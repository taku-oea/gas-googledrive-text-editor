/* ---------------------- ドラッグ＆ドロップ ---------------------- */

/**
 * 行にドラッグ＆ドロップを結び付ける。
 * ファイル／フォルダをフォルダ行の上に落とすと移動する。
 * ファイル行の上に落とした場合はその親フォルダへ移動する（VS Code と同じ挙動）。
 * @param {HTMLElement} row
 * @param {TreeNode} node
 */
function wireDragAndDrop(row, node) {
  if (!Tree.isRoot(node.id)) {
    row.addEventListener('dragstart', (ev) => {
      App.dragId = node.id;
      row.classList.add('row--dragging');
      // フォルダへのドロップは移動、「ピン留め」の見出しへのドロップは複製
      // （置き場所は変わらない）。effectAllowed に含まれない dropEffect を
      // 落とし先が指定すると、ブラウザがドロップ自体を取りやめるので両方許可する。
      ev.dataTransfer.effectAllowed = 'copyMove';
      // 一部ブラウザは何かセットしないと dragstart を無効にする。text/plain は
      // 使わない（本文の上で落ちると、その文字列が貼り付けられてしまう）。
      try { ev.dataTransfer.setData(DRAG_TYPE, node.id); } catch (e) { /* 無視 */ }
    });
    row.addEventListener('dragend', () => {
      App.dragId = null;
      row.classList.remove('row--dragging');
      for (const r of el.entryList.querySelectorAll('.row--dropTarget')) {
        r.classList.remove('row--dropTarget');
      }
    });
  }

  row.addEventListener('dragover', (ev) => {
    const destId = dropTargetFor(node);
    if (!destId) return;
    // OS からのファイルドロップはアップロード。
    if (isFileDrag(ev)) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      row.classList.add('row--dropTarget');
      return;
    }
    if (!App.dragId || !canDropInto(App.dragId, destId)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    row.classList.add('row--dropTarget');
  });
  row.addEventListener('dragleave', () => { row.classList.remove('row--dropTarget'); });
  row.addEventListener('drop', (ev) => {
    row.classList.remove('row--dropTarget');
    const destId = dropTargetFor(node);
    if (!destId) return;

    if (isFileDrag(ev)) {
      ev.preventDefault();
      ev.stopPropagation();
      void uploadFiles(ev.dataTransfer.files, destId);
      return;
    }

    const srcId = App.dragId;
    if (!srcId || !canDropInto(srcId, destId)) return;
    ev.preventDefault();
    ev.stopPropagation();
    // 複数選択されていれば、選択したもの全部を動かす。
    const targets = App.selection.has(srcId) ? actionableSelection() : [Tree.get(srcId)];
    void moveEntries(targets.filter(Boolean), destId);
  });
}

/** その行に落としたときの移動先フォルダ。 */
function dropTargetFor(node) {
  return node.type === 'folder' ? node.id : (node.parentId || null);
}

/**
 * 移動できる組み合わせか、クライアント側で分かる範囲だけ判定する。
 * 循環参照の最終判定はサーバー側（isDescendantOf_）で行う。
 */
function canDropInto(srcId, destId) {
  if (srcId === destId) return false;
  const src = Tree.get(srcId);
  if (!src) return false;
  if (src.parentId === destId) return false;   // すでにそこにある

  // 自分の子孫の中へは落とせない
  let cur = Tree.get(destId);
  for (let i = 0; cur && i < 30; i++) {
    if (cur.id === srcId) return false;
    cur = cur.parentId ? Tree.get(cur.parentId) : null;
  }
  return true;
}

/**
 * ファイル／フォルダを別フォルダへ移動する。
 * @param {string} srcId
 * @param {string} destFolderId
 */
/**
 * 複数のノードをまとめて移動する。
 * @param {TreeNode[]} nodes
 * @param {string} destFolderId
 */
async function moveEntries(nodes, destFolderId) {
  const movable = nodes.filter((n) => n && canDropInto(n.id, destFolderId));
  if (!movable.length) return;
  if (movable.length === 1) { await moveEntry(movable[0].id, destFolderId); return; }

  const dest = Tree.get(destFolderId);
  const go = await modal({
    title: movable.length + ' 件を移動',
    body: h('div', {}, [
      h('p', { text: '「' + (dest ? dest.name : '') + '」へ次のものを移動します。' }),
      h('p', { text: movable.map((n) => n.name).join('、') })
    ]),
    actions: [
      { label: '移動する', value: true, variant: 'primary' },
      { label: 'キャンセル', value: false }
    ]
  });
  if (!go) return;

  // 画面上は先に全部動かし、Drive への移動は並列に投げる。失敗したものだけ元へ戻す。
  const restores = new Map();
  const fromIds = new Map();
  for (const node of movable) {
    fromIds.set(node.id, node.parentId);
    restores.set(node.id, Tree.detach(node.id));
    Tree.attach(node.id, destFolderId);
    if (node.type !== 'folder') syncTempFlag(node.id, destFolderId);
  }
  if (dest) dest.expanded = true;
  App.selection.clear();
  renderTree();
  Session.save();

  const results = await Promise.allSettled(movable.map((node) =>
    (node.type === 'folder' ? Api.moveFolder(node.id, destFolderId) : Api.moveFile(node.id, destFolderId))));
  const failed = [];
  results.forEach((r, i) => {
    const node = movable[i];
    if (r.status === 'fulfilled') {
      if (node.type !== 'folder' && node.entry && r.value && r.value.updatedAtIso) Object.assign(node.entry, r.value);
      return;
    }
    Tree.detach(node.id);
    restores.get(node.id)();
    if (node.type !== 'folder') syncTempFlag(node.id, fromIds.get(node.id));
    failed.push(node.name + '（' + (r.reason && r.reason.message ? r.reason.message : r.reason) + '）');
  });
  if (dest && !dest.loaded) void loadFolder(destFolderId, false);
  renderTree();
  if (failed.length) toast('移動できなかったもの: ' + failed.join('、'), 'error', 12000);
  else toast(movable.length + ' 件を移動しました', 'info', 4000);
}

/**
 * 移動したファイルの「一時メモかどうか」をタブ側にも反映する。
 *
 * ツリーから一時メモを引きずり出すのは、保存先を決めるもう 1 つの経路。
 * 逆に普通のファイルを一時メモへ放り込めば一時メモとして扱われる。
 * どちらも置き場所（tmp の中か外か）だけで決まる。
 *
 * @param {string} fileId
 * @param {string} destFolderId
 */
function syncTempFlag(fileId, destFolderId) {
  const tab = getTab(fileId);
  if (!tab) return;
  const nowTemp = Tree.isTmpRoot(destFolderId);
  if (tab.temp === nowTemp) return;
  tab.temp = nowTemp;
  renderTabs();
  if (fileId === App.activeId) refreshStatus();
}

async function moveEntry(srcId, destFolderId) {
  const src = Tree.get(srcId);
  const dest = Tree.get(destFolderId);
  if (!src || !dest) return;
  const fromId = src.parentId;

  // ルートをまたぐ移動は、別のドライブへ移す可能性がある。
  // 共有ドライブをまたぐと所有者が変わるので、黙って実行しない。
  const srcRoot = Tree.rootOf(srcId);
  const destRoot = Tree.rootOf(destFolderId);
  if (srcRoot && destRoot && srcRoot !== destRoot) {
    const srcRootName = (Tree.get(srcRoot) || {}).name || '';
    const destRootName = (Tree.get(destRoot) || {}).name || '';
    const go = await modal({
      title: '別のフォルダへ移動します',
      body: h('div', {}, [
        h('p', { text: '「' + src.name + '」を' }),
        h('p', { text: srcRootName + ' → ' + destRootName }),
        h('p', { text: 'へ移動します。移動先が共有ドライブの場合、' +
          'ファイルの所有者が共有ドライブに変わり、元に戻すには再度の移動が必要です。' })
      ]),
      actions: [
        { label: '移動する', value: true, variant: 'danger' },
        { label: 'キャンセル', value: false, variant: 'primary' }
      ]
    });
    if (!go) return;
  }

  // 画面上は先に動かし、Drive への移動は裏で送る。失敗したら元の場所へ戻す。
  const wasExpanded = dest.expanded;
  void optimistic({
    apply: () => {
      const restore = Tree.detach(srcId);
      Tree.attach(srcId, destFolderId);
      dest.expanded = true;
      if (src.type !== 'folder') syncTempFlag(srcId, destFolderId);
      renderTree();
      return () => {
        Tree.detach(srcId);
        restore();
        dest.expanded = wasExpanded;
        if (src.type !== 'folder') syncTempFlag(srcId, fromId);
        renderTree();
      };
    },
    commit: () => (src.type === 'folder'
      ? Api.moveFolder(srcId, destFolderId)
      : Api.moveFile(srcId, destFolderId)),
    onCommit: (res) => {
      if (src.type !== 'folder' && src.entry && res && res.updatedAtIso) Object.assign(src.entry, res);
      // 移動先が未読込なら、開いて見せるために一覧を取る（移動したものはそこで現れる）。
      if (!dest.loaded) void loadFolder(destFolderId, false);
      renderTree();
    },
    success: () => '「' + src.name + '」を「' + dest.name + '」へ移動しました',
    failure: '「' + src.name + '」を移動できませんでした'
  }).catch(() => { /* トースト済み */ });
}

