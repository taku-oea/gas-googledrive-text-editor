/* ------------------------------------------------------------------ *
 *  Vendor — CodeMirror 等のライブラリの取得元
 *
 *  取得元は 3 つあり、この順に試す。どこから来ても同じ形（fromEsm と
 *  client/vendor/index.js の export が一致）にして Editor に渡す。
 *   1. window.VENDOR … tools/build.mjs --inline が GAS の HTML に同梱した版
 *   2. import('vendor') … import map の "vendor"（配信元に置いた content-hash 付きバンドル 1 本）
 *   3. esm.sh … import map のパッケージ別 URL（32 ファイル / 4 段の直列取得）
 *  2 は tools/build.mjs --apply が import map に書き込む。無ければ試さない。
 *  2 には import map の integrity（SRI）が付いていて、中身が違えば読み込みが失敗する。
 *  3 は SRI を付けられない第三者 CDN なので、スクリプトプロパティ
 *  ESM_FALLBACK_ENABLED=true のとき（window.__ESM_FALLBACK）だけ使う。
 * ------------------------------------------------------------------ */

const Vendor = {
  mod: null,
  source: null,
  _p: null,

  /** import map に "vendor" が登録されているか（build --apply 済みか）。 */
  configured() {
    try {
      const im = document.querySelector('script[type="importmap"]');
      return !!(im && JSON.parse(im.textContent).imports.vendor);
    } catch (e) {
      return false;
    }
  },

  /** esm.sh に落ちてよいか（管理者が ESM_FALLBACK_ENABLED=true にしたときだけ）。 */
  esmAllowed() {
    return window.__ESM_FALLBACK === true;
  },

  /** esm.sh を使えないときの失敗。原因を画面に出せる文にする。 */
  blocked(cause) {
    return new Error('エディタのライブラリを読み込めませんでした（' + cause + '）。' +
      'ネットワークを確認してください。続く場合は管理者に連絡してください。');
  },

  load() {
    if (Vendor._p) return Vendor._p;
    Vendor._p = (async () => {
      const end = Perf.start('vendor.load');
      if (window.VENDOR) {
        Vendor.mod = window.VENDOR;
        Vendor.source = 'inline';
      } else if (Vendor.configured()) {
        try {
          Vendor.mod = await import('vendor');
          Vendor.source = 'bundle';
        } catch (err) {
          const why = err && err.message ? err.message : String(err);
          if (!Vendor.esmAllowed()) throw Vendor.blocked('配信元のバンドル: ' + why);
          console.warn('[vendor] バンドルを取得できなかったため esm.sh から読み込みます: ' + why);
          Vendor.mod = await Vendor.fromEsm();
          Vendor.source = 'esm.sh';
        }
      } else {
        if (!Vendor.esmAllowed()) throw Vendor.blocked('バンドルが import map に登録されていません');
        Vendor.mod = await Vendor.fromEsm();
        Vendor.source = 'esm.sh';
      }
      end({ source: Vendor.source });
      return Vendor.mod;
    })();
    Vendor._p.catch(() => { Vendor._p = null; });
    return Vendor._p;
  },

  /** esm.sh からパッケージ別に読み、バンドルと同じ形に整える。 */
  async fromEsm() {
    const [cmMod, stateMod, viewMod, commandsMod, searchMod, langMod, lezerMod, indentMod] =
      await Promise.all([
        import('codemirror'),
        import('@codemirror/state'),
        import('@codemirror/view'),
        import('@codemirror/commands'),
        import('@codemirror/search'),
        import('@codemirror/language'),
        import('@lezer/highlight'),
        import('@replit/codemirror-indentation-markers')
      ]);
    return {
      basicSetup: cmMod.basicSetup,
      EditorState: stateMod.EditorState,
      EditorSelection: stateMod.EditorSelection,
      Compartment: stateMod.Compartment,
      Annotation: stateMod.Annotation,
      Transaction: stateMod.Transaction,
      Prec: stateMod.Prec,
      EditorView: viewMod.EditorView,
      keymap: viewMod.keymap,
      indentWithTab: commandsMod.indentWithTab,
      search: searchMod.search,
      gotoLine: searchMod.gotoLine,
      openSearchPanel: searchMod.openSearchPanel,
      indentUnit: langMod.indentUnit,
      syntaxHighlighting: langMod.syntaxHighlighting,
      HighlightStyle: langMod.HighlightStyle,
      StreamLanguage: langMod.StreamLanguage,
      tags: lezerMod.tags,
      indentationMarkers: indentMod.indentationMarkers,
      langs: {
        javascript: (o) => import('@codemirror/lang-javascript').then((m) => m.javascript(o || {})),
        json:       () => import('@codemirror/lang-json').then((m) => m.json()),
        html:       () => import('@codemirror/lang-html').then((m) => m.html()),
        css:        () => import('@codemirror/lang-css').then((m) => m.css()),
        markdown:   () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
        python:     () => import('@codemirror/lang-python').then((m) => m.python()),
        yaml:       () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
        sql:        () => import('@codemirror/lang-sql').then((m) => m.sql()),
        xml:        () => import('@codemirror/lang-xml').then((m) => m.xml()),
        shell:      () => import('@codemirror/legacy-modes/mode/shell')
          .then((m) => langMod.StreamLanguage.define(m.shell))
      },
      loadMerge: () => import('@codemirror/merge'),
      loadMarked: () => import('marked'),
      loadDompurify: () => import('dompurify'),
      loadFuzzysort: () => import('fuzzysort'),
      loadMermaid: () => import('mermaid')
    };
  },

  /** 言語サポートを読む（LANGUAGES から）。 */
  async lang(key, opts) {
    const v = await Vendor.load();
    const loader = v.langs && v.langs[key];
    if (!loader) throw new Error('未対応の言語です: ' + key);
    return loader(opts);
  }
};

const Editor = {
  cm: null,
  // view は「アクティブなペインの EditorView」への getter。Editor の下で定義する。
  languageCompartment: null,
  wrapCompartment: null,
  indentCompartment: null,
  themeCompartment: null,
  readOnlyCompartment: null,
  langCache: new Map(),
  wrapEnabled: true,

  /** load() の進行中／完了した Promise。失敗したら null に戻し、次の呼び出しで再試行する。 */
  _loading: null,
  /** 未編集タブの本文を裏で差し替えるときに付ける印。updateListener はこれを見て dirty にしない。 */
  silentSwap: null,

  /**
   * CodeMirror 本体（モジュール群）を読み込む。EditorView はまだ作らない。
   * 何度呼んでも読み込みは 1 回。CDN に到達できず失敗したときだけ次回に再試行する。
   * 呼び出し側は失敗を catch すること（ツリーなど CM を使わない部分は動き続ける）。
   * @return {Promise<void>}
   */
  load() {
    if (Editor._loading) return Editor._loading;
    Editor._loading = (async () => {
      const v = await Vendor.load();
      Editor.cm = {
        basicSetup: v.basicSetup,
        EditorState: v.EditorState,
        EditorSelection: v.EditorSelection,
        Compartment: v.Compartment,
        Annotation: v.Annotation,
        Transaction: v.Transaction,
        Prec: v.Prec,
        EditorView: v.EditorView,
        keymap: v.keymap,
        indentWithTab: v.indentWithTab,
        search: v.search,
        gotoLine: v.gotoLine,
        openSearchPanel: v.openSearchPanel,
        indentUnit: v.indentUnit,
        // テーマとトークン色は compartment で差し替えるので、作り方だけ持つ。
        themeFor: (mode) => [
          cmTheme(v.EditorView, mode),
          v.syntaxHighlighting(cmHighlightStyle(v.HighlightStyle, v.tags, mode))
        ],
        hasSelection: cmHasSelection(v.EditorView),
        indentationMarkers: v.indentationMarkers
      };
      Editor.silentSwap = v.Annotation.define();
      Editor.languageCompartment = new Editor.cm.Compartment();
      Editor.wrapCompartment = new Editor.cm.Compartment();
      Editor.indentCompartment = new Editor.cm.Compartment();
      Editor.themeCompartment = new Editor.cm.Compartment();
      Editor.readOnlyCompartment = new Editor.cm.Compartment();
    })();
    Editor._loading.catch(() => { Editor._loading = null; });
    return Editor._loading;
  },

  /**
   * ペイン 1 枚ぶんの EditorView を作る。そのペインが表示されている状態で、
   * 実際に表示する state を渡して呼ぶ（空の state で作ってから setState で
   * 入れ替えると、レイアウトが 2 回走る）。既に作ってあれば何もしない。
   * @param {Object} leaf ペイン
   * @param {Object|null} [state] 無ければ空の文書
   * @return {Object} EditorView
   */
  mount(leaf, state) {
    if (leaf.view) return leaf.view;
    leaf.view = new Editor.cm.EditorView({
      state: state || Editor.buildState('', null),
      parent: leaf.el.editorHost
    });
    // スクロール連動用。scrollDOM は setState をまたいでも同じ要素なので、
    // ここで 1 回だけ張ればこのペインの全タブに効く。連動先は「いま表示している
    // ファイルのプレビュータブ」で、別のペインに出ていても届く。
    leaf.view.scrollDOM.addEventListener('scroll', () => {
      Sync.onEditorScroll(getTab(leaf.activeId));
    }, { passive: true });
    App.editorReady = true;
    return leaf.view;
  },

  /**
   * 未編集のタブの本文を、選択とスクロール位置を保ったまま差し替える
   * （起動時のスナップショットより新しい本文が届いたときなど）。
   * dirty にも Undo 履歴にも残さない。
   * @param {Tab} tab
   * @param {Object} data readFile の data
   */
  replaceDocKeepView(tab, data) {
    const text = normalizeEol(data.content);
    // 別の場所で改行コードが変えられていることがある（reloadTab と同じく判定し直す）。
    // 古い eol のまま次の保存をすると、相手が変えた改行コードを全行ぶん書き戻してしまう。
    tab.eol = detectEol(data.content) || tab.eol;
    tab.baseUpdatedAtIso = data.updatedAtIso;
    tab.size = data.size;
    tab.name = data.name;
    // 新しい本文で「読めない」が付いた・外れたら閲覧専用も合わせる。buildState でしか
    // 決めていないと、壊れた本文が編集できたり、直った本文が閲覧専用のまま残ったりする
    // （呼び出し元は Store.putContent / Api.readFile で TextCodec を更新済み）。
    const broken = TextCodec.isBroken(tab.id);
    const flip = !!tab.state && tab.state.readOnly !== broken;
    const changed = !!tab.state && tab.state.doc.toString() !== text;
    if (changed || flip) {
      const spec = {
        annotations: [Editor.silentSwap.of(true), Editor.cm.Transaction.addToHistory.of(false)]
      };
      if (changed) spec.changes = { from: 0, to: tab.state.doc.length, insert: text };
      if (flip) spec.effects = Editor.readOnlyCompartment.reconfigure(Editor.readOnlyFor(tab.id));
      // どのペインに出ていても届くように、表示中ならそのビューへ流す。
      const view = Panes.viewOf(tab.id);
      if (view) view.dispatch(spec);
      else tab.state = tab.state.update(spec).state;
    }
    if (flip && broken) {
      toast('「' + tab.name + '」の新しい内容には UTF-8 としても Shift_JIS としても読めない部分があるため、' +
        '閲覧専用にしました（保存すると読めない部分が壊れるため）。', 'warn', 10000);
    }
    if (App.activeId === tab.id) {
      el.sbName.textContent = tab.name;
      el.sbSize.textContent = formatBytes(tab.size);
    }
  },

  /**
   * 閲覧専用の拡張。UTF-8 としても Shift_JIS としても読めなかったファイルは閲覧専用
   * （置換文字で開いているので、編集して保存すると元のバイト列が失われる）。
   * @param {string|null} tabId
   * @return {*} Extension
   */
  readOnlyFor(tabId) {
    return tabId && TextCodec.isBroken(tabId) ? Editor.cm.EditorState.readOnly.of(true) : [];
  },

  /**
   * タブ 1 枚ぶんの EditorState を作る。
   * updateListener にタブ ID を焼き込むので、どのタブの変更かを取り違えない。
   * @param {string} doc
   * @param {string|null} tabId
   * @return {Object} EditorState
   */
  buildState(doc, tabId) {
    const {
      EditorState, EditorView, basicSetup, keymap, search, indentWithTab, Prec,
      themeFor, hasSelection, indentationMarkers
    } = Editor.cm;
    return EditorState.create({
      doc,
      extensions: [
        // basicSetup に 行番号 / 検索 / 複数カーソル / Undo履歴 / 括弧対応 / 折りたたみ が入る。
        basicSetup,
        // テーマとトークン色。basicSetup の defaultHighlightStyle より後ろに
        // 置いて上書きする。中身はライト／ダークで差し替える（Editor.setTheme）。
        Editor.themeCompartment.of(themeFor(Theme.resolved)),
        hasSelection,
        // light / dark は CM6 がテーマの dark フラグから決めるので、
        // テーマを差し替えればガイドの色も一緒に切り替わる。
        indentationMarkers({
          highlightActiveBlock: true,
          hideFirstIndent: true,
          thickness: 1,
          colors: { light: '#d3d3d3', dark: '#404040', activeLight: '#a8a8a8', activeDark: '#707070' }
        }),
        search({ top: true }),
        EditorState.phrases.of(PHRASES),
        Editor.languageCompartment.of([]),
        Editor.wrapCompartment.of(Editor.wrapEnabled ? EditorView.lineWrapping : []),
        Editor.indentCompartment.of([]),
        // 読めなかったファイルは閲覧専用。裏で本文が差し替わったときに付け外しできるよう
        // Compartment に入れる（replaceDocKeepView）。
        Editor.readOnlyCompartment.of(Editor.readOnlyFor(tabId)),

        // タブやツリーの行を本文の上で落としたとき、CodeMirror は既定では
        // それをテキストの貼り付けとして扱う。ここで止めて、ペイン側の
        // 受け口（wirePaneDrop）へ渡す。
        EditorView.domEventHandlers({
          dragover: (event) => {
            if (!isAppDrag()) return false;
            event.preventDefault();
            return true;
          },
          drop: (event) => {
            if (!isAppDrag()) return false;
            event.preventDefault();
            return true;
          }
        }),

        // basicSetup のキーマップより先に効かせる。
        Prec.high(keymap.of(vsCodeKeymap())),
        // Tab でインデント。コードを書く用途なので既定の a11y 挙動より優先する
        // （Escape でフォーカスを外せば Tab でのページ移動に戻れる）。
        keymap.of([indentWithTab]),

        EditorView.updateListener.of((update) => {
          if (!tabId) return;
          const tab = getTab(tabId);
          if (!tab) return;
          // アクティブなタブの state は常に最新へ同期しておく。
          tab.state = update.state;
          // 裏での本文差し替え（replaceDocKeepView）は編集として扱わない。
          if (update.transactions.some((tr) => tr.annotation(Editor.silentSwap))) return;
          // tabId は state を作った時点の ID。作成中の一時メモでは仮 ID なので、
          // 保存など下流へ渡すときは必ず今の tab.id（実 ID）に読み替える。
          if (update.docChanged) onDocChanged(tab.id);
          if (update.selectionSet || update.docChanged) updateCursorReadout();
        })
      ]
    });
  },

  /**
   * 言語サポートを当てる。非アクティブなタブには state を直接組み替える
   * （view.dispatch は今表示している state にしか効かないため）。
   * @param {Tab} tab
   * @param {*} support
   */
  applyLanguage(tab, support) {
    const effects = Editor.languageCompartment.reconfigure(support || []);
    const view = Panes.viewOf(tab.id);
    if (view) {
      view.dispatch({ effects });
    } else {
      tab.state = tab.state.update({ effects }).state;
    }
  },

  /**
   * 言語モジュールを読み込む。失敗してもプレーンテキストとして開けるよう、
   * 例外は握りつぶして警告だけ出す。
   * @param {string|null} langKey
   * @return {Promise<{support:*, label:string}>}
   */
  async loadLanguage(langKey) {
    const entry = langKey ? LANGUAGES[langKey] : null;
    if (!entry) return { support: [], label: 'プレーンテキスト' };
    try {
      if (!Editor.langCache.has(langKey)) {
        Editor.langCache.set(langKey, await entry.load());
      }
      return { support: Editor.langCache.get(langKey), label: entry.label };
    } catch (err) {
      console.warn('言語モジュールの読み込みに失敗しました: ' + langKey, err);
      return { support: [], label: 'プレーンテキスト（' + entry.label + ' の読み込みに失敗）' };
    }
  },

  /**
   * タブのインデント設定を state に反映する。
   * @param {Tab} tab
   */
  applyIndent(tab) {
    const { EditorState, indentUnit } = Editor.cm;
    const unit = tab.indentWithTabs ? '\t' : ' '.repeat(tab.indentUnit);
    const effects = Editor.indentCompartment.reconfigure([
      indentUnit.of(unit),
      EditorState.tabSize.of(tab.indentUnit)
    ]);
    const view = Panes.viewOf(tab.id);
    if (view) view.dispatch({ effects });
    else if (tab.state) tab.state = tab.state.update({ effects }).state;
  },

  /**
   * compartment の差し替えを、開いている全タブに効かせる。
   * どれかのペインに出ているタブはそのビュー越しに、出ていないタブは
   * state を直接組み替える（ビューを持たないため）。
   * @param {Object} effects
   */
  broadcast(effects) {
    for (const leaf of Panes.leaves()) {
      if (leaf.view) leaf.view.dispatch({ effects });
    }
    for (const tab of App.tabs) {
      if (!Panes.isVisible(tab.id) && tab.state) {
        tab.state = tab.state.update({ effects }).state;
      }
    }
  },

  /**
   * 配色を差し替える。全タブに効かせる。
   * CM の読み込み前に呼ばれたら何もしない（buildState が Theme.resolved を見る）。
   * @param {'light'|'dark'} mode
   */
  setTheme(mode) {
    if (!Editor.cm || !Editor.themeCompartment) return;
    const effects = Editor.themeCompartment.reconfigure(Editor.cm.themeFor(mode));
    Editor.broadcast(effects);
    Diff.applyEffects(effects);
  },

  /**
   * 折り返しを設定する。全タブに効かせる。
   * @param {boolean} enabled
   */
  setWrap(enabled) {
    const { EditorView } = Editor.cm;
    Editor.wrapEnabled = !!enabled;
    const value = Editor.wrapEnabled ? EditorView.lineWrapping : [];
    const effects = Editor.wrapCompartment.reconfigure(value);
    Editor.broadcast(effects);
    Diff.applyEffects(effects);
  },

  /** 折り返しの ON/OFF を切り替える（Alt+Z）。設定にも反映する。 */
  toggleWrap() {
    Editor.setWrap(!Editor.wrapEnabled);
    Settings.set('lineWrap', Editor.wrapEnabled);
    toast('行の折り返しを' + (Editor.wrapEnabled ? 'ON' : 'OFF') + 'にしました', 'info', 2500);
    return true;
  }
};

/**
 * アクティブなペインの EditorView。
 *
 * 分割前は 1 つしか無かったので Editor.view を直に持っていた。いまは
 * ペインごとに 1 つずつあり、「いま操作しているビュー」を指すこの名前は
 * アクティブなペインのものへ委譲する。特定のタブに効かせたいときは
 * Panes.viewOf(tabId) を使うこと。
 */
Object.defineProperty(Editor, 'view', {
  get() {
    const leaf = Panes.active();
    return leaf ? leaf.view : null;
  }
});

/**
 * VS Code 風の追加キーバインド。
 * 行移動・行複製・行削除・コメントトグル・Mod-d は defaultKeymap / searchKeymap に
 * 含まれているのでここでは足さない。ここは CM6 に無いものだけ。
 * @return {Array}
 */
function vsCodeKeymap() {
  return [
    { key: 'Mod-s', preventDefault: true, run: () => { void saveNow(App.activeId); return true; } },
    { key: 'Mod-Alt-ArrowUp', preventDefault: true, run: addCursorVertically(-1) },
    { key: 'Mod-Alt-ArrowDown', preventDefault: true, run: addCursorVertically(1) },
    { key: 'Alt-z', preventDefault: true, run: () => Editor.toggleWrap() },
    { key: 'Mod-Shift-v', preventDefault: true, run: () => { void togglePreview(); return true; } },
    { key: 'Mod-b', preventDefault: true, run: () => { Layout.toggleSidebar(); return true; } },
    { key: 'Mod-p', preventDefault: true, run: () => { Palette.open('file'); return true; } },
    { key: 'Mod-Shift-p', preventDefault: true, run: () => { Palette.open('command'); return true; } },
    { key: 'Mod-Shift-f', preventDefault: true, run: () => {
        Views.show('search'); el.searchInput.focus(); return true;
      } }
  ];
}

/**
 * 上／下の行にカーソルを追加する（VS Code の Ctrl+Alt+↑/↓）。
 * CM6 の標準コマンドには無いので自前で実装する。
 * @param {number} dir -1 で上、1 で下
 * @return {function(Object): boolean}
 */
function addCursorVertically(dir) {
  return (view) => {
    const { EditorSelection } = Editor.cm;
    const state = view.state;
    const ranges = state.selection.ranges;

    // いちばん端のカーソルを起点にすると、押すたびに範囲が広がる。
    const edge = ranges.reduce((a, b) => (dir < 0
      ? (a.head < b.head ? a : b)
      : (a.head > b.head ? a : b)));

    const line = state.doc.lineAt(edge.head);
    const goalCol = edge.head - line.from;
    const targetNo = line.number + dir;
    if (targetNo < 1 || targetNo > state.doc.lines) return false;

    const target = state.doc.line(targetNo);
    const pos = Math.min(target.from + goalCol, target.to);
    if (ranges.some((r) => r.empty && r.head === pos)) return false;

    view.dispatch({
      selection: EditorSelection.create(
        [...ranges, EditorSelection.cursor(pos)],
        ranges.length
      ),
      scrollIntoView: true
    });
    return true;
  };
}

/** タブの本文を取り出す。 */
function tabDoc(tab) {
  if (tab.state) return tab.state.doc.toString();
  // CM 到着前でスナップショットの本文だけ持っている段階。
  if (tab.pending && typeof tab.pending.content === 'string') return normalizeEol(tab.pending.content);
  return '';
}

function updateCursorReadout() {
  const tab = activeTab();
  if (!tab || !Editor.view) { el.sbCursor.textContent = ''; return; }

  const state = Editor.view.state;
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);
  const parts = [line.number + ' 行 ' + (main.head - line.from + 1) + ' 列'];

  // 選択している文字数。複数選択なら合計と個数。
  const ranges = state.selection.ranges;
  const selected = ranges.reduce((sum, r) => sum + (r.to - r.from), 0);
  if (ranges.length > 1) {
    parts.push(ranges.length + ' カーソル' + (selected ? ' / ' + selected + ' 文字選択' : ''));
  } else if (selected > 0) {
    parts.push(selected + ' 文字選択');
  }

  el.sbCursor.textContent = parts.join('（') + (parts.length > 1 ? '）' : '');
}

/** ステータスバーのインデント・改行コード・言語の表示を更新する。 */
function updateStatusMeta() {
  const tab = activeTab();
  const isText = !!tab && tab.kind === 'text';

  el.sbIndent.hidden = !isText;
  el.sbEol.hidden = !isText;
  el.sbEnc.hidden = !isText;
  el.sbCursor.hidden = !isText;

  if (!tab) {
    el.sbLang.textContent = '';
    return;
  }
  if (tab.kind === 'diff') {
    el.sbLang.textContent = '比較（左右それぞれ編集できます）';
    return;
  }
  if (tab.kind === 'preview') {
    const mode = tab.pv ? tab.pv.mode : '';
    el.sbLang.textContent = (PREVIEW_LABELS[mode] || 'プレビュー') +
      (mode === 'csv' ? '（セルを編集できます）' : '（閲覧のみ）');
    return;
  }
  if (tab.kind === 'term') {
    el.sbLang.textContent = 'ターミナル · ' + Vfs.pathOf(tab.term ? tab.term.cwd : null);
    return;
  }
  const viewer = VIEWERS[tab.kind];
  el.sbLang.textContent = viewer ? viewer.label + '（閲覧のみ）' : tab.langLabel;
  if (!isText) return;

  el.sbIndent.textContent = tab.indentWithTabs
    ? 'タブ: ' + tab.indentUnit
    : 'スペース: ' + tab.indentUnit;
  el.sbEol.textContent = tab.eol;
  el.sbEnc.textContent = TextCodec.label(tab.id);
}

