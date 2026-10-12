/**
 * DriveServiceSearch.gs — DriveService のうち 全体検索とリビジョン履歴。
 *
 * DriveService は 1 つのオブジェクトだが、長いので機能ごとのファイルに分けて足している。
 * GAS は全ファイルを 1 つのグローバルに読み込み、読み込む順は決められないので、
 * どのファイルも「無ければ作る」形にしてある（呼ばれるのは全ファイルを読み終えた後）。
 */

var DriveService = DriveService || {};

Object.assign(DriveService, {

  /* ------------------------------------------------------------------ *
   *  全体検索
   * ------------------------------------------------------------------ */

  /**
   * ルート配下のテキストファイルの中身を検索する。
   *
   * 二段構えにしている。
   *  1. Drive の全文索引（fullText contains）で候補ファイルを絞る（配下のフォルダを先に列挙して親に入れる）
   *  2. 候補のうち上位だけ本文を取り、一致行と行番号を組み立てる
   *
   * 全ファイルを読んで検索すると往復もダウンロード量も跳ねるので、
   * 候補の絞り込みは Drive 側の索引に任せる。
   * そのため以下の制約がある（docs/architecture.md の「全体検索」に明記）:
   *  - 索引の反映が遅れるので、保存直後の内容は見つからないことがある
   *  - 正規表現は使えない（索引は語単位の一致）
   *
   * @param {string} query
   * @param {Array<string>} rootIds
   * @param {{caseSensitive:boolean}} opts
   * @return {{query:string, files:Array, candidates:number, truncated:boolean, indexed:boolean}}
   */
  searchContents_: function (query, rootIds, opts) {
    var q = String(query || '').trim();
    if (q.length < 2) {
      throw appError_('UNKNOWN', '検索語は 2 文字以上で入力してください。');
    }
    if (q.length > MAX_SEARCH_QUERY) {
      throw appError_('UNKNOWN', '検索語は ' + MAX_SEARCH_QUERY + ' 文字以内で入力してください。');
    }
    if (!restAvailable_() && !DriveService.hasAdvancedDrive_()) {
      throw appError_(
        'UNKNOWN',
        '全体検索には Drive の拡張サービスが必要です。appsscript.json の ' +
          'enabledAdvancedServices を確認してください。'
      );
    }

    var roots = [];
    var srcRoots = Array.isArray(rootIds) ? rootIds : [];
    for (var i = 0; i < srcRoots.length; i++) {
      if (validId_(srcRoots[i])) roots.push(String(srcRoots[i]));
    }
    if (!roots.length) {
      return {
        query: q, files: [], candidates: 0, truncated: false, indexed: true,
        folders: 0, scopePartial: false
      };
    }

    // Drive の `X in parents` は直下しか見ない。ルート ID だけを条件にすると
    // ルート直下のファイルしか当たらず、1 段でも掘った先は永久に出てこない。
    // 検索の前に配下のフォルダを列挙して、全部を親の候補に入れる。
    var scope = DriveService.searchFolderIds_(roots);

    // fullText contains の引数はシングルクォートで囲むので、中のクォートを潰す。
    var escaped = escQ_(q);
    var candidates = DriveService.searchCandidates_(escaped, scope.ids);

    var needle = opts && opts.caseSensitive ? q : q.toLowerCase();

    // 親を分割して集めたので、Drive が返した順はあてにならない。更新の新しい順に並べ、
    // 同じファイルが複数のリクエストに現れた場合（複数の親を持つファイル）はまとめる。
    candidates.sort(function (a, b) {
      var x = String(a.modifiedTime || '');
      var y = String(b.modifiedTime || '');
      return x < y ? 1 : (x > y ? -1 : 0);   // ISO8601 なので文字列比較で新しい順になる
    });

    // 開けるもの（テキストで上限内）を先頭から MAX_SEARCH_FILES 件だけ本文を読む。
    var targets = [];
    var picked = {};
    for (var c = 0; c < candidates.length && targets.length < MAX_SEARCH_FILES; c++) {
      if (picked[candidates[c].id]) continue;
      picked[candidates[c].id] = true;
      var entry = DriveService.entryFromMeta_(candidates[c]);
      if (entry.viewer === 'editor') targets.push(entry);
    }
    // 以前は 1 件ずつ readText_ を直列に呼んでいた（30 件で 8〜20 秒）。まとめて並列に取る。
    var bodies = DriveService.readBodies_(targets.map(function (t) { return t.id; }));

    var out = [];
    for (var i = 0; i < targets.length; i++) {
      var content = bodies[i];
      if (content === null || content === undefined) continue;

      var lines = content.split('\n');
      var hits = [];
      for (var L = 0; L < lines.length && hits.length < MAX_SEARCH_HITS_PER_FILE; L++) {
        var line = lines[L];
        var hay = (opts && opts.caseSensitive) ? line : line.toLowerCase();
        var at = hay.indexOf(needle);
        if (at < 0) continue;
        hits.push({
          line: L + 1,
          column: at + 1,
          // 長い行はそのまま返さず、一致箇所の周辺だけに切る。
          text: line.length > 200 ? line.slice(Math.max(0, at - 60), at + 140) : line
        });
      }
      if (hits.length) out.push({ entry: targets[i], hits: hits });
    }

    return {
      query: q,
      files: out,
      candidates: candidates.length,
      truncated: candidates.length > targets.length,
      indexed: true,
      folders: scope.ids.length,
      scopePartial: scope.partial
    };
  },

  /**
   * ルート配下のフォルダ ID を、ルート自身も含めて集める。
   *
   * Drive の検索は `X in parents`（直下のみ）しか持たず、「配下すべて」を
   * 表す条件が無い。そのため階層を 1 段ずつ広げて ID を集める。段ごとに
   * まとめて問い合わせるので、往復は「フォルダ数」ではなく「深さ」で決まる。
   *
   * 深さ・総数に上限を置き、打ち切ったときは partial=true で返す
   * （呼び出し側が「範囲の一部だけを見た」ことを表示できるように）。
   *
   * @param {Array<string>} rootIds
   * @return {{ids:Array<string>, partial:boolean}}
   */
  searchFolderIds_: function (rootIds) {
    var all = [];
    var seen = {};
    for (var i = 0; i < rootIds.length; i++) {
      if (seen[rootIds[i]]) continue;
      seen[rootIds[i]] = true;
      all.push(rootIds[i]);
    }

    var frontier = all.slice();
    var depth = 0;
    var partial = false;
    // 件数と深さの上限に加えて、時間でも打ち切る（GAS の実行時間 6 分に近づけない。
    // 本文の取得と照合がこのあとに続くので、列挙に使うのはその一部だけ）。
    var deadline = Date.now() + SEARCH_FOLDER_BUDGET_MS;

    while (frontier.length && depth < MAX_SEARCH_DEPTH) {
      if (Date.now() > deadline) { partial = true; break; }
      var children = DriveService.childFolderIds_(frontier);
      var next = [];
      for (var c = 0; c < children.length; c++) {
        var id = children[c];
        if (seen[id]) continue;
        if (all.length >= MAX_SEARCH_FOLDERS) { partial = true; break; }
        seen[id] = true;
        all.push(id);
        next.push(id);
      }
      if (partial) break;
      frontier = next;
      depth++;
    }
    // 上限で止めたせいで、まだ見ていない段が残っている。
    if (frontier.length) partial = true;

    return { ids: all, partial: partial };
  },

  /**
   * 複数フォルダの「直下にあるフォルダ」の ID を 1 段ぶんまとめて取る。
   * @param {Array<string>} parentIds
   * @return {Array<string>}
   */
  childFolderIds_: function (parentIds) {
    var out = [];
    if (!parentIds.length) return out;

    var groups = [];
    for (var i = 0; i < parentIds.length; i += MAX_PARENTS_PER_LIST_REQ) {
      groups.push(parentIds.slice(i, i + MAX_PARENTS_PER_LIST_REQ));
    }

    if (restAvailable_()) {
      try {
        // 1 段ぶんをまとめて並列に投げる。1 フォルダの直下に 1000 を超える
        // サブフォルダがある構成は想定しない（ページングは追いかけない）。
        var rs = fetchAll_(groups.map(function (g) { return listReq_(g, null, true); }));
        for (var r = 0; r < rs.length; r++) {
          if (!rs[r].ok) continue;   // 読めない枝は飛ばす（検索そのものは続ける）
          var files = rs[r].json().files || [];
          for (var f = 0; f < files.length; f++) out.push(files[f].id);
        }
        return out;
      } catch (e) {
        if (!(e && e.restFailure)) throw e;
        out.length = 0;   // REST 経路の取りこぼしを残さない
      }
    }

    if (!DriveService.hasAdvancedDrive_()) return out;

    for (var g = 0; g < groups.length; g++) {
      var clauses = [];
      for (var k = 0; k < groups[g].length; k++) clauses.push("'" + groups[g][k] + "' in parents");
      try {
        var res = Drive.Files.list({
          q: "mimeType = '" + FOLDER_MIME + "' and trashed = false and (" + clauses.join(' or ') + ')',
          fields: 'files(id)',
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true
        });
        var items = res.files || [];
        for (var m = 0; m < items.length; m++) out.push(items[m].id);
      } catch (e2) {
        // 読めない枝は飛ばす。
      }
    }
    return out;
  },

  /**
   * 全文索引で候補ファイルを集める。親フォルダが多いと 1 本の q に入り切らないので
   * 分割して投げ、REST が使えるならまとめて並列にする。
   *
   * @param {string} escaped クォートを潰した検索語
   * @param {Array<string>} folderIds 対象フォルダ（ルートと配下）
   * @return {Array<Object>} files.list のメタデータ
   */
  searchCandidates_: function (escaped, folderIds) {
    var out = [];
    if (!folderIds.length) return out;

    // URL は 2,082 文字まで。内訳はおおよそ
    //   固定部分（fields・pageSize など）245 + 親 1 つ 65 + 検索語
    // なので、検索語が食うぶんを引いた残りで 1 本に載せる親の数を決める。
    var budget = 1750 - encodeURIComponent(escaped).length;
    var perReq = Math.max(1, Math.min(MAX_PARENTS_PER_SEARCH_REQ, Math.floor(budget / 65)));

    var groups = [];
    for (var i = 0; i < folderIds.length; i += perReq) {
      groups.push(folderIds.slice(i, i + perReq));
    }

    if (restAvailable_()) {
      try {
        // 1 ラウンド = 全グループを並列。次ページが要るグループだけ次のラウンドへ回す。
        var pending = groups.map(function (g) { return { parents: g, token: null }; });
        var round = 0;
        while (pending.length && round < 3) {
          var rs = fetchAll_(pending.map(function (p) {
            return searchReq_(escaped, p.parents, p.token);
          }));
          var next = [];
          for (var r = 0; r < rs.length; r++) {
            if (!rs[r].ok) continue;
            var body = rs[r].json();
            var files = body.files || [];
            for (var f = 0; f < files.length; f++) out.push(files[f]);
            if (body.nextPageToken) {
              next.push({ parents: pending[r].parents, token: body.nextPageToken });
            }
          }
          pending = next;
          round++;
        }
        return out;
      } catch (e) {
        if (!(e && e.restFailure)) throw e;
        out.length = 0;
      }
    }

    if (!DriveService.hasAdvancedDrive_()) return out;

    for (var g = 0; g < groups.length; g++) {
      var clauses = [];
      for (var k = 0; k < groups[g].length; k++) clauses.push("'" + groups[g][k] + "' in parents");
      var pageToken = null;
      var pages = 0;
      do {
        var res = Drive.Files.list({
          q: "fullText contains '" + escaped + "' and trashed = false and (" +
            clauses.join(' or ') + ')',
          fields: 'nextPageToken, files(id,name,mimeType,size,modifiedTime,parents)',
          pageSize: 100,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          pageToken: pageToken
        });
        var items = res.files || [];
        for (var n = 0; n < items.length; n++) out.push(items[n]);
        pageToken = res.nextPageToken;
        pages++;
      } while (pageToken && pages < 3);
    }
    return out;
  },

  /**
   * 複数ファイルの本文だけを並列に取る（全体検索用）。読めなかったものは null。
   * @param {Array<string>} ids
   * @return {Array<string|null>} ids と同じ順
   */
  readBodies_: function (ids) {
    var out = [];
    if (!ids.length) return out;
    if (restAvailable_()) {
      try {
        var rs = fetchAll_(ids.map(function (id) { return mediaReq_(id); }));
        for (var i = 0; i < rs.length; i++) {
          out.push(rs[i].ok ? DriveService.stripBom_(rs[i].decoded().text) : null);
        }
        return out;
      } catch (e) {
        if (!(e && e.restFailure)) throw e;
      }
    }
    for (var j = 0; j < ids.length; j++) {
      try {
        out.push(DriveService.readTextLegacy_(ids[j]).content);
      } catch (e2) {
        out.push(null);
      }
    }
    return out;
  },

  /* ------------------------------------------------------------------ *
   *  リビジョン履歴
   * ------------------------------------------------------------------ */

  /**
   * ファイルの過去のリビジョンを一覧する。
   * Drive が保持している版なので、このエディタのセッションを超えて戻せる。
   *
   * @param {string} fileId
   * @return {{revisions:Array<{id:string, modifiedTime:string, size:number,
   *           lastModifyingUser:(string|null), keepForever:boolean}>}}
   */
  listRevisions_: function (fileId) {
    DriveService.assertFile_(fileId);
    if (!DriveService.hasAdvancedDrive_()) {
      throw appError_(
        'UNKNOWN',
        '変更履歴には Drive の拡張サービスが必要です。appsscript.json の ' +
          'enabledAdvancedServices を確認してください。'
      );
    }

    // Drive は古い順に返す。1 ページだけだと、版が多いファイルで新しい版が丸ごと欠けるので、
    // 最後のページまで追ってから新しい側を MAX_REVISIONS 件だけ返す。
    var list = [];
    try {
      var pageToken = null;
      var pages = 0;
      do {
        var res = Drive.Revisions.list(fileId, {
          fields: 'nextPageToken,revisions(id,modifiedTime,size,keepForever,lastModifyingUser(displayName))',
          pageSize: 1000,
          pageToken: pageToken
        });
        list = list.concat((res && res.revisions) || []);
        pageToken = res && res.nextPageToken;
        pages++;
      } while (pageToken && pages < MAX_REVISION_PAGES);
    } catch (e) {
      throw appError_(
        'FORBIDDEN',
        'このファイルの変更履歴を取得できませんでした。' +
          '共有ドライブや権限の設定によっては参照できないことがあります。（' +
          (e && e.message ? e.message : e) + '）'
      );
    }

    var out = [];
    for (var i = list.length - 1; i >= 0 && out.length < MAX_REVISIONS; i--) {   // 新しい順にする
      var rev = list[i];
      out.push({
        id: String(rev.id),
        modifiedTime: rev.modifiedTime,
        size: Number(rev.size || 0),
        keepForever: !!rev.keepForever,
        lastModifyingUser: (rev.lastModifyingUser && rev.lastModifyingUser.displayName) || null
      });
    }
    return { revisions: out };
  },

  /**
   * 指定リビジョンの本文を取得する。
   *
   * 復元はしない。中身を返してエディタに載せるだけにしてある。
   * その状態で保存すれば結果的に復元になるし、競合検出も通常どおり働く。
   *
   * @param {string} fileId
   * @param {string} revisionId
   * @return {{content:string, encoding:string}}
   */
  readRevision_: function (fileId, revisionId) {
    DriveService.assertFile_(fileId);
    if (!DriveService.hasAdvancedDrive_()) {
      throw appError_('UNKNOWN', '変更履歴には Drive の拡張サービスが必要です。');
    }

    // 本文より先に大きさを確かめる（通常の読み込みと同じ 5MB の上限）。
    var rev = null;
    try {
      rev = Drive.Revisions.get(fileId, revisionId, { fields: 'id,size' });
    } catch (e0) {
      rev = null;   // 取れなければ本文の取得で同じエラーになるので、そちらに任せる
    }
    if (rev && Number(rev.size) > MAX_FILE_SIZE_BYTES) {
      throw appError_('TOO_LARGE', 'このリビジョンは上限（5MB）を超えているため読み込めません（' +
        DriveService.formatBytes_(Number(rev.size)) + '）。');
    }

    var blob;
    try {
      blob = Drive.Revisions.get(fileId, revisionId, { alt: 'media' });
    } catch (e) {
      throw appError_(
        'UNKNOWN',
        'このリビジョンの内容を取得できませんでした。（' +
          (e && e.message ? e.message : e) + '）'
      );
    }

    var dec;
    try {
      dec = decodeText_(blob);
    } catch (e2) {
      throw appError_('UNKNOWN', 'このリビジョンをテキストとして読み込めませんでした。');
    }

    return { content: DriveService.stripBom_(dec.text), encoding: dec.encoding };
  }
});
