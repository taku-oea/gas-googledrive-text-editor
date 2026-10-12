/**
 * DriveServiceList.gs — DriveService のうち 一覧（フォルダの中身・複数フォルダの一括取得・キャッシュ）。
 *
 * DriveService は 1 つのオブジェクトだが、長いので機能ごとのファイルに分けて足している。
 * GAS は全ファイルを 1 つのグローバルに読み込み、読み込む順は決められないので、
 * どのファイルも「無ければ作る」形にしてある（呼ばれるのは全ファイルを読み終えた後）。
 */

var DriveService = DriveService || {};

Object.assign(DriveService, {

  /* ------------------------------------------------------------------ *
   *  一覧
   * ------------------------------------------------------------------ */

  /**
   * Drive の拡張サービス（Drive API v3）が使えるか。
   *
   * appsscript.json の enabledAdvancedServices で有効化しているが、
   * 何らかの理由で使えない環境でも動くよう、呼び出し側は DriveApp へ
   * フォールバックする。
   * @return {boolean}
   */
  hasAdvancedDrive_: function () {
    try {
      return typeof Drive !== 'undefined' && !!Drive.Files;
    } catch (e) {
      return false;
    }
  },

  /**
   * files.list の応答（複数親をまとめて問い合わせたもの）を、親フォルダごとの
   * {folders, files, truncated} に振り分ける。REST 経路と Advanced Service 経路で共用。
   *
   * @param {Array<Object>} items files.list の files
   * @param {Array<string>} ids 今回問い合わせた親フォルダ ID（全部にバケツを用意する）
   * @param {Object<string, {folders:Array, files:Array, truncated:boolean}>} buckets 出力先（追記）
   */
  bucketize_: function (items, ids, buckets) {
    var idSet = {};
    for (var i = 0; i < ids.length; i++) {
      idSet[ids[i]] = true;
      if (!buckets[ids[i]]) buckets[ids[i]] = { folders: [], files: [], truncated: false };
    }
    for (var n = 0; n < items.length; n++) {
      var meta = items[n];
      // 1 つのファイルが複数の親を持つことがある。今回問い合わせた側の親に入れる。
      var parents = meta.parents || [];
      var owner = null;
      for (var p = 0; p < parents.length; p++) {
        if (idSet[parents[p]]) { owner = parents[p]; break; }
      }
      if (!owner) continue;
      var bucket = buckets[owner];
      if (meta.mimeType === FOLDER_MIME) {
        if (bucket.folders.length >= MAX_FOLDERS_PER_LISTING) { bucket.truncated = true; continue; }
        bucket.folders.push({ id: meta.id, name: meta.name });
      } else {
        if (bucket.files.length >= MAX_FILES_PER_LISTING) { bucket.truncated = true; continue; }
        bucket.files.push(DriveService.entryFromMeta_(meta));
      }
    }
  },

  /**
   * バケツを listEntries の戻り値の形に仕上げる（ソート・fetchedAt 付与）。
   * folder.name は呼び出し側が分かっていれば上書きする。
   * fetchedAt は「30 秒以内なら新しい」の判定（isFresh_）に使う。
   *
   * @param {string} id
   * @param {{folders:Array, files:Array, truncated:boolean}|undefined} bucket
   * @param {boolean} truncated ページ継続を打ち切ったなど、外から分かった打ち切り
   * @return {Object}
   */
  finishBucket_: function (id, bucket, truncated) {
    var b = bucket || { folders: [], files: [], truncated: false };
    b.folders.sort(DriveService.byName_);
    b.files.sort(DriveService.byName_);
    return {
      folder: { id: id, name: '' },
      folders: b.folders,
      files: b.files,
      truncated: !!(b.truncated || truncated),
      fromCache: false,
      fetchedAt: Date.now()
    };
  },

  /**
   * 複数フォルダの一覧を REST で取る。15 親ずつのチャンクを並列に投げ、
   * ページ継続（最大 4 回）も並列に追う。失敗したチャンクのフォルダは結果に含めない
   * （アクセス不可・消えた可能性。呼び出し側は「無い」として扱う）。
   *
   * @param {Array<string>} ids 検証済みの ID
   * @param {boolean} [foldersOnly]
   * @return {Object<string, Object>} id → listEntries の形（folder.name は ''）
   */
  listViaRest_: function (ids, foldersOnly) {
    var out = {};
    if (!ids.length) return out;
    var chunks = chunk_(ids, MAX_PARENTS_PER_LIST_REQ);
    var rs = fetchAll_(chunks.map(function (c) { return listReq_(c, null, !!foldersOnly); }));
    var buckets = {};
    var pending = [];
    for (var k = 0; k < rs.length; k++) {
      if (!rs[k].ok) continue;
      var body = rs[k].json();
      DriveService.bucketize_(body.files || [], chunks[k], buckets);
      if (body.nextPageToken) pending.push({ ids: chunks[k], token: body.nextPageToken });
    }
    for (var round = 0; round < 4 && pending.length; round++) {
      var more = fetchAll_(pending.map(function (p) { return listReq_(p.ids, p.token, !!foldersOnly); }));
      var next = [];
      for (var m = 0; m < more.length; m++) {
        if (!more[m].ok) continue;
        var b2 = more[m].json();
        DriveService.bucketize_(b2.files || [], pending[m].ids, buckets);
        if (b2.nextPageToken) next.push({ ids: pending[m].ids, token: b2.nextPageToken });
      }
      pending = next;
    }
    var truncatedIds = {};
    for (var q = 0; q < pending.length; q++) {
      for (var t = 0; t < pending[q].ids.length; t++) truncatedIds[pending[q].ids[t]] = true;
    }
    for (var i = 0; i < ids.length; i++) {
      if (!buckets[ids[i]]) continue;
      out[ids[i]] = DriveService.finishBucket_(ids[i], buckets[ids[i]], !!truncatedIds[ids[i]]);
    }
    return out;
  },

  /**
   * 指定フォルダ群の直下にある要素を、Drive API v3 で一括取得する。
   *
   * DriveApp のイテレータはファイル 1 件ごとにゲッターを呼ぶ必要があるが、
   * こちらは fields を絞った 1 リクエストで全件のメタデータが返る。
   * 複数フォルダも "('a' in parents or 'b' in parents)" で 1 リクエストに畳める。
   *
   * @param {Array<string>} folderIds
   * @return {Object<string, {folders:Array, files:Array, truncated:boolean}>}
   */
  fetchChildrenViaApi_: function (folderIds) {
    var ids = [];
    for (var i = 0; i < folderIds.length; i++) {
      // ID はクエリ文字列に素で埋めるので、想定外の文字が来たら弾く。
      if (validId_(folderIds[i])) ids.push(String(folderIds[i]));
    }

    var result = {};
    for (var j = 0; j < ids.length; j++) {
      result[ids[j]] = { folders: [], files: [], truncated: false };
    }
    if (!ids.length) return result;

    var idSet = {};
    for (var k = 0; k < ids.length; k++) idSet[ids[k]] = true;

    var parentClauses = [];
    for (var m = 0; m < ids.length; m++) parentClauses.push("'" + ids[m] + "' in parents");
    var q = '(' + parentClauses.join(' or ') + ') and trashed = false';

    var pageToken = null;
    var pages = 0;
    var counted = 0;
    do {
      var res = Drive.Files.list({
        q: q,
        fields: 'nextPageToken, files(id,name,mimeType,size,modifiedTime,parents)',
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageToken: pageToken
      });

      var items = res.files || [];
      for (var n = 0; n < items.length; n++) {
        var meta = items[n];
        // 1 つのファイルが複数の親を持つことがある。今回問い合わせた側の親に入れる。
        var parents = meta.parents || [];
        var owner = null;
        for (var q2 = 0; q2 < parents.length; q2++) {
          if (idSet[parents[q2]]) { owner = parents[q2]; break; }
        }
        if (!owner) continue;

        var bucket = result[owner];
        if (meta.mimeType === 'application/vnd.google-apps.folder') {
          if (bucket.folders.length >= MAX_FOLDERS_PER_LISTING) { bucket.truncated = true; continue; }
          bucket.folders.push({ id: meta.id, name: meta.name });
        } else {
          if (bucket.files.length >= MAX_FILES_PER_LISTING) { bucket.truncated = true; continue; }
          bucket.files.push(DriveService.entryFromMeta_(meta));
        }
        counted++;
      }

      pageToken = res.nextPageToken;
      pages++;
    } while (pageToken && pages < 5 && counted < (MAX_FILES_PER_LISTING + MAX_FOLDERS_PER_LISTING) * ids.length);

    if (pageToken) {
      for (var r = 0; r < ids.length; r++) result[ids[r]].truncated = true;
    }

    for (var t = 0; t < ids.length; t++) {
      result[ids[t]].folders.sort(DriveService.byName_);
      result[ids[t]].files.sort(DriveService.byName_);
    }
    return result;
  },

  /**
   * DriveApp を使った子要素の取得（拡張サービスが使えない場合のフォールバック）。
   * @param {GoogleAppsScript.Drive.Folder} folder
   * @return {{folders:Array, files:Array, truncated:boolean}}
   */
  fetchChildrenViaDriveApp_: function (folder) {
    var folders = [];
    var files = [];
    var truncated = false;

    var fit = folder.getFolders();
    while (fit.hasNext()) {
      if (folders.length >= MAX_FOLDERS_PER_LISTING) { truncated = true; break; }
      var sub = fit.next();
      folders.push({ id: sub.getId(), name: sub.getName() });
    }
    folders.sort(DriveService.byName_);

    var it = folder.getFiles();
    while (it.hasNext()) {
      if (files.length >= MAX_FILES_PER_LISTING) { truncated = true; break; }
      files.push(DriveService.entryOf_(it.next()));
    }
    files.sort(DriveService.byName_);

    return { folders: folders, files: files, truncated: truncated };
  },

  /**
   * フォルダ直下のサブフォルダ一覧のみを返す（フォルダツリーの遅延ロード用）。
   *
   * 各フォルダが子を持つかどうかはここでは調べない。調べるとフォルダ数ぶんの
   * API 呼び出しが増えて（N+1）遅延ロードの意味が無くなるため、
   * UI 側は常に展開可能として描画し、空だった場合に「サブフォルダはありません」を出す。
   *
   * @param {string|null} parentFolderId null ならマイドライブのルート
   * @return {{parent:{id:string,name:string}, folders:Array<{id:string,name:string}>, truncated:boolean}}
   */
  listSubFolders_: function (parentFolderId) {
    var id = parentFolderId ? String(parentFolderId) : 'root';
    if (!validId_(id)) {
      throw appError_('NOT_FOUND', 'フォルダ ID の形式が正しくありません。');
    }
    if (!restAvailable_()) return DriveService.listSubFoldersLegacy_(parentFolderId);

    var rs;
    try {
      // フォルダ自身（アクセス可否・名前）と直下のサブフォルダを並列に取る。
      // 'root' はマイドライブの別名で、files.get も files.list の parents も受け付ける。
      rs = fetchAll_([metaReq_(id, 'id,name,mimeType,driveId,trashed'), listReq_([id], null, true)]);
    } catch (e) {
      if (e && e.restFailure) return DriveService.listSubFoldersLegacy_(parentFolderId);
      throw e;
    }
    var parent = DriveService.folderFromMetaResp_(id, rs[0]);
    if (!rs[1].ok) throw driveErr_(rs[1], 'フォルダの一覧');

    // 'root' で問い合わせた場合、子の parents には実 ID が入るので実 ID で振り分ける。
    var buckets = {};
    var body = rs[1].json();
    DriveService.bucketize_(body.files || [], [parent.id], buckets);
    var pageToken = body.nextPageToken;
    for (var pages = 1; pageToken && pages < 5; pages++) {
      var more = fetchAll_([listReq_([parent.id], pageToken, true)])[0];
      if (!more.ok) break;
      var b2 = more.json();
      DriveService.bucketize_(b2.files || [], [parent.id], buckets);
      pageToken = b2.nextPageToken;
    }
    var bucket = buckets[parent.id] || { folders: [], truncated: false };
    bucket.folders.sort(DriveService.byName_);
    return { parent: parent, folders: bucket.folders, truncated: !!(bucket.truncated || pageToken) };
  },

  /** DriveApp / Advanced Service 経路の listSubFolders_（REST が使えないときのフォールバック）。 */
  listSubFoldersLegacy_: function (parentFolderId) {
    var id = parentFolderId ? String(parentFolderId) : DriveApp.getRootFolder().getId();
    var access = DriveService.assertFolderAccess_(id);

    // 取得は Drive API を優先する。共有ドライブのルートは
    // DriveApp の Folder オブジェクトが得られないことがあるため。
    if (DriveService.hasAdvancedDrive_()) {
      try {
        var bucket = DriveService.fetchChildrenViaApi_([access.id])[access.id];
        return {
          parent: { id: access.id, name: access.name },
          folders: bucket.folders,
          truncated: bucket.truncated
        };
      } catch (e) {
        console.warn('Drive API でのフォルダ取得に失敗したため DriveApp で再試行します: ' +
          (e && e.message ? e.message : e));
      }
    }

    if (!access.folder) {
      throw appError_('FORBIDDEN',
        '「' + access.name + '」の中身を取得できませんでした。');
    }

    var folders = [];
    var truncated = false;
    var it = access.folder.getFolders();
    while (it.hasNext()) {
      if (folders.length >= MAX_FOLDERS_PER_LISTING) {
        truncated = true;
        break;
      }
      var f = it.next();
      folders.push({ id: f.getId(), name: f.getName() });
    }
    folders.sort(DriveService.byName_);

    return {
      parent: { id: access.id, name: access.name },
      folders: folders,
      truncated: truncated
    };
  },

  /**
   * フォルダ選択画面に出すルートの一覧。
   * マイドライブと、ユーザーが参加している共有ドライブ。
   *
   * 共有ドライブの列挙は DriveApp ではできないので Drive API を使う。
   * 拡張サービスが使えない場合はマイドライブだけを返し、
   * 共有ドライブは URL 貼り付けで指定してもらう。
   *
   * @return {{roots:Array<{id:string,name:string,kind:string}>, sharedDrivesAvailable:boolean}}
   */
  listPickerRoots_: function () {
    var myDriveId = null;
    if (restAvailable_()) {
      try {
        var r = fetchAll_([metaReq_('root', 'id')])[0];
        if (r.ok) myDriveId = r.json().id;
      } catch (e) {
        if (!(e && e.restFailure)) throw e;
      }
    }
    if (!myDriveId) myDriveId = DriveApp.getRootFolder().getId();
    var roots = [{ id: myDriveId, name: 'マイドライブ', kind: 'myDrive' }];

    var names = DriveService.sharedDriveNames_();
    if (names === null) return { roots: roots, sharedDrivesAvailable: false };

    for (var id in names) {
      if (Object.prototype.hasOwnProperty.call(names, id)) {
        roots.push({ id: id, name: names[id], kind: 'sharedDrive' });
      }
    }
    return { roots: roots, sharedDrivesAvailable: true };
  },

  /**
   * 参加している共有ドライブの id → name を返す。
   *
   * **共有ドライブのルートは DriveApp から名前が取れない。**
   * DriveApp.getFolderById(<共有ドライブ ID>) は成功するものの、getName() が
   * 実際のドライブ名ではなくロケール依存の汎用名（日本語なら「ドライブ」）を
   * 返す。そのまま使うと共有ドライブのルートが全部「ドライブ」になり、
   * 複数開いていると見分けがつかない。実名が取れるのは Drive API の Drives だけ。
   *
   * ルート 1 件ずつ Drives.get を叩くとルートの数だけ往復するので、
   * Drives.list の 1 リクエストでまとめて取って CacheService に載せる。
   *
   * @return {Object<string, string>|null}
   *         取得できなかった場合は null（呼び出し側は DriveApp の名前のまま進む）。
   *         参加している共有ドライブが 0 件なら空オブジェクト。
   */
  sharedDriveNames_: function () {
    // 同じ実行の中では 1 回だけ取る。以前はルートやフォルダの名前を出すたびに
    // CacheService.get + ungzip + JSON.parse を繰り返していた（ルート 8 個で 8 回）。
    if (memo_.driveNames !== undefined) return memo_.driveNames;
    var names = DriveService.sharedDriveNamesUncached_();
    memo_.driveNames = names;
    return names;
  },

  /** sharedDriveNames_ の実体。キャッシュ → Drive API の順に取る。 */
  sharedDriveNamesUncached_: function () {
    var cached = DriveService.cacheGet_('sharedDriveNames');
    if (cached) {
      try {
        var parsed = JSON.parse(cached);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (e) {
        // 壊れていたら取り直す。
      }
    }

    if (!DriveService.hasAdvancedDrive_()) return null;
    // 直前に失敗しているならしばらく試さない（下の catch を参照）。
    if (DriveService.cacheGet_('sharedDriveNamesFailed')) return null;

    var map = {};
    try {
      var pageToken = null;
      var pages = 0;
      do {
        var res = Drive.Drives.list({
          pageSize: 100,
          fields: 'nextPageToken, drives(id,name)',
          pageToken: pageToken
        });
        var items = res.drives || [];
        for (var i = 0; i < items.length; i++) map[items[i].id] = items[i].name;
        pageToken = res.nextPageToken;
        pages++;
      } while (pageToken && pages < 5);
    } catch (e) {
      // 取得できない構成（権限不足など）。この関数はフォルダを開くたびに
      // 通るので、失敗し続ける呼び出しを繰り返さないよう短く覚えておく。
      console.warn('共有ドライブの一覧を取得できませんでした: ' + (e && e.message ? e.message : e));
      DriveService.cachePut_('sharedDriveNamesFailed', '1', SHARED_DRIVE_FAIL_TTL_SEC);
      return null;
    }

    DriveService.cachePut_('sharedDriveNames', JSON.stringify(map), SHARED_DRIVE_NAME_TTL_SEC);
    return map;
  },

  /**
   * 画面に出すフォルダ名。共有ドライブのルートだけ実名に差し替える。
   *
   * 対応表に無い ID（通常のフォルダ）は渡された名前をそのまま返すので、
   * 共有ドライブを使っていない環境の挙動は変わらない。
   *
   * @param {string} id
   * @param {string} name DriveApp などから取れた名前
   * @return {string}
   */
  displayFolderName_: function (id, name) {
    var names = DriveService.sharedDriveNames_();
    return (names && names[String(id)]) || name;
  },

  /**
   * フォルダ直下のサブフォルダとファイルを返す。
   * 開けないファイルも reason 付きで返し、UI 側でグレー表示させる。
   *
   * @param {string} folderId 表示対象のフォルダ
   * @param {boolean} forceRefresh true で一覧キャッシュを無視
   * @return {Object}
   */
  listEntries_: function (folderId, forceRefresh) {
    if (!folderId) {
      throw appError_('NOT_FOUND', 'フォルダが指定されていません。');
    }
    var id = String(folderId);
    var cacheKey = 'list:' + id;
    if (!forceRefresh) {
      var hit = DriveService.cacheGetJson_(cacheKey);
      if (hit && DriveService.isFresh_(hit)) {
        hit.fromCache = true;
        return hit;
      }
    }
    if (!restAvailable_() || !validId_(id)) return DriveService.listEntriesLegacy_(id, forceRefresh);

    var rs;
    try {
      // フォルダのメタデータ（アクセス可否・名前）と一覧を並列に取る。
      // 以前は assertFolderAccess_（DriveApp の往復）を先に済ませてから一覧を取っていた。
      rs = fetchAll_([metaReq_(id, 'id,name,mimeType,driveId,trashed'), listReq_([id], null)]);
    } catch (e) {
      if (e && e.restFailure) return DriveService.listEntriesLegacy_(id, forceRefresh);
      throw e;
    }
    var folder = DriveService.folderFromMetaResp_(id, rs[0]);
    if (!rs[1].ok) throw driveErr_(rs[1], 'フォルダの一覧');

    var buckets = {};
    var body = rs[1].json();
    DriveService.bucketize_(body.files || [], [folder.id], buckets);
    var pageToken = body.nextPageToken;
    for (var pages = 1; pageToken && pages < 5; pages++) {
      var more = fetchAll_([listReq_([folder.id], pageToken)])[0];
      if (!more.ok) break;
      var b2 = more.json();
      DriveService.bucketize_(b2.files || [], [folder.id], buckets);
      pageToken = b2.nextPageToken;
    }
    var result = DriveService.finishBucket_(folder.id, buckets[folder.id], !!pageToken);
    result.folder.name = folder.name;
    // 6 時間まで残す（起動時のインライン表示用）。「新しい」と見なすのは fetchedAt から 30 秒。
    DriveService.cachePutJson_(cacheKey, result, SNAPSHOT_TTL_SEC);
    return result;
  },

  /** DriveApp / Advanced Service 経路の listEntries_（REST が使えないときのフォールバック）。 */
  listEntriesLegacy_: function (folderId, forceRefresh) {
    var cacheKey = 'list:' + folderId;
    if (!forceRefresh) {
      var cached = DriveService.cacheGet_(cacheKey);
      if (cached) {
        try {
          var parsed = JSON.parse(cached);
          // 値は 6 時間残るが、そのまま返してよいのは取得から 30 秒以内のものだけ。
          if (DriveService.isFresh_(parsed)) {
            parsed.fromCache = true;
            return parsed;
          }
        } catch (e) {
          // 壊れたキャッシュは無視して取り直す。
        }
      }
    }

    // アクセス可否の検証はここで必ず行う（要件どおり try/catch）。
    // 共有ドライブのルートは DriveApp から開けないことがあるので、
    // Folder オブジェクトが取れなくても ID と名前で先に進める。
    var access = DriveService.assertFolderAccess_(folderId);

    // 拡張サービスが使えるなら 1 リクエストで済ませる。
    // クエリが通らない構成に当たっても止まらないよう、失敗したら DriveApp に落ちる。
    var children = null;
    if (DriveService.hasAdvancedDrive_()) {
      try {
        children = DriveService.fetchChildrenViaApi_([access.id])[access.id];
      } catch (e) {
        console.warn('Drive API での一覧取得に失敗したため DriveApp で再試行します: ' +
          (e && e.message ? e.message : e));
        children = null;
      }
    }
    if (!children) {
      if (!access.folder) {
        throw appError_('FORBIDDEN',
          '「' + access.name + '」の中身を取得できませんでした。');
      }
      children = DriveService.fetchChildrenViaDriveApp_(access.folder);
    }

    // パンくずはここでは作らない。サイドバーがツリーになってから使われておらず、
    // 生成には親を最大 MAX_PATH_DEPTH 段まで遡る DriveApp 呼び出しが必要だった
    // （一覧のたびに最大 12 往復ぶんの無駄）。
    // 必要なのは resolveFolderRef（選択画面の表示）だけなので、そちらでのみ作る。
    var result = {
      folder: { id: access.id, name: access.name },
      folders: children.folders,
      files: children.files,
      truncated: children.truncated,
      fromCache: false,
      fetchedAt: Date.now()
    };

    DriveService.cachePut_(cacheKey, JSON.stringify(result), SNAPSHOT_TTL_SEC);
    return result;
  },

  /**
   * 一覧・作成・リネームで共通に使うファイル 1 件の形。
   * @param {GoogleAppsScript.Drive.File} file
   * @return {Object}
   */
  entryOf_: function (file) {
    // getName() / getMimeType() をここで 1 回だけ呼び、classify_ にも渡す。
    // 以前は entryOf_ と classify_ の両方で呼んでいて、ファイル 1 件あたり
    // DriveApp のゲッターが 7 回走っていた（→ 5 回）。
    var name = file.getName();
    var mime = String(file.getMimeType() || '');
    var info = DriveService.classify_(file, name, mime);
    return {
      id: file.getId(),
      name: name,
      mimeType: mime,
      size: info.size,
      updatedAtIso: file.getLastUpdated().toISOString(),
      kind: info.kind,
      viewer: info.viewer,
      openable: info.openable,
      reason: info.reason
    };
  },

  /**
   * Drive API v3 のメタデータから、entryOf_ と同じ形を作る。
   *
   * updatedAtIso を Date 経由で作り直しているのは、DriveApp 側
   * （getLastUpdated().toISOString()）と表記を必ず一致させるため。
   * 競合検出は文字列比較なので、書式が揺れると誤検出になる。
   *
   * @param {Object} meta {id, name, mimeType, size, modifiedTime}
   * @return {Object}
   */
  entryFromMeta_: function (meta) {
    var info = DriveService.classifyMeta_(meta.name, meta.mimeType, Number(meta.size) || 0);
    return {
      id: meta.id,
      name: meta.name,
      mimeType: meta.mimeType,
      size: info.size,
      updatedAtIso: new Date(meta.modifiedTime).toISOString(),
      kind: info.kind,
      viewer: info.viewer,
      openable: info.openable,
      reason: info.reason
    };
  },

  /**
   * 複数フォルダの一覧をまとめて返す（ツリーの展開状態の復元用）。
   *
   * 拡張サービスが使えるときは全フォルダを 1 リクエストで取る。
   * アクセスできないフォルダは、クエリがユーザー権限で走るので単に
   * 結果が空になる（個別に getFolderById で検証すると
   * フォルダ数ぶん往復が増え、まとめた意味が無くなるため検証しない）。
   *
   * @param {Array<string>} folderIds
   * @return {Object<string, Object>}
   */
  listEntriesMany_: function (folderIds) {
    var ids = [];
    var src = Array.isArray(folderIds) ? folderIds.slice(0, MAX_MULTI_LIST) : [];
    for (var i = 0; i < src.length; i++) {
      if (validId_(src[i]) && src[i] !== 'root') ids.push(String(src[i]));
    }
    var out = {};
    if (!ids.length) return out;

    // 30 秒以内に取った一覧はそのまま使う（getAll で 1 回）。
    var cached = DriveService.cacheGetAllJson_(ids.map(function (id) { return 'list:' + id; }));
    var toFetch = [];
    for (var j = 0; j < ids.length; j++) {
      var hit = cached['list:' + ids[j]];
      if (hit && DriveService.isFresh_(hit)) {
        hit.fromCache = true;
        out[ids[j]] = hit;
      } else {
        toFetch.push(ids[j]);
      }
    }
    if (!toFetch.length) return out;

    var fetched = null;
    if (restAvailable_()) {
      try {
        fetched = DriveService.listViaRest_(toFetch, false);
      } catch (e) {
        if (!(e && e.restFailure)) throw e;
        fetched = null;
      }
    }
    if (!fetched) fetched = DriveService.listEntriesManyLegacy_(toFetch);

    var toPut = {};
    for (var k = 0; k < toFetch.length; k++) {
      var id = toFetch[k];
      if (!fetched[id]) continue;
      out[id] = fetched[id];
      toPut['list:' + id] = fetched[id];
    }
    DriveService.cachePutAllJson_(toPut, SNAPSHOT_TTL_SEC);
    return out;
  },

  /** Advanced Service / DriveApp 経路の listEntriesMany_（REST が使えないときのフォールバック）。 */
  listEntriesManyLegacy_: function (folderIds) {
    var ids = Array.isArray(folderIds) ? folderIds.slice(0, MAX_MULTI_LIST) : [];
    var out = {};
    if (!ids.length) return out;

    var buckets = null;
    if (DriveService.hasAdvancedDrive_()) {
      try {
        buckets = DriveService.fetchChildrenViaApi_(ids);
      } catch (e) {
        console.warn('Drive API での一括取得に失敗したため 1 件ずつ取得します: ' +
          (e && e.message ? e.message : e));
        buckets = null;
      }
    }

    if (!buckets) {
      // フォールバック。フォルダ数ぶん往復するが、動くことを優先する。
      for (var i = 0; i < ids.length; i++) {
        try {
          out[ids[i]] = DriveService.listEntries_(ids[i], false);
        } catch (e) {
          // 消えた／権限が外れたフォルダは結果に含めない。
        }
      }
      return out;
    }

    for (var j = 0; j < ids.length; j++) {
      var id = ids[j];
      var bucket = buckets[id];
      if (!bucket) continue;
      // ツリーの復元では folder 名を使わないので、
      // ここでは getFolderById を呼ばない（往復を増やさないため）。
      out[id] = {
        folder: { id: id, name: '' },
        folders: bucket.folders,
        files: bucket.files,
        truncated: bucket.truncated,
        fromCache: false,
        fetchedAt: Date.now()
      };
    }
    return out;
  },

  /**
   * 名前の昇順ソート。
   * @param {{name:string}} a
   * @param {{name:string}} b
   * @return {number}
   */
  byName_: function (a, b) {
    if (COLLATOR_JA) return COLLATOR_JA.compare(a.name, b.name);
    try {
      return a.name.localeCompare(b.name, 'ja');
    } catch (e) {
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    }
  },

  /**
   * 指定フォルダの一覧キャッシュを捨てる。
   * 対象フォルダが確実に分かる操作（作成・リネーム・削除）でのみ呼ぶこと。
   * @param {string} folderId
   */
  invalidateFolderList_: function (folderId) {
    if (!folderId) return;
    try {
      CacheService.getUserCache().remove('list:' + folderId);
    } catch (e) {
      // 消せなくても TTL 切れで解決する。
    }
  }
});
