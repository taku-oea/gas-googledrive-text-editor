/**
 * DriveServiceTemp.gs — DriveService のうち 一時メモ（tmp フォルダ）。
 *
 * DriveService は 1 つのオブジェクトだが、長いので機能ごとのファイルに分けて足している。
 * GAS は全ファイルを 1 つのグローバルに読み込み、読み込む順は決められないので、
 * どのファイルも「無ければ作る」形にしてある（呼ばれるのは全ファイルを読み終えた後）。
 */

var DriveService = DriveService || {};

Object.assign(DriveService, {

  /* ------------------------------------------------------------------ *
   *  一時メモ（tmp フォルダ）
   *
   *  「とっさのメモ」をタブ 1 枚ぶんの一時ファイルとして Drive に置く。
   *  実ファイルにしてあるので、自動保存も競合検出もセッション復元も
   *  通常のファイルとまったく同じ経路を通る（このアプリのタブ ID は
   *  Drive のファイル ID そのもの）。保存先を決めた時点で
   *  promoteTempFile_ が本来のフォルダへ移す。
   * ------------------------------------------------------------------ */

  /**
   * 覚えている tmp フォルダの ID を返す（Drive は見ない）。
   * 起動時の往復を増やさずに「一時メモ」セクションを描くために使う。
   * まだ一度も一時メモを作っていなければ null。
   *
   * @return {string|null}
   */
  tmpFolderIdCached_: function () {
    try {
      return PropertiesService.getUserProperties().getProperty(PROP_TMP_FOLDER_ID) || null;
    } catch (e) {
      return null;
    }
  },

  /**
   * 一時メモを置くフォルダ（<親> / <アプリ名> / tmp。親の既定はマイドライブ）を返す。無ければ作る。
   * @return {{id:string, name:string}}
   */
  tmpFolder_: function () {
    // 覚えている ID をそのまま信じる。以前はここで getFolderById + isTrashed + getName の
    // 往復で毎回確かめていたが、消えていれば実操作が NOT_FOUND を返すので、
    // withTmpFolder_ がそこで作り直す。
    var id = DriveService.tmpFolderIdCached_();
    if (id) return { id: id, name: TMP_FOLDER_NAME };
    return DriveService.tmpFolderCreate_();
  },

  /**
   * tmp フォルダを探して（無ければ作って）ID を覚える。
   * 作る場所は「覚えている親 / <アプリ名> / tmp」。親が未設定ならマイドライブ直下。
   */
  tmpFolderCreate_: function () {
    var parent = DriveService.tmpParentRef_();
    var made;
    try {
      made = DriveService.ensureTmpFolder_(parent);
    } catch (e) {
      // 覚えていた親が消された／権限が外れた場合だけ、既定の場所へ戻して作り直す
      // （ここで諦めると、一時メモが 1 枚も作れなくなる）。通信の一時的な失敗まで
      // ここで拾うと、選んだ置き場所が黙って既定に戻ってしまう。
      var lost = e && (e.appCode === 'NOT_FOUND' || e.appCode === 'FORBIDDEN');
      if (!parent || !lost) throw e;
      DriveService.saveTmpParent_(null);
      made = DriveService.ensureTmpFolder_(null);
    }
    PropertiesService.getUserProperties().setProperty(PROP_TMP_FOLDER_ID, made.id);
    return made;
  },

  /**
   * 覚えている「一時メモの親フォルダ」を返す。未設定（既定のマイドライブ）なら null。
   * @return {{id:string, name:string}|null}
   */
  tmpParentRef_: function () {
    try {
      return DriveService.parseFolderRefRaw_(
        PropertiesService.getUserProperties().getProperty(PROP_TMP_PARENT));
    } catch (e) {
      return null;
    }
  },

  /**
   * 一時メモの親フォルダを覚える。null なら既定（マイドライブ）に戻す。
   * @param {{id:string, name:string}|null} ref
   */
  saveTmpParent_: function (ref) {
    var props = PropertiesService.getUserProperties();
    try {
      if (ref && ref.id) {
        props.setProperty(PROP_TMP_PARENT, JSON.stringify({
          id: String(ref.id),
          name: String(ref.name || '').slice(0, 120)
        }));
      } else {
        props.deleteProperty(PROP_TMP_PARENT);
      }
    } catch (e) {
      // 覚えられなくても、この回の操作そのものは成立している。
    }
  },

  /**
   * <親> / <アプリ名> / tmp を用意する（途中のフォルダが無ければ作る）。
   * @param {{id:string, name:string}|null} parentRef null ならマイドライブ直下
   * @return {{id:string, name:string}} tmp フォルダ
   */
  ensureTmpFolder_: function (parentRef) {
    var parentId = (parentRef && parentRef.id) ? String(parentRef.id) : null;
    if (restAvailable_() && (!parentId || validId_(parentId))) {
      try {
        return DriveService.ensureTmpFolderRest_(parentId);
      } catch (e) {
        if (!(e && e.restFailure)) throw e;
        // UrlFetchApp が使えない環境。DriveApp 経路でやり直す。
      }
    }
    return DriveService.ensureTmpFolderLegacy_(parentId);
  },

  /** REST 経路の ensureTmpFolder_。'root' はマイドライブを指す別名。 */
  ensureTmpFolderRest_: function (parentId) {
    if (parentId) {
      // 親が生きているフォルダかを先に確かめる。ここで弾いておかないと、
      // ゴミ箱の中や別種の ID の下に tmp を作ってしまう。
      DriveService.folderFromMetaResp_(
        parentId, fetchAll_([metaReq_(parentId, 'id,name,mimeType,trashed')])[0]);
    }
    var app = DriveService.ensureChildFolderRest_(parentId || 'root', TMP_APP_FOLDER_NAME);
    return DriveService.ensureChildFolderRest_(app.id, TMP_FOLDER_NAME);
  },

  /**
   * 直下のサブフォルダを名前で 1 つ探し、無ければ作る（REST）。
   * @return {{id:string, name:string}}
   */
  ensureChildFolderRest_: function (parentId, name) {
    var found = fetchAll_([nameQueryReq_(parentId, name, true)])[0];
    if (found.ok) {
      var files = found.json().files || [];
      if (files.length) return { id: files[0].id, name: files[0].name };
    } else {
      // 探せなかった（404 に加えて 429 / 5xx など一時的な失敗も）のに作りに進むと、
      // 既にある <アプリ名> / tmp と同名のフォルダが二重にでき、メモが分かれて見えなくなる。
      throw driveErr_(found, 'フォルダ');
    }

    var created = fetchAll_([req_('files', { supportsAllDrives: true, fields: 'id,name' }, {
      method: 'post',
      payload: JSON.stringify({ name: name, parents: [parentId], mimeType: FOLDER_MIME }),
      contentType: 'application/json'
    })])[0];
    if (!created.ok) {
      if (created.code === 404) throw driveErr_(created, 'フォルダ');
      throw appError_(
        'FORBIDDEN',
        '「' + name + '」フォルダを作成できませんでした。選んだ場所への書き込み権限を確認してください。' +
          (created.message ? '（' + created.message + '）' : '')
      );
    }
    DriveService.invalidateFolderList_(parentId);
    var meta = created.json();
    return { id: meta.id, name: meta.name };
  },

  /** DriveApp 経路の ensureTmpFolder_（REST が使えないときのフォールバック）。 */
  ensureTmpFolderLegacy_: function (parentId) {
    var base = parentId ? DriveService.assertFolder_(parentId) : DriveApp.getRootFolder();
    var app = DriveService.childFolderByName_(base, TMP_APP_FOLDER_NAME) ||
      base.createFolder(TMP_APP_FOLDER_NAME);
    var tmp = DriveService.childFolderByName_(app, TMP_FOLDER_NAME) ||
      app.createFolder(TMP_FOLDER_NAME);
    return { id: tmp.getId(), name: tmp.getName() };
  },

  /**
   * tmp フォルダを使う処理を包む。フォルダが消えていた／ゴミ箱に入っていた
   * （NOT_FOUND）ときだけ、覚えていた ID を捨てて作り直し、1 回やり直す。
   *
   * @param {function({id:string, name:string}): *} fn
   * @return {*}
   */
  withTmpFolder_: function (fn) {
    var tmp = DriveService.tmpFolder_();
    try {
      return fn(tmp);
    } catch (e) {
      if (!e || e.appCode !== 'NOT_FOUND') throw e;
      try {
        PropertiesService.getUserProperties().deleteProperty(PROP_TMP_FOLDER_ID);
      } catch (e2) {
        // 消せなくても作り直した ID を setProperty で上書きする。
      }
      return fn(DriveService.tmpFolderCreate_());
    }
  },

  /**
   * 直下のサブフォルダを名前で 1 つ探す（ゴミ箱の中は無視する）。
   * @param {GoogleAppsScript.Drive.Folder} parent
   * @param {string} name
   * @return {GoogleAppsScript.Drive.Folder|null}
   */
  childFolderByName_: function (parent, name) {
    var it = parent.getFoldersByName(name);
    while (it.hasNext()) {
      var folder = it.next();
      if (!folder.isTrashed()) return folder;
    }
    return null;
  },

  /**
   * 一時メモを 1 つ作る。
   *
   * 名前に日時を入れるのは、同じ tmp フォルダを複数の端末が共有するため。
   * 「無題-1」方式だと端末をまたいだときに衝突しやすい。
   *
   * @param {string} extension 'txt' | 'md'
   * @return {{entry:Object, folder:{id:string,name:string}}}
   */
  createTempFile_: function (extension) {
    var ext = TMP_EXTENSIONS[String(extension || '').toLowerCase()]
      ? String(extension).toLowerCase()
      : DEFAULT_TMP_EXTENSION;
    var base = 'メモ ' + Utilities.formatDate(
      new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HHmm');
    var mime = MIME_BY_EXTENSION[ext] || 'text/plain';

    return DriveService.withTmpFolder_(function (tmp) {
      if (!restAvailable_() || !validId_(tmp.id)) {
        return DriveService.createTempFileLegacy_(tmp, base, ext, mime);
      }
      var rs;
      try {
        // tmp フォルダの状態（ゴミ箱に入っていないか）と既存のメモ名を並列に取る。
        // 名前の衝突は取った一覧に対して JS で判定する
        // （以前は候補ごとに getFilesByName を最大 49 回呼んでいた）。
        rs = fetchAll_([
          metaReq_(tmp.id, 'id,name,trashed'),
          req_('files', {
            q: "'" + tmp.id + "' in parents and trashed = false",
            fields: 'files(name)',
            pageSize: 1000,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true
          })
        ]);
      } catch (e) {
        if (e && e.restFailure) return DriveService.createTempFileLegacy_(tmp, base, ext, mime);
        throw e;
      }
      if (!rs[0].ok) throw driveErr_(rs[0], 'フォルダ');   // NOT_FOUND なら withTmpFolder_ が作り直す
      if (rs[0].json().trashed) {
        throw appError_('NOT_FOUND', 'tmp フォルダはゴミ箱に入っています。');
      }
      var taken = {};
      if (rs[1].ok) {
        var files = rs[1].json().files || [];
        for (var i = 0; i < files.length; i++) taken[files[i].name] = true;
      }
      var name = base + '.' + ext;
      for (var n = 2; n <= 50 && taken[name]; n++) name = base + '-' + n + '.' + ext;

      var created = fetchAll_([req_('files', { supportsAllDrives: true, fields: ENTRY_FIELDS }, {
        method: 'post',
        payload: JSON.stringify({ name: name, parents: [tmp.id], mimeType: mime }),
        contentType: 'application/json'
      })])[0];
      if (!created.ok) {
        if (created.code === 404) throw driveErr_(created, 'フォルダ');
        throw appError_(
          'FORBIDDEN',
          '一時メモを作成できませんでした。一時メモの置き場所への書き込み権限を確認してください。' +
            (created.message ? '（' + created.message + '）' : '')
        );
      }
      DriveService.invalidateFolderList_(tmp.id);
      return { entry: DriveService.entryFromMeta_(created.json()), folder: tmp };
    });
  },

  /** DriveApp 経路の createTempFile_（REST が使えないときのフォールバック）。 */
  createTempFileLegacy_: function (tmp, base, ext, mime) {
    var folder;
    try {
      folder = DriveApp.getFolderById(tmp.id);
      if (folder.isTrashed()) throw appError_('NOT_FOUND', 'tmp フォルダはゴミ箱に入っています。');
    } catch (e) {
      if (e && e.appCode) throw e;
      throw appError_('NOT_FOUND', 'tmp フォルダが見つかりません。');
    }
    var name = base + '.' + ext;
    for (var i = 2; i <= 50 && DriveService.nameExistsIn_(folder, name, null); i++) {
      name = base + '-' + i + '.' + ext;
    }
    var file;
    try {
      file = folder.createFile(name, '', mime);
    } catch (e) {
      throw appError_(
        'FORBIDDEN',
        '一時メモを作成できませんでした。一時メモの置き場所への書き込み権限を確認してください。（' +
          (e && e.message ? e.message : e) + '）'
      );
    }
    DriveService.invalidateFolderList_(tmp.id);
    return { entry: DriveService.entryOf_(file), folder: tmp };
  },

  /**
   * 一時メモを保存先のフォルダへ確定させる（保存 → 改名 → 移動）。
   *
   * 3 つを 1 回の呼び出しにまとめているのは、往復を減らすためだけでなく、
   * 途中で失敗したときに「移動はできたが名前は古いまま」のような
   * 半端な状態を残さないため。名前の衝突は、何かを書き換える前に確かめる。
   *
   * @param {string} fileId
   * @param {string} destFolderId
   * @param {string} newName
   * @param {string|null} content null なら本文には触らない
   * @param {string} baseUpdatedAtIso 競合検出の基準
   * @param {boolean} force 競合を無視して上書きするか
   * @return {{entry:Object, folder:{id:string,name:string}, timestampVerified:boolean}}
   */
  promoteTempFile_: function (fileId, destFolderId, newName, content, baseUpdatedAtIso, force) {
    var id = String(fileId);
    var destId = String(destFolderId);
    var name = DriveService.validateFileName_(newName);
    DriveService.assertOpenableName_(name, '保存');
    if (!restAvailable_() || !validId_(id) || !validId_(destId)) {
      return DriveService.promoteTempFileLegacy_(fileId, destFolderId, newName, content, baseUpdatedAtIso, force);
    }

    var rs;
    try {
      // ファイルの現状・保存先フォルダ・同名チェックを並列に取る。
      rs = fetchAll_([
        metaReq_(id, ENTRY_FIELDS),
        metaReq_(destId, 'id,name,mimeType,trashed'),
        nameQueryReq_(destId, name, false)
      ]);
    } catch (e) {
      if (e && e.restFailure) {
        return DriveService.promoteTempFileLegacy_(fileId, destFolderId, newName, content, baseUpdatedAtIso, force);
      }
      throw e;
    }
    if (!rs[0].ok) throw driveErr_(rs[0], 'ファイル');
    var fileMeta = rs[0].json();
    var dest = DriveService.folderFromMetaResp_(destId, rs[1]);
    if (rs[2].ok) {
      var same = rs[2].json().files || [];
      for (var i = 0; i < same.length; i++) {
        if (same[i].id !== id) {
          throw appError_(
            'UNKNOWN',
            '「' + name + '」は既に「' + dest.name + '」にあります。別の名前にしてください。'
          );
        }
      }
    }

    var verified = true;
    if (typeof content === 'string') {
      verified = DriveService.writeText_(id, content, baseUpdatedAtIso, !!force).timestampVerified;
    }

    // 改名と移動はメタデータの PATCH 1 本。応答が新しい modifiedTime を持つので、
    // 以前のように setName 後に再取得と sleep で追いかける必要が無い。
    var from = (fileMeta.parents && fileMeta.parents[0]) || null;
    var body = {};
    var params = {};
    if (name !== fileMeta.name) body.name = name;
    if (!from || from !== dest.id) {
      params.addParents = dest.id;
      if (from) params.removeParents = from;
    }
    var finalMeta = fileMeta;
    if (body.name || params.addParents) {
      var up = fetchAll_([patchMetaReq_(id, body, params)])[0];
      if (!up.ok) {
        throw appError_(
          'FORBIDDEN',
          '保存先へ移動できませんでした。移動元と移動先の両方に編集権限が必要です。' +
            (up.message ? '（' + up.message + '）' : '')
        );
      }
      finalMeta = up.json();
    } else if (typeof content === 'string') {
      // 名前も場所も変わらないなら、書き込み後のメタデータを取り直して返す。
      var again = fetchAll_([metaReq_(id, ENTRY_FIELDS)])[0];
      if (again.ok) finalMeta = again.json();
    }

    if (from) DriveService.invalidateFolderList_(from);
    DriveService.invalidateFolderList_(dest.id);
    DriveService.saveLastSaveFolder_(dest.id, dest.name);

    var entry = DriveService.entryFromMeta_(finalMeta);
    // 改名で更新日時が進んでいるので、スナップショットの基準日時も揃える。
    DriveService.putFileSnapshot_(id, typeof content === 'string' ? {
      id: id,
      name: entry.name,
      mimeType: entry.mimeType,
      size: entry.size,
      content: content,
      updatedAtIso: entry.updatedAtIso,
      unchanged: false,
      fromCache: true
    } : null);

    return {
      entry: entry,
      folder: { id: dest.id, name: dest.name },
      timestampVerified: verified
    };
  },

  /** DriveApp 経路の promoteTempFile_（REST が使えないときのフォールバック）。 */
  promoteTempFileLegacy_: function (fileId, destFolderId, newName, content, baseUpdatedAtIso, force) {
    var file = DriveService.assertFile_(fileId);
    var dest = DriveService.assertFolder_(destFolderId);
    var name = DriveService.validateFileName_(newName);
    DriveService.assertOpenableName_(name, '保存');

    if (DriveService.nameExistsIn_(dest, name, fileId)) {
      throw appError_(
        'UNKNOWN',
        '「' + name + '」は既に「' + dest.getName() + '」にあります。別の名前にしてください。'
      );
    }

    var verified = true;
    if (typeof content === 'string') {
      verified = DriveService.writeTextLegacy_(fileId, content, baseUpdatedAtIso, !!force)
        .timestampVerified;
    }

    var beforeIso = DriveApp.getFileById(fileId).getLastUpdated().toISOString();
    var from = DriveService.parentOf_(file);
    var renamed = false;

    if (name !== file.getName()) {
      try {
        file.setName(name);
        renamed = true;
      } catch (e) {
        throw appError_(
          'FORBIDDEN',
          '名前を変更できませんでした。編集権限があるか確認してください。（' +
            (e && e.message ? e.message : e) + '）'
        );
      }
    }

    if (!from || from.getId() !== dest.getId()) {
      try {
        file.moveTo(dest);
      } catch (e) {
        throw appError_(
          'FORBIDDEN',
          '移動できませんでした。移動元と移動先の両方に編集権限が必要です。（' +
            (e && e.message ? e.message : e) + '）'
        );
      }
    }

    // setName は更新日時を変えるが、DriveApp のメタデータは少し遅れて追いつく。
    // 古い値をクライアントへ返すと、次の保存が必ず競合として弾かれる。
    if (renamed) {
      for (var attempt = 0; attempt < 3; attempt++) {
        if (DriveApp.getFileById(fileId).getLastUpdated().toISOString() !== beforeIso) break;
        verified = false;
        Utilities.sleep(250);
      }
    }

    if (from) DriveService.invalidateFolderList_(from.getId());
    DriveService.invalidateFolderList_(dest.getId());
    DriveService.saveLastSaveFolder_(dest.getId(), dest.getName());

    return {
      entry: DriveService.entryOf_(DriveApp.getFileById(fileId)),
      folder: { id: dest.getId(), name: dest.getName() },
      timestampVerified: verified
    };
  },

  /**
   * tmp に溜まった一時メモを片付ける。
   *
   * 完全削除はせずゴミ箱へ入れるだけにする（取り違えても戻せるように）。
   *  - 保存期間を過ぎたもの               … 設定（0 なら無期限）
   *  - 中身が空のまま 24 時間経過したもの … 作りかけの残骸
   *
   * @param {number} retentionDays 0 で無期限
   * @return {{trashed:number, scanned:number}}
   */
  sweepTempFiles_: function (retentionDays) {
    var id = DriveService.tmpFolderIdCached_();
    if (!id) return { trashed: 0, scanned: 0 };

    var days = Number(retentionDays);
    if (!isFinite(days) || days < 0) days = DEFAULT_TMP_RETENTION_DAYS;
    var now = Date.now();
    var expireBefore = days > 0 ? now - days * 24 * 60 * 60 * 1000 : null;

    if (!restAvailable_() || !validId_(id)) {
      return DriveService.sweepTempFilesLegacy_(id, expireBefore, now);
    }
    try {
      // 候補は files.list 1 本（size と modifiedTime を fields で取る）。
      // 以前は 1 件ごとに getLastUpdated() と getSize() を往復していた（最大 300 件）。
      var r = fetchAll_([req_('files', {
        q: "'" + id + "' in parents and trashed = false",
        // 所有者の判定に ownedByMe（マイドライブ）と lastModifyingUser.me（共有ドライブ）を取る。
        fields: 'files(id,size,modifiedTime,ownedByMe,lastModifyingUser(me))',
        pageSize: MAX_TMP_SWEEP_FILES,
        orderBy: 'modifiedTime',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      })])[0];
      // フォルダが消えている等。作り直しは次に tmp を使うときに起きる。
      if (!r.ok) return { trashed: 0, scanned: 0 };

      var files = r.json().files || [];
      var victims = [];
      for (var i = 0; i < files.length; i++) {
        if (!DriveService.isMyTempFile_(files[i])) continue;
        var updated = new Date(files[i].modifiedTime).getTime();
        var tooOld = expireBefore !== null && updated < expireBefore;
        var staleEmpty = (Number(files[i].size) || 0) === 0 && (now - updated) > TMP_EMPTY_MAX_AGE_MS;
        if (tooOld || staleEmpty) victims.push(files[i].id);
      }
      var trashed = 0;
      if (victims.length) {
        // ゴミ箱への移動は並列 PATCH。
        var rs = fetchAll_(victims.map(function (v) { return patchMetaReq_(v, { trashed: true }, null); }));
        for (var k = 0; k < rs.length; k++) if (rs[k].ok) trashed++;
      }
      if (trashed) DriveService.invalidateFolderList_(id);
      return { trashed: trashed, scanned: files.length };
    } catch (e) {
      if (e && e.restFailure) return DriveService.sweepTempFilesLegacy_(id, expireBefore, now);
      throw e;
    }
  },

  /**
   * 掃除してよい一時メモか（自分のものか）。
   *
   * tmp フォルダは名前で探して使い回すので、置き場所を共有フォルダや共有ドライブに
   * すると複数の人が同じ tmp を使う。そのとき他人の古いメモまでゴミ箱へ移さないよう、
   * マイドライブなら所有者が自分、共有ドライブ（所有者はドライブ）なら最後に
   * 書いたのが自分のものだけを対象にする。判定できないものは残す。
   *
   * @param {{ownedByMe?:boolean, lastModifyingUser?:{me?:boolean}}} f files.list の 1 件
   * @return {boolean}
   */
  isMyTempFile_: function (f) {
    if (!f) return false;
    if (f.ownedByMe === true) return true;
    return !!(f.lastModifyingUser && f.lastModifyingUser.me === true);
  },

  /** DriveApp 経路の sweepTempFiles_（REST が使えないときのフォールバック）。 */
  sweepTempFilesLegacy_: function (id, expireBefore, now) {
    var folder;
    try {
      folder = DriveApp.getFolderById(id);
      if (folder.isTrashed()) return { trashed: 0, scanned: 0 };
    } catch (e) {
      return { trashed: 0, scanned: 0 };
    }

    // DriveApp では共有ドライブの「最後に書いた人」が取れないので、所有者が自分のものだけ。
    var me = '';
    try { me = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { me = ''; }
    if (!me) return { trashed: 0, scanned: 0 };

    var it = folder.getFiles();
    var scanned = 0;
    var trashed = 0;
    while (it.hasNext() && scanned < MAX_TMP_SWEEP_FILES) {
      scanned++;
      var file = it.next();
      try {
        var owner = file.getOwner();
        if (!owner || String(owner.getEmail() || '').toLowerCase() !== me) continue;
        var updated = file.getLastUpdated().getTime();
        var tooOld = expireBefore !== null && updated < expireBefore;
        var staleEmpty = file.getSize() === 0 && (now - updated) > TMP_EMPTY_MAX_AGE_MS;
        if (tooOld || staleEmpty) {
          file.setTrashed(true);
          trashed++;
        }
      } catch (e) {
        // 1 件の失敗で全体を止めない。
      }
    }

    if (trashed) DriveService.invalidateFolderList_(id);
    return { trashed: trashed, scanned: scanned };
  },

  /**
   * 前回から一定時間が経っていれば掃除する。
   * 一時メモを作るとき／一覧を開くときにだけ呼ぶ。起動時には呼ばない
   * （起動の往復を増やさないため）。
   *
   * @param {number} retentionDays
   * @return {number} ゴミ箱へ移した件数
   */
  maybeSweepTemp_: function (retentionDays) {
    var props = PropertiesService.getUserProperties();
    var last = Number(props.getProperty(PROP_TMP_SWEPT_AT) || 0);
    if (isFinite(last) && last > 0 && Date.now() - last < TMP_SWEEP_INTERVAL_MS) return 0;

    // 先に時刻を記録する。掃除が失敗し続けても毎回走らせない。
    props.setProperty(PROP_TMP_SWEPT_AT, String(Date.now()));
    try {
      return DriveService.sweepTempFiles_(retentionDays).trashed;
    } catch (e) {
      console.warn('一時メモの掃除に失敗しました: ' + (e && e.message ? e.message : e));
      return 0;
    }
  },

  /**
   * 一時メモの置き場所（親フォルダ）を変える。
   *
   * 選ぶのは親フォルダで、実体はその下の <アプリ名> / tmp。掃除が
   * ユーザーの既存ファイルを巻き込まないよう、必ずアプリが作ったフォルダに閉じる。
   *
   * まだ一度も一時メモを使っていなければ、記録だけして実体は作らない
   * （「使うまで tmp を作らない」現状の方針をそのまま保つ）。実体があれば
   * 新しい場所に作り直し、中のファイルをそこへ移す。
   *
   * 引っ越したあとの古いフォルダは残す。移しきれなかったものがあるかもしれず、
   * 空に見えても消してよいとは限らないため（消すのは人の判断に任せる）。
   *
   * @param {string|null} parentId 親フォルダの ID。null / '' で既定（マイドライブ）へ
   * @return {{parent:({id:string,name:string}|null),
   *           folder:({id:string,name:string}|null),
   *           previousFolderId:(string|null),
   *           moved:number, failed:number, hasMore:boolean, unchanged:boolean}}
   */
  setTempFolder_: function (parentId) {
    var props = PropertiesService.getUserProperties();
    var ref = parentId ? DriveService.folderRef_(String(parentId)) : null;
    var prevParent = DriveService.tmpParentRef_();
    var prevFolderId = DriveService.tmpFolderIdCached_();
    var samePlace = (ref ? ref.id : null) === (prevParent ? prevParent.id : null);
    var pending = DriveService.tmpMoveFromList_(props.getProperty(PROP_TMP_MOVE_FROM));

    // 実体がまだ無い（一度も一時メモを使っていない）。記録だけして Drive は触らない。
    if (!prevFolderId) {
      DriveService.saveTmpParent_(ref);
      return {
        parent: ref, folder: null, previousFolderId: null,
        moved: 0, failed: 0, hasMore: false, unchanged: false
      };
    }

    // 同じ場所で、前回の移動もやり残していない。何もしない。
    if (samePlace && !pending.length) {
      return {
        parent: ref, folder: { id: prevFolderId, name: TMP_FOLDER_NAME },
        previousFolderId: prevFolderId,
        moved: 0, failed: 0, hasMore: false, unchanged: true
      };
    }

    // 同じ場所を選び直したときは「前回の続き」。新しい tmp は作らない。
    var dest = samePlace
      ? { id: prevFolderId, name: TMP_FOLDER_NAME }
      : DriveService.ensureTmpFolder_(ref);
    // 移す元は、いまの tmp と前回までの移し残しの全部（新しい順）。
    var sources = [];
    var cands = samePlace ? pending : [prevFolderId].concat(pending);
    for (var i = 0; i < cands.length; i++) {
      if (cands[i] && cands[i] !== dest.id && sources.indexOf(cands[i]) < 0) sources.push(cands[i]);
    }
    var result = {
      parent: ref, folder: dest, previousFolderId: sources[0] || null,
      moved: 0, failed: 0, hasMore: false, unchanged: false
    };

    // 先に中身を移し、動かせたことを確かめてから記録を書き換える。逆にすると、
    // 途中で落ちたときに「新しい場所を指しているのに中身は古い場所にある」状態が残る。
    // 1 回で動かす件数は全体で MAX_TMP_MOVE_FILES 程度に抑え、残りは次回に回す。
    var left = [];
    for (var j = 0; j < sources.length; j++) {
      if (result.moved + result.failed >= MAX_TMP_MOVE_FILES) {
        left.push(sources[j]);
        result.hasMore = true;
        continue;
      }
      var moved = DriveService.moveTempFiles_(sources[j], dest.id);
      result.moved += moved.moved;
      result.failed += moved.failed;
      if (moved.hasMore) result.hasMore = true;
      // 残りがあるなら、次に同じ場所を選んだときに続きから移せるよう覚えておく。
      if (moved.hasMore || moved.failed) left.push(sources[j]);
    }
    if (sources.length || pending.length) {
      try {
        if (left.length) {
          props.setProperty(PROP_TMP_MOVE_FROM, JSON.stringify(left.slice(0, MAX_TMP_MOVE_FROM)));
        } else {
          props.deleteProperty(PROP_TMP_MOVE_FROM);
        }
      } catch (e) {
        // 覚えられなくても、移せたぶんは移せている。
      }
    }

    props.setProperty(PROP_TMP_FOLDER_ID, dest.id);
    DriveService.saveTmpParent_(ref);
    return result;
  },

  /**
   * 移し残しの記録（PROP_TMP_MOVE_FROM の生の値）を ID の配列にする。
   * 以前の形式（ID 1 つの文字列）もそのまま 1 件として読む。
   * @param {string|null} raw
   * @return {Array<string>} 新しい順
   */
  tmpMoveFromList_: function (raw) {
    if (!raw) return [];
    var list = [raw];
    if (String(raw).charAt(0) === '[') {
      try {
        var parsed = JSON.parse(raw);
        list = Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        list = [];
      }
    }
    var out = [];
    for (var i = 0; i < list.length && out.length < MAX_TMP_MOVE_FROM; i++) {
      var id = list[i] == null ? '' : String(list[i]);
      if (id && validId_(id) && out.indexOf(id) < 0) out.push(id);
    }
    return out;
  },

  /**
   * フォルダ ID を検証して {id, name} にする。開けなければ例外。
   * @param {string} folderId
   * @return {{id:string, name:string}}
   */
  folderRef_: function (folderId) {
    var id = String(folderId);
    if (restAvailable_() && validId_(id)) {
      try {
        return DriveService.folderFromMetaResp_(
          id, fetchAll_([metaReq_(id, 'id,name,mimeType,trashed')])[0]);
      } catch (e) {
        if (!(e && e.restFailure)) throw e;
      }
    }
    var folder = DriveService.assertFolder_(id);
    return {
      id: folder.getId(),
      name: DriveService.displayFolderName_(folder.getId(), folder.getName())
    };
  },

  /**
   * tmp フォルダの中身を別の tmp フォルダへ移す。
   *
   * 1 件でも失敗したら止める、ということはしない（残りは移せるため）。
   * 失敗した件数だけ返し、呼び出し側が知らせる。
   *
   * @param {string} fromId
   * @param {string} toId
   * @return {{moved:number, failed:number, hasMore:boolean}}
   */
  moveTempFiles_: function (fromId, toId) {
    if (restAvailable_() && validId_(fromId) && validId_(toId)) {
      try {
        return DriveService.moveTempFilesRest_(fromId, toId);
      } catch (e) {
        if (!(e && e.restFailure)) throw e;
      }
    }
    return DriveService.moveTempFilesLegacy_(fromId, toId);
  },

  /** REST 経路の moveTempFiles_。移動は並列 PATCH（addParents / removeParents）。 */
  moveTempFilesRest_: function (fromId, toId) {
    var listed = fetchAll_([req_('files', {
      q: "'" + fromId + "' in parents and trashed = false",
      fields: 'nextPageToken,files(id)',
      pageSize: MAX_TMP_MOVE_FILES,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    })])[0];
    // 古いフォルダが消えている等。移すものが無いのと同じ扱いでよい。
    if (!listed.ok) return { moved: 0, failed: 0, hasMore: false };

    var json = listed.json();
    var files = json.files || [];
    var ids = [];
    for (var i = 0; i < files.length; i++) ids.push(files[i].id);

    var moved = 0;
    var failed = 0;
    var groups = chunk_(ids, MAX_FETCH_ALL);
    for (var g = 0; g < groups.length; g++) {
      var reqs = [];
      for (var k = 0; k < groups[g].length; k++) {
        reqs.push(patchMetaReq_(groups[g][k], {}, {
          addParents: toId, removeParents: fromId
        }));
      }
      var rs = fetchAll_(reqs);
      for (var r = 0; r < rs.length; r++) {
        if (rs[r].ok) moved++;
        else failed++;
      }
    }

    if (moved) {
      DriveService.invalidateFolderList_(fromId);
      DriveService.invalidateFolderList_(toId);
    }
    return { moved: moved, failed: failed, hasMore: !!json.nextPageToken };
  },

  /** DriveApp 経路の moveTempFiles_（REST が使えないときのフォールバック）。 */
  moveTempFilesLegacy_: function (fromId, toId) {
    var from;
    var to;
    try {
      from = DriveApp.getFolderById(fromId);
      to = DriveApp.getFolderById(toId);
    } catch (e) {
      return { moved: 0, failed: 0, hasMore: false };
    }

    // 移しながら列挙すると、イテレータが途中の要素を飛ばすことがある。
    // 先に ID を全部取ってから動かす。
    var it = from.getFiles();
    var files = [];
    while (it.hasNext() && files.length < MAX_TMP_MOVE_FILES) files.push(it.next());
    var hasMore = it.hasNext();

    var moved = 0;
    var failed = 0;
    for (var i = 0; i < files.length; i++) {
      try {
        files[i].moveTo(to);
        moved++;
      } catch (e) {
        failed++;
      }
    }

    if (moved) {
      DriveService.invalidateFolderList_(fromId);
      DriveService.invalidateFolderList_(toId);
    }
    return { moved: moved, failed: failed, hasMore: hasMore };
  },

  /**
   * フォルダの参照（生 JSON → {id, name}）。
   * 一時メモの保存先として最後に選んだフォルダ（保存ダイアログの初期値。
   * 同じ場所へ続けて保存することが多いため）と、一時メモの置き場所に使う。
   */
  parseFolderRefRaw_: function (raw) {
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.id) return null;
      return { id: String(parsed.id), name: String(parsed.name || '') };
    } catch (e) {
      return null;
    }
  },

  /**
   * @param {string} id
   * @param {string} name
   */
  saveLastSaveFolder_: function (id, name) {
    try {
      PropertiesService.getUserProperties().setProperty(
        PROP_LAST_SAVE_FOLDER,
        JSON.stringify({ id: String(id), name: String(name || '').slice(0, 120) })
      );
    } catch (e) {
      // 覚えられなくても保存そのものは成功している。
    }
  }
});
