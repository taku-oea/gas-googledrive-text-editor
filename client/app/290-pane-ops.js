/* ------------------------------------------------------------------ *
 *  ペインの操作（移動・分割・境目のドラッグ）
 * ------------------------------------------------------------------ */

/**
 * 操作対象のペインが変わったときに、アプリ全体で 1 つしかないものを
 * 新しいペインへ合わせる（ステータスバー・パンくず・変更履歴）。
 */
function onActivePaneChanged() {
  const leaf = Panes.active();
  const tab = leaf ? getTab(leaf.activeId) : null;

  el.statusbar.hidden = !tab;
  if (tab) {
    el.sbName.textContent = tab.name;
    el.sbSize.textContent = tab.kind === 'text' ? formatBytes(tab.size) : '';
  }
  renderTabs();
  renderEditorCrumbs();
  updateStatusMeta();
  updatePreviewAvailability();
  if (tab && tab.kind === 'text') {
    App.lastTextTabId = tab.id;
    updateCursorReadout();
  }
  refreshStatus();
  if (Views.current === 'history') void History.load();
  renderTreeStates();
  Session.save();
}

/**
 * タブを別のペインへ移す。移動元が空になったら、そのペインは畳む。
 * @param {string} tabId
 * @param {Object} target 移動先のペイン
 * @param {number} [index] 移動先での位置（省略すると末尾）
 */
function moveTabToPane(tabId, target, index) {
  const from = Panes.leafOf(tabId);
  if (!from || !target || from === target) return;

  // 移動元でまだ表示していたなら、いまの state を書き戻してから外す。
  if (from.activeId === tabId) Panes.stash(from);
  Panes.removeTab(tabId);
  Panes.addTab(target, tabId, index);
  // 畳む前にアクティブを移しておく（消えるペインを指したままにしない）。
  Panes.activeId = target.id;

  if (!from.tabIds.length) {
    if (Panes.isSplit()) Panes.drop(from);
    else showEmptyPane(from);
  } else {
    // 繰り上がったタブは本文をまだ読んでいないことがあるので、読んでから描く。
    void paintPane(from);
  }

  Panes.paint();
  void activateTab(tabId);
}

/**
 * タブを新しいペインへ移す（タブの右クリックメニューから）。
 * @param {string} tabId
 * @param {'row'|'col'} dir row=右へ, col=下へ
 */
function splitTabOut(tabId, dir) {
  const from = Panes.leafOf(tabId);
  if (!from) return;
  const fresh = Panes.split(from.id, dir, true);
  if (fresh) moveTabToPane(tabId, fresh);
}

/**
 * ドラッグしていたタブを、落とした先のペインへ入れる。
 * 端に落としたときはその向きへ分割してから移す。
 * @param {string} tabId
 * @param {Object} leaf 落とした先のペイン
 * @param {'center'|'left'|'right'|'top'|'bottom'} zone
 */
function dropTabOnPane(tabId, leaf, zone) {
  if (!getTab(tabId)) return;
  const from = Panes.leafOf(tabId);

  // 外周に落とした場合は、木全体を割って全幅・全高のペインを作る。
  if (zone && zone.indexOf('root-') === 0) {
    const side = zone.slice(5);
    // 1 枚しかないペインから出しても、元が空になって畳まれるだけ。
    if (from === leaf && leaf.tabIds.length <= 1) return;
    const dir = (side === 'left' || side === 'right') ? 'row' : 'col';
    const fresh = Panes.splitRoot(dir, side === 'right' || side === 'bottom');
    if (fresh) moveTabToPane(tabId, fresh);
    return;
  }

  if (zone && zone !== 'center') {
    // 1 枚しかないペインを自分の端に落としても、元が空になって畳まれるだけ。
    if (from === leaf && leaf.tabIds.length <= 1) return;
    const dir = (zone === 'left' || zone === 'right') ? 'row' : 'col';
    const fresh = Panes.split(leaf.id, dir, zone === 'right' || zone === 'bottom');
    if (fresh) moveTabToPane(tabId, fresh);
    return;
  }
  // 真ん中はこのペインへ移動。同じペインの中での並べ替えはタブ側が受け持つ。
  if (from === leaf) return;
  moveTabToPane(tabId, leaf);
}

/**
 * タブをペインへドラッグしたときの受け口。
 * 端（4 分の 1 より外）に寄せるとその向きへ新しく分割し、
 * 真ん中ならそのペインへ移動する。
 * @param {Object} leaf
 */
function wirePaneDrop(leaf) {
  let current = null;

  /** エディタ領域の外周からこの距離までは、木全体に対する分割にする。 */
  const OUTER_PX = 28;

  const zoneAt = (ev) => {
    const r = leaf.root.getBoundingClientRect();
    if (!r.width || !r.height) return 'center';
    const inBar = leaf.el.tabbar.contains(ev.target);

    // エディタ領域のいちばん外側に近ければ、木全体を割って
    // 全幅・全高のペインを作る。これが無いと、左右に 3 列並べたあとで
    // 「下に全幅の段」を足すことができない（左列の中にしか作れない）。
    const outer = el.paneRoot.getBoundingClientRect();
    const bar = leaf.el.tabbar.getBoundingClientRect();
    const touches = (a, b) => Math.abs(a - b) < 2;
    if (!inBar) {
      if (touches(r.left, outer.left) && ev.clientX - outer.left < OUTER_PX) return 'root-left';
      if (touches(r.right, outer.right) && outer.right - ev.clientX < OUTER_PX) return 'root-right';
      if (touches(r.bottom, outer.bottom) && outer.bottom - ev.clientY < OUTER_PX) return 'root-bottom';
      // 上端はタブバーが占めているので、その下から測る。
      if (touches(r.top, outer.top) &&
          ev.clientY > bar.bottom && ev.clientY - bar.bottom < OUTER_PX) return 'root-top';
    }

    // タブバーの上はタブの並べ替えなので、ここから先の分割の的にはしない。
    if (inBar) return 'center';

    const x = (ev.clientX - r.left) / r.width;
    const y = (ev.clientY - r.top) / r.height;
    const edge = 0.25;
    // 角では、縦横のうちより端に寄っているほうを採る。
    const dx = Math.min(x, 1 - x);
    const dy = Math.min(y, 1 - y);
    if (dx >= edge && dy >= edge) return 'center';
    if (dx <= dy) return x < 0.5 ? 'left' : 'right';
    return y < 0.5 ? 'top' : 'bottom';
  };

  const paint = (zone) => {
    // 木全体に対する分割は、そのペインではなくエディタ領域ぜんぶで示す。
    const outer = (zone && zone.indexOf('root-') === 0) ? zone.slice(5) : null;
    for (const side of ['left', 'right', 'top', 'bottom']) {
      el.paneRoot.classList.toggle('paneRoot--drop-' + side, outer === side);
    }
    leaf.el.drop.className = 'paneLeaf__drop' +
      (zone && !outer ? ' paneLeaf__drop--on' : '') +
      (zone && !outer && zone !== 'center' ? ' paneLeaf__drop--' + zone : '');
  };

  leaf.root.addEventListener('dragover', (ev) => {
    if (!App.dragTabId) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    const zone = zoneAt(ev);
    if (zone !== current) { current = zone; paint(zone); }
  });
  leaf.root.addEventListener('dragleave', (ev) => {
    // 中の要素をまたいだだけなら消さない。
    if (ev.relatedTarget && leaf.root.contains(ev.relatedTarget)) return;
    current = null;
    paint(null);
  });
  leaf.root.addEventListener('drop', (ev) => {
    if (!App.dragTabId) return;
    ev.preventDefault();
    const zone = current || zoneAt(ev);
    const tabId = App.dragTabId;
    App.dragTabId = null;
    current = null;
    paint(null);
    dropTabOnPane(tabId, leaf, zone);
  });

  // 埋め込みが拒否されたときの控え。ペインごとに iframe があるので、ここで張る。
  leaf.el.viewerFrame.addEventListener('error', () => {
    leaf.el.viewerFallback.hidden = false;
  });

  // タブバーの空いているところをダブルクリックで新しい一時メモ（VS Code と同じ）。
  // タブや「＋」の上は対象外にしたいので、発生元がタブバー自身のときだけ拾う。
  leaf.el.tabbar.addEventListener('dblclick', (ev) => {
    if (ev.target !== leaf.el.tabbar) return;
    ev.preventDefault();
    Panes.focus(leaf.id);
    void TempMemo.create();
  });
}

/**
 * 分割の境目をドラッグして取り分を変える。
 * 掴んだ境目の両隣だけを動かし、他のペインの大きさは変えない。
 * @param {MouseEvent} ev
 * @param {Object} node 枝
 * @param {number} index 何番目の境目か
 */
function startSashDrag(ev, node, index) {
  const before = node.children[index];
  const after = node.children[index + 1];
  if (!before || !after) return;
  ev.preventDefault();

  const horizontal = node.dir === 'row';
  const sash = node.sashes[index];
  const rectA = before.root.getBoundingClientRect();
  const rectB = after.root.getBoundingClientRect();
  const sizeA = horizontal ? rectA.width : rectA.height;
  const total = sizeA + (horizontal ? rectB.width : rectB.height);
  const sum = before.size + after.size;
  const start = horizontal ? ev.clientX : ev.clientY;
  if (total <= 0 || sum <= 0) return;

  sash.classList.add('paneSash--drag');
  document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';

  const onMove = (e) => {
    const delta = (horizontal ? e.clientX : e.clientY) - start;
    const min = Math.min(Panes.MIN_PX, total / 2);
    const a = Math.max(min, Math.min(total - min, sizeA + delta));
    before.size = sum * (a / total);
    after.size = sum - before.size;
    before.root.style.flex = before.size + ' 1 0%';
    after.root.style.flex = after.size + ' 1 0%';
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    sash.classList.remove('paneSash--drag');
    document.body.style.cursor = '';
    // 幅が変わっても resize は起きないので、測り直しを促しておく。
    for (const leaf of Panes.leaves()) {
      if (leaf.view) leaf.view.requestMeasure();
    }
    Diff.remeasureActive();
    Session.save();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

/**
 * アクティブなペインを分割する。
 *
 * 同じファイルを 2 枚に出せないので、VS Code と違って中身は複製されない。
 * タブが 2 枚以上あるときは表示中のタブを新しいペインへ移し、1 枚しか
 * 無いときは空のペインを作る（そこへクイックオープンなどで開く）。
 * @param {'row'|'col'} dir
 */
function splitActivePane(dir) {
  const leaf = Panes.active();
  if (!leaf) return;
  if (leaf.tabIds.length > 1 && leaf.activeId) {
    splitTabOut(leaf.activeId, dir);
    return;
  }
  const fresh = Panes.split(leaf.id, dir, true);
  if (fresh) showEmptyPane(fresh);
}

/** ペインへフォーカスを移す（キーボードからの移動用）。 */
function focusPane(leaf) {
  if (!leaf) return;
  Panes.focus(leaf.id);
  const tab = getTab(leaf.activeId);
  if (tab && tab.kind === 'text' && leaf.view) leaf.view.focus();
}

/**
 * 次（または前）のペインへ移る。並び順は木を左上から辿った順。
 * @param {number} step
 */
function focusNextPane(step) {
  const leaves = Panes.leaves();
  if (leaves.length < 2) return;
  const at = leaves.findIndex((l) => l.id === Panes.activeId);
  focusPane(leaves[(at + step + leaves.length) % leaves.length]);
}

/** 複数タブをまとめて閉じる。 */
async function closeTabs(tabs) {
  for (const tab of tabs.slice()) await closeTab(tab.id);
}

/**
 * クリップボードへ書き込む。
 * サンドボックス iframe では権限が無いことがあるので、失敗したら
 * 内容をモーダルに出して手でコピーしてもらう。
 * @param {string} text
 */
async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('コピーしました: ' + text, 'info', 3000);
  } catch (e) {
    await modal({
      title: 'コピーできませんでした',
      body: h('div', {}, [
        h('p', { text: 'ブラウザの制限でクリップボードへ書き込めませんでした。' +
          '以下を手でコピーしてください。' }),
        h('input', { class: 'input modal__input', value: text, readonly: true })
      ]),
      actions: [{ label: '閉じる', value: null, variant: 'primary' }]
    });
  }
}

