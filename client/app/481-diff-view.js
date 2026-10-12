/* ------------------------------------------------------------------ *
 *  Diff（続き）— エディタの組み立て・再計測・移動
 * ------------------------------------------------------------------ */

Object.assign(Diff, {

  /**
   * アクティブな比較タブのペインを出す。無ければ作る。
   * タブを切り替えてもペインは残すので、スクロール位置と Undo 履歴が保たれる。
   * @param {Tab} tab
   */
  mount(leaf, tab) {
    const body = leaf.el.diffBody;
    for (const node of Array.from(body.children)) node.hidden = true;
    const d = tab.diff;
    if (!d.host) d.host = h('div', { class: 'diffPane' });
    // 別のペインへ移した比較タブは、作ってあるビューごと引っ越す。
    if (d.host.parentElement !== body) body.appendChild(d.host);
    d.host.hidden = false;
    if (!d.view) {
      Diff.build(tab);
    } else {
      // 隠れている間は幅 0 で測られているので、余白（spacer）を測り直させる。
      Diff.remeasure(tab);
    }
    Diff.renderBar(tab);
  },

  /** 左右の内容から MergeView（並列）か EditorView（インライン）を作る。 */
  build(tab) {
    const d = tab.diff;
    const { MergeView, unifiedMergeView } = Diff.mod;
    const { EditorView } = Editor.cm;
    d.host.textContent = '';

    const aDoc = Diff.docText(tab, 'a');
    const bDoc = Diff.docText(tab, 'b');
    const collapse = d.collapse ? Diff.COLLAPSE : undefined;

    if (d.mode === 'unified') {
      d.view = new EditorView({
        doc: bDoc,
        extensions: [
          Diff.sideExtensions(tab, 'b'),
          unifiedMergeView({
            original: aDoc,
            highlightChanges: true,
            gutter: true,
            allowInlineDiffs: true,
            mergeControls: !d.normalize,
            collapseUnchanged: collapse,
            diffConfig: Diff.DIFF_CONFIG
          })
        ],
        parent: d.host
      });
    } else {
      d.view = new MergeView({
        a: { doc: aDoc, extensions: Diff.sideExtensions(tab, 'a') },
        b: { doc: bDoc, extensions: Diff.sideExtensions(tab, 'b') },
        parent: d.host,
        // 整形して比較している間は中身を触らせない（表示が元の文字列と違うため）。
        revertControls: d.normalize ? undefined : d.revert,
        highlightChanges: true,
        gutter: true,
        collapseUnchanged: collapse,
        diffConfig: Diff.DIFF_CONFIG
      });
    }
    Diff.refreshStats(tab);
  },

  /**
   * 片側ぶんのエディタ拡張。テキストのタブと同じ見た目・キー操作にそろえる。
   * 配色と折り返しは Editor と同じ compartment を使うので、設定変更が一緒に効く。
   * @param {Tab} tab
   * @param {'a'|'b'} which
   */
  sideExtensions(tab, which) {
    const {
      EditorState, EditorView, basicSetup, keymap, search, indentUnit, Prec,
      themeFor, hasSelection
    } = Editor.cm;
    const d = tab.diff;
    const side = d[which];
    const support = (side.langKey && Editor.langCache.get(side.langKey)) || [];
    const useTabs = !!Settings.get('defaultIndentWithTabs');
    const size = Settings.get('defaultIndentUnit') || 2;
    const tabId = tab.id;

    return [
      basicSetup,
      Editor.themeCompartment.of(themeFor(Theme.resolved)),
      hasSelection,
      Editor.wrapCompartment.of(Editor.wrapEnabled ? EditorView.lineWrapping : []),
      indentUnit.of(useTabs ? '\t' : ' '.repeat(size)),
      EditorState.tabSize.of(size),
      // 検索パネルはテキストのタブと違って下に出す。並列表示では片側のエディタに
      // しか出ないので、上に置くとその側だけ下へずれて左右の行が揃わなくなる。
      search(),
      EditorState.phrases.of(PHRASES),
      support,
      d.normalize ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
      Prec.high(keymap.of(Diff.keymapFor(tabId))),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) Diff.onEdited(tabId, which);
        // インライン表示の「取り込む」は元（左）の側を書き換える。
        if (update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(Diff.mod.updateOriginalDoc)))) {
          Diff.onEdited(tabId, 'a');
        }
      })
    ];
  },

  /** 比較ビューの中だけで効かせるキー。 */
  keymapFor(tabId) {
    return [
      { key: 'F7', preventDefault: true, run: () => Diff.navById(tabId, 1) },
      { key: 'Shift-F7', preventDefault: true, run: () => Diff.navById(tabId, -1) },
      { key: 'Mod-s', preventDefault: true, run: () => { void Diff.saveFocused(tabId); return true; } },
      { key: 'Mod-b', preventDefault: true, run: () => { Layout.toggleSidebar(); return true; } },
      { key: 'Mod-p', preventDefault: true, run: () => { Palette.open('file'); return true; } },
      { key: 'Mod-Shift-p', preventDefault: true, run: () => { Palette.open('command'); return true; } },
      { key: 'Alt-z', preventDefault: true, run: () => Editor.toggleWrap() }
    ];
  },

  /** 作り直す（表示モードや材料が変わったとき）。 */
  async rebuild(tab) {
    const d = tab.diff;
    // 言語サポートは作る前にそろえておく（間に合わなければハイライト無しで作る）。
    const keys = [d.a.langKey, d.b.langKey].filter(Boolean);
    if (keys.length) await Promise.all(keys.map((k) => Editor.loadLanguage(k)));
    if (!getTab(tab.id)) return;

    Diff.destroyView(d);
    const leaf = Panes.leafOf(tab.id);
    if (leaf && leaf.activeId === tab.id) {
      Diff.mount(leaf, tab);
    } else {
      // 非アクティブなタブは、次に表示されたときに作る。
      Diff.refreshStats(tab);
    }
  },

  destroyView(d) {
    if (d.barTimer) { clearTimeout(d.barTimer); d.barTimer = null; }
    if (d.view) {
      try { d.view.destroy(); } catch (e) { /* 破棄の失敗は無視してよい */ }
      d.view = null;
    }
    if (d.host) d.host.textContent = '';
  },

  /** タブを閉じるときの後片付け。 */
  destroy(tab) {
    if (!tab.diff) return;
    Diff.destroyView(tab.diff);
    if (tab.diff.host) {
      tab.diff.host.remove();
      tab.diff.host = null;
    }
  },

  /**
   * いま表示している比較ビューを測り直す（ペインの幅・サイドバー幅・
   * ウィンドウサイズが変わったとき）。分割していれば複数ありうる。
   */
  remeasureActive() {
    for (const leaf of Panes.leaves()) {
      const tab = getTab(leaf.activeId);
      if (tab && tab.kind === 'diff') Diff.remeasure(tab);
    }
  },

  /** 隠れている間に測れなかった余白を測り直させる。 */
  remeasure(tab) {
    const d = tab.diff;
    if (!d.view) return;
    if (d.mode === 'unified') { d.view.requestMeasure(); return; }
    d.view.a.requestMeasure();
    d.view.b.requestMeasure();
    // reconfigure は最後に scheduleMeasure() を呼ぶので、空の指定で測り直しだけ頼める。
    d.view.reconfigure({});
  },

  /** 配色・折り返しの差し替えを、開いている比較ビューにも当てる。 */
  applyEffects(effects) {
    for (const tab of App.tabs) {
      if (tab.kind !== 'diff' || !tab.diff || !tab.diff.view) continue;
      Diff.eachView(tab, (v) => v.dispatch({ effects }));
    }
  },

  eachView(tab, fn) {
    const d = tab.diff;
    if (!d || !d.view) return;
    if (d.mode === 'unified') fn(d.view);
    else { fn(d.view.a); fn(d.view.b); }
  },

  /* -------------------------------------------------- *
   *  内容の出し入れ
   * -------------------------------------------------- */

  /** エディタに載せる文字列（「空白を無視」なら整形後）。 */
  docText(tab, which) {
    const side = tab.diff[which];
    return tab.diff.normalize ? Diff.normalizeText(side.content) : side.content;
  },

  /**
   * 空白の違いを無視するための整形。
   * 行の前後の空白を落とし、行内の連続する空白を 1 つにし、空行を捨てる。
   * 表示もこの結果になるので、この間は書き戻しを止めている。
   */
  normalizeText(text) {
    return String(text || '')
      .split('\n')
      .map((line) => line.replace(/[ \t　]+/g, ' ').trim())
      .filter((line) => line.length > 0)
      .join('\n');
  },

  /** @type {function(Tab): ({a:Object, b:Object}|null)} 表示中の Text（左右）。 */
  docs(tab) {
    const d = tab.diff;
    if (!d.view) return null;
    if (d.mode === 'unified') {
      return { a: Diff.mod.getOriginalDoc(d.view.state), b: d.view.state.doc };
    }
    return { a: d.view.a.state.doc, b: d.view.b.state.doc };
  },

  /** いまの片側の内容（編集やコピーの結果を含む）。 */
  contentOf(tab, which) {
    const docs = Diff.docs(tab);
    if (docs) return docs[which].toString();
    return tab.diff[which].content;
  },

  /**
   * 表示中の内容を DiffSide へ書き戻す（作り直しても編集結果が消えないように）。
   * 整形して比較している間は表示が元の文字列と違うので取り込まない。
   */
  captureContents(tab) {
    const d = tab.diff;
    if (d.normalize) return;
    const docs = Diff.docs(tab);
    if (!docs) return;
    d.a.content = docs.a.toString();
    d.b.content = docs.b.toString();
  },

  /* -------------------------------------------------- *
   *  差分の集計とナビゲーション
   * -------------------------------------------------- */

  chunksOf(tab) {
    const d = tab.diff;
    if (!d.view) return [];
    if (d.mode === 'unified') {
      const got = Diff.mod.getChunks(d.view.state);
      return (got && got.chunks) || [];
    }
    return d.view.chunks || [];
  },

  /** 「N 箇所 / −X 行 / +Y 行」を数え直す。 */
  refreshStats(tab) {
    const d = tab.diff;
    const chunks = Diff.chunksOf(tab);
    const docs = Diff.docs(tab);
    let del = 0;
    let ins = 0;
    let precise = true;
    if (docs) {
      for (const c of chunks) {
        if (c.toA !== c.fromA) del += docs.a.lineAt(c.endA).number - docs.a.lineAt(c.fromA).number + 1;
        if (c.toB !== c.fromB) ins += docs.b.lineAt(c.endB).number - docs.b.lineAt(c.fromB).number + 1;
        if (c.precise === false) precise = false;
      }
    }
    d.stats = { count: chunks.length, del, ins, precise };
  },

  navById(tabId, dir) {
    const tab = getTab(tabId);
    if (!tab || tab.kind !== 'diff') return false;
    return Diff.nav(tab, dir);
  },

  /** 次（dir>0）／前（dir<0）の差分へ移動する。 */
  nav(tab, dir) {
    const d = tab.diff;
    if (!d.view) return false;
    if (!d.stats.count) {
      toast('差分はありません', 'info', 2000);
      return true;
    }
    const view = Diff.focusedView(tab);
    const cmd = dir > 0 ? Diff.mod.goToNextChunk : Diff.mod.goToPreviousChunk;
    const moved = cmd(view);
    view.focus();
    if (!moved) {
      toast(dir > 0 ? 'これより後に差分はありません' : 'これより前に差分はありません', 'info', 2000);
    }
    return true;
  },

  /** 操作の対象になるエディタ。フォーカスが無ければ右側。 */
  focusedView(tab) {
    const d = tab.diff;
    if (d.mode === 'unified') return d.view;
    if (d.view.a.hasFocus) return d.view.a;
    return d.view.b;
  },

  focusedSide(tab) {
    const d = tab.diff;
    if (d.mode === 'unified') return 'b';
    return d.view && d.view.a.hasFocus ? 'a' : 'b';
  }
});
