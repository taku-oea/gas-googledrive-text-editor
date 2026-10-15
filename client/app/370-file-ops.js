/* ------------------------------------------------------------------ *
 *  ファイル操作（作成・複製・改名・移動・削除）
 * ------------------------------------------------------------------ */

/**
 * クリップボードへコピーする（実際の複製は貼り付け時）。
 * @param {TreeNode} node
 */
function doCopyToClipboard(node) {
  App.clipboard = { id: node.id, name: node.name, kind: 'file' };
  toast('「' + node.name + '」をコピーしました。フォルダを' + (Mobile.on ? '長押し' : '右クリック') + 'して貼り付けてください。', 'info', 4500);
}

/**
 * クリップボードのファイルを貼り付ける。
 * @param {string} folderId
 */
async function doPaste(folderId) {
  const clip = App.clipboard;
  if (!clip) return;
  const dest = Tree.get(folderId);
  if (!dest) return;

  try {
    const entry = await Api.copyFile(clip.id, folderId, null);
    dest.expanded = true;
    if (dest.loaded) Tree.insertChild(folderId, entry);
    else void loadFolder(folderId, false);
    renderTree();
    toast('「' + entry.name + '」として貼り付けました', 'info', 4000);
    Session.save();
  } catch (err) {
    toast('貼り付けできませんでした: ' + err.message, 'error', 10000);
  }
}

/**
 * 同じフォルダに複製する。
 * @param {TreeNode} node
 */
async function doDuplicate(node) {
  const folderId = node.parentId || Tree.rootIds[0];
  if (!folderId) return;
  try {
    const entry = await Api.copyFile(node.id, folderId, null);
    Tree.insertChild(folderId, entry);
    renderTree();
    toast('「' + entry.name + '」を作成しました', 'info', 4000);
  } catch (err) {
    toast('複製できませんでした: ' + err.message, 'error', 10000);
  }
}

/**
 * ファイルをゴミ箱へ移動する。
 * @param {TreeNode} node
 */
async function doTrash(node) {
  const tab = getTab(node.id);
  const go = await modal({
    title: 'ゴミ箱へ移動',
    body: h('div', {}, [
      h('p', { text: '「' + node.name + '」を Drive のゴミ箱へ移動します。' }),
      tab && tab.dirty
        ? h('p', { text: 'このファイルには未保存の変更があります。移動すると失われます。' })
        : null,
      h('p', { text: 'ゴミ箱からは復元できます。' })
    ]),
    actions: [
      { label: 'ゴミ箱へ移動', value: true, variant: 'danger' },
      { label: 'キャンセル', value: false, variant: 'primary' }
    ]
  });
  if (!go) return;

  // closeTab は未保存なら下書きを flush する。下書きを消すのはゴミ箱へ移せてから
  // （権限不足などで失敗すると開き直すので、そのとき下書きから復元できるように）。
  const hadTab = !!getTab(node.id);
  if (hadTab) await closeTab(node.id, { force: true });
  if (App.clipboard && App.clipboard.id === node.id) App.clipboard = null;

  // ツリーからは先に消し、往復は待たない。失敗したら戻して知らせる。
  void optimistic({
    apply: () => {
      const restore = Tree.detach(node.id);
      renderTree();
      return () => {
        restore();
        renderTree();
        if (hadTab && node.entry) void openEntry(node.entry, { ephemeral: false });
      };
    },
    commit: () => Api.trashFile(node.id),
    onCommit: () => { Draft.clear(node.id); Pins.remove(node.id); Tree.remove(node.id); renderTree(); },
    success: () => '「' + node.name + '」をゴミ箱へ移動しました',
    failure: '「' + node.name + '」をゴミ箱へ移動できませんでした'
  }).catch(() => { /* トースト済み */ });
}

/**
 * フォルダをゴミ箱へ移動する。中のファイルを開いていれば閉じる。
 * @param {TreeNode} node
 */
async function doTrashFolder(node) {
  const openInside = App.tabs.filter((t) => isInsideFolder(t.id, node.id));
  const dirtyInside = openInside.filter((t) => t.dirty);

  const go = await modal({
    title: 'フォルダをゴミ箱へ移動',
    body: h('div', {}, [
      h('p', { text: '「' + node.name + '」を中身ごと Drive のゴミ箱へ移動します。' }),
      openInside.length
        ? h('p', { text: 'このフォルダ内で開いているタブ（' +
            openInside.map((t) => t.name).join('、') + '）は閉じられます。' })
        : null,
      dirtyInside.length
        ? h('p', { text: 'うち ' + dirtyInside.map((t) => t.name).join('、') +
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

  for (const tab of openInside) await closeTab(tab.id, { force: true });

  void optimistic({
    apply: () => {
      const restore = Tree.detach(node.id);
      renderTree();
      return () => { restore(); renderTree(); };
    },
    commit: () => Api.trashFolder(node.id),
    // 配下の判定にツリーが要るので、Tree.remove より先に外す。
    onCommit: () => { Pins.removeUnder(node.id); Tree.remove(node.id); renderTree(); },
    success: () => '「' + node.name + '」をゴミ箱へ移動しました',
    failure: '「' + node.name + '」をゴミ箱へ移動できませんでした'
  }).catch(() => { /* トースト済み */ });
}

/**
 * fileId がツリー上で folderId の配下にあるか。
 * ツリーに載っていない（未展開の）ものは判定できないので false を返す。
 */
function isInsideFolder(fileId, folderId) {
  let node = Tree.get(fileId);
  for (let i = 0; node && i < 30; i++) {
    if (node.parentId === folderId) return true;
    node = node.parentId ? Tree.get(node.parentId) : null;
  }
  return false;
}

