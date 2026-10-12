/* ------------------------------------------------------------------ *
 *  ターミナル
 *
 *  Drive をファイルシステムに見立てたコマンドライン。シェルではないので
 *  プロセスは無く、動くのはここで定義したコマンドだけ。それでも
 *
 *    - まとめて動かす（mv *.md docs/ ・ sed -i で複数ファイルの一括置換）
 *    - 引数を渡す（open a.md:120 ・ diff a.md b.md）
 *    - 同じ操作を履歴から呼び出す
 *
 *  という、GUI では届かないところを埋められる。
 *
 *  ターミナルは「タブの一種」（kind: 'term'）として作ってある。プレビューや
 *  比較ビューと同じで、DOM はタブが持ち、ペインへは差し込むだけ。これだけで
 *  分割・ドラッグでの移動・セッション復元が全部そのまま効く。
 *
 *  速さについて考えていること:
 *    - 補完の候補はツリー（Tree.nodes）から同期で作る。読み込み済みの階層なら
 *      Tab を押した瞬間に出る（サーバー往復ゼロ）
 *    - 未読込のフォルダをまたぐときは listEntriesMulti で 1 往復にまとめる
 *    - 本文は Store（LRU + 再検証）を通すので、開いているファイルは 0ms
 *    - まとめて書くときは 6 本まで並列（Drive の PATCH は 1 本 2.5 秒前後）
 *    - 出力は 1 コマンド 1 ブロック（1 DOM ノード）。行ごとに div を作らない
 * ------------------------------------------------------------------ */

/* ---------------------- 仮想ファイルシステム ---------------------- */

/**
 * Drive をパスで辿るための薄い層。実体は Tree.nodes（サイドバーと同じモデル）で、
 * 未読込のフォルダに当たったときだけ Drive を読みに行く。
 *
 * パスの決まりごと:
 *   /            … 仮想ルート。直下にルートフォルダと「一時メモ」が並ぶ
 *   ~            … 一時メモ
 *   id:<Drive の ID> … 名前に / を含むファイルを指すための逃げ道
 */
const Vfs = {
  /** ** で潜るときに見るフォルダ数の上限（全体検索の MAX_SEARCH_FOLDERS と同じ考え方）。 */
  MAX_FOLDERS: 400,
  /** 1 回の展開で返す最大件数。 */
  MAX_MATCHES: 2000,
  /** 直前の glob が上限で打ち切られたか。コマンド側が注意書きを出すのに使う。 */
  truncated: false,

  /** 仮想ルートか（id が空）。 */
  isRoot(id) { return !id; },

  /** 仮想ルート直下に並ぶフォルダ（ルート + 一時メモ）。 */
  roots() {
    return Tree.allRootIds().map((id) => Tree.get(id)).filter(Boolean);
  },

  /** 表示用のパス。'/ルート名/フォルダ/ファイル'。 */
  pathOf(id) {
    if (Vfs.isRoot(id)) return '/';
    const parts = [];
    let node = Tree.get(id);
    for (let i = 0; node && i < 40; i++) {
      parts.unshift(node.name);
      node = node.parentId ? Tree.get(node.parentId) : null;
    }
    return '/' + parts.join('/');
  },

  /** 親フォルダの id（ルートフォルダの親は仮想ルート = null）。 */
  parentOf(id) {
    if (Vfs.isRoot(id)) return null;
    const node = Tree.get(id);
    return (node && node.parentId) ? node.parentId : null;
  },

  /** 子。仮想ルートならルートフォルダ、フォルダならその中身。 */
  children(id) {
    if (Vfs.isRoot(id)) return { folders: Vfs.roots(), files: [] };
    const node = Tree.get(id);
    if (!node || node.type !== 'folder') return { folders: [], files: [] };
    return {
      folders: node.childFolderIds.map((c) => Tree.get(c)).filter(Boolean),
      files: node.childFileIds.map((c) => Tree.get(c)).filter(Boolean)
    };
  },

  /** そのフォルダの中身を読んであるか。 */
  loaded(id) {
    if (Vfs.isRoot(id)) return true;
    const node = Tree.get(id);
    return !!node && (node.type !== 'folder' || node.loaded);
  },

  /**
   * 未読込のフォルダをまとめて読む。
   * 1 個ずつ listEntries を叩くと往復がそのまま足し算になるので、
   * listEntriesMulti（サーバー側 / 直接 API のどちらも 1 本の files.list に束ねる）へ渡す。
   * @param {string|Array<string>} ids
   */
  async ensure(ids) {
    const want = (Array.isArray(ids) ? ids : [ids]).filter((id) => {
      if (Vfs.isRoot(id)) return false;
      const node = Tree.get(id);
      return !!node && node.type === 'folder' && !node.loaded;
    });
    if (!want.length) return;
    const uniq = Array.from(new Set(want));
    const jobs = [];
    // 一時メモは専用 API（フォルダの実体がまだ無いことがある）。
    for (const id of uniq.filter((x) => Tree.isTmpRoot(x))) jobs.push(TempMemo.load(false));
    const rest = uniq.filter((x) => !Tree.isTmpRoot(x));
    for (let i = 0; i < rest.length; i += 24) {
      const chunk = rest.slice(i, i + 24);
      jobs.push(Store.dedup('list:multi:' + chunk.join(','), () => Api.listEntriesMulti(chunk))
        .then((multi) => {
          for (const [folderId, data] of Object.entries(multi || {})) Tree.ingest(folderId, data);
        })
        .catch((err) => { throw new TermError('フォルダを読めませんでした: ' + err.message); }));
    }
    await Promise.all(jobs);
    renderTree();
  },

  /** 名前で子を 1 つ引く。まず完全一致、無ければ大文字小文字を無視して探す。 */
  find(parentId, name) {
    const ch = Vfs.children(parentId);
    const all = ch.folders.concat(ch.files);
    for (const node of all) { if (node.name === name) return node; }
    const lower = name.toLowerCase();
    for (const node of all) { if (node.name.toLowerCase() === lower) return node; }
    return null;
  },

  /**
   * パスを解決する。
   * @param {string|null} cwd 起点のフォルダ（仮想ルートは null）
   * @param {string} path
   * @param {{allowMissing?:boolean}} [opts] 末尾が無くてもよい（作成先として使う）
   * @return {Promise<{id:(string|null), node:(Object|null), parentId:(string|null),
   *                   name:string, missing:boolean}>}
   */
  async resolve(cwd, path, opts) {
    const o = opts || {};
    const raw = String(path == null ? '' : path);

    // Drive は名前に / を許すので、パスで書けないファイルが存在しうる。
    // その逃げ道（ツリーに読み込み済みのものに限る）。
    if (raw.indexOf('id:') === 0) {
      const node = Tree.get(raw.slice(3));
      if (!node) throw new TermError('その ID はまだツリーに読み込まれていません: ' + raw.slice(3));
      return { id: node.id, node, parentId: node.parentId || null, name: node.name, missing: false };
    }

    let cur = cwd || null;
    let body = raw;
    if (raw === '~' || raw.indexOf('~/') === 0) {
      if (!Tree.tmpRootId) throw new TermError('一時メモのフォルダがまだありません。');
      cur = Tree.tmpRootId;
      body = raw.slice(1);
    } else if (raw.charAt(0) === '/') {
      cur = null;
    }

    const segs = body.split('/').filter((s) => s !== '' && s !== '.');
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const last = i === segs.length - 1;
      if (seg === '..') { cur = Vfs.parentOf(cur); continue; }
      await Vfs.ensure(cur);
      const found = Vfs.find(cur, seg);
      if (!found) {
        if (last && o.allowMissing) {
          return { id: null, node: null, parentId: cur, name: seg, missing: true };
        }
        throw new TermError('見つかりません: ' + raw);
      }
      if (!last && found.type !== 'folder') {
        throw new TermError('フォルダではありません: ' + Vfs.pathOf(found.id));
      }
      cur = found.id;
    }

    const node = Vfs.isRoot(cur) ? null : Tree.get(cur);
    return {
      id: cur,
      node,
      parentId: node ? (node.parentId || null) : null,
      name: node ? node.name : '/',
      missing: false
    };
  },

  /** フォルダとその子孫を全部集める（** 用）。上限に当たったら truncated を立てる。 */
  async descend(ids) {
    const out = [];
    const seen = new Set();
    let level = ids.slice();
    for (let depth = 0; depth < 12 && level.length; depth++) {
      await Vfs.ensure(level);
      const next = [];
      for (const id of level) {
        const key = id || '/';
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(id);
        if (out.length >= Vfs.MAX_FOLDERS) { Vfs.truncated = true; return out; }
        for (const f of Vfs.children(id).folders) next.push(f.id);
      }
      level = next;
    }
    return out;
  },

  /**
   * ワイルドカードを展開する。* ? [] は 1 階層の中で、** は階層をまたいで当たる。
   * @param {string|null} cwd
   * @param {string} pattern
   * @param {{type?:('file'|'folder'), allowMissing?:boolean}} [opts]
   * @return {Promise<Array<Object>>} Tree のノード
   */
  async glob(cwd, pattern, opts) {
    const o = opts || {};
    const raw = String(pattern == null ? '' : pattern);
    if (!/[*?[]/.test(raw)) {
      const r = await Vfs.resolve(cwd, raw, o);
      if (r.missing || !r.node) return [];
      return [r.node];
    }
    // 名前そのものに [ ] * ? を含むファイル（「[重要]議事録.md」など）は珍しくない。
    // パターンとして展開すると本人に当たらず、「要議事録.md」のような別のファイルに当たる
    // （rm -f なら確認なしで消える）ので、その名前のものが実在すればそれだけを返す。
    const exact = await Vfs.resolve(cwd, raw, o).catch(() => null);
    if (exact && !exact.missing && exact.node && (!o.type || exact.node.type === o.type)) return [exact.node];

    let base = cwd || null;
    let body = raw;
    if (raw === '~' || raw.indexOf('~/') === 0) {
      if (!Tree.tmpRootId) throw new TermError('一時メモのフォルダがまだありません。');
      base = Tree.tmpRootId;
      body = raw.slice(1);
    } else if (raw.charAt(0) === '/') {
      base = null;
    }

    const segs = body.split('/').filter((s) => s !== '' && s !== '.');
    let frontier = [base];
    let hits = null;

    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const last = i === segs.length - 1;
      if (seg === '..') {
        frontier = Array.from(new Set(frontier.map((id) => Vfs.parentOf(id))));
        if (last) hits = frontier.filter((id) => id).map((id) => Tree.get(id)).filter(Boolean);
        continue;
      }
      if (seg === '**') {
        frontier = await Vfs.descend(frontier);
        if (last) hits = frontier.filter((id) => id).map((id) => Tree.get(id)).filter(Boolean);
        continue;
      }
      await Vfs.ensure(frontier);
      const re = globToRegExp(seg);
      const nextIds = [];
      const found = [];
      for (const id of frontier) {
        const ch = Vfs.children(id);
        for (const folder of ch.folders) {
          if (!re.test(folder.name)) continue;
          nextIds.push(folder.id);
          found.push(folder);
        }
        if (last) {
          for (const file of ch.files) { if (re.test(file.name)) found.push(file); }
        }
      }
      if (last) hits = found;
      else {
        frontier = Array.from(new Set(nextIds));
        if (!frontier.length) return [];
      }
    }

    let out = hits || [];
    if (o.type) out = out.filter((n) => (o.type === 'folder' ? n.type === 'folder' : n.type === 'file'));
    // ** は同じノードを複数の経路で拾うことがある。
    const seen = new Set();
    out = out.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
    if (out.length > Vfs.MAX_MATCHES) { Vfs.truncated = true; out = out.slice(0, Vfs.MAX_MATCHES); }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  }
};

