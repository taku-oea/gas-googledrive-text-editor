/**
 * client/lib/pane-tree.js — ペインの木（エディタの分割）の形だけを扱う純粋な関数。
 *
 * client/app/030-panes.js の Panes は、木の形の操作と DOM の組み立てを同じメソッドで
 * 行っていた。ここには形の操作だけを移し、ノードを作る（DOM を持たせる）のは
 * 呼び出し側から渡す関数に任せる。どの関数も DOM・Panes・画面の状態に触らない。
 *
 * ノードの形（Panes.createLeaf / createSplit が作るもの。ここで使うのはこの項目だけ）:
 *   leaf  … { id, type: 'leaf',  parent, tabIds: string[], activeId, size }
 *   split … { id, type: 'split', parent, dir: 'row'|'col', children: Node[], size }
 * size は兄弟との取り分（flex-grow）。合計がいくつでも構わない。
 */

/** 木を左上から順に辿って leaf を並べる。 */
export function paneLeaves(root) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (n.type === 'leaf') out.push(n);
    else n.children.forEach(walk);
  })(root);
  return out;
}

/** タブが載っている leaf（無ければ null）。 */
export function paneLeafOf(root, tabId) {
  if (!tabId) return null;
  for (const leaf of paneLeaves(root)) {
    if (leaf.tabIds.indexOf(tabId) >= 0) return leaf;
  }
  return null;
}

/** タブを leaf に足す。index を省くと末尾。既に載っていれば何もしない。 */
export function paneAddTab(leaf, tabId, index) {
  if (!leaf || leaf.tabIds.indexOf(tabId) >= 0) return;
  if (index == null || index < 0 || index > leaf.tabIds.length) leaf.tabIds.push(tabId);
  else leaf.tabIds.splice(index, 0, tabId);
}

/**
 * タブを leaf から外す。表示中だったら隣のタブに送る。
 * @return {Object|null} 外した leaf（どこにも載っていなければ null）
 */
export function paneRemoveTab(root, tabId) {
  const leaf = paneLeafOf(root, tabId);
  if (!leaf) return null;
  const i = leaf.tabIds.indexOf(tabId);
  leaf.tabIds.splice(i, 1);
  if (leaf.activeId === tabId) {
    leaf.activeId = leaf.tabIds[Math.min(i, leaf.tabIds.length - 1)] || null;
  }
  return leaf;
}

/**
 * leaf の隣に fresh を差し込む（Panes.split の形の部分）。
 * 同じ向きの枝の中なら並べるだけ（取り分は配り直す）。向きが変わるなら枝を 1 つ挟む。
 * @param {Object} root いまの根
 * @param {Object} leaf 分割元
 * @param {Object} fresh 新しい leaf（parent / size はここで決める）
 * @param {'row'|'col'} dir
 * @param {boolean} after true なら右／下
 * @param {function(string, Object, number): Object} makeSplit (dir, parent, size) → 枝
 * @return {Object} 新しい根
 */
export function paneInsertBeside(root, leaf, fresh, dir, after, makeSplit) {
  const parent = leaf.parent;
  if (parent && parent.dir === dir) {
    // 同じ向きの枝には並べるだけ。深さを増やさないほうが境目の扱いが素直。
    const i = parent.children.indexOf(leaf);
    fresh.parent = parent;
    parent.children.splice(after ? i + 1 : i, 0, fresh);
    // 取り分は配り直す。分割元が半分ずつ譲っていくと、3 枚目・4 枚目が
    // みるみる細くなって使いものにならなくなる。
    for (const child of parent.children) child.size = 1;
    return root;
  }
  // 向きが変わるので、この位置に枝を 1 つ挟む。
  const node = makeSplit(dir, parent, leaf.size);
  if (parent) parent.children[parent.children.indexOf(leaf)] = node;
  else root = node;
  leaf.parent = node;
  leaf.size = 1;
  fresh.parent = node;
  fresh.size = 1;
  node.children = after ? [leaf, fresh] : [fresh, leaf];
  return root;
}

/**
 * 木全体の外側に fresh を足す（Panes.splitRoot の形の部分）。
 * @return {Object} 新しい根
 */
export function paneInsertOutside(root, fresh, dir, after, makeSplit) {
  if (root.type === 'split' && root.dir === dir) {
    // 根が同じ向きなら、その端に並べるだけ。
    fresh.parent = root;
    root.children.splice(after ? root.children.length : 0, 0, fresh);
    for (const child of root.children) child.size = 1;
    return root;
  }
  const node = makeSplit(dir, null, 1);
  root.parent = node;
  root.size = 1;
  fresh.parent = node;
  fresh.size = 1;
  node.children = after ? [root, fresh] : [fresh, root];
  return node;
}

/**
 * leaf を木から外す（Panes.drop の形の部分）。子が 1 つだけになった枝は、
 * その子を自分の位置へ繰り上げて消す。最後の 1 枚（親が無い leaf）は外さない。
 * @return {{root:Object, removed:boolean, collapsed:(Object|null)}}
 *   collapsed … 畳んだ枝（呼び出し側が DOM と索引から消す）
 */
export function paneDetach(root, leaf) {
  const parent = leaf.parent;
  if (!parent) return { root, removed: false, collapsed: null };
  parent.children.splice(parent.children.indexOf(leaf), 1);
  if (parent.children.length !== 1) return { root, removed: true, collapsed: null };
  const only = parent.children[0];
  const gp = parent.parent;
  only.size = parent.size;
  only.parent = gp;
  if (gp) gp.children[gp.children.indexOf(parent)] = only;
  else root = only;
  return { root, removed: true, collapsed: parent };
}

/**
 * セッションに残す形。タブ ID と表示中タブ、取り分だけを持つ。
 * 取り分は 9KB 制限のある置き場所に入るので、小数 2 桁で足りる。
 * @param {Object|null} root
 * @param {function(string): boolean} [keep] 残してよいタブ ID か
 */
export function paneSerialize(root, keep) {
  const size = (v) => Math.round((v > 0 ? v : 1) * 100) / 100;
  const walk = (n) => {
    if (n.type === 'leaf') {
      const tabs = keep ? n.tabIds.filter(keep) : n.tabIds.slice();
      return {
        t: 'l', size: size(n.size), tabs,
        active: tabs.indexOf(n.activeId) >= 0 ? n.activeId : (tabs[0] || null)
      };
    }
    return { t: 's', dir: n.dir, size: size(n.size), ch: n.children.map(walk) };
  };
  return root ? walk(root) : null;
}

/**
 * セッションの形から木を組み直す。復元できるタブだけを載せる。
 * @param {Object|null} data paneSerialize() の形
 * @param {function(string): boolean} keep そのタブ ID を載せてよいか
 * @param {{max:number, makeLeaf:function():Object,
 *          makeSplit:function(string, Object, number):Object,
 *          forget:function(Object)}} f
 *   forget … 作ったが要らなくなった枝（呼び出し側の索引から消す）
 * @return {Object|null} 新しい根（組み直せなければ null）
 */
export function paneRestore(data, keep, f) {
  if (!data || (data.t !== 's' && data.t !== 'l')) return null;
  let count = 0;

  const walk = (spec, parent) => {
    if (!spec) return null;
    if (spec.t !== 's' || !Array.isArray(spec.ch) || spec.ch.length < 2) {
      if (count >= f.max) return null;
      count++;
      const leaf = f.makeLeaf();
      leaf.parent = parent;
      leaf.size = Number(spec.size) > 0 ? Number(spec.size) : 1;
      leaf.tabIds = (Array.isArray(spec.tabs) ? spec.tabs : []).filter(keep);
      leaf.activeId = leaf.tabIds.indexOf(spec.active) >= 0 ? spec.active : (leaf.tabIds[0] || null);
      return leaf;
    }
    const node = f.makeSplit(spec.dir, parent, Number(spec.size));
    for (const child of spec.ch) {
      const c = walk(child, node);
      if (c) node.children.push(c);
    }
    if (!node.children.length) { f.forget(node); return null; }
    if (node.children.length === 1) {
      // 1 枚に減ったなら枝は要らない。子を自分の位置へ繰り上げる。
      const only = node.children[0];
      only.parent = parent;
      only.size = node.size;
      f.forget(node);
      return only;
    }
    return node;
  };

  return walk(data, null);
}
