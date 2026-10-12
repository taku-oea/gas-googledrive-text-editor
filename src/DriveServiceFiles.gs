/**
 * DriveServiceFiles.gs — DriveService のうち 作成・改名・移動・複製・アップロード・ゴミ箱。
 *
 * DriveService は 1 つのオブジェクトだが、長いので機能ごとのファイルに分けて足している。
 * GAS は全ファイルを 1 つのグローバルに読み込み、読み込む順は決められないので、
 * どのファイルも「無ければ作る」形にしてある（呼ばれるのは全ファイルを読み終えた後）。
 */

var DriveService = DriveService || {};

Object.assign(DriveService, {

  /* ------------------------------------------------------------------ *
   *  作成・リネーム・削除
   * ------------------------------------------------------------------ */

  /**
   * ファイル名を検証して整形する。
   * @param {string} name
   * @return {string}
   */
  validateFileName_: function (name) {
    var trimmed = String(name == null ? '' : name).trim();
    if (!trimmed) {
      throw appError_('NOT_FOUND', 'ファイル名を入力してください。');
    }
    if (trimmed.length > 255) {
      throw appError_('UNKNOWN', 'ファイル名が長すぎます（255 文字以内にしてください）。');
    }
    if (trimmed.indexOf('/') >= 0 || trimmed.indexOf('\\') >= 0) {
      throw appError_('UNKNOWN', 'ファイル名に / や \\ は使えません。');
    }
    if (trimmed === '.' || trimmed === '..') {
      throw appError_('UNKNOWN', 'そのファイル名は使えません。');
    }
    return trimmed;
  },

  /**
   * このエディタで開ける拡張子か検証する。
   * 開けない名前で作成／リネームすると一覧でグレー表示になるだけなので、事前に止める。
   * @param {string} name
   * @param {string} action エラーメッセージ用の動作名
   */
  assertOpenableName_: function (name, action) {
    var ext = DriveService.extensionOf_(name);
    if (!TEXT_EXTENSIONS[ext]) {
      throw appError_(
        'NOT_TEXT',
        '「' + name + '」はこのエディタで開ける拡張子ではないため、' + action + 'を中止しました。' +
          '（.txt .md .js .json .html .css .py .sh .yml .sql など）'
      );
    }
  },

  /**
   * 同じフォルダに同名ファイルがあるか。Drive は同名を許すが、
   * エディタとしては取り違えの元なので事前に弾く。
   * @param {GoogleAppsScript.Drive.Folder} folder
   * @param {string} name
   * @param {string|null} exceptFileId 自分自身は除外する
   * @return {boolean}
   */
  nameExistsIn_: function (folder, name, exceptFileId) {
    var it = folder.getFilesByName(name);
    while (it.hasNext()) {
      var f = it.next();
      if (!exceptFileId || f.getId() !== exceptFileId) return true;
    }
    return false;
  },

  /**
   * 同名チェックを files.list 1 本で行う。
   * DriveApp の getFilesByName はイテレータで 1 件ずつ往復するため、REST で置き換えた。
   * REST が使えないときは DriveApp 経路に落ちる。
   *
   * @param {string} folderId
   * @param {string} name
   * @param {string|null} exceptId 自分自身は除外する
   * @param {boolean} foldersOnly フォルダ同士の同名だけ見る
   * @return {boolean}
   */
  nameExistsById_: function (folderId, name, exceptId, foldersOnly) {
    var id = String(folderId);
    if (restAvailable_() && validId_(id)) {
      try {
        var r = fetchAll_([nameQueryReq_(id, name, !!foldersOnly)])[0];
        if (r.ok) {
          var files = r.json().files || [];
          for (var i = 0; i < files.length; i++) {
            if (!exceptId || files[i].id !== exceptId) return true;
          }
        }
        // 403 / 404 は「見えない」= 同名の判定ができない。続く操作で改めてエラーになる。
        return false;
      } catch (e) {
        if (!(e && e.restFailure)) throw e;
      }
    }
    var folder = DriveApp.getFolderById(id);
    if (foldersOnly) {
      var it = folder.getFoldersByName(name);
      while (it.hasNext()) {
        if (it.next().getId() !== exceptId) return true;
      }
      return false;
    }
    return DriveService.nameExistsIn_(folder, name, exceptId);
  },

  /**
   * 「name のコピー」「name のコピー 2」… と空いている名前を探す（REST 版）。
   * 候補ごとに name = '<候補>' で問い合わせ、数本ずつ並列に投げる。
   * フォルダの中身を一覧して突き合わせると、1 ページ（1,000 件）を超える
   * 大きなフォルダで見落として同名を作ってしまうため。
   *
   * @param {string} folderId
   * @param {string} original
   * @return {string}
   */
  uniqueCopyNameById_: function (folderId, original) {
    var id = String(folderId);
    var dot = original.lastIndexOf('.');
    var base = dot > 0 ? original.slice(0, dot) : original;
    var ext = dot > 0 ? original.slice(dot) : '';
    var candidates = [];
    for (var n = 1; n <= 50; n++) {
      candidates.push(base + ' のコピー' + (n === 1 ? '' : ' ' + n) + ext);
    }

    var usable = restAvailable_() && validId_(id);
    if (usable) {
      try {
        // ほとんどは最初の数本で空きが見つかるので、少しずつ問い合わせる。
        var groups = chunk_(candidates, 5);
        for (var g = 0; g < groups.length && usable; g++) {
          var rs = fetchAll_(groups[g].map(function (c) { return nameQueryReq_(id, c, false); }));
          for (var i = 0; i < rs.length; i++) {
            // 確かめられなかった候補があれば、順番が崩れるので DriveApp で数え直す。
            if (!rs[i].ok) { usable = false; break; }
            if (!(rs[i].json().files || []).length) return groups[g][i];
          }
        }
        if (usable) return base + ' のコピー ' + new Date().getTime() + ext;
      } catch (e) {
        if (!(e && e.restFailure)) throw e;
      }
    }
    return DriveService.uniqueCopyName_(DriveApp.getFolderById(id), original);
  },

  /**
   * ファイルの親フォルダを 1 つ返す（取れなければ null）。
   * @param {GoogleAppsScript.Drive.File} file
   * @return {GoogleAppsScript.Drive.Folder|null}
   */
  parentOf_: function (file) {
    try {
      var parents = file.getParents();
      return parents.hasNext() ? parents.next() : null;
    } catch (e) {
      return null;
    }
  },

  /**
   * 空のテキストファイルを作る。
   * @param {string} folderId
   * @param {string} name
   * @return {Object} entryOf_ と同じ形
   */
  createTextFile_: function (folderId, name) {
    var folder = DriveService.assertFolder_(folderId);
    var fileName = DriveService.validateFileName_(name);
    DriveService.assertOpenableName_(fileName, '作成');

    if (DriveService.nameExistsById_(folder.getId(), fileName, null, false)) {
      throw appError_('UNKNOWN', '「' + fileName + '」は既にこのフォルダにあります。');
    }

    var ext = DriveService.extensionOf_(fileName);
    var mime = MIME_BY_EXTENSION[ext] || 'text/plain';

    var file;
    try {
      file = folder.createFile(fileName, '', mime);
    } catch (e) {
      throw appError_(
        'FORBIDDEN',
        'ファイルを作成できませんでした。このフォルダへの編集権限があるか確認してください。（' +
          (e && e.message ? e.message : e) + '）'
      );
    }

    DriveService.invalidateFolderList_(folderId);
    return DriveService.entryOf_(file);
  },

  /**
   * ファイル名を変更する。
   * 改名は更新日時も変えるので、戻り値の updatedAtIso で
   * クライアント側の競合検出の基準値を必ず差し替えること。
   *
   * REST が使えるときはメタデータの PATCH 1 本で改名し、応答の modifiedTime を返す。
   * setName 直後の getLastUpdated は古い値を返すことがあり、次の保存が
   * 偽の CONFLICT になるため（DriveApp は REST が使えないときのフォールバック）。
   * @param {string} fileId
   * @param {string} newName
   * @return {Object} entryOf_ と同じ形
   */
  renameFile_: function (fileId, newName) {
    var file = DriveService.assertFile_(fileId);
    var name = DriveService.validateFileName_(newName);
    if (name === file.getName()) return DriveService.entryOf_(file);

    DriveService.assertOpenableName_(name, '名前の変更');

    var parent = DriveService.parentOf_(file);
    if (parent && DriveService.nameExistsById_(parent.getId(), name, fileId, false)) {
      throw appError_('UNKNOWN', '「' + name + '」は既に同じフォルダにあります。');
    }

    // 本文のスナップショットは改名前の更新日時を持っているので捨てる。
    DriveService.putFileSnapshot_(fileId, null);

    var id = String(fileId);
    if (restAvailable_() && validId_(id)) {
      try {
        var up = fetchAll_([patchMetaReq_(id, { name: name }, null)])[0];
        if (!up.ok) {
          throw appError_(
            'FORBIDDEN',
            '名前を変更できませんでした。編集権限があるか確認してください。' +
              (up.message ? '（' + up.message + '）' : '')
          );
        }
        if (parent) DriveService.invalidateFolderList_(parent.getId());
        return DriveService.entryFromMeta_(up.json());
      } catch (e) {
        if (!(e && e.restFailure)) throw e;
      }
    }

    try {
      file.setName(name);
    } catch (e) {
      throw appError_(
        'FORBIDDEN',
        '名前を変更できませんでした。編集権限があるか確認してください。（' +
          (e && e.message ? e.message : e) + '）'
      );
    }

    if (parent) DriveService.invalidateFolderList_(parent.getId());
    return DriveService.entryOf_(DriveApp.getFileById(fileId));
  },

  /**
   * フォルダの名前を変更する。
   * @param {string} folderId
   * @param {string} newName
   * @return {{id:string, name:string}}
   */
  renameFolder_: function (folderId, newName) {
    var folder = DriveService.assertFolder_(folderId);
    var name = DriveService.validateFileName_(newName);
    if (name === folder.getName()) return { id: folder.getId(), name: name };

    var parent = null;
    try {
      var parents = folder.getParents();
      if (parents.hasNext()) parent = parents.next();
    } catch (e) {
      parent = null;
    }
    // 以前は兄弟フォルダを全部走査して getName() を 1 件ずつ呼んでいた。
    if (parent && DriveService.nameExistsById_(parent.getId(), name, folderId, true)) {
      throw appError_('UNKNOWN', '「' + name + '」は既に同じ階層にあります。');
    }

    try {
      folder.setName(name);
    } catch (e) {
      throw appError_(
        'FORBIDDEN',
        'フォルダ名を変更できませんでした。編集権限があるか確認してください。（' +
          (e && e.message ? e.message : e) + '）'
      );
    }

    if (parent) DriveService.invalidateFolderList_(parent.getId());
    return { id: folderId, name: name };
  },

  /**
   * フォルダをゴミ箱へ移動する。中身ごと入るが、Drive のゴミ箱から復元できる。
   * @param {string} folderId
   * @return {{id:string, name:string}}
   */
  trashFolder_: function (folderId) {
    var folder = DriveService.assertFolder_(folderId);
    var name = folder.getName();

    var parent = null;
    try {
      var parents = folder.getParents();
      if (parents.hasNext()) parent = parents.next();
    } catch (e) {
      parent = null;
    }

    try {
      folder.setTrashed(true);
    } catch (e) {
      throw appError_(
        'FORBIDDEN',
        'フォルダをゴミ箱へ移動できませんでした。編集権限があるか確認してください。（' +
          (e && e.message ? e.message : e) + '）'
      );
    }

    if (parent) DriveService.invalidateFolderList_(parent.getId());
    return { id: folderId, name: name };
  },

  /**
   * ファイルを複製する。
   * @param {string} fileId
   * @param {string} destFolderId 複製先フォルダ
   * @param {string} [newName] 省略時は「元の名前 のコピー」
   * @return {Object} entryOf_ と同じ形
   */
  copyFile_: function (fileId, destFolderId, newName) {
    var file = DriveService.assertFile_(fileId);
    var dest = DriveService.assertFolder_(destFolderId);

    var name = newName
      ? DriveService.validateFileName_(newName)
      : DriveService.uniqueCopyNameById_(dest.getId(), file.getName());

    if (DriveService.nameExistsById_(dest.getId(), name, null, false)) {
      throw appError_('UNKNOWN', '「' + name + '」は既に「' + dest.getName() + '」にあります。');
    }

    var copy;
    try {
      copy = file.makeCopy(name, dest);
    } catch (e) {
      throw appError_(
        'FORBIDDEN',
        'コピーを作成できませんでした。コピー先への編集権限があるか確認してください。（' +
          (e && e.message ? e.message : e) + '）'
      );
    }

    DriveService.invalidateFolderList_(destFolderId);
    return DriveService.entryOf_(copy);
  },

  /**
   * 「name のコピー」「name のコピー 2」… と空いている名前を探す。
   * 拡張子の手前に入れるので「memo のコピー.md」になる。
   * @param {GoogleAppsScript.Drive.Folder} folder
   * @param {string} original
   * @return {string}
   */
  uniqueCopyName_: function (folder, original) {
    var dot = original.lastIndexOf('.');
    var base = dot > 0 ? original.slice(0, dot) : original;
    var ext = dot > 0 ? original.slice(dot) : '';

    for (var i = 1; i <= 50; i++) {
      var candidate = base + ' のコピー' + (i === 1 ? '' : ' ' + i) + ext;
      if (!DriveService.nameExistsIn_(folder, candidate, null)) return candidate;
    }
    return base + ' のコピー ' + new Date().getTime() + ext;
  },

  /**
   * ファイルを別のフォルダへ移動する。
   * @param {string} fileId
   * @param {string} destFolderId
   * @return {Object} entryOf_ と同じ形
   */
  moveFile_: function (fileId, destFolderId) {
    var file = DriveService.assertFile_(fileId);
    var dest = DriveService.assertFolder_(destFolderId);

    var current = DriveService.parentOf_(file);
    if (current && current.getId() === dest.getId()) {
      return DriveService.entryOf_(file);   // 同じ場所。何もしない
    }
    if (DriveService.nameExistsById_(dest.getId(), file.getName(), fileId, false)) {
      throw appError_('UNKNOWN',
        '「' + file.getName() + '」は既に「' + dest.getName() + '」にあります。');
    }

    try {
      file.moveTo(dest);
    } catch (e) {
      throw appError_(
        'FORBIDDEN',
        '移動できませんでした。移動元と移動先の両方に編集権限が必要です。（' +
          (e && e.message ? e.message : e) + '）'
      );
    }

    if (current) DriveService.invalidateFolderList_(current.getId());
    DriveService.invalidateFolderList_(destFolderId);
    return DriveService.entryOf_(DriveApp.getFileById(fileId));
  },

  /**
   * フォルダを別のフォルダへ移動する。
   * 自分自身や自分の子孫へは移動できない（無限ループになるため）。
   * @param {string} folderId
   * @param {string} destFolderId
   * @return {{id:string, name:string}}
   */
  moveFolder_: function (folderId, destFolderId) {
    var folder = DriveService.assertFolder_(folderId);
    var dest = DriveService.assertFolder_(destFolderId);

    if (folder.getId() === dest.getId()) {
      throw appError_('UNKNOWN', 'フォルダを自分自身の中へは移動できません。');
    }
    if (DriveService.isDescendantOf_(dest, folder.getId())) {
      throw appError_('UNKNOWN', 'フォルダを自分の下の階層へは移動できません。');
    }

    var current = DriveService.parentOf_(folder);
    if (current && current.getId() === dest.getId()) {
      return { id: folder.getId(), name: folder.getName() };
    }

    try {
      folder.moveTo(dest);
    } catch (e) {
      throw appError_(
        'FORBIDDEN',
        'フォルダを移動できませんでした。移動元と移動先の両方に編集権限が必要です。（' +
          (e && e.message ? e.message : e) + '）'
      );
    }

    if (current) DriveService.invalidateFolderList_(current.getId());
    DriveService.invalidateFolderList_(destFolderId);
    return { id: folder.getId(), name: folder.getName() };
  },

  /**
   * candidate が ancestorId の子孫かどうか。親を遡って判定する。
   * @param {GoogleAppsScript.Drive.Folder} candidate
   * @param {string} ancestorId
   * @return {boolean}
   */
  isDescendantOf_: function (candidate, ancestorId) {
    var current = candidate;
    for (var depth = 0; depth < MAX_PATH_DEPTH; depth++) {
      if (current.getId() === ancestorId) return true;
      var parent = null;
      try {
        var parents = current.getParents();
        if (!parents.hasNext()) return false;
        parent = parents.next();
      } catch (e) {
        return false;
      }
      current = parent;
    }
    return false;
  },

  /**
   * サブフォルダを作る。
   * @param {string} parentFolderId
   * @param {string} name
   * @return {{id:string, name:string}}
   */
  createFolder_: function (parentFolderId, name) {
    var parent = DriveService.assertFolder_(parentFolderId);
    var folderName = DriveService.validateFileName_(name);

    if (DriveService.nameExistsById_(parent.getId(), folderName, null, true)) {
      throw appError_('UNKNOWN', '「' + folderName + '」は既にこのフォルダにあります。');
    }

    var created;
    try {
      created = parent.createFolder(folderName);
    } catch (e) {
      throw appError_(
        'FORBIDDEN',
        'フォルダを作成できませんでした。編集権限があるか確認してください。（' +
          (e && e.message ? e.message : e) + '）'
      );
    }

    DriveService.invalidateFolderList_(parentFolderId);
    return { id: created.getId(), name: created.getName() };
  },

  /**
   * ブラウザが申告した MIME タイプを、アップロードに使ってよい形だけ通す。
   * 「type/subtype」の形でないもの、Google 独自形式（application/vnd.google-apps.*。
   * 変換やショートカット扱いを引き起こす）は捨て、拡張子からの推定に任せる。
   * @param {*} mimeType
   * @return {string} 使えなければ ''
   */
  safeUploadMime_: function (mimeType) {
    var m = String(mimeType || '').trim().toLowerCase();
    if (m.length > 127 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(m)) return '';
    if (m.indexOf('application/vnd.google-apps.') === 0) return '';
    return m;
  },

  /**
   * ブラウザから受け取った内容で新しいファイルを作る（ドラッグ＆ドロップ）。
   *
   * テキストもバイナリも Base64 で受け取り、Blob 経由で作る。
   * 文字コードの解釈をブラウザ側でやらずに済み、PDF や画像も同じ道を通せる。
   *
   * @param {string} folderId
   * @param {string} name
   * @param {string} base64 ファイルの中身（Base64）
   * @param {string} mimeType ブラウザが判定した MIME（空なら拡張子から推測）
   * @return {Object} entryOf_ と同じ形
   */
  uploadFile_: function (folderId, name, base64, mimeType) {
    var folder = DriveService.assertFolder_(folderId);
    var fileName = DriveService.validateFileName_(name);

    var bytes;
    try {
      bytes = Utilities.base64Decode(String(base64 || ''));
    } catch (e) {
      throw appError_('UNKNOWN', '「' + fileName + '」のデータを読み取れませんでした。');
    }
    if (bytes.length > MAX_UPLOAD_BYTES) {
      throw appError_(
        'TOO_LARGE',
        '「' + fileName + '」は ' + DriveService.formatBytes_(bytes.length) +
          ' で、アップロードの上限（' + DriveService.formatBytes_(MAX_UPLOAD_BYTES) +
          '）を超えています。Drive に直接アップロードしてください。'
      );
    }

    // 同名は上書きせず、空いている名前へ退避する（取り違えを防ぐため）。
    if (DriveService.nameExistsById_(folder.getId(), fileName, null, false)) {
      fileName = DriveService.uniqueCopyNameById_(folder.getId(), fileName);
    }

    var ext = DriveService.extensionOf_(fileName);
    var mime = DriveService.safeUploadMime_(mimeType) || MIME_BY_EXTENSION[ext] || 'application/octet-stream';

    var file;
    try {
      file = folder.createFile(Utilities.newBlob(bytes, mime, fileName));
    } catch (e) {
      throw appError_(
        'FORBIDDEN',
        '「' + fileName + '」を作成できませんでした。このフォルダへの編集権限があるか確認してください。（' +
          (e && e.message ? e.message : e) + '）'
      );
    }

    DriveService.invalidateFolderList_(folderId);
    return DriveService.entryOf_(file);
  },

  /**
   * ファイルをゴミ箱へ移動する（完全削除はしない）。
   * @param {string} fileId
   * @return {{id:string, name:string}}
   */
  trashFile_: function (fileId) {
    var file = DriveService.assertFile_(fileId);
    var name = file.getName();
    var parent = DriveService.parentOf_(file);

    try {
      file.setTrashed(true);
    } catch (e) {
      throw appError_(
        'FORBIDDEN',
        'ゴミ箱へ移動できませんでした。編集権限があるか確認してください。（' +
          (e && e.message ? e.message : e) + '）'
      );
    }

    if (parent) DriveService.invalidateFolderList_(parent.getId());
    return { id: fileId, name: name };
  }
});
