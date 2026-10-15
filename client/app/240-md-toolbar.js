/* ------------------------------------------------------------------ *
 *  Markdown の入力バー
 *
 *  記法を覚えていなくても書けるようにするためのもの。
 *  ボタンは選択範囲に対するトグルで、押し直せば元に戻る。
 *  キーバインドは足していない（Mod+B はサイドバー、Mod+I は既定の動作があり、
 *  Markdown のタブでだけ意味が変わると事故のもとになるため）。
 * ------------------------------------------------------------------ */

/**
 * 選択範囲を記号で囲む。すでに囲まれていれば外す。
 * 選択が無いときは記号だけ置いて、間にカーソルを残す。
 */
function wrapSelection(view, before, after) {
  const { EditorSelection } = Editor.cm;
  const state = view.state;
  const doc = state.doc;

  view.dispatch(state.changeByRange((range) => {
    const inner = doc.sliceString(range.from, range.to);

    // 記号のすぐ内側を選んでいる場合（**ここ** の「ここ」）。
    const outFrom = range.from - before.length;
    const outTo = range.to + after.length;
    if (outFrom >= 0 && outTo <= doc.length
        && doc.sliceString(outFrom, range.from) === before
        && doc.sliceString(range.to, outTo) === after) {
      return {
        changes: [
          { from: outFrom, to: range.from },
          { from: range.to, to: outTo }
        ],
        range: EditorSelection.range(outFrom, outFrom + inner.length)
      };
    }

    // 記号ごと選んでいる場合（**ここ** 全体）。
    if (inner.length >= before.length + after.length
        && inner.startsWith(before) && inner.endsWith(after)) {
      const bare = inner.slice(before.length, inner.length - after.length);
      return {
        changes: { from: range.from, to: range.to, insert: bare },
        range: EditorSelection.range(range.from, range.from + bare.length)
      };
    }

    return {
      changes: { from: range.from, to: range.to, insert: before + inner + after },
      range: inner
        ? EditorSelection.range(range.from + before.length, range.from + before.length + inner.length)
        : EditorSelection.cursor(range.from + before.length)
    };
  }));
  view.focus();
}

/**
 * ブロックを挿入する。行の途中なら次の行から置く。
 * @param {Object} view EditorView
 * @param {string} text 挿入するブロック
 * @param {number} [caret] 挿入した文字列の先頭から数えたカーソル位置
 */
function insertBlock(view, text, caret) {
  const { EditorSelection } = Editor.cm;
  const state = view.state;
  const line = state.doc.lineAt(state.selection.main.head);
  const empty = !line.text.trim();
  // 直前の行に本文があるときは空行をはさむ。詰めて置くと --- が
  // 「前の行の見出し」として解釈されるなど、別の記法になってしまう。
  const lead = empty ? '' : '\n\n';
  const from = empty ? line.from : line.to;
  const insert = lead + text + '\n';
  const head = from + lead.length + (caret === undefined ? text.length : caret);

  view.dispatch({
    changes: { from, to: empty ? line.to : from, insert },
    selection: EditorSelection.cursor(head),
    scrollIntoView: true
  });
  view.focus();
}

/** リンクを作る。選択が無ければ文言も置いて、そこを選んだ状態にする。 */
function insertLink(view) {
  const { EditorSelection } = Editor.cm;
  const state = view.state;
  const doc = state.doc;

  view.dispatch(state.changeByRange((range) => {
    const text = doc.sliceString(range.from, range.to) || 'リンク';
    const url = 'https://';
    const insert = '[' + text + '](' + url + ')';
    // URL を選んだ状態にしておけば、貼り付けるだけで差し替えられる。
    const at = range.from + text.length + 3;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(at, at + url.length)
    };
  }));
  view.focus();
}

/** 入力バーのボタン。label は見た目、title は説明。 */
const MD_TOOLS = [
  { label: 'H1', title: '見出し 1', run: (v) => toggleHeading(v, 1) },
  { label: 'H2', title: '見出し 2', run: (v) => toggleHeading(v, 2) },
  { label: 'H3', title: '見出し 3', run: (v) => toggleHeading(v, 3) },
  { sep: true },
  { label: 'B', title: '太字', class: 'mdbar__btn--bold', run: (v) => wrapSelection(v, '**', '**') },
  { label: 'I', title: '斜体', class: 'mdbar__btn--italic', run: (v) => wrapSelection(v, '*', '*') },
  { label: 'S', title: '打ち消し線', class: 'mdbar__btn--strike', run: (v) => wrapSelection(v, '~~', '~~') },
  { label: '`', title: 'コード（文中）', class: 'mdbar__btn--mono', run: (v) => wrapSelection(v, '`', '`') },
  { sep: true },
  { label: '引用', title: '引用', run: (v) => toggleLinePrefix(v, 'quote') },
  { label: '箇条書き', title: '箇条書き', run: (v) => toggleLinePrefix(v, 'bullet') },
  { label: '番号', title: '番号付きリスト', run: (v) => toggleLinePrefix(v, 'number') },
  { label: 'チェック', title: 'チェックリスト', run: (v) => toggleLinePrefix(v, 'task') },
  { sep: true },
  { label: 'リンク', title: 'リンク', run: (v) => insertLink(v) },
  { label: '表', title: '表を挿入', run: (v) => insertBlock(v, TABLE_TEMPLATE, 2) },
  { label: 'コード', title: 'コードブロックを挿入', run: (v) => insertBlock(v, '```\n\n```', 4) },
  { label: '図', title: 'Mermaid の図を挿入', run: (v) => insertBlock(v, MERMAID_TEMPLATE) },
  { label: '区切り', title: '区切り線', run: (v) => insertBlock(v, '---') }
];

const MdBar = {
  built: false,

  build() {
    el.mdBar.textContent = '';
    for (const tool of MD_TOOLS) {
      if (tool.sep) {
        el.mdBar.appendChild(h('span', { class: 'mdbar__sep' }));
        continue;
      }
      const btn = h('button', {
        type: 'button',
        class: 'mdbar__btn' + (tool.class ? ' ' + tool.class : ''),
        title: tool.title,
        text: tool.label
      });
      // mousedown を止めないと、押した瞬間にエディタの選択が外れる。
      btn.addEventListener('mousedown', (ev) => ev.preventDefault());
      btn.addEventListener('click', () => {
        if (Editor.view && Editor.cm) tool.run(Editor.view);
      });
      el.mdBar.appendChild(btn);
    }
    MdBar.built = true;
  },

  /** Markdown のタブのときだけ出す。 */
  update() {
    const tab = activeTab();
    const show = !!tab && Preview.mode(tab) === 'markdown'
      && Settings.get('mdToolbar') !== false;
    if (show && !MdBar.built) MdBar.build();
    el.mdBar.hidden = !show;
  }
};

/**
 * 縦の仕切りをドラッグで動かせるようにする。
 * サイドバーとプレビューで同じ処理を使う。
 *
 * @param {HTMLElement} handle 仕切りの要素
 * @param {{onDrag: function(number): void, onEnd?: function(): void,
 *          onReset?: function(): void}} opts onDrag は clientX を受け取る
 */
function wireSplitter(handle, opts) {
  let dragging = false;

  const onMove = (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    opts.onDrag(ev.clientX);
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('splitter--dragging');
    el.app.classList.remove('app--dragging');
    if (opts.onEnd) opts.onEnd();
  };

  handle.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    dragging = true;
    handle.classList.add('splitter--dragging');
    el.app.classList.add('app--dragging');
  });

  if (opts.onReset) {
    handle.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      opts.onReset();
    });
  }

  // mousemove / mouseup は window で拾う。
  // 速く動かすとポインタが仕切りから外れるため。
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

/**
 * サイドバーの幅と表示状態。
 * localStorage はサンドボックス iframe だとリロードをまたいで残らないので、
 * セッション（UserProperties）に載せる。
 */
const Layout = {
  DEFAULT_WIDTH: 268,
  MIN_WIDTH: 160,

  width: 268,
  sidebarHidden: false,

  /**
   * 画面幅に対して広すぎない値に丸める。
   * スマホではサイドバーはドロワーで幅も CSS が決めるので、丸めずにそのまま持つ
   * （セッションは PC と共有なので、スマホの幅で丸めた値を PC へ持ち帰らない）。
   */
  clamp(px) {
    if (Mobile.on) return Number.isFinite(px) ? Math.round(px) : Layout.width;
    const max = Math.max(Layout.MIN_WIDTH, Math.round(window.innerWidth * 0.6));
    return Math.min(max, Math.max(Layout.MIN_WIDTH, Math.round(px)));
  },

  apply() {
    el.app.style.setProperty('--sidebar-w', Layout.width + 'px');
    el.app.classList.toggle('app--sidebarHidden', Layout.sidebarHidden);
    el.btnToggleSidebar.setAttribute('aria-expanded',
      String(Mobile.on ? Mobile.drawerOpen : !Layout.sidebarHidden));
    el.btnToggleSidebar.title = Mobile.on ? 'ファイル一覧'
      : (Layout.sidebarHidden ? 'サイドバーを表示' : 'サイドバーを隠す') + '（' + MOD + ' + B）';
    // 幅が変わっても window の resize は起きないので、
    // 各ペインの CodeMirror に測り直しを促しておく。
    for (const leaf of Panes.leaves()) {
      if (leaf.view) leaf.view.requestMeasure();
    }
    // 比較ビューは左右の行を縦に揃える余白を px で持っているので、こちらも測り直す。
    Diff.remeasureActive();
  },

  setWidth(px, persist) {
    Layout.width = Layout.clamp(px);
    Layout.apply();
    if (persist) Session.save();
  },

  toggleSidebar() {
    // スマホではドロワーの開閉にする（PC のサイドバーの開閉状態は触らない）。
    if (Mobile.on) { Mobile.toggleDrawer(); return; }
    Layout.sidebarHidden = !Layout.sidebarHidden;
    Layout.apply();
    Session.save();
    if (!Layout.sidebarHidden) renderTreeStates();
    else if (Editor.view && activeTab()) Editor.view.focus();
  },

  /**
   * セッションから復元する。
   * サイドバーが実際に表示されたあとで呼ぶこと（幅の実測値を読むため）。
   */
  restore(session) {
    if (session && Number.isFinite(session.sidebarWidth)) {
      Layout.width = Layout.clamp(session.sidebarWidth);
      Layout.sidebarHidden = !!session.sidebarHidden;
      Layout.apply();
      return;
    }

    // 保存が無い場合は CSS の既定値に合わせる。
    // --sidebar-w は画面幅によって変わる（狭い画面では 200px）ので、
    // ここで実測しておかないと最初のドラッグで幅が飛ぶ。
    const measured = parseFloat(getComputedStyle(el.sidebar).width);
    if (Number.isFinite(measured) && measured > 0) Layout.width = Math.round(measured);

    if (session) {
      Layout.sidebarHidden = !!session.sidebarHidden;
      Layout.apply();
    }
  }
};

