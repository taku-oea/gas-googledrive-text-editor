/* ---------------------- 右クリックメニュー ---------------------- */

const Ctx = {
  open: false,

  /**
   * @param {number} x
   * @param {number} y
   * @param {Array<Object>} items {label, icon, onClick, danger, disabled, desktopOnly} か {sep:true}。
   *        null は読み飛ばす
   */
  show(x, y, items) {
    Ctx.hide();
    el.ctxMenu.textContent = '';
    // スマホでは分割まわり（desktopOnly）を出さない。消した前後で区切り線が
    // 続いたり端に残ったりしないよう、あわせて詰める。
    items = items.filter((it) => it && !(Mobile.on && it.desktopOnly));
    items = items.filter((it, i, arr) => !it.sep || (i > 0 && i < arr.length - 1 && !arr[i - 1].sep));

    for (const item of items) {
      if (item.sep) {
        el.ctxMenu.appendChild(h('div', { class: 'ctxmenu__sep' }));
        continue;
      }
      el.ctxMenu.appendChild(h('button', {
        type: 'button',
        class: 'ctxmenu__item' + (item.danger ? ' ctxmenu__item--danger' : ''),
        disabled: !!item.disabled,
        onclick: () => { Ctx.hide(); item.onClick(); }
      }, [
        h('span', { class: 'ctxmenu__icon' }, item.icon ? [icon(item.icon)] : []),
        h('span', { text: item.label }),
        item.key ? h('span', { class: 'ctxmenu__key', text: item.key }) : null
      ]));
    }

    el.ctxMenu.hidden = false;
    Ctx.open = true;

    // 画面外へはみ出さない位置に補正する。
    const rect = el.ctxMenu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    el.ctxMenu.style.left = Math.max(4, left) + 'px';
    el.ctxMenu.style.top = Math.max(4, top) + 'px';
  },

  hide() {
    if (!Ctx.open && el.ctxMenu.hidden) return;
    el.ctxMenu.hidden = true;
    Ctx.open = false;
  }
};

/**
 * ツリーのノードに対する右クリックメニューを出す。
 * @param {number} x
 * @param {number} y
 * @param {TreeNode} node
 */
function showNodeMenu(x, y, node) {
  // 複数選択されているなら、選択全体に対するメニューを出す。
  const multi = actionableSelection();
  if (multi.length > 1 && App.selection.has(node.id)) {
    // ちょうど 2 件（どちらもテキストとして開けるファイル）なら、その場で比較できる。
    const pair = multi.length === 2 && multi.every((nd) =>
      nd.type === 'file' && nd.entry && nd.entry.viewer === 'editor') ? multi : null;
    Ctx.show(x, y, [
      pair
        ? { label: 'この 2 件を比較', icon: 'diff',
            onClick: () => void Diff.twoFiles(pair[0].id, pair[0].name, pair[1].id, pair[1].name) }
        : null,
      pair ? { sep: true } : null,
      { label: multi.length + ' 件をピン留め', icon: 'pin',
        disabled: !multi.some((nd) => nd.type === 'file' && nd.entry && nd.entry.openable),
        onClick: () => {
          const added = Pins.addNodes(multi);
          toast(added ? added + ' 件をピン留めしました' : 'すでにピン留めされています',
            'info', 3000);
        } },
      { sep: true },
      { label: multi.length + ' 件を移動…', icon: 'move',
        onClick: () => void moveViaPicker(multi) },
      { label: multi.length + ' 件をゴミ箱へ移動', icon: 'trash', danger: true,
        onClick: () => void trashNodes(multi) },
      { sep: true },
      { label: '選択を解除', icon: 'clear',
        onClick: () => { App.selection = new Set([node.id]); renderTreeStates(); } }
    ].filter(Boolean));
    return;
  }

  const isFolder = node.type === 'folder';
  const isRoot = Tree.isRoot(node.id);
  const entry = node.entry;
  const clip = App.clipboard;
  const items = [];

  // 一時メモのセクションは外せないし、中にフォルダも作らない。
  // 出せるのは「作る」「取り直す」「Drive で中身を見る」の 3 つだけ。
  if (Tree.isTmpRoot(node.id)) {
    Ctx.show(x, y, [
      { label: '新しい一時メモ', icon: 'memo', key: MOD + '+Alt+N',
        onClick: () => void TempMemo.create() },
      { sep: true },
      { label: '再読み込み', icon: 'refresh', onClick: () => void TempMemo.refresh() },
      {
        label: 'Drive で開く',
        icon: 'open',
        onClick: () => {
          window.open('https://drive.google.com/drive/folders/' +
            encodeURIComponent(node.id), '_blank', 'noopener');
        }
      }
    ]);
    return;
  }

  if (isFolder) {
    items.push(
      { label: '新規ファイル', icon: 'file-new', key: 'Alt+N',
        onClick: () => startInlineCreate('newFile', node.id) },
      { label: '新規フォルダ', icon: 'folder-new',
        onClick: () => startInlineCreate('newFolder', node.id) },
      { label: 'ここでターミナルを開く', icon: 'terminal',
        onClick: () => void Term.open({ cwd: node.id }) },
      { sep: true },
      {
        label: clip ? '貼り付け（' + clip.name + '）' : '貼り付け',
        icon: 'paste',
        disabled: !clip,
        onClick: () => void doPaste(node.id)
      },
      { sep: true },
      { label: '再読み込み', icon: 'refresh', onClick: () => void refreshFolder(node.id) }
    );
    if (isRoot) {
      items.push(
        { sep: true },
        { label: 'このフォルダを閉じる', icon: 'clear', onClick: () => void doRemoveRoot(node) }
      );
    } else {
      items.push(
        { sep: true },
        { label: '名前を変更', icon: 'rename', key: 'F2',
          onClick: () => startInlineRename(node) },
        { label: '移動…', icon: 'move', onClick: () => void moveViaPicker([node]) },
        { label: 'ゴミ箱へ移動', icon: 'trash', key: 'Delete', danger: true,
          onClick: () => void doTrashFolder(node) }
      );
    }
  } else {
    items.push(
      {
        label: 'エディタで開く',
        icon: 'open',
        disabled: !entry.openable,
        onClick: () => void openEntry(entry, { ephemeral: false })
      },
      // スマホではペインを分割しないので出さない。
      Mobile.on ? null : {
        label: '横のペインで開く',
        icon: 'columns',
        disabled: !entry.openable ||
          (!Panes.leafOf(node.id) && Panes.leaves().length >= Panes.MAX),
        onClick: () => void openBeside(entry)
      }
    );
    if (Tree.isTmpRoot(node.parentId)) {
      items.push({
        label: '保存先を決める…',
        icon: 'save',
        disabled: !entry.openable,
        onClick: () => void promoteFromTree(node)
      });
    }
    if (entry.viewer === 'editor') {
      items.push(
        { sep: true },
        { label: '別のファイルと比較…', icon: 'diff',
          onClick: () => void Diff.fromFile(node.id, node.name, 'file') },
        { label: '貼り付けたテキストと比較…', icon: 'diff',
          onClick: () => void Diff.fromFile(node.id, node.name, 'paste') },
        { label: '過去の版と比較…', icon: 'history',
          onClick: () => void Diff.pickRevisionAndCompare(node.id, node.name) }
      );
    }
    items.push(
      { sep: true },
      { label: Pins.has(node.id) ? 'ピン留めを外す' : 'ピン留めする',
        icon: Pins.has(node.id) ? 'pin-off' : 'pin',
        disabled: !entry.openable,
        onClick: () => Pins.toggleNode(node) },
      { sep: true },
      { label: 'コピー', icon: 'copy', onClick: () => doCopyToClipboard(node) },
      { label: '複製', icon: 'duplicate', onClick: () => void doDuplicate(node) },
      { sep: true },
      { label: '名前を変更', icon: 'rename', key: 'F2',
        onClick: () => startInlineRename(node) },
      { label: '移動…', icon: 'move', onClick: () => void moveViaPicker([node]) },
      { label: 'ゴミ箱へ移動', icon: 'trash', key: 'Delete', danger: true,
        onClick: () => void doTrash(node) }
    );
  }

  Ctx.show(x, y, items.filter(Boolean));
}

/**
 * 何も無いところを右クリックしたとき。
 * ルートが 1 つならそのフォルダのメニュー、複数なら追加操作だけを出す
 * （どのフォルダに作るのかが曖昧になるため）。
 */
function showRootMenu(x, y) {
  if (Tree.rootIds.length === 1) {
    const root = Tree.get(Tree.rootIds[0]);
    if (root) showNodeMenu(x, y, root);
    return;
  }
  Ctx.show(x, y, [
    { label: '新しい一時メモ', icon: 'memo', key: MOD + '+Alt+N',
      onClick: () => void TempMemo.create() },
    { sep: true },
    { label: 'フォルダを管理', icon: 'folders', onClick: () => { Picker.open(null); } },
    { label: 'すべて再読み込み', icon: 'refresh', onClick: () => void refreshAllRoots() }
  ]);
}

