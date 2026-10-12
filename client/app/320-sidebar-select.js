/* ---------------------- 選択（複数対応） ---------------------- */

/**
 * ツリーの選択を更新する。
 *
 * 素のクリックは単独選択、Cmd/Ctrl は追加・解除、Shift は範囲選択。
 * 範囲は画面に並んでいる順（flatten の順）で取る。
 *
 * @param {string} nodeId
 * @param {{meta?:boolean, shift?:boolean}} mods
 */
function selectNode(nodeId, mods = {}) {
  if (mods.meta) {
    if (App.selection.has(nodeId)) App.selection.delete(nodeId);
    else App.selection.add(nodeId);
    App.selectedId = nodeId;
    renderTreeStates();
    return;
  }

  if (mods.shift && App.selectedId && App.selectedId !== nodeId) {
    const order = Tree.flatten().map((r) => r.node.id);
    const from = order.indexOf(App.selectedId);
    const to = order.indexOf(nodeId);
    if (from >= 0 && to >= 0) {
      App.selection = new Set(order.slice(Math.min(from, to), Math.max(from, to) + 1));
      App.selectedId = nodeId;
      renderTreeStates();
      return;
    }
  }

  App.selection = new Set([nodeId]);
  App.selectedId = nodeId;
  renderTreeStates();
}

/** 選択中のノード（画面の並び順）。 */
function selectedNodes() {
  const order = Tree.flatten().map((r) => r.node);
  return order.filter((n) => App.selection.has(n.id));
}

/** 選択の中で「実際に操作していいもの」だけ。ルートは除く。 */
function actionableSelection() {
  return selectedNodes().filter((n) => !Tree.isRoot(n.id));
}

/**
 * 選択したものをまとめてゴミ箱へ移す。
 * @param {TreeNode[]} nodes
 */
async function trashNodes(nodes) {
  if (!nodes.length) return;
  if (nodes.length === 1) {
    if (nodes[0].type === 'folder') await doTrashFolder(nodes[0]);
    else await doTrash(nodes[0]);
    return;
  }

  const openInside = App.tabs.filter((t) => nodes.some(
    (n) => n.id === t.id || isInsideFolder(t.id, n.id)));
  const dirty = openInside.filter((t) => t.dirty);

  const go = await modal({
    title: nodes.length + ' 件をゴミ箱へ移動',
    body: h('div', {}, [
      h('p', { text: '次の ' + nodes.length + ' 件を Drive のゴミ箱へ移動します。' }),
      h('p', { text: nodes.map((n) => n.name).join('、') }),
      dirty.length
        ? h('p', { text: 'うち ' + dirty.map((t) => t.name).join('、') +
            ' には未保存の変更があります。' })
        : null,
      h('p', { text: 'ゴミ箱からは復元できます。' })
    ]),
    actions: [
      { label: 'ゴミ箱へ移動', value: true, variant: 'danger' },
      { label: 'キャンセル', value: false, variant: 'primary' }
    ]
  });
  if (!go) return;

  // 先にタブを閉じてツリーから外し、Drive への移動は並列に投げる。失敗したものだけ戻す。
  for (const tab of openInside) await closeTab(tab.id, { force: true });
  const restores = new Map();
  for (const node of nodes) {
    Draft.clear(node.id);
    if (App.clipboard && App.clipboard.id === node.id) App.clipboard = null;
    restores.set(node.id, Tree.detach(node.id));
  }
  App.selection.clear();
  renderTree();
  Session.save();

  const results = await Promise.allSettled(nodes.map((node) =>
    (node.type === 'folder' ? Api.trashFolder(node.id) : Api.trashFile(node.id))));
  const failed = [];
  results.forEach((r, i) => {
    const node = nodes[i];
    if (r.status === 'fulfilled') {
      if (node.type === 'folder') Pins.removeUnder(node.id);
      else Pins.remove(node.id);
      Tree.remove(node.id);
    } else {
      restores.get(node.id)();
      failed.push(node.name + '（' + (r.reason && r.reason.message ? r.reason.message : r.reason) + '）');
    }
  });
  renderTree();
  Session.save();

  if (failed.length) {
    toast('移動できなかったもの: ' + failed.join('、'), 'error', 12000);
  } else {
    toast(nodes.length + ' 件をゴミ箱へ移動しました', 'info', 4000);
  }
}

