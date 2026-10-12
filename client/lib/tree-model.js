/**
 * client/lib/tree-model.js — サイドバーのフォルダツリーのデータモデル（ノードの Map・ルート・並べ替え・パス）。
 *
 * 依存の無い純粋な部分を client/app から切り出した ES モジュール。
 * client/app 側からは tools/build-app.mjs がつなぐので、同じ名前のまま参照できる。
 */

/**
 * @typedef {{
 *   id: string, name: string, type: ('folder'|'file'), parentId: (string|null),
 *   entry: (Object|null),
 *   expanded: boolean, loaded: boolean, loading: boolean,
 *   childFolderIds: string[], childFileIds: string[]
 * }} TreeNode
 */

export const Tree = {
  /** @type {Map<string, TreeNode>} */
  nodes: new Map(),

  /** @type {string[]} 最上位に並べるフォルダ。複数のドライブをまたげる。 */
  rootIds: [],

  /**
   * 「一時メモ」セクション（tmp フォルダ）。常に最上段に出す固定ルートで、
   * rootIds とは別に持つ。ユーザーが外したり並べ替えたりできないものを
   * rootIds に混ぜると、外す／保存する／数を数えるといった処理すべてに
   * 例外条件が要るため。
   * @type {string|null}
   */
  tmpRootId: null,

  get(id) { return Tree.nodes.get(id) || null; },

  isRoot(id) { return Tree.isTmpRoot(id) || Tree.rootIds.indexOf(id) >= 0; },

  isTmpRoot(id) { return !!Tree.tmpRootId && id === Tree.tmpRootId; },

  /** 一時メモを含めた、描画順の最上位フォルダ。 */
  allRootIds() {
    return Tree.tmpRootId ? [Tree.tmpRootId].concat(Tree.rootIds) : Tree.rootIds.slice();
  },

  /** ルートを作り直す（起動時・ルートの追加／削除後）。 */
  reset(roots) {
    Tree.nodes = new Map();
    Tree.rootIds = [];
    Tree.tmpRootId = null;
    for (const root of roots) Tree.addRoot(root);
  },

  /**
   * 「一時メモ」セクションを用意する（既にあれば名前だけ更新）。
   * @param {{id:string, name:string}} folder tmp フォルダ
   */
  setTmpRoot(folder) {
    if (!folder || !folder.id) return;
    const existing = Tree.get(folder.id);
    if (existing) {
      // 「Googleドライブテキストエディタ」フォルダ自体をルートに追加していると、
      // tmp が誰かの子として既に載っている。親から外してから固定セクションに
      // 昇格させないと、同じフォルダが 2 行に出てしまう。
      const parent = existing.parentId ? Tree.get(existing.parentId) : null;
      if (parent) {
        parent.childFolderIds = parent.childFolderIds.filter((id) => id !== folder.id);
      }
      existing.name = '一時メモ';
      existing.parentId = null;
    } else {
      Tree.nodes.set(folder.id, {
        id: folder.id, name: '一時メモ', type: 'folder', parentId: null, entry: null,
        // 既定では畳んでおく。開いた時点で初めて中身を取りに行く。
        expanded: false, loaded: false, loading: false,
        childFolderIds: [], childFileIds: []
      });
    }
    Tree.tmpRootId = folder.id;
  },

  /** ルートを 1 つ足す。既にあれば名前だけ更新する。 */
  addRoot(root) {
    const existing = Tree.get(root.id);
    if (existing) {
      existing.name = root.name;
      existing.parentId = null;
    } else {
      Tree.nodes.set(root.id, {
        id: root.id, name: root.name, type: 'folder', parentId: null, entry: null,
        expanded: true, loaded: false, loading: false,
        childFolderIds: [], childFileIds: []
      });
    }
    if (!Tree.isRoot(root.id)) Tree.rootIds.push(root.id);
  },

  /** ルートを 1 つ外す。配下のノードも Map から落とす。 */
  removeRoot(rootId) {
    Tree.rootIds = Tree.rootIds.filter((id) => id !== rootId);
    Tree.remove(rootId);
  },

  /**
   * listEntries / listEntriesMulti の戻り値をノードへ取り込む。
   * @param {string} folderId
   * @param {{folders:Array, files:Array, truncated:boolean}} data
   */
  ingest(folderId, data) {
    const parent = Tree.get(folderId);
    if (!parent) return;

    // 再読み込みで消えていた子は Map からも消す。
    // 残したままだと、絞り込み（Map 全走査）に削除済みファイルが出続ける。
    const before = new Set(parent.childFolderIds.concat(parent.childFileIds));
    const after = new Set(
      (data.folders || []).map((f) => f.id).concat((data.files || []).map((f) => f.id)));
    for (const id of before) {
      if (!after.has(id)) Tree.remove(id);
    }

    parent.childFolderIds = [];
    parent.childFileIds = [];
    parent.truncated = !!data.truncated;
    parent.listedAt = Date.now();
    parent.sig = folderSig(data);

    for (const f of data.folders || []) {
      // tmp は最上段の固定セクションとして別に出しているので、
      // 親フォルダの子としては並べない（同じフォルダが 2 行に出る）。
      if (Tree.isTmpRoot(f.id)) continue;
      const existing = Tree.get(f.id);
      Tree.nodes.set(f.id, existing
        ? Object.assign(existing, { name: f.name, parentId: folderId })
        : {
            id: f.id, name: f.name, type: 'folder', parentId: folderId, entry: null,
            expanded: false, loaded: false, loading: false,
            childFolderIds: [], childFileIds: []
          });
      parent.childFolderIds.push(f.id);
    }

    for (const file of data.files || []) {
      Tree.nodes.set(file.id, {
        id: file.id, name: file.name, type: 'file', parentId: folderId, entry: file,
        expanded: false, loaded: true, loading: false,
        childFolderIds: [], childFileIds: []
      });
      parent.childFileIds.push(file.id);
    }

    parent.loaded = true;
    parent.loading = false;
  },

  /**
   * 親の子リストから外す（Map には残す）。楽観的更新の途中で元に戻せるよう、戻し関数を返す。
   * @param {string} id
   * @return {function()} 元の親・元の位置へ戻す
   */
  detach(id) {
    const node = Tree.get(id);
    const parentId = node ? node.parentId : null;
    const parent = parentId ? Tree.get(parentId) : null;
    if (!node || !parent) return () => {};
    const listName = node.type === 'folder' ? 'childFolderIds' : 'childFileIds';
    const index = parent[listName].indexOf(id);
    if (index >= 0) parent[listName].splice(index, 1);
    return () => {
      node.parentId = parentId;
      const p = Tree.get(parentId);
      if (!p || p[listName].indexOf(id) >= 0) return;
      p[listName].splice(Math.min(index < 0 ? p[listName].length : index, p[listName].length), 0, id);
    };
  },

  /** 別の親の下へ付ける。親が未読込なら Map 上の親だけ変え、次の読み込みで一覧に現れる。 */
  attach(id, parentId) {
    const node = Tree.get(id);
    const parent = Tree.get(parentId);
    if (!node || !parent) return;
    node.parentId = parentId;
    if (!parent.loaded) return;
    const listName = node.type === 'folder' ? 'childFolderIds' : 'childFileIds';
    if (parent[listName].indexOf(id) < 0) parent[listName].push(id);
    sortChildren(parentId);
  },

  /**
   * 作成・複製で返ってきた 1 件を親の下に足す（一覧を取り直さない）。
   * @param {string} parentId
   * @param {Object} item フォルダなら {id, name, type:'folder'}、ファイルなら listEntries の files の 1 件
   */
  insertChild(parentId, item) {
    const parent = Tree.get(parentId);
    if (!parent || !item || !item.id || Tree.get(item.id)) return;
    if (item.type === 'folder') {
      Tree.nodes.set(item.id, {
        id: item.id, name: item.name, type: 'folder', parentId, entry: null,
        expanded: false, loaded: false, loading: false, childFolderIds: [], childFileIds: []
      });
      parent.childFolderIds.push(item.id);
    } else {
      Tree.nodes.set(item.id, {
        id: item.id, name: item.name, type: 'file', parentId, entry: item,
        expanded: false, loaded: true, loading: false, childFolderIds: [], childFileIds: []
      });
      parent.childFileIds.push(item.id);
    }
    parent.loaded = true;
    sortChildren(parentId);
  },

  /** ノードとその子孫を Map から取り除く。 */
  remove(id) {
    const node = Tree.get(id);
    if (!node) return;
    for (const childId of node.childFolderIds.concat(node.childFileIds)) Tree.remove(childId);
    const parent = node.parentId ? Tree.get(node.parentId) : null;
    if (parent) {
      parent.childFolderIds = parent.childFolderIds.filter((x) => x !== id);
      parent.childFileIds = parent.childFileIds.filter((x) => x !== id);
    }
    Tree.nodes.delete(id);
    Tree.onRemoved(id);
  },

  /**
   * ノードを 1 つ消したあとに呼ぶ（子から順に 1 件ずつ）。モデルの外の後始末
   * （ファイル名の索引・閉じたタブの記録）は client/app 側がここに差し込む。
   * @param {string} id
   */
  onRemoved(id) {},

  /**
   * 展開中のフォルダ ID（セッション保存用）。ルートも含める。
   * ルートを畳んだ状態も覚えたいので、除外しない。
   */
  expandedIds() {
    const out = [];
    for (const node of Tree.nodes.values()) {
      if (node.type === 'folder' && node.expanded) out.push(node.id);
    }
    return out;
  },

  /**
   * 描画順にノードを並べる。折りたたまれたフォルダの下は含めない。
   * パスは親のパスに名前を足して組み立てる（行ごとに祖先を遡らないため）。
   */
  flatten() {
    const rows = [];
    const walk = (id, depth, path) => {
      const node = Tree.get(id);
      if (!node) return;
      const full = path ? path + ' / ' + node.name : node.name;
      rows.push({ node, depth, path: full });
      if (node.type !== 'folder' || !node.expanded) return;
      for (const childId of node.childFolderIds) walk(childId, depth + 1, full);
      for (const childId of node.childFileIds) walk(childId, depth + 1, full);
    };
    // ルート自身も行として出す。複数あるので見出しが無いと区別できない。
    // 一時メモは常に先頭（allRootIds が先に並べている）。
    for (const rootId of Tree.allRootIds()) walk(rootId, 0, '');
    return rows;
  },

  /** ノードが属するルートを返す（移動がドライブをまたぐかの判定に使う）。 */
  rootOf(id) {
    let node = Tree.get(id);
    for (let i = 0; node && i < 40; i++) {
      if (Tree.isRoot(node.id)) return node.id;
      node = node.parentId ? Tree.get(node.parentId) : null;
    }
    return null;
  },

  /** 読み込み済みのファイルノード全部（クイックオープン用）。 */
  allFiles() {
    const out = [];
    for (const node of Tree.nodes.values()) {
      if (node.type === 'file' && node.entry && node.entry.openable) out.push(node);
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    return out;
  },

  /** 絞り込み用。読み込み済みのファイルノードから一致するものを集める。 */
  matchingFiles(needle) {
    const out = [];
    for (const node of Tree.nodes.values()) {
      if (node.type === 'file' && node.name.toLowerCase().includes(needle)) out.push(node);
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    return out;
  },

  /**
   * 親を遡ってパスを組み立てる。
   * 描画のホットパスでは使わない（flatten が親のパスを引き継ぐ）。
   * 絞り込み表示のように親子が飛ぶ場面でのみ呼ぶ。
   */
  pathOf(id) {
    const parts = [];
    let node = Tree.get(id);
    for (let i = 0; node && i < 20; i++) {
      parts.unshift(node.name);
      node = node.parentId ? Tree.get(node.parentId) : null;
    }
    return parts.join(' / ');
  }
};

/** 子ノードを名前順に並べ直す（改名・作成のあと）。 */
export function sortChildren(folderId) {
  const parent = Tree.get(folderId);
  if (!parent) return;
  const byName = (a, b) => {
    const na = Tree.get(a), nb = Tree.get(b);
    return (na && nb) ? na.name.localeCompare(nb.name, 'ja') : 0;
  };
  parent.childFolderIds.sort(byName);
  parent.childFileIds.sort(byName);
}

/** 一覧の同一性を見るための署名。id・名前・更新日時・サイズが同じなら描き直さない。 */
export function folderSig(listing) {
  if (!listing) return '';
  const SEP = String.fromCharCode(1);
  const REC = String.fromCharCode(2);
  const PART = String.fromCharCode(3);
  return (listing.folders || []).map((f) => f.id + SEP + f.name).join(REC) + PART +
    (listing.files || []).map((f) => f.id + SEP + f.name + SEP + f.updatedAtIso + SEP + f.size).join(REC);
}
