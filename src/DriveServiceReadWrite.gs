/**
 * DriveServiceReadWrite.gs — DriveService のうち 本文の読み込みと保存（競合検出つき）。
 *
 * DriveService は 1 つのオブジェクトだが、長いので機能ごとのファイルに分けて足している。
 * GAS は全ファイルを 1 つのグローバルに読み込み、読み込む順は決められないので、
 * どのファイルも「無ければ作る」形にしてある（呼ばれるのは全ファイルを読み終えた後）。
 */

var DriveService = DriveService || {};

Object.assign(DriveService, {

  /* ------------------------------------------------------------------ *
   *  読み込み・保存
   * ------------------------------------------------------------------ */

  /**
   * ファイル本文を取得する。
   *
   * REST 経路はメタデータと本文を毎回 Drive から取る（本文キャッシュは使わない）。
   * knownUpdatedAtIso が Drive 側の更新日時と同じなら本文を送らず unchanged:true を返す。
   * REST が使えなければ readTextLegacy_（更新日時入りのキーで本文をキャッシュする）へ。
   *
   * @param {string} fileId
   * @param {string|null} [knownUpdatedAtIso] クライアントが本文を持っている版の更新日時
   * @return {{id:string, name:string, mimeType:string, size:number, content:(string|null),
   *           encoding?:string, bom?:boolean, broken?:boolean,
   *           updatedAtIso:string, unchanged:boolean, fromCache:boolean}}
   *   bom    … 先頭に BOM が付いていた（content からは外してある。保存時に付け直す）
   *   broken … UTF-8 としても Shift_JIS としても読めなかった（クライアントは保存させない）
   */
  readText_: function (fileId, knownUpdatedAtIso) {
    if (!fileId) {
      throw appError_('NOT_FOUND', 'ファイルが指定されていません。');
    }
    var id = String(fileId);
    if (!restAvailable_() || !validId_(id)) return DriveService.readTextLegacy_(id);

    try {
      if (knownUpdatedAtIso) {
        // クライアントが本文を持っているので、まず更新日時だけ確かめる（応答 ~200B）。
        var m = fetchAll_([metaReq_(id, 'id,name,mimeType,size,modifiedTime')])[0];
        if (!m.ok) throw driveErr_(m, 'ファイル');
        var meta = m.json();
        DriveService.assertReadable_(meta);
        if (iso_(meta.modifiedTime) === String(knownUpdatedAtIso)) {
          return {
            id: id,
            name: meta.name,
            mimeType: String(meta.mimeType || ''),
            size: Number(meta.size) || 0,
            content: null,
            updatedAtIso: String(knownUpdatedAtIso),
            unchanged: true,
            fromCache: false
          };
        }
        return DriveService.assembleRead_(id, meta, fetchAll_([mediaReq_(id)])[0]);
      }

      // メタデータと本文を並列に取る。
      // 以前は DriveApp のゲッター（往復）→ キャッシュ確認 → getBlob（往復）の直列だった。
      var rs = fetchAll_([metaReq_(id, 'id,name,mimeType,size,modifiedTime'), mediaReq_(id)]);
      if (!rs[0].ok) throw driveErr_(rs[0], 'ファイル');
      return DriveService.assembleRead_(id, rs[0].json(), rs[1]);
    } catch (e) {
      if (e && e.restFailure) return DriveService.readTextLegacy_(id);
      throw e;
    }
  },

  /**
   * エディタで開けるメタデータか確かめる。開けなければ throw。
   * @param {{name:string, mimeType:string, size:*}} meta
   * @return {Object} classifyMeta_ の結果
   */
  assertReadable_: function (meta) {
    var info = DriveService.classifyMeta_(meta.name, meta.mimeType, Number(meta.size) || 0);
    if (!info.openable) {
      throw appError_(info.code || 'NOT_TEXT', info.reason);
    }
    if (info.viewer !== 'editor') {
      throw appError_('NOT_TEXT', 'このファイルはテキストとして読み込めません（' + info.kind + '）。');
    }
    return info;
  },

  /**
   * メタデータと本文の応答から readFile の戻り値を組む。
   * @param {string} id
   * @param {Object} meta files.get の JSON
   * @param {Object} media alt=media の応答（parseResp_）
   * @return {Object}
   */
  assembleRead_: function (id, meta, media) {
    var info = DriveService.assertReadable_(meta);
    if (!media.ok) throw driveErr_(media, 'ファイル本文');
    var dec = media.decoded();
    return {
      id: id,
      name: meta.name,
      mimeType: String(meta.mimeType || ''),
      size: info.size,
      content: DriveService.stripBom_(dec.text),
      encoding: dec.encoding,
      bom: dec.bom,
      broken: dec.broken,
      updatedAtIso: iso_(meta.modifiedTime),
      unchanged: false,
      fromCache: false
    };
  },

  /**
   * 複数ファイルの本文を 1 回の fetchAll で取る（開いているタブの先読み用）。
   * 読めなかったものは結果に含めない。
   * @param {Array<string>} fileIds 最大 MAX_MULTI_READ 件
   * @return {Object<string, Object>} id → readText_ と同じ形
   */
  readMany_: function (fileIds) {
    var ids = [];
    var src = Array.isArray(fileIds) ? fileIds.slice(0, MAX_MULTI_READ) : [];
    for (var i = 0; i < src.length; i++) {
      if (validId_(src[i]) && src[i] !== 'root') ids.push(String(src[i]));
    }
    var out = {};
    if (!ids.length) return out;

    var rs = null;
    if (restAvailable_()) {
      var reqs = [];
      for (var j = 0; j < ids.length; j++) {
        reqs.push(metaReq_(ids[j], 'id,name,mimeType,size,modifiedTime'));
        reqs.push(mediaReq_(ids[j]));
      }
      try {
        rs = fetchAll_(reqs);
      } catch (e) {
        if (!(e && e.restFailure)) throw e;
        rs = null;
      }
    }
    for (var k = 0; k < ids.length; k++) {
      try {
        if (rs) {
          if (!rs[2 * k].ok) continue;
          out[ids[k]] = DriveService.assembleRead_(ids[k], rs[2 * k].json(), rs[2 * k + 1]);
        } else {
          out[ids[k]] = DriveService.readTextLegacy_(ids[k]);
        }
      } catch (e2) {
        // 開けない・消えた。呼び出し側は無いものとして扱う。
      }
    }
    return out;
  },

  /**
   * DriveApp 経路の readText_（REST が使えないときのフォールバック）。
   * キャッシュキーに更新日時を含めているので、Drive 側が更新されていれば
   * 自動的にキャッシュミスになる。
   */
  readTextLegacy_: function (fileId) {
    var file = DriveService.assertFile_(fileId);
    var name = file.getName();
    var mime = String(file.getMimeType() || '');
    var info = DriveService.classify_(file, name, mime);
    if (!info.openable) {
      throw appError_(info.code || 'NOT_TEXT', info.reason);
    }
    // PDF は openable だがテキストではない。ビューアで開くべきもの。
    if (info.viewer !== 'editor') {
      throw appError_('NOT_TEXT', 'このファイルはテキストとして読み込めません（' + info.kind + '）。');
    }

    var updatedAtIso = file.getLastUpdated().toISOString();
    // 'f2:' は文字コード判定を入れたときに変えた。旧実装は Shift_JIS を UTF-8 として
    // 読んだ（化けた）本文を 'f:' に載せていたので、それを拾わないようにする。
    var cacheKey = 'f2:' + fileId + ':' + updatedAtIso;

    // キャッシュに載せるのは BOM なしで正しく読めた UTF-8 のものだけ（下）なので、当たればそれ。
    var cached = DriveService.cacheGet_(cacheKey);
    if (cached !== null && cached !== undefined) {
      return {
        id: fileId,
        name: name,
        mimeType: mime,
        size: info.size,
        content: cached,
        encoding: 'UTF-8',
        bom: false,
        broken: false,
        updatedAtIso: updatedAtIso,
        fromCache: true
      };
    }

    var dec;
    try {
      dec = decodeText_(file.getBlob());
    } catch (e) {
      throw appError_(
        'UNKNOWN',
        'ファイルの読み込みに失敗しました。（' + (e && e.message ? e.message : e) + '）'
      );
    }
    var content = DriveService.stripBom_(dec.text);
    if (dec.encoding === 'UTF-8' && !dec.bom && !dec.broken) {
      DriveService.cachePut_(cacheKey, content, CONTENT_CACHE_TTL_SEC);
    }

    return {
      id: fileId,
      name: name,
      mimeType: mime,
      size: info.size,
      content: content,
      encoding: dec.encoding,
      bom: dec.bom,
      broken: dec.broken,
      updatedAtIso: updatedAtIso,
      fromCache: false
    };
  },

  /**
   * ファイルを保存する。競合検出つき。
   *
   * @param {string} fileId
   * @param {string} content
   * @param {string} baseUpdatedAtIso クライアントが開いた／最後に保存した時点の更新日時
   * @param {boolean} force true なら競合を無視して上書きする
   * @param {string} [encoding] 'Shift_JIS' ならその文字コードで書く（既定は UTF-8）
   * @param {boolean} [bom] UTF-8 の先頭に BOM を付ける（開いたときに付いていたファイル）
   * @return {{updatedAtIso:string, size:number, name:string, timestampVerified:boolean}}
   */
  writeText_: function (fileId, content, baseUpdatedAtIso, force, encoding, bom) {
    if (typeof content !== 'string') {
      throw appError_('UNKNOWN', '保存する内容が文字列ではありません。');
    }
    var sjis = encoding === 'Shift_JIS';
    // BOM は UTF-8 のときだけ。本文の先頭に置けば UTF-8 で EF BB BF として書かれる。
    var bomPrefix = (!sjis && bom) ? '\ufeff' : '';
    // UTF-8 のバイト数は文字数以上。文字数だけで上限を超えているなら Blob を作らずに弾く。
    if (content.length > MAX_FILE_SIZE_BYTES) DriveService.throwTooLarge_(null);
    var id = String(fileId);
    // DriveApp の setContent は UTF-8 でしか書けないので、Shift_JIS は REST 経路だけ。
    if (sjis && (!restAvailable_() || !validId_(id))) {
      throw appError_('UNKNOWN', 'Shift_JIS での保存には Drive API（拡張サービスか REST）が必要です。');
    }
    if (!restAvailable_() || !validId_(id)) {
      return DriveService.writeTextLegacy_(id, content, baseUpdatedAtIso, force, !!bomPrefix);
    }
    // 表せない文字があれば、Drive に触る前にここで止める。
    var payload = sjis ? encodeSjis_(content) : bomPrefix + content;
    if (sjis && payload.length > MAX_FILE_SIZE_BYTES) DriveService.throwTooLarge_(payload.length);
    // 文字数が上限の 1/3 を超えるときだけバイト数を実測する（全文の Blob 化は重い）。
    if (!sjis) DriveService.assertUtf8Size_(content, false);

    // 同じユーザーの二重保存（自動保存と Cmd+S の競走）を直列化する。
    // PATCH 1 本になったので待ち時間は短くてよい。
    var lock = LockService.getUserLock();
    var locked = false;
    try {
      locked = lock.tryLock(3000);
    } catch (e) {
      locked = false;
    }
    if (!locked) {
      throw appError_('LOCKED', '別の保存処理が進行中です。数秒おいて再試行してください。');
    }

    var restFailed = false;
    try {
      // 競合検出。Drive v3 には更新日時を条件にする If-Match が無いので、直前の get で確かめる。
      var m = fetchAll_([metaReq_(id, 'id,name,mimeType,modifiedTime,size')])[0];
      if (!m.ok) throw driveErr_(m, 'ファイル');
      var meta = m.json();
      var mime = String(meta.mimeType || 'text/plain');
      if (mime.indexOf('application/vnd.google-apps.') === 0) {
        throw appError_('NOT_TEXT', 'Google 独自形式のファイルには保存できません。');
      }
      var serverIso = iso_(meta.modifiedTime);
      DriveService.assertNoConflict_(serverIso, baseUpdatedAtIso, force, meta.name);

      // 本文を multipart の PATCH 1 本で書く。応答に新しい modifiedTime が入るので、
      // setContent のあと再取得と sleep（最大 750ms）で追いかける必要が無くなった。
      var up = fetchAll_([uploadReq_(id, payload, mime, null, null)])[0];
      if (!up.ok) {
        if (up.code === 401 || up.code === 403) {
          throw appError_(
            'FORBIDDEN',
            'ファイルの書き込みに失敗しました。編集権限があるか確認してください。' +
              (up.message ? '（' + up.message + '）' : '')
          );
        }
        throw driveErr_(up, 'ファイルの書き込み');
      }
      var saved = up.json();
      var newIso = iso_(saved.modifiedTime);
      var size = Number(saved.size) || 0;

      // 起動時のインライン表示用スナップショット（doGet が読む）。
      DriveService.putFileSnapshot_(id, {
        id: id,
        name: saved.name,
        mimeType: String(saved.mimeType || mime),
        size: size,
        content: content,
        encoding: sjis ? 'Shift_JIS' : 'UTF-8',
        bom: !!bomPrefix,
        broken: false,
        updatedAtIso: newIso,
        unchanged: false,
        fromCache: true
      });

      return { updatedAtIso: newIso, size: size, name: saved.name, timestampVerified: true };
    } catch (e) {
      if (e && e.restFailure) restFailed = true;
      else throw e;
    } finally {
      try { lock.releaseLock(); } catch (e2) { /* 解放失敗は無視 */ }
    }
    // ここに来るのは REST が使えなかったときだけ（ロックは解放済み）。
    // DriveApp の setContent は UTF-8 でしか書けない。黙って文字コードを変えないよう、
    // Shift_JIS は保存せずに失敗として返す（下書きは残る）。
    if (sjis) {
      throw appError_('UNKNOWN', 'Drive API に接続できなかったため、Shift_JIS で保存できませんでした。' +
        '少しおいて再試行してください。');
    }
    return DriveService.writeTextLegacy_(id, content, baseUpdatedAtIso, force, !!bomPrefix);
  },

  /**
   * 保存時の競合検出（REST と DriveApp の両経路で共通）。
   * 基準が空のまま来たら（クライアントの不具合など）、黙って上書きせず競合として返す。
   * 画面では「差分を見る／上書き／読み込み直す」を選べるので、上書きは force で明示させる。
   * @param {string} serverIso Drive 上の現在の更新日時
   * @param {string} baseUpdatedAtIso クライアントが知っている更新日時
   * @param {boolean} force
   * @param {string} name
   */
  assertNoConflict_: function (serverIso, baseUpdatedAtIso, force, name) {
    if (force || serverIso === String(baseUpdatedAtIso || '')) return;
    throw appError_(
      'CONFLICT',
      'このファイルは別の場所で更新されています。上書きすると相手の変更が失われます。',
      { serverUpdatedAtIso: serverIso, name: name }
    );
  },

  /** @param {number|null} bytes 分かっていればメッセージに添える */
  throwTooLarge_: function (bytes) {
    throw appError_(
      'TOO_LARGE',
      '保存しようとしている内容が上限（5MB）を超えています' +
        (bytes ? '（' + DriveService.formatBytes_(bytes) + '）' : '') + '。'
    );
  },

  /**
   * UTF-8 で書いたときに上限に収まるか。
   * 文字数が上限を超えていれば Blob を作らずに弾き、上限の 1/3 以下なら実測を省く
   * （1 文字は UTF-8 で最大 3 バイト。サロゲートペアは 2 文字で 4 バイト）。
   * @param {string} content
   * @param {boolean} measure true なら省略せず必ず実測してバイト数を返す
   * @return {number|null} 実測したバイト数（省いたら null）
   */
  assertUtf8Size_: function (content, measure) {
    if (content.length > MAX_FILE_SIZE_BYTES) DriveService.throwTooLarge_(null);
    if (!measure && content.length * 3 <= MAX_FILE_SIZE_BYTES) return null;
    var bytes = DriveService.byteLength_(content);
    if (bytes > MAX_FILE_SIZE_BYTES) DriveService.throwTooLarge_(bytes);
    return bytes;
  },

  /**
   * アクティブファイルの本文スナップショットを CacheService に置く／消す。
   * doGet がこれを HTML に埋め込み、getBootstrap の往復を待たずに本文を描く。
   * 大きい本文（MAX_INLINE_CONTENT_CHARS 超）は載せない。
   *
   * @param {string} id
   * @param {Object|null} payload readText_ と同じ形。null なら消す
   */
  putFileSnapshot_: function (id, payload) {
    var key = 'snap:file:' + id;
    if (payload && typeof payload.content === 'string' &&
        payload.content.length <= MAX_INLINE_CONTENT_CHARS) {
      DriveService.cachePutJson_(key, payload, SNAPSHOT_TTL_SEC);
      return;
    }
    try { CacheService.getUserCache().remove(key); } catch (e) { /* 無ければ無いでよい */ }
  },

  /**
   * DriveApp 経路の writeText_（REST が使えないときのフォールバック）。
   * setContent 後のメタデータ遅延を再取得と sleep で吸収する旧実装。
   * bom なら先頭に BOM を付けて書く（setContent は UTF-8 なので EF BB BF になる）。
   */
  writeTextLegacy_: function (fileId, content, baseUpdatedAtIso, force, bom) {
    if (typeof content !== 'string') {
      throw appError_('UNKNOWN', '保存する内容が文字列ではありません。');
    }

    var lock = LockService.getUserLock();
    var locked = false;
    try {
      locked = lock.tryLock(10000);
    } catch (e) {
      locked = false;
    }
    if (!locked) {
      throw appError_('LOCKED', '別の保存処理が進行中です。数秒おいて再試行してください。');
    }

    try {
      var file = DriveService.assertFile_(fileId);
      var serverIso = file.getLastUpdated().toISOString();

      DriveService.assertNoConflict_(serverIso, baseUpdatedAtIso, force, file.getName());
      var bytes = DriveService.assertUtf8Size_(content, true);

      try {
        file.setContent(bom ? '\ufeff' + content : content);
      } catch (e) {
        throw appError_(
          'UNKNOWN',
          'ファイルの書き込みに失敗しました。編集権限があるか確認してください。（' +
            (e && e.message ? e.message : e) + '）'
        );
      }

      // setContent 直後は DriveApp のメタデータが古いままのことがある。
      // 新しい File オブジェクトで取り直し、変わっていなければ短く待って再取得する。
      // 更新日時が古いままだと、次回保存で誤検出の競合を起こすため。
      var newIso = serverIso;
      var verified = false;
      for (var attempt = 0; attempt < 3; attempt++) {
        newIso = DriveApp.getFileById(fileId).getLastUpdated().toISOString();
        if (newIso !== serverIso) { verified = true; break; }
        Utilities.sleep(250);
      }

      // 保存した内容をそのまま新しいキーでキャッシュへ載せておく（次回読み込みが速くなる）。
      // キャッシュに当たると BOM なしとして返すので、BOM 付きは載せない（readTextLegacy_ と同じ）。
      if (!bom) DriveService.cachePut_('f2:' + fileId + ':' + newIso, content, CONTENT_CACHE_TTL_SEC);

      return {
        updatedAtIso: newIso,
        size: bytes,
        name: file.getName(),
        timestampVerified: verified
      };
    } finally {
      try { lock.releaseLock(); } catch (e) { /* 解放失敗は無視 */ }
    }
  }
});
