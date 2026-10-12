/* ---------------------- キーボード操作 ---------------------- */

/**
 * ツリーのキーボード操作。
 * VS Code のエクスプローラと同じ割り当て。
 *
 * ↑↓ 移動 / → 展開・子へ / ← 折りたたみ・親へ / Enter 開く（固定タブ）
 * Space 仮タブで開く / F2 改名 / Delete ゴミ箱 / Alt+N 新規ファイル
 * Home End 先頭・末尾
 *
 * @param {KeyboardEvent} ev
 */
function onTreeKeyDown(ev) {
  // 入力欄（絞り込み・インライン編集）の中では何もしない。
  if (ev.target && /^(INPUT|TEXTAREA)$/.test(ev.target.tagName)) return;
  if (App.inlineEdit) return;

  const rows = Tree.flatten();
  if (!rows.length) return;

  let index = rows.findIndex((r) => r.node.id === App.selectedId);
  const current = index >= 0 ? rows[index].node : null;

  const focusRow = (i, extend) => {
    const target = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!target) return;
    if (extend) App.selection.add(target.node.id);
    else App.selection = new Set([target.node.id]);
    App.selectedId = target.node.id;
    renderTreeStates();
    // 同じファイルがピン留めにも出ていることがある。カーソルはツリー側の行。
    const node = el.entryList.querySelector(
      '.row:not(.row--pin)[data-node-id="' + CSS.escape(target.node.id) + '"]');
    if (node) node.scrollIntoView({ block: 'nearest' });
  };

  switch (ev.key) {
    case 'ArrowDown':
      ev.preventDefault();
      focusRow(index < 0 ? 0 : index + 1, ev.shiftKey);
      return;

    case 'ArrowUp':
      ev.preventDefault();
      focusRow(index < 0 ? 0 : index - 1, ev.shiftKey);
      return;

    case 'a':
      if (ev.metaKey || ev.ctrlKey) {
        ev.preventDefault();
        App.selection = new Set(rows.map((r) => r.node.id));
        renderTreeStates();
      }
      return;

    case 'Home':
      ev.preventDefault();
      focusRow(0);
      return;

    case 'End':
      ev.preventDefault();
      focusRow(rows.length - 1);
      return;

    case 'ArrowRight':
      ev.preventDefault();
      if (!current) return;
      // 閉じたフォルダなら開く。開いているなら最初の子へ。
      if (current.type === 'folder' && !current.expanded) void toggleFolder(current.id);
      else focusRow(index + 1);
      return;

    case 'ArrowLeft':
      ev.preventDefault();
      if (!current) return;
      if (current.type === 'folder' && current.expanded) {
        void toggleFolder(current.id);
      } else if (current.parentId && Tree.get(current.parentId)) {
        const parentIndex = rows.findIndex((r) => r.node.id === current.parentId);
        if (parentIndex >= 0) focusRow(parentIndex);
      }
      return;

    case 'Enter':
      ev.preventDefault();
      if (!current) return;
      if (current.type === 'folder') void toggleFolder(current.id);
      else if (current.entry && current.entry.openable) {
        void openEntry(current.entry, { ephemeral: false });
      }
      return;

    case ' ':
      ev.preventDefault();
      if (current && current.type === 'file' && current.entry && current.entry.openable) {
        void openEntry(current.entry, { ephemeral: true });
      }
      return;

    case 'F2':
      ev.preventDefault();
      if (current) startInlineRename(current);
      return;

    case 'Delete':
    case 'Backspace': {
      ev.preventDefault();
      const targets = actionableSelection();
      if (targets.length) void trashNodes(targets);
      return;
    }

    case 'n':
    case 'N':
      if (ev.altKey) {
        ev.preventDefault();
        startInlineCreate(ev.shiftKey ? 'newFolder' : 'newFile', targetFolderId());
      }
      return;

    default:
      return;
  }
}

