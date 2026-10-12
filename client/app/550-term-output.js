/* ---------------------- 出力の行 ---------------------- */

/** 一覧の 1 行（クリックで開く／フォルダなら移動する）。 */
function termEntryRow(ctx, node, long, withPath) {
  const isFolder = node.type === 'folder';
  const entry = node.entry;
  const open = isFolder || (entry && entry.openable);
  const label = (withPath ? Vfs.pathOf(node.id) : node.name) + (isFolder ? '/' : '');

  const parts = [
    h('span', { class: 'term__rowIcon' }, [
      icon(isFolder ? 'folder' : (entry && entry.viewer === 'embed' ? 'file' : 'file-text'),
        isFolder ? 'icon--folder' : 'icon--file')
    ]),
    h('span', { class: 'term__rowName', text: label })
  ];
  if (long) {
    parts.push(h('span', { class: 'term__rowMeta', text: entry ? formatBytes(entry.size || 0) : '' }));
    parts.push(h('span', { class: 'term__rowMeta', text: entry ? formatRelative(entry.updatedAtIso) : '' }));
  }
  if (!isFolder && entry && !entry.openable) {
    parts.push(h('span', { class: 'term__rowWarn', text: '開けません' }));
  }

  return h('button', {
    type: 'button',
    class: 'term__row' + (open ? '' : ' term__row--dim'),
    title: Vfs.pathOf(node.id) + (entry && entry.reason ? '\n' + entry.reason : ''),
    onclick: () => {
      if (!Tree.get(node.id)) return;    // 実行後に消えた
      if (isFolder) { void Term.runFromClick(ctx.term, 'cd ' + termQuote(Vfs.pathOf(node.id))); return; }
      void Term.openNode(ctx.term, node, {}).catch((err) => Term.text(ctx.term, err.message, 'term__err'));
    }
  }, parts);
}

/** grep の 1 行（クリックでその行へ飛ぶ）。 */
function termHitRow(ctx, node, line, text) {
  return h('button', {
    type: 'button',
    class: 'term__row term__row--hit',
    title: Vfs.pathOf(node.id) + ':' + line,
    onclick: () => {
      void Term.openNode(ctx.term, node, { line, column: 1 })
        .catch((err) => Term.text(ctx.term, err.message, 'term__err'));
    }
  }, [
    h('span', { class: 'term__hitPath', text: Vfs.pathOf(node.id) }),
    h('span', { class: 'term__hitLine', text: ':' + line }),
    h('span', { class: 'term__hitText', text: text.length > 400 ? text.slice(0, 400) + '…' : text })
  ]);
}

