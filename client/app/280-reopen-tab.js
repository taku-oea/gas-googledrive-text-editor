/* ------------------------------------------------------------------ *
 *  閉じたタブを開き直す
 *
 *  Mod+Shift+T はブラウザが「閉じたブラウザタブを開き直す」に使っていて奪えないので、
 *  Alt+Shift+T とコマンドパレットに置く。対象は Drive 上のファイルを映すタブ
 *  （テキストとビューア）だけ。比較・プレビュー・ターミナルは実体を持たないので覚えない。
 *  開き直すのは元のペインの元の位置（ペインが畳まれていれば、いま操作中のペイン）。
 * ------------------------------------------------------------------ */

const ClosedTabs = {
  MAX: 20,
  /** @type {Array<{id:string, name:string, kind:string, paneId:string, index:number}>} 新しいものが末尾 */
  stack: [],

  /** @param {Tab} tab 閉じる直前のタブ（まだペインに載っている） */
  remember(tab) {
    if (!tab || !tab.loaded || tab.creating || String(tab.id).indexOf('new:') === 0) return;
    if (tab.kind !== 'text' && !VIEWERS[tab.kind]) return;
    const leaf = Panes.leafOf(tab.id);
    ClosedTabs.forget(tab.id);
    ClosedTabs.stack.push({
      id: tab.id, name: tab.name, kind: tab.kind,
      paneId: leaf ? leaf.id : null, index: leaf ? leaf.tabIds.indexOf(tab.id) : -1
    });
    if (ClosedTabs.stack.length > ClosedTabs.MAX) ClosedTabs.stack.shift();
  },

  /** Drive から消えた・動かせなくなったファイルは覚えておかない。 */
  forget(id) {
    ClosedTabs.stack = ClosedTabs.stack.filter((x) => x.id !== id);
  },

  /** 最後に閉じたタブを開き直す。いま開いているものは飛ばす。 */
  async reopen() {
    while (ClosedTabs.stack.length) {
      const item = ClosedTabs.stack.pop();
      if (getTab(item.id)) continue;
      const pane = item.paneId && Panes.byId.has(item.paneId) ? item.paneId : null;
      if (pane) Panes.focus(pane);
      await openFile(item.id, item.name, item.kind, {
        ephemeral: false, pane: pane || undefined, index: pane ? item.index : undefined
      });
      return;
    }
    toast('開き直せるタブはありません', 'info', 2500);
  }
};

/**
 * タブを閉じる。未保存なら保存を試み、それでも残るなら確認する。
 * @param {string} tabId
 * @param {{force?:boolean}} [opts]
 * @return {Promise<boolean>} 実際に閉じたか
 */
async function closeTab(tabId, opts = {}) {
  const tab = getTab(tabId);
  if (!tab) return true;
  tabId = tab.id;

  // ターミナルは本文も未保存の変更も持たない。走っているコマンドを止めて外すだけ
  // （書き込み中のものは中断フラグを見て自分で止まる）。
  if (tab.kind === 'term') {
    Term.destroy(tab);
    detachTab(tab);
    renderTabs();
    Session.save();
    return true;
  }

  // プレビュータブは元のファイルを映しているだけで、本文も未保存の変更も持たない。
  // 確認は要らないが、裏で動く iframe とタイマーは止めてから外す。
  if (tab.kind === 'preview') {
    Preview.destroy(tab);
    detachTab(tab);
    renderTabs();
    Session.save();
    return true;
  }

  // 比較タブは本文を持たない（保存の確認も下書きも無い）。
  // 書き戻していない変更があるときだけ確認し、MergeView を破棄して外す。
  if (tab.kind === 'diff') {
    if (!opts.force && Diff.hasUnsaved(tab)) {
      const go = await modal({
        title: '書き戻していない変更があります',
        body: '比較ビューで編集した内容は、まだ Drive にもタブにも書き戻されていません。' +
          '閉じると失われます。',
        actions: [
          { label: '閉じる', value: true, variant: 'danger' },
          { label: 'キャンセル', value: false, variant: 'primary' }
        ]
      });
      if (!go) return false;
    }
    Diff.destroy(tab);
    detachTab(tab);
    renderTabs();
    Session.save();
    return true;
  }

  // 中身を書かないまま閉じた一時メモは、残しておく価値が無いうえに
  // マイドライブに溜まり続ける（しかも全端末へ同期される）。ここで片付ける。
  // 保存確認もしない（保存すべき中身が無い）。
  const discardTemp = tab.temp && tab.loaded && !tabDoc(tab).trim();

  // 未編集の仮タブを差し替えるだけの場合は、確認も下書き確定も要らない。
  if (!discardTemp && opts.keepDraft && !tab.dirty) {
    clearTimeout(tab.saveTimer);
    // 直後に同じ場所へ新しいタブが入るので、次のタブへ送らない。
    detachTab(tab, { quiet: true });
    return true;
  }

  if (!discardTemp && !opts.force && tab.dirty) {
    await doSave(tabId, false);
    const t = getTab(tabId);
    if (!t) return true;
    if (t.dirty) {
      const go = await modal({
        title: '未保存の変更があります',
        body: '「' + t.name + '」の保存が完了していません。閉じると変更は下書きにのみ残ります。',
        actions: [
          { label: '閉じる', value: true, variant: 'danger' },
          { label: 'キャンセル', value: false, variant: 'primary' }
        ]
      });
      if (!go) return false;
    }
  }

  const target = getTab(tabId);
  if (!target) return true;

  // このファイルのプレビューは、元が閉じたら映すものが無くなる。
  const preview = Preview.forSource(tabId);
  if (preview) await closeTab(preview.id, { force: true });

  // 状態を捨てる前に、保留中の下書き書き込みを確定させる。
  if (target.dirty && !discardTemp) Draft.flush(tabId);
  clearTimeout(target.saveTimer);

  if (discardTemp) {
    Draft.clear(tabId);
    Tree.remove(target.id);
    // モデルから消しただけでは行が残るので、ここで描き直す。
    renderTree();
    if (target.creating) {
      // まだ Drive にファイルが無い。作成が終わってから片付ける（bindCreated を参照）。
      target.discardAfterCreate = true;
    } else if (!target.createError) {
      // ゴミ箱行きは投げっぱなしでよい。失敗しても空ファイルが残るだけで、
      // それは tmp の定期掃除（24 時間で空ファイルを回収）が拾う。
      Api.trashFile(target.id)
        .catch((err) => console.warn('空の一時メモを片付けられませんでした: ' + err.message));
    }
  } else {
    ClosedTabs.remember(target);
  }

  detachTab(target);
  renderTabs();
  renderTreeStates();
  Session.save();
  return true;
}

/**
 * タブを一覧とペインから外し、そのペインの表示を次のタブへ送る。
 * ペインが空になったら、分割しているならそのペインごと畳む。
 * @param {Tab} tab
 * @param {{quiet?:boolean}} [opts] quiet=true なら次のタブへ送らない
 */
function detachTab(tab, opts = {}) {
  const at = App.tabs.indexOf(tab);
  if (at >= 0) App.tabs.splice(at, 1);

  const leaf = Panes.leafOf(tab.id);
  if (!leaf) return;
  const wasShown = leaf.activeId === tab.id;
  Panes.removeTab(tab.id);
  if (opts.quiet) return;

  if (leaf.tabIds.length) {
    if (wasShown) void activateTab(leaf.activeId);
    return;
  }
  // 空になったペインは畳む。最後の 1 枚なら空のまま残す。
  if (Panes.isSplit()) Panes.drop(leaf);
  else showEmptyPane(leaf);
}

function renderTabs() {
  for (const leaf of Panes.leaves()) renderPaneTabs(leaf);
}

/**
 * ペイン 1 枚ぶんのタブバーを描く。
 * 「表示中のタブ」はペインごとにあるので、アクティブの印は leaf.activeId で決める。
 * @param {Object} leaf
 */
function renderPaneTabs(leaf) {
  const bar = leaf.el.tabbar;
  bar.textContent = '';
  // スマホでは操作対象のペインしか出さない。PC で分割していたセッションなら、
  // ほかのペインのタブへ行けるよう、何枚目かを出して押すと次のペインへ移る。
  if (Mobile.on && Panes.isSplit()) {
    const leaves = Panes.leaves();
    bar.appendChild(h('button', {
      type: 'button',
      class: 'tabbar__pane',
      title: '次のペインへ（PC で分割していたペイン）',
      text: (leaves.indexOf(leaf) + 1) + '/' + leaves.length,
      onclick: () => { focusNextPane(1); renderTabs(); }
    }));
  }
  for (const tabId of leaf.tabIds) {
    const tab = getTab(tabId);
    if (!tab) continue;
    const unsaved = tab.dirty || (tab.kind === 'diff' && Diff.hasUnsaved(tab));
    const indicator = tab.saving
      ? h('span', { class: 'tab__saving' }, [icon('saving')])
      : h('span', { class: 'tab__dirty' }, unsaved ? [icon('dot')] : []);

    const node = h('div', {
      class: 'tab' +
        (tab.id === leaf.activeId ? ' tab--active' : '') +
        (tab.kind !== 'text' || tab.loaded || Store.peek(tab.id) ? '' : ' tab--unloaded') +
        (tab.ephemeral ? ' tab--preview' : '') +
        (tab.pinned ? ' tab--pinned' : '') +
        (tab.temp ? ' tab--temp' : '') +
        (tab.kind === 'diff' ? ' tab--diff' : '') +
        (tab.kind === 'term' ? ' tab--term' : '') +
        (tab.kind === 'preview' ? ' tab--pv' : ''),
      'data-tab-id': tab.id,
      draggable: 'true',
      title: tab.kind === 'diff'
        ? '比較\n左: ' + tab.diff.a.name + '\n右: ' + tab.diff.b.name
        : tab.kind === 'preview'
        ? tab.name + ' のプレビュー（元のファイルを編集すると追従します）'
        : tab.kind === 'term'
        ? 'ターミナル' + (tab.term ? '\n' + Vfs.pathOf(tab.term.cwd) : '')
        : !(tab.loaded || Store.peek(tab.id)) ? tab.name + '（未読み込み・クリックで開きます）'
        : tab.temp ? tab.name + '\n一時メモ（' + MOD + '+S で保存先を決めます）'
        : tab.name,
      onclick: () => { void activateTab(tab.id); },
      // ダブルクリックで仮タブを固定する（VS Code と同じ）。
      ondblclick: () => {
        if (tab.ephemeral) { tab.ephemeral = false; renderTabs(); Session.save(); }
      },
      // 中クリックで閉じる。
      onauxclick: (ev) => { if (ev.button === 1) { ev.preventDefault(); void closeTab(tab.id); } },
      oncontextmenu: (ev) => { ev.preventDefault(); showTabMenu(ev.clientX, ev.clientY, tab); }
    }, [
      // ピン留めは外すまで続く状態なので、未保存・保存中の表示を優先する。
      tab.pinned && !unsaved && !tab.saving
        ? h('span', { class: 'tab__pin', title: 'ピン留め' }, [icon('pin')])
        : indicator,
      tab.temp ? h('span', { class: 'tab__temp', text: 'tmp', title: '一時メモ' }) : null,
      tab.kind === 'diff'
        ? h('span', { class: 'tab__diff', text: '比較', title: '比較ビュー' })
        : null,
      tab.kind === 'preview'
        ? h('span', { class: 'tab__pv', text: '見る', title: 'プレビュー' })
        : null,
      tab.kind === 'term'
        ? h('span', { class: 'tab__term', text: '>_', title: 'ターミナル' })
        : null,
      h('span', {
        class: 'tab__label',
        // プレビューは元のファイル名をそのまま出す（改名にも追従する）。
        text: tab.kind === 'preview' ? ((Preview.sourceOf(tab) || tab).name) : tab.name
      }),
      h('button', {
        type: 'button',
        class: 'tab__close',
        title: '閉じる',
        onclick: (ev) => { ev.stopPropagation(); void closeTab(tab.id); }
      }, [icon('close', 'icon--sm')])
    ]);

    wireTabDrag(node, tab, leaf);
    bar.appendChild(node);
  }

  // 右端の「＋」。空いているところのダブルクリックと同じ動きだが、
  // ダブルクリックは知らないと気づけないので目に見える入口も置く。
  bar.appendChild(h('button', {
    type: 'button',
    class: 'tabbar__new',
    title: '新しい一時メモ (' + MOD + '+Alt+N)',
    onclick: () => { Panes.focus(leaf.id); void TempMemo.create(); }
  }, [icon('memo')]));
}

/**
 * タブのドラッグ。同じペインの中なら並べ替え、別のペインへ落としたら移動になる。
 * ペインの端（タブバーではなく本文側）に落としたときの分割は wirePaneDrop が拾う。
 * @param {Element} node タブの DOM
 * @param {Tab} tab
 * @param {Object} leaf そのタブが載っているペイン
 */
function wireTabDrag(node, tab, leaf) {
  node.addEventListener('dragstart', (ev) => {
    App.dragTabId = tab.id;
    ev.dataTransfer.effectAllowed = 'move';
    // 一部ブラウザは何かセットしないと dragstart を無効にするので、
    // 独自の型に入れる。text/plain に入れると、エディタ本文の上で落ちたときに
    // CodeMirror が「テキストの貼り付け」として扱い、本文に文字列が入ってしまう。
    try { ev.dataTransfer.setData(DRAG_TYPE, 'tab:' + tab.id); } catch (e) { /* 無視 */ }
  });
  node.addEventListener('dragend', () => { App.dragTabId = null; });

  node.addEventListener('dragover', (ev) => {
    if (!App.dragTabId || App.dragTabId === tab.id) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
  });
  node.addEventListener('drop', (ev) => {
    if (!App.dragTabId || App.dragTabId === tab.id) return;
    ev.preventDefault();
    ev.stopPropagation();
    const dragged = App.dragTabId;
    App.dragTabId = null;
    const to = leaf.tabIds.indexOf(tab.id);
    if (to < 0) return;

    const from = Panes.leafOf(dragged);
    if (from === leaf) {
      const at = leaf.tabIds.indexOf(dragged);
      if (at < 0) return;
      leaf.tabIds.splice(at, 1);
      leaf.tabIds.splice(to, 0, dragged);
      renderTabs();
      Session.save();
      return;
    }
    moveTabToPane(dragged, leaf, to);
  });
}

/** タブの右クリックメニュー。 */
function showTabMenu(x, y, tab) {
  // 「他の」「右側の」はこのペインの中だけを指す（VS Code と同じ）。
  const leaf = Panes.leafOf(tab.id) || Panes.active();
  const ids = leaf ? leaf.tabIds : [];
  const index = ids.indexOf(tab.id);
  const pick = (list) => list.map(getTab).filter((t) => t && t.id !== tab.id && !t.pinned);
  const others = pick(ids);
  const toRight = pick(ids.slice(index + 1));
  // 1 枚しかないペインから出しても、元のペインが空になって畳まれるだけ。
  const canSplit = !!leaf && ids.length > 1 && Panes.leaves().length < Panes.MAX;

  // ターミナルは Drive 上のファイルに対応していないので、
  // 保存・比較・パスといった項目は出さない。
  if (tab.kind === 'term') {
    Ctx.show(x, y, [
      { label: '閉じる', icon: 'close', onClick: () => void closeTab(tab.id) },
      { label: '他のタブを閉じる', icon: 'clear', disabled: !others.length,
        onClick: () => void closeTabs(others) },
      { sep: true },
      { label: '画面を消す', icon: 'clear',
        onClick: () => { if (tab.term) Term.clear(tab.term); } },
      { label: '新しいターミナル', icon: 'terminal',
        onClick: () => void Term.open({ cwd: tab.term ? tab.term.cwd : null }) },
      { sep: true },
      { label: '右のペインへ移す', icon: 'columns', disabled: !canSplit, desktopOnly: true,
        onClick: () => splitTabOut(tab.id, 'row') },
      { label: '下のペインへ移す', icon: 'rows', disabled: !canSplit, desktopOnly: true,
        onClick: () => splitTabOut(tab.id, 'col') }
    ]);
    return;
  }

  // プレビュータブは元のファイルを映しているだけなので、
  // 保存・比較・パスといった項目は元のタブ側に出す。
  if (tab.kind === 'preview') {
    const src = Preview.sourceOf(tab);
    Ctx.show(x, y, [
      { label: '閉じる', icon: 'close', onClick: () => void closeTab(tab.id) },
      { label: '他のタブを閉じる', icon: 'clear', disabled: !others.length,
        onClick: () => void closeTabs(others) },
      { label: '右側のタブを閉じる', icon: 'indent-in', disabled: !toRight.length,
        onClick: () => void closeTabs(toRight) },
      { sep: true },
      { label: '元のファイルへ移動', icon: 'goto', disabled: !src,
        onClick: () => { if (src) void activateTab(src.id); } },
      { label: '描き直す', icon: 'refresh',
        onClick: () => Preview.render(tab) },
      { sep: true },
      { label: '右のペインへ移す', icon: 'columns', disabled: !canSplit, desktopOnly: true,
        onClick: () => splitTabOut(tab.id, 'row') },
      { label: '下のペインへ移す', icon: 'rows', disabled: !canSplit, desktopOnly: true,
        onClick: () => splitTabOut(tab.id, 'col') }
    ]);
    return;
  }

  // 比較タブは Drive 上のファイルに対応していないので、パスや Drive で開くは出さない。
  if (tab.kind === 'diff') {
    const inline = tab.diff.mode === 'unified';
    Ctx.show(x, y, [
      { label: '閉じる', icon: 'close', onClick: () => void closeTab(tab.id) },
      { label: '他のタブを閉じる', icon: 'clear', disabled: !others.length,
        onClick: () => void closeTabs(others) },
      { label: '右側のタブを閉じる', icon: 'indent-in', disabled: !toRight.length,
        onClick: () => void closeTabs(toRight) },
      { sep: true },
      { label: '左右を入れ替え', icon: 'swap', onClick: () => void Diff.swap(tab) },
      { label: inline ? '並列表示にする' : 'インライン表示にする',
        icon: inline ? 'columns' : 'rows',
        onClick: () => void Diff.setMode(tab, inline ? 'split' : 'unified') },
      { sep: true },
      // 比較タブは Drive 上のファイルに対応していないので、
      // サイドバーの「ピン留め」には並べられない（このタブの中だけの旗になる）。
      { sep: true },
      { label: '右のペインへ移す', icon: 'columns', disabled: !canSplit, desktopOnly: true,
        onClick: () => splitTabOut(tab.id, 'row') },
      { label: '下のペインへ移す', icon: 'rows', disabled: !canSplit, desktopOnly: true,
        onClick: () => splitTabOut(tab.id, 'col') },
      { sep: true },
      // 比較タブは Drive 上のファイルに対応していないので、
      // サイドバーの「ピン留め」には並べられない（このタブの中だけの旗になる）。
      { label: tab.pinned ? 'ピン留めを外す' : 'ピン留めする', icon: 'pin',
        onClick: () => Pins.toggleTab(tab) }
    ]);
    return;
  }

  Ctx.show(x, y, [
    { label: '閉じる', icon: 'close', onClick: () => void closeTab(tab.id) },
    {
      label: '他のタブを閉じる',
      icon: 'clear',
      disabled: !others.length,
      onClick: () => void closeTabs(others)
    },
    {
      label: '右側のタブを閉じる',
      icon: 'indent-in',
      disabled: !toRight.length,
      onClick: () => void closeTabs(toRight)
    },
    {
      label: '閉じたタブを開き直す',
      icon: 'refresh',
      disabled: !ClosedTabs.stack.length,
      onClick: () => void ClosedTabs.reopen()
    },
    { sep: true },
    {
      label: '右のペインへ移す',
      icon: 'columns',
      disabled: !canSplit, desktopOnly: true,
      onClick: () => splitTabOut(tab.id, 'row')
    },
    {
      label: '下のペインへ移す',
      icon: 'rows',
      disabled: !canSplit, desktopOnly: true,
      onClick: () => splitTabOut(tab.id, 'col')
    },
    { sep: true },
    {
      label: tab.pinned ? 'ピン留めを外す' : 'ピン留めする',
      icon: 'pin',
      onClick: () => Pins.toggleTab(tab)
    },
    tab.ephemeral
      ? { label: 'このタブを固定する', icon: 'pin-off', onClick: () => {
          tab.ephemeral = false; renderTabs(); Session.save();
        } }
      : null,
    { sep: true },
    {
      label: 'Drive 上の内容と比較',
      icon: 'diff',
      disabled: tab.kind !== 'text' || tab.temp || tab.creating,
      onClick: () => void Diff.withSaved(tab.id)
    },
    {
      label: '他のファイルと比較…',
      icon: 'diff',
      disabled: tab.kind !== 'text',
      onClick: () => void Diff.fromTab(tab.id, 'file')
    },
    {
      label: '過去の版と比較…',
      icon: 'history',
      disabled: tab.kind !== 'text' || tab.temp || tab.creating,
      onClick: () => void Diff.pickRevisionAndCompare(tab.id, tab.name)
    },
    { sep: true },
    {
      label: 'パスをコピー',
      icon: 'copy',
      onClick: () => void copyTextToClipboard(Tree.get(tab.id) ? Tree.pathOf(tab.id) : tab.name)
    },
    {
      label: 'Drive で開く',
      icon: 'open',
      onClick: () => {
        window.open('https://drive.google.com/file/d/' + encodeURIComponent(tab.id) + '/view',
          '_blank', 'noopener');
      }
    }
  ].filter(Boolean));
}

