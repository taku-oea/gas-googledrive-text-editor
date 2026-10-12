
/** Drive REST で実装した API。戻り値の形は同名のサーバー関数と同じ。 */
const Direct = {
  /** 全体検索でルートから何段まで潜るか（サーバーの MAX_SEARCH_DEPTH と同じ）。 */
  SEARCH_DEPTH: 8,
  /** 全体検索の対象にするフォルダ数の上限（MAX_SEARCH_FOLDERS と同じ）。 */
  SEARCH_FOLDERS: 300,
  /** 1 本のフォルダ列挙に載せる親の数（MAX_PARENTS_PER_LIST_REQ と同じ）。 */
  LIST_PARENTS: 15,
  /**
   * 1 本の検索リクエストに載せる親の数の上限（MAX_PARENTS_PER_SEARCH_REQ と同じ）。
   * 検索語が長いときは URL 長に合わせてここからさらに減らす。
   */
  SEARCH_PARENTS: 12,
  /** 検索語の長さの上限（MAX_SEARCH_QUERY と同じ）。 */
  SEARCH_QUERY_MAX: 100,
  /**
   * フォルダ列挙の結果を使い回す時間（ミリ秒）。検索語を打ち直すたびに
   * 階層を辿り直すと、深さのぶんだけ往復が増えるので短時間だけ覚えておく。
   */
  SEARCH_SCOPE_TTL: 60000,
  /** 変更履歴に返す版の数（新しい順。サーバーの MAX_REVISIONS と同じ）。 */
  MAX_REVISIONS: 200,
  /** 変更履歴の一覧で追うページ数の上限（MAX_REVISION_PAGES と同じ。1 ページ 1,000 版）。 */
  MAX_REVISION_PAGES: 10,

  /** 直近のフォルダ列挙（{key, at, scope}）。 */
  searchScope: null,

  collator: (typeof Intl !== 'undefined' && Intl.Collator) ? new Intl.Collator('ja') : null,
  byName(a, b) {
    return Direct.collator ? Direct.collator.compare(a.name, b.name) : (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  },

  /** サーバーの classifyMeta_ と同じ規則。判定表は getBootstrap の config.types で配られる。 */
  classify(name, mimeType, size) {
    const T = (App.config && App.config.types) || {};
    const mime = String(mimeType || '');
    size = Number(size) || 0;
    if (mime.indexOf('application/vnd.google-apps.') === 0) {
      const googleKind = (T.googleViewKinds || {})[mime];
      if (googleKind) return { kind: googleKind, viewer: 'embed', openable: true, size: 0, reason: null, code: null };
      const label = (T.googleTypeLabels || {})[mime] || 'Google 独自形式のファイル';
      return { kind: 'google', viewer: null, openable: false, size: 0,
        reason: label + ' は raw テキストとして取得できないため、このエディタでは開けません。', code: 'NOT_TEXT' };
    }
    const ext = extensionOf(name);
    if (mime === 'application/pdf' || ext === 'pdf') {
      return { kind: 'pdf', viewer: 'embed', openable: true, size, reason: null, code: null };
    }
    if (/\.drawio\.(png|svg)$/i.test(String(name || ''))) {
      return { kind: 'media', viewer: 'embed', openable: true, size, reason: null, code: null };
    }
    const lower = mime.toLowerCase();
    const isText = !!(T.textExtensions || {})[ext] || lower.indexOf('text/') === 0 || !!(T.textMimeExact || {})[lower];
    if (!isText && ((T.mediaExtensions || {})[ext] || lower.indexOf('image/') === 0 ||
        lower.indexOf('video/') === 0 || lower.indexOf('audio/') === 0)) {
      return { kind: 'media', viewer: 'embed', openable: true, size, reason: null, code: null };
    }
    if (!isText) {
      return { kind: 'binary', viewer: null, openable: false, size,
        reason: 'テキストファイルとして扱えない形式です（' + (mime || '種類不明') + '）。', code: 'NOT_TEXT' };
    }
    const max = (App.config && App.config.maxFileSizeBytes) || 5 * 1024 * 1024;
    if (size > max) {
      return { kind: 'text', viewer: null, openable: false, size,
        reason: 'サイズが上限（5MB）を超えているため開けません（' + formatBytes(size) + '）。', code: 'TOO_LARGE' };
    }
    return { kind: 'text', viewer: 'editor', openable: true, size, reason: null, code: null };
  },

  entryFromMeta(meta) {
    const info = Direct.classify(meta.name, meta.mimeType, Number(meta.size) || 0);
    return {
      id: meta.id, name: meta.name, mimeType: meta.mimeType || '', size: info.size,
      updatedAtIso: DriveApi.iso(meta.modifiedTime),
      kind: info.kind, viewer: info.viewer, openable: info.openable, reason: info.reason
    };
  },

  assertReadable(meta) {
    const info = Direct.classify(meta.name, meta.mimeType, Number(meta.size) || 0);
    if (!info.openable) throw new ApiError(info.code || 'NOT_TEXT', info.reason);
    if (info.viewer !== 'editor') throw new ApiError('NOT_TEXT', 'このファイルはテキストとして読み込めません（' + info.kind + '）。');
    return info;
  },

  stripBom(t) { return t && t.charCodeAt(0) === 0xfeff ? t.slice(1) : t; },

  /** files.list の結果を親ごとに振り分ける（サーバーの bucketize_ と同じ上限）。 */
  bucketize(items, ids, buckets) {
    const idSet = new Set(ids);
    for (const id of ids) if (!buckets[id]) buckets[id] = { folders: [], files: [], truncated: false };
    for (const meta of items) {
      const owner = (meta.parents || []).find((pid) => idSet.has(pid));
      if (!owner) continue;
      const b = buckets[owner];
      if (meta.mimeType === DriveApi.FOLDER) {
        if (b.folders.length >= 300) { b.truncated = true; continue; }
        b.folders.push({ id: meta.id, name: meta.name });
      } else {
        if (b.files.length >= 500) { b.truncated = true; continue; }
        b.files.push(Direct.entryFromMeta(meta));
      }
    }
  },

  finish(id, bucket, truncated) {
    const b = bucket || { folders: [], files: [], truncated: false };
    b.folders.sort(Direct.byName);
    b.files.sort(Direct.byName);
    return { folder: { id, name: '' }, folders: b.folders, files: b.files,
      truncated: !!(b.truncated || truncated), fromCache: false, fetchedAt: Date.now() };
  },

  /** 複数フォルダの一覧。15 親ずつのクエリを並列に投げる。失敗したチャンクのフォルダは結果に含めない。 */
  async listMany(ids, foldersOnly) {
    const chunks = [];
    for (let i = 0; i < ids.length; i += 15) chunks.push(ids.slice(i, i + 15));
    const buckets = {};
    const truncatedIds = new Set();
    const failed = new Set();
    await Promise.all(chunks.map(async (chunk) => {
      let q = '(' + chunk.map((id) => "'" + id + "' in parents").join(' or ') + ') and trashed = false';
      if (foldersOnly) q += " and mimeType = '" + DriveApi.FOLDER + "'";
      let pageToken = null;
      let pages = 0;
      try {
        do {
          const body = await DriveApi.json('files', {
            q, fields: 'nextPageToken,files(' + DriveApi.FIELDS + ')', pageSize: 1000,
            supportsAllDrives: true, includeItemsFromAllDrives: true, pageToken
          }, null, 'フォルダの一覧');
          Direct.bucketize(body.files || [], chunk, buckets);
          pageToken = body.nextPageToken || null;
          pages++;
        } while (pageToken && pages < 5);
        if (pageToken) chunk.forEach((id) => truncatedIds.add(id));
      } catch (err) {
        if (err && err.network) throw err;
        chunk.forEach((id) => failed.add(id));
      }
    }));
    const out = {};
    for (const id of ids) {
      if (failed.has(id) || !buckets[id]) continue;
      out[id] = Direct.finish(id, buckets[id], truncatedIds.has(id));
    }
    return out;
  },

  async listEntries(folderId) {
    const id = String(folderId);
    const [metaRes, lists] = await Promise.all([
      DriveApi.json('files/' + encodeURIComponent(id), { supportsAllDrives: true, fields: 'id,name,mimeType,trashed' }, null, 'フォルダ')
        .then((meta) => ({ ok: true, meta }), (err) => ({ ok: false, err })),
      Direct.listMany([id], false)
    ]);
    if (metaRes.ok) {
      if (metaRes.meta.trashed) throw new ApiError('NOT_FOUND', 'このフォルダはゴミ箱に入っています。');
      if (metaRes.meta.mimeType !== DriveApi.FOLDER) throw new ApiError('NOT_FOUND', '指定された ID はフォルダではありません。');
    } else if (metaRes.err && metaRes.err.network) {
      throw metaRes.err;
    }
    const listing = lists[id];
    if (!listing) {
      // 共有ドライブのルートは files.get が通らないことがあるが、その場合は一覧のほうが返る。
      // 両方ダメなら、メタデータ側のエラー（404 / 403）を理由として出す。
      throw metaRes.ok
        ? new ApiError('FORBIDDEN', 'このフォルダの中身を取得できませんでした。')
        : metaRes.err;
    }
    const node = Tree.get(id);
    listing.folder.name = metaRes.ok ? metaRes.meta.name : (node ? node.name : '');
    return listing;
  },

  listEntriesMulti(ids) {
    const valid = (ids || []).map(String).filter((id) => /^[A-Za-z0-9_-]+$/.test(id)).slice(0, 30);
    return Direct.listMany(valid, false);
  },

  /** @param {{text:string, encoding:string}} body DriveApi.decoded の結果 */
  assemble(id, meta, body) {
    const info = Direct.assertReadable(meta);
    return {
      id, name: meta.name, mimeType: meta.mimeType || '', size: info.size,
      content: Direct.stripBom(body.text), encoding: body.encoding,
      // BOM の有無は保存で付け直すために、読めなかったことは保存を止めるために返す。
      bom: !!body.bom, broken: !!body.broken,
      updatedAtIso: DriveApi.iso(meta.modifiedTime),
      unchanged: false, fromCache: false
    };
  },

  async readFile(fileId, knownUpdatedAtIso) {
    const id = String(fileId);
    const metaP = DriveApi.json('files/' + encodeURIComponent(id),
      { supportsAllDrives: true, fields: 'id,name,mimeType,size,modifiedTime' }, null, 'ファイル');
    const mediaP = () => DriveApi.decoded('files/' + encodeURIComponent(id), { supportsAllDrives: true, alt: 'media' }, 'ファイル本文');
    if (knownUpdatedAtIso) {
      // 手元に本文がある。更新日時だけ確かめ、同じなら本文は取らない。
      const meta = await metaP;
      Direct.assertReadable(meta);
      if (DriveApi.iso(meta.modifiedTime) === String(knownUpdatedAtIso)) {
        return { id, name: meta.name, mimeType: meta.mimeType || '', size: Number(meta.size) || 0,
          content: null, updatedAtIso: String(knownUpdatedAtIso), unchanged: true, fromCache: false };
      }
      return Direct.assemble(id, meta, await mediaP());
    }
    // メタデータと本文を並列に。開けない種別（Google ドキュメント等）は本文側が 403 になるが、
    // 先に classify で理由を確定させたいので、本文の失敗はいったん保留する。
    const [meta, bodyRes] = await Promise.all([
      metaP,
      mediaP().then((t) => ({ ok: true, t }), (err) => ({ ok: false, err }))
    ]);
    Direct.assertReadable(meta);
    if (!bodyRes.ok) throw bodyRes.err;
    return Direct.assemble(id, meta, bodyRes.t);
  },

  /** 同時 6 本までで並列に読む。読めなかったものは結果に含めない。 */
  async readFilesMulti(fileIds) {
    const ids = (fileIds || []).map(String).filter((id) => /^[A-Za-z0-9_-]+$/.test(id)).slice(0, 20);
    const out = {};
    const queue = ids.slice();
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try { out[id] = await Direct.readFile(id, null); }
        catch (err) { if (err && err.network) throw err; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, ids.length) }, worker));
    return out;
  },

  async saveFile(fileId, content, baseUpdatedAtIso, force, encoding, bom) {
    const id = String(fileId);
    if (typeof content !== 'string') throw new ApiError('UNKNOWN', '保存する内容が文字列ではありません。');
    const max = (App.config && App.config.maxFileSizeBytes) || 5 * 1024 * 1024;
    // Shift_JIS は先に符号化する（表せない文字があれば、Drive に触る前にここで止める）。
    const sjis = encoding === TextCodec.SJIS ? TextCodec.encode(content, encoding) : null;
    // 開いたときに BOM が付いていた UTF-8 は付け直す（文字列の先頭に置けば UTF-8 で EF BB BF になる）。
    if (!sjis && bom) content = '\ufeff' + content;
    if (sjis ? sjis.length > max
      : (content.length > max || (content.length * 3 > max && new TextEncoder().encode(content).length > max))) {
      throw new ApiError('TOO_LARGE', '保存しようとしている内容が上限（5MB）を超えています。');
    }
    // 競合検出。Drive v3 には更新日時を条件にする If-Match が無いので、直前の get で確かめる。
    const meta = await DriveApi.json('files/' + encodeURIComponent(id),
      { supportsAllDrives: true, fields: 'id,name,mimeType,modifiedTime' }, null, 'ファイル');
    const mime = String(meta.mimeType || 'text/plain');
    if (mime.indexOf('application/vnd.google-apps.') === 0) {
      throw new ApiError('NOT_TEXT', 'Google 独自形式のファイルには保存できません。');
    }
    const serverIso = DriveApi.iso(meta.modifiedTime);
    // 基準が空なら黙って上書きしない（サーバーの writeText_ と同じ扱い）。
    if (!force && serverIso !== String(baseUpdatedAtIso || '')) {
      throw new ApiError('CONFLICT', 'このファイルは別の場所で更新されています。上書きすると相手の変更が失われます。',
        { serverUpdatedAtIso: serverIso, name: meta.name });
    }
    // multipart で本文を書く。metadata 側で mimeType を明示し、既存の型（text/markdown 等）を保つ。
    const boundary = 'gdte_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const head =
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify({ mimeType: mime }) + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: ' + mime + '\r\n\r\n';
    const tail = '\r\n--' + boundary + '--';
    // Shift_JIS は文字列のまま送ると UTF-8 になってしまうので、バイト列を挟んだ Blob にする。
    const body = sjis ? new Blob([head, sjis, tail]) : head + content + tail;
    let saved;
    try {
      saved = await DriveApi.upload('files/' + encodeURIComponent(id),
        { uploadType: 'multipart', supportsAllDrives: true, fields: 'id,name,modifiedTime,size,mimeType' },
        { method: 'PATCH', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body },
        'ファイルの書き込み');
    } catch (err) {
      if (err && err.code === 'FORBIDDEN') {
        throw new ApiError('FORBIDDEN', 'ファイルの書き込みに失敗しました。編集権限があるか確認してください。');
      }
      throw err;
    }
    return { updatedAtIso: DriveApi.iso(saved.modifiedTime), size: Number(saved.size) || 0, name: saved.name, timestampVerified: true };
  },

  /**
   * ルート配下のフォルダ ID を、ルート自身も含めて集める
   * （サーバーの searchFolderIds_ と同じ役目）。
   *
   * Drive の検索は `X in parents`（直下のみ）しか持たず「配下すべて」を表す
   * 条件が無い。ルート ID だけを親にすると 1 段でも掘った先が出てこないので、
   * 階層を 1 段ずつ広げて ID を集める。往復はフォルダ数ではなく深さで決まる。
   *
   * @param {Array<string>} rootIds
   * @return {Promise<{ids:Array<string>, partial:boolean}>}
   */
  async searchFolderIds(rootIds) {
    const key = rootIds.join(',');
    const memo = Direct.searchScope;
    if (memo && memo.key === key && Date.now() - memo.at < Direct.SEARCH_SCOPE_TTL) {
      return memo.scope;
    }

    const all = [];
    const seen = new Set();
    for (const id of rootIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      all.push(id);
    }

    let frontier = all.slice();
    let depth = 0;
    let partial = false;

    while (frontier.length && depth < Direct.SEARCH_DEPTH) {
      const groups = [];
      for (let i = 0; i < frontier.length; i += Direct.LIST_PARENTS) {
        groups.push(frontier.slice(i, i + Direct.LIST_PARENTS));
      }
      const bodies = await Promise.all(groups.map((g) => DriveApi.json('files', {
        q: "mimeType = '" + DriveApi.FOLDER + "' and trashed = false and (" +
          g.map((id) => "'" + id + "' in parents").join(' or ') + ')',
        fields: 'files(id)', pageSize: 1000,
        supportsAllDrives: true, includeItemsFromAllDrives: true
      }, null, 'フォルダ一覧').catch((err) => {
        if (err && err.network) throw err;   // 経路の切り替えは呼び出し側で
        return { files: [] };                // 読めない枝は飛ばして検索は続ける
      })));

      const next = [];
      for (const body of bodies) {
        for (const f of body.files || []) {
          if (seen.has(f.id)) continue;
          if (all.length >= Direct.SEARCH_FOLDERS) { partial = true; break; }
          seen.add(f.id);
          all.push(f.id);
          next.push(f.id);
        }
        if (partial) break;
      }
      if (partial) break;
      frontier = next;
      depth++;
    }
    // 上限で止めたせいで、まだ見ていない段が残っている。
    if (frontier.length) partial = true;

    const scope = { ids: all, partial };
    Direct.searchScope = { key, at: Date.now(), scope };
    return scope;
  },

  /**
   * 全文索引で候補ファイルを集める。親が多いと 1 本の q に入り切らないので
   * 分割し、1 ラウンドぶんをまとめて並列に投げる。
   *
   * @param {string} query
   * @param {Array<string>} folderIds
   * @return {Promise<Array<Object>>}
   */
  async searchCandidates(query, folderIds) {
    if (!folderIds.length) return [];
    const esc = DriveApi.escQ(query);
    // URL 長（上限 2,082）に収めるため、検索語が長いときは 1 本に載せる親を減らす。
    const budget = 1750 - encodeURIComponent(esc).length;
    const perReq = Math.max(1, Math.min(Direct.SEARCH_PARENTS, Math.floor(budget / 65)));

    const groups = [];
    for (let i = 0; i < folderIds.length; i += perReq) {
      groups.push(folderIds.slice(i, i + perReq));
    }

    const out = [];
    let pending = groups.map((g) => ({ parents: g, token: null }));
    let round = 0;
    while (pending.length && round < 3) {
      const bodies = await Promise.all(pending.map((p) => DriveApi.json('files', {
        q: "fullText contains '" + esc + "' and trashed = false and (" +
          p.parents.map((id) => "'" + id + "' in parents").join(' or ') + ')',
        fields: 'nextPageToken,files(' + DriveApi.FIELDS + ')', pageSize: 100,
        supportsAllDrives: true, includeItemsFromAllDrives: true, pageToken: p.token
      }, null, '検索').catch((err) => {
        if (err && err.network) throw err;
        return { files: [] };
      })));

      const next = [];
      for (let i = 0; i < bodies.length; i++) {
        for (const f of bodies[i].files || []) out.push(f);
        if (bodies[i].nextPageToken) {
          next.push({ parents: pending[i].parents, token: bodies[i].nextPageToken });
        }
      }
      pending = next;
      round++;
    }
    return out;
  },

  async searchContents(query, rootIds, opts) {
    const q = String(query || '').trim();
    if (q.length < 2) throw new ApiError('UNKNOWN', '検索語は 2 文字以上で入力してください。');
    if (q.length > Direct.SEARCH_QUERY_MAX) {
      throw new ApiError('UNKNOWN', '検索語は ' + Direct.SEARCH_QUERY_MAX + ' 文字以内で入力してください。');
    }
    const roots = (rootIds || []).map(String).filter((id) => /^[A-Za-z0-9_-]+$/.test(id));
    if (!roots.length) {
      return { query: q, files: [], candidates: 0, truncated: false, indexed: true,
        folders: 0, scopePartial: false };
    }
    const scope = await Direct.searchFolderIds(roots);
    const candidates = await Direct.searchCandidates(q, scope.ids);

    const caseSensitive = !!(opts && opts.caseSensitive);
    const needle = caseSensitive ? q : q.toLowerCase();
    // 親を分割して集めたので、Drive が返した順はあてにならない。更新の新しい順に並べ、
    // 同じファイルが複数のリクエストに現れた場合はまとめる。
    candidates.sort((a, b) => String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')));

    const targets = [];
    const picked = new Set();
    for (const meta of candidates) {
      if (targets.length >= 30) break;
      if (picked.has(meta.id)) continue;
      picked.add(meta.id);
      const entry = Direct.entryFromMeta(meta);
      if (entry.viewer === 'editor') targets.push(entry);
    }
    const bodies = new Map();
    const queue = targets.slice();
    const worker = async () => {
      while (queue.length) {
        const t = queue.shift();
        try {
          bodies.set(t.id, Direct.stripBom((await DriveApi.decoded('files/' + encodeURIComponent(t.id), { supportsAllDrives: true, alt: 'media' }, 'ファイル本文')).text));
        } catch (err) { if (err && err.network) throw err; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, targets.length) }, worker));

    const files = [];
    for (const entry of targets) {
      const content = bodies.get(entry.id);
      if (content === undefined) continue;
      const hits = searchLines(content, needle, caseSensitive);
      if (hits.length) files.push({ entry, hits });
    }
    return { query: q, files, candidates: candidates.length,
      truncated: candidates.length > targets.length, indexed: true,
      folders: scope.ids.length, scopePartial: scope.partial };
  },

  /* ---- 変更系（サーバーの validateFileName_ / assertOpenableName_ / nameExistsIn_ と同じ規則） ---- */

  /** client/lib/format.js の validFileName。 */
  validName: validFileName,

  assertOpenableName(name, action) {
    const T = (App.config && App.config.types) || {};
    if (!(T.textExtensions || {})[extensionOf(name)]) {
      throw new ApiError('NOT_TEXT', '「' + name + '」はこのエディタで開ける拡張子ではないため、' + action +
        'を中止しました。（.txt .md .js .json .html .css .py .sh .yml .sql など）');
    }
  },

  async nameExists(parentId, name, exceptId, foldersOnly) {
    let q = "'" + parentId + "' in parents and name = '" + DriveApi.escQ(name) + "' and trashed = false";
    if (foldersOnly) q += " and mimeType = '" + DriveApi.FOLDER + "'";
    const body = await DriveApi.json('files', {
      q, fields: 'files(id)', pageSize: 10, supportsAllDrives: true, includeItemsFromAllDrives: true
    }, null, 'フォルダ');
    return (body.files || []).some((f) => f.id !== exceptId);
  },

  patchMeta(id, body, extra) {
    return DriveApi.json('files/' + encodeURIComponent(id),
      Object.assign({ supportsAllDrives: true, fields: DriveApi.FIELDS }, extra || {}),
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) },
      'ファイル');
  },

  async renameFile(fileId, newName) {
    const id = String(fileId);
    const name = Direct.validName(newName);
    Direct.assertOpenableName(name, '名前の変更');
    const node = Tree.get(id);
    const parent = node && node.parentId ? node.parentId : null;
    if (parent && await Direct.nameExists(parent, name, id, false)) {
      throw new ApiError('UNKNOWN', '「' + name + '」は既に同じフォルダにあります。');
    }
    return Direct.entryFromMeta(await Direct.patchMeta(id, { name }));
  },

  async renameFolder(folderId, newName) {
    const id = String(folderId);
    const name = Direct.validName(newName);
    const node = Tree.get(id);
    const parent = node && node.parentId ? node.parentId : null;
    if (parent && await Direct.nameExists(parent, name, id, true)) {
      throw new ApiError('UNKNOWN', '「' + name + '」は既に同じ階層にあります。');
    }
    const meta = await Direct.patchMeta(id, { name }, { fields: 'id,name' });
    return { id: meta.id, name: meta.name };
  },

  async trashFile(fileId) {
    const meta = await Direct.patchMeta(String(fileId), { trashed: true }, { fields: 'id,name' });
    return { id: meta.id, name: meta.name };
  },

  async trashFolder(folderId) {
    const meta = await Direct.patchMeta(String(folderId), { trashed: true }, { fields: 'id,name' });
    Direct.searchScope = null;   // 全体検索が辿った階層はもう古い
    return { id: meta.id, name: meta.name };
  },

  /** 移動元の親は Drive に聞く（楽観的更新で Tree 側は先に移動先へ書き換わっているため）。 */
  async moveFile(fileId, destFolderId) {
    const id = String(fileId);
    const dest = String(destFolderId);
    const meta = await DriveApi.json('files/' + encodeURIComponent(id),
      { supportsAllDrives: true, fields: 'id,name,parents' }, null, 'ファイル');
    const from = (meta.parents || [])[0] || null;
    if (from === dest) {
      return Direct.entryFromMeta(await DriveApi.json('files/' + encodeURIComponent(id),
        { supportsAllDrives: true, fields: DriveApi.FIELDS }, null, 'ファイル'));
    }
    if (await Direct.nameExists(dest, meta.name, id, false)) {
      throw new ApiError('UNKNOWN', '「' + meta.name + '」は既に移動先にあります。');
    }
    return Direct.entryFromMeta(await Direct.patchMeta(id, {}, { addParents: dest, removeParents: from }));
  },

  async moveFolder(folderId, destFolderId) {
    const id = String(folderId);
    const dest = String(destFolderId);
    if (id === dest) throw new ApiError('UNKNOWN', 'フォルダを自分自身の中へは移動できません。');
    const meta = await DriveApi.json('files/' + encodeURIComponent(id),
      { supportsAllDrives: true, fields: 'id,name,parents' }, null, 'フォルダ');
    const from = (meta.parents || [])[0] || null;
    if (from === dest) return { id: meta.id, name: meta.name };
    if (await Direct.nameExists(dest, meta.name, id, true)) {
      throw new ApiError('UNKNOWN', '「' + meta.name + '」は既に移動先にあります。');
    }
    const moved = await Direct.patchMeta(id, {}, { addParents: dest, removeParents: from, fields: 'id,name' });
    Direct.searchScope = null;
    return { id: moved.id, name: moved.name };
  },

  async createFile(folderId, name) {
    const parent = String(folderId);
    const fileName = Direct.validName(name);
    Direct.assertOpenableName(fileName, '作成');
    if (await Direct.nameExists(parent, fileName, null, false)) {
      throw new ApiError('UNKNOWN', '「' + fileName + '」は既にこのフォルダにあります。');
    }
    const T = (App.config && App.config.types) || {};
    const mime = (T.mimeByExtension || {})[extensionOf(fileName)] || 'text/plain';
    const meta = await DriveApi.json('files', { supportsAllDrives: true, fields: DriveApi.FIELDS },
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: fileName, parents: [parent], mimeType: mime }) }, 'フォルダ');
    return Direct.entryFromMeta(meta);
  },

  async createFolder(parentFolderId, name) {
    const parent = String(parentFolderId);
    const folderName = Direct.validName(name);
    if (await Direct.nameExists(parent, folderName, null, true)) {
      throw new ApiError('UNKNOWN', '「' + folderName + '」は既にこのフォルダにあります。');
    }
    const meta = await DriveApi.json('files', { supportsAllDrives: true, fields: 'id,name' },
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: folderName, parents: [parent], mimeType: DriveApi.FOLDER }) }, 'フォルダ');
    Direct.searchScope = null;
    return { id: meta.id, name: meta.name };
  },

  async copyFile(fileId, destFolderId, newName) {
    const id = String(fileId);
    const dest = String(destFolderId);
    const src = Tree.get(id);
    let srcName = src ? src.name : null;
    if (!srcName) {
      srcName = (await DriveApi.json('files/' + encodeURIComponent(id), { supportsAllDrives: true, fields: 'name' }, null, 'ファイル')).name;
    }
    let name;
    if (newName) {
      name = Direct.validName(newName);
      if (await Direct.nameExists(dest, name, null, false)) {
        throw new ApiError('UNKNOWN', '「' + name + '」は既に移動先にあります。');
      }
    } else {
      // 「name のコピー」「name のコピー 2」… 移動先の名前を 1 本で集めてから採番する。
      const body = await DriveApi.json('files', {
        q: "'" + dest + "' in parents and trashed = false", fields: 'files(name)', pageSize: 1000,
        supportsAllDrives: true, includeItemsFromAllDrives: true
      }, null, 'フォルダ');
      const taken = new Set((body.files || []).map((f) => f.name));
      const dot = srcName.lastIndexOf('.');
      const base = dot > 0 ? srcName.slice(0, dot) : srcName;
      const ext = dot > 0 ? srcName.slice(dot) : '';
      name = base + ' のコピー ' + Date.now() + ext;
      for (let n = 1; n <= 50; n++) {
        const candidate = base + ' のコピー' + (n === 1 ? '' : ' ' + n) + ext;
        if (!taken.has(candidate)) { name = candidate; break; }
      }
    }
    const meta = await DriveApi.json('files/' + encodeURIComponent(id) + '/copy', { supportsAllDrives: true, fields: DriveApi.FIELDS },
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parents: [dest] }) }, 'ファイル');
    return Direct.entryFromMeta(meta);
  },

  async listRevisions(fileId) {
    // Drive は古い順に返す。1 ページだけだと、版が多いファイルで新しい版が丸ごと欠けるので、
    // 最後のページまで追ってから新しい側を MAX_REVISIONS 件だけ返す（サーバーの listRevisions_ と同じ）。
    let list = [];
    let pageToken = null;
    let pages = 0;
    do {
      const res = await DriveApi.json('files/' + encodeURIComponent(String(fileId)) + '/revisions',
        { fields: 'nextPageToken,revisions(id,modifiedTime,size,keepForever,lastModifyingUser(displayName))',
          pageSize: 1000, pageToken },
        null, 'ファイルの変更履歴');
      list = list.concat((res && res.revisions) || []);
      pageToken = (res && res.nextPageToken) || null;
      pages++;
    } while (pageToken && pages < Direct.MAX_REVISION_PAGES);
    const out = [];
    for (let i = list.length - 1; i >= 0 && out.length < Direct.MAX_REVISIONS; i--) {
      const rev = list[i];
      out.push({ id: String(rev.id), modifiedTime: rev.modifiedTime, size: Number(rev.size || 0),
        keepForever: !!rev.keepForever,
        lastModifyingUser: (rev.lastModifyingUser && rev.lastModifyingUser.displayName) || null });
    }
    return { revisions: out };
  },

  async readRevision(fileId, revisionId) {
    const t = await DriveApi.decoded('files/' + encodeURIComponent(String(fileId)) + '/revisions/' + encodeURIComponent(String(revisionId)),
      { alt: 'media' }, 'リビジョン');
    return { content: Direct.stripBom(t.text), encoding: t.encoding };
  }
};

