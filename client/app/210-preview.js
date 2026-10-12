/* ------------------------------------------------------------------ *
 *  プレビュー（Markdown / HTML / drawio / 表）
 *
 *  Markdown … marked で HTML にして DOMPurify を通し、このアプリの CSS で描く。
 *             ブロックごとに data-src-line を振って左右のスクロールを連動させ、
 *             ```mermaid のコードブロックは mermaid で SVG に差し替える。
 *  HTML     … サニタイズせず、sandbox 付き iframe の srcdoc へまるごと渡す。
 *             script や style を落としたらプレビューにならないので、
 *             「消す」のではなく「隔離する」（index.html の iframe を参照）。
 *             スクリプトは既定で止め、上端のバーから明示的に動かしたときだけ実行する
 *             （共有された HTML を開いただけで外部送信・偽フォーム・ポップアップが動かないように）。
 *
 *  表       … CSV / TSV を表にする（client/app/215-csv-grid.js）。
 *
 *  どれも入力が止まったら自動で描き直す。間隔を分けているのは、
 *  Markdown は差分描画で軽いのに対し、HTML は srcdoc の入れ替え＝
 *  ページの再読み込みになるため。
 * ------------------------------------------------------------------ */

const Preview = {
  marked: null,
  purify: null,
  mermaid: null,
  /** mermaid の import は重いので、同時に何度も走らせないよう Promise を持ち回す。 */
  mermaidPending: null,

  /**
   * mermaid のソース → SVG。打鍵のたびに全部描き直さないためのキャッシュ。
   * 中身は文字列なので、プレビュータブが何枚あっても共有してよい。
   */
  diagramCache: new Map(),
  /**
   * ブロック単位の描画キャッシュ。key（種類 + 元テキスト + 参照定義）→ sanitize 済み HTML。
   * 打鍵のたびに全文を parser と DOMPurify に通していたのを、変わったブロックだけにする。
   */
  blockCache: new Map(),
  BLOCK_CACHE_MAX: 500,

  /** プレビュータブの id。元ファイルの id から作る。 */
  idFor(fileId) { return 'preview:' + fileId; },

  /** そのファイルのプレビュータブ。開いていなければ null。 */
  forSource(fileId) { return fileId ? getTab(Preview.idFor(fileId)) : null; },

  /** プレビュータブが映している元のタブ。 */
  sourceOf(tab) {
    return (tab && tab.kind === 'preview' && tab.pv) ? getTab(tab.pv.src) : null;
  },

  /**
   * そのタブでプレビューできる形式。
   * @param {Tab} tab
   * @return {'markdown'|'html'|'drawio'|'csv'|null}
   */
  mode(tab) {
    if (!tab || tab.kind !== 'text') return null;
    // drawio は拡張子で決める（中身は XML なので言語モードは xml になる）。
    if (DRAWIO_RE.test(tab.name)) return 'drawio';
    // 表も拡張子で決める（言語モードはプレーンテキストのまま）。
    if (/\.(csv|tsv)$/i.test(tab.name)) return 'csv';
    if (tab.langKey === 'markdown') return 'markdown';
    if (tab.langKey === 'html') return 'html';
    return null;
  },

  /**
   * marked と DOMPurify を遅延読み込みする。
   * ファイルの中身をそのまま HTML として描画するので、必ずサニタイズを通す。
   * 自分のファイルであっても、他人から共有されたものを開く可能性がある。
   */
  async load() {
    if (Preview.marked && Preview.purify) return true;
    try {
      const v = await Vendor.load();
      const [markedMod, purifyMod] = await Promise.all([v.loadMarked(), v.loadDompurify()]);
      Preview.marked = markedMod.marked || markedMod.default;
      Preview.purify = purifyMod.default || purifyMod;
      Preview.marked.setOptions({ gfm: true, breaks: false });
      return true;
    } catch (err) {
      console.error(err);
      toast('プレビュー用のライブラリを読み込めませんでした（ネットワークを確認してください）。', 'error', 10000);
      return false;
    }
  },

  /**
   * mermaid の設定を当てる。テーマを切り替えたときにも呼び直す。
   * @param {Object} m mermaid のモジュール
   */
  configureMermaid(m) {
    const dark = Theme.resolved === 'dark';
    // 描画はこちらから render() で呼ぶので startOnLoad は切る。
    // securityLevel は既定の strict のまま（ラベル内の HTML をエスケープする）。
    // 共有されたファイルを開く以上、ここは緩めない。
    m.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // 解釈できなかったとき、mermaid は「Syntax error」の図を
      // document.body に差し込む。エラー時の見せ方はこちらで決めるので止める。
      suppressErrorRendering: true,
      // %%{init: ...}%% や frontmatter の config: で書き換えられない項目。既定の一覧に
      // themeCSS・themeVariables・fontFamily など CSS へ入る項目を足す（MERMAID_SECURE）。
      // 図の中から文書全体に効く CSS を差し込めないようにするため。
      secure: MERMAID_SECURE,
      theme: dark ? 'dark' : 'default',
      darkMode: dark,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif'
    });
  },

  /**
   * mermaid を遅延読み込みする。数 MB あるので、```mermaid のブロックが
   * 実際に現れるまで読まない。
   * @return {Promise<Object|null>}
   */
  loadMermaid() {
    if (Preview.mermaid) return Promise.resolve(Preview.mermaid);
    if (!Preview.mermaidPending) {
      // 配信元のバンドルの遅延チャンク（SRI 付き）から読む。--inline の同梱版には
      // mermaid が入っていないので、そのときだけ esm.sh（許可されていれば）に落ちる。
      Preview.mermaidPending = Vendor.load()
        .then((v) => {
          if (v.loadMermaid) return v.loadMermaid();
          if (!Vendor.esmAllowed()) throw Vendor.blocked('mermaid が同梱されていません');
          return import('mermaid');
        })
        .then((mod) => {
          const m = mod.default || mod;
          Preview.configureMermaid(m);
          Preview.mermaid = m;
          return m;
        })
        .catch((err) => {
          console.error(err);
          // 次にプレビューを開いたときに再試行できるよう、失敗は覚えない。
          Preview.mermaidPending = null;
          toast('Mermaid を読み込めませんでした（ネットワークを確認してください）。', 'error', 8000);
          return null;
        });
    }
    return Preview.mermaidPending;
  },

  /**
   * プレビュータブを開く。既にあればそこへ移るだけ。
   *
   * 出す先は隣のペイン（無ければ分割して作る）。同じペインに重ねると
   * タブを切り替えるたびに本文かプレビューのどちらかが消えて、並べて見る
   * というプレビュー本来の使い方にならない。
   *
   * @param {Tab} srcTab 元のタブ
   * @return {Promise<Tab|null>}
   */
  async open(srcTab) {
    const mode = Preview.mode(srcTab);
    if (!mode) return null;
    if (mode === 'markdown' && !(await Preview.load())) return null;
    if (!getTab(srcTab.id)) return null;   // 読み込みを待つ間に閉じられた

    const id = Preview.idFor(srcTab.id);
    const existing = getTab(id);
    if (existing) { await activateTab(id); return existing; }

    const tab = makeTab(id, srcTab.name, 'preview');
    tab.pv = Preview.create(tab, srcTab, mode);
    App.tabs.push(tab);

    // 隣のペインへ。無ければ分割して作り、それも無理なら同じペインに置く。
    const from = Panes.active() || Panes.init();
    const leaves = Panes.leaves();
    const next = leaves[leaves.indexOf(from) + 1] ||
      (leaves.length < Panes.MAX ? Panes.split(from.id, 'row', true) : from);
    Panes.addTab(next || from, tab.id);

    renderTabs();
    await activateTab(tab.id);
    Session.save();
    return tab;
  },

  /**
   * プレビュー 1 枚ぶんの状態と DOM を作る。
   * DOM はタブが持ち、ペインを移っても作り直さない（図とスクロール位置が残る）。
   * @param {Tab} tab プレビュータブ
   * @param {Tab} srcTab 元のタブ
   * @param {'markdown'|'html'|'drawio'|'csv'} mode
   */
  create(tab, srcTab, mode) {
    const body = h('div', { class: 'preview__body markdown' });
    const frame = h('iframe', {
      class: 'preview__frame',
      title: 'HTML プレビュー',
      // script や style を落としたらプレビューにならないので、「消す」のではなく
      // 「隔離する」。allow-same-origin を付けないのが要点で、これが無い限り
      // 中身は opaque origin になり、親の DOM も Drive のセッションも触れない。
      // 最初は何も許さない（スクリプト・フォーム・ポップアップ無し）。Preview.setScripts 参照。
      sandbox: PREVIEW_SANDBOX_STATIC,
      referrerpolicy: 'no-referrer',
      hidden: true
    });
    const scriptBtn = h('button', {
      type: 'button',
      class: 'btn preview__barBtn',
      onclick: () => {
        if (tab.pv.mode === 'html') Preview.setScripts(tab, !tab.pv.scripts);
        else Preview.releaseRemote(tab.pv);
      }
    });
    const scriptMsg = h('span', { class: 'preview__barMsg' });
    const bar = h('div', { class: 'preview__bar', hidden: true }, [scriptMsg, scriptBtn]);
    const dio = h('iframe', {
      class: 'preview__frame preview__frame--drawio',
      title: 'drawio プレビュー',
      referrerpolicy: 'no-referrer',
      hidden: true
    });
    const fallback = h('div', { class: 'preview__fallback', hidden: true });
    const host = h('div', { class: 'preview' }, [bar, body, frame, dio, fallback]);
    host.addEventListener('scroll', () => Sync.onPreviewScroll(tab), { passive: true });

    // 画像や Mermaid の図が描き終わると高さが変わるので、対応表を取り直す。
    let ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(() => {
        if (!Sync.ready(tab)) return;
        Sync.measure(tab);
        Sync.follow(tab);
      });
      ro.observe(body);
    }

    return {
      ro,
      /** 元ファイルのタブ id。 */
      src: srcTab.id,
      mode,
      host, body, frame, dio, fallback,
      bar: { el: bar, msg: scriptMsg, btn: scriptBtn },
      /** HTML プレビューでスクリプトを動かしているか。タブごと・既定は止める。 */
      scripts: false,
      /** Markdown プレビューで外部の画像を出しているか。タブごと・既定は止める。 */
      remote: false,
      timer: null,
      /**
       * 描き直すたびに増える通し番号。mermaid の描画は非同期なので、
       * 待っている間に次の描画が始まっていないかをこれで確かめる。
       */
      generation: 0,
      /** 直前に描けた図（並び順）。入力途中の構文エラーで図が消えないように残す。 */
      lastDiagrams: [],
      /** HTML プレビューの縦位置。srcdoc を入れ替えると必ず先頭に戻るため覚えておく。 */
      frameScroll: 0,
      /** 一度でも描いたか。隠れている間の変更は、次に表示されたときにまとめて描く。 */
      painted: false,
      drawio: { ready: false, loaded: false, pending: null, timer: null },
      /** 表プレビューの状態（CsvGrid.create）。表に切り替わったときに作る。 */
      grid: null,
      sync: { marks: [], lock: 0, lockTimer: null, frame: 0 }
    };
  },

  /**
   * ペインの中へ差し込む。タブを切り替えても DOM は捨てないので、
   * 図やスクロール位置はそのまま残る（比較ビューと同じ考え方）。
   * @param {Object} leaf
   * @param {Tab} tab
   */
  mount(leaf, tab) {
    const host = leaf.el.previewHost;
    for (const node of Array.from(host.children)) node.hidden = true;
    const pv = tab.pv;
    if (!pv) return;
    // 別のペインへ移したときは、作ってある DOM ごと引っ越す。
    if (pv.host.parentElement !== host) host.appendChild(pv.host);
    pv.host.hidden = false;

    Preview.applyMode(tab);
    if (!pv.painted) {
      pv.painted = true;
      // セッション復元の直後は、元ファイルの本文をまだ読んでいないことがある。
      const src = Preview.sourceOf(tab);
      if (src && src.kind === 'text' && !src.loaded) {
        void loadTabContent(src).then((ok) => {
          if (ok && tab.pv && getTab(tab.id)) Preview.render(tab);
        });
      } else {
        Preview.render(tab);
      }
    } else if (pv.mode === 'markdown') {
      // 隠れている間は幅 0 で測られているので、対応表を作り直す。
      Sync.measure(tab);
      Sync.follow(tab);
    } else if (pv.mode === 'csv' && pv.grid) {
      // 隠れている間は高さ 0 で、描く範囲が決められていなかった。
      pv.grid.painted = { from: -1, to: -1 };
      CsvGrid.schedulePaint(pv.grid);
    }
  },

  /** 形式にあわせて中身を出し分ける。 */
  applyMode(tab) {
    const pv = tab.pv;
    if (!pv) return;
    pv.host.classList.toggle('preview--frame', pv.mode !== 'markdown');
    pv.body.hidden = pv.mode !== 'markdown';
    pv.frame.hidden = pv.mode !== 'html';
    Preview.paintBar(pv);
    pv.dio.hidden = pv.mode !== 'drawio';
    if (pv.mode === 'csv' && !pv.grid) {
      pv.grid = CsvGrid.create(tab);
      pv.host.appendChild(pv.grid.el);
    }
    if (pv.grid) pv.grid.el.hidden = pv.mode !== 'csv';
    pv.fallback.hidden = true;
    if (pv.mode === 'drawio') Drawio.open(tab);
    else Drawio.close(tab);
  },

  /** タブを閉じるときに片付ける。裏で動き続けさせない。 */
  destroy(tab) {
    const pv = tab && tab.pv;
    if (!pv) return;
    if (pv.ro) pv.ro.disconnect();
    clearTimeout(pv.timer);
    Drawio.close(tab);
    Sync.reset(tab);
    CsvGrid.destroy(pv.grid);
    // 閉じたプレビューのスクリプトを残さない。
    if (pv.frame.srcdoc) pv.frame.srcdoc = '';
    pv.host.remove();
    tab.pv = null;
  },

  /**
   * 元ファイルの本文が変わったとき。
   * 表示中のプレビューだけ描き直し、隠れているものは次に出たときにまとめて描く。
   * @param {string} fileId
   */
  refreshSource(fileId) {
    const tab = Preview.forSource(fileId);
    if (!tab) return;
    if (Panes.isVisible(tab.id)) Preview.schedule(tab);
    else tab.pv.painted = false;
  },

  /**
   * 元ファイルの種別が変わったとき（言語モードの手動変更・改名）。
   * プレビューできない形式になったらタブごと閉じる。
   * @param {string} fileId
   */
  syncMode(fileId) {
    const tab = Preview.forSource(fileId);
    if (!tab) return;
    const mode = Preview.mode(getTab(fileId));
    if (!mode) { void closeTab(tab.id, { force: true }); return; }
    if (mode === tab.pv.mode) return;
    tab.pv.mode = mode;
    tab.pv.painted = false;
    if (Panes.isVisible(tab.id)) {
      Preview.applyMode(tab);
      tab.pv.painted = true;
      Preview.render(tab);
    }
  },

  /**
   * テーマが変わったとき。Markdown の HTML 自体に色は入っていないが、
   * Mermaid は SVG に色を焼き込んで描くのでキャッシュを捨てて描き直す。
   * drawio も配色を URL で渡しているので読み込み直す。
   * HTML プレビューは白地のままにするので何もしない。
   */
  onThemeChange() {
    Preview.diagramCache.clear();
    if (Preview.mermaid) Preview.configureMermaid(Preview.mermaid);

    for (const tab of App.tabs) {
      if (tab.kind !== 'preview' || !tab.pv) continue;
      const pv = tab.pv;
      pv.lastDiagrams = [];
      if (pv.mode === 'markdown') {
        // 差分描画は「変わったブロック」しか作り直さない。図を確実に描き直させたいので、
        // いったん空にして全部組み直す（テーマの変更は頻度が低いので許容する）。
        pv.body.textContent = '';
        if (Panes.isVisible(tab.id)) Preview.render(tab);
        else pv.painted = false;
      } else if (pv.mode === 'drawio') {
        Drawio.reload(tab);
      }
    }
  },

  /** いま表示すべき内容を描画する。 */
  render(tab) {
    const pv = tab && tab.pv;
    const src = Preview.sourceOf(tab);
    if (!pv || !src) return;

    pv.generation++;
    if (pv.mode === 'html') { Preview.renderHtml(tab, src); return; }
    if (pv.mode === 'drawio') { Drawio.show(tab, tabDoc(src)); return; }
    if (pv.mode === 'csv') { CsvGrid.render(tab, src); return; }
    // 言語モードを HTML から Markdown へ変えた直後など、まだ読めていないことがある。
    if (!Preview.marked || !Preview.purify) {
      void Preview.load().then((ok) => { if (ok && getTab(tab.id)) Preview.render(tab); });
      return;
    }
    Preview.renderMarkdown(tab, src);
  },

  /** Markdown を描く。変わったブロックだけ作り直し、同じブロックの DOM は使い回す。 */
  renderMarkdown(tab, src) {
    const pv = tab.pv;
    const endMd = Perf.start('preview.md');
    let built;
    try {
      built = Preview.buildBlocks(tabDoc(src));
    } catch (err) {
      pv.body.textContent = 'Markdown を解釈できませんでした: ' + err.message;
      return;
    }
    const added = Preview.reconcileBlocks(pv.body, built.blocks, { remote: pv.remote });
    endMd({ blocks: built.blocks.length, added: added.length, parsed: built.misses });
    Preview.paintBar(pv);

    const endMeasure = Perf.start('preview.measure');
    Sync.measure(tab);
    Sync.follow(tab);
    endMeasure();
    // 図の描き直しは新しく入ったブロックの中だけ。前から表示されている図は触らない（点滅しない）。
    if (added.length) void Preview.renderDiagrams(tab, pv.generation, added);
    else Preview.rememberDiagrams(tab);
  },

  /**
   * Markdown をトップレベルのブロックに分け、それぞれを sanitize 済み HTML にする。
   *
   * marked のトークンは行番号を持たないので、raw の改行数を数えて自分で追う。
   * トークンを 1 つずつ描くのは、ブロックごとにキャッシュするため。
   * 参照リンク（[a][ref]）は lexer の時点で解決済みで、定義が変わると同じ raw でも
   * 出力が変わるので、定義の一覧もキーに混ぜる（コード・HTML・水平線は影響を受けない）。
   *
   * @param {string} src
   * @return {{blocks:Array<{key:string, line:number, html:string}>, misses:number}}
   */
  buildBlocks(src) {
    const tokens = Preview.marked.lexer(src);
    const defs = JSON.stringify(tokens.links || {});
    const SEP = String.fromCharCode(0);
    const blocks = [];
    const seen = new Map();
    let line = 1;
    let misses = 0;
    for (const token of tokens) {
      const start = line;
      line += ((token.raw || '').match(/\n/g) || []).length;
      // 空行と参照定義は何も描かない。行番号だけ進めて飛ばす。
      if (token.type === 'space' || token.type === 'def') continue;
      const plain = token.type === 'code' || token.type === 'html' || token.type === 'hr';
      const key = token.type + SEP + token.raw + (plain ? '' : SEP + defs);
      let html = Preview.blockCache.get(key);
      if (html === undefined) {
        html = Preview.purify.sanitize(Preview.marked.parser([token]), MD_PURIFY);
        misses++;
      } else {
        Preview.blockCache.delete(key);   // 末尾へ動かす（LRU）
      }
      Preview.blockCache.set(key, html);
      if (Preview.blockCache.size > Preview.BLOCK_CACHE_MAX) {
        Preview.blockCache.delete(Preview.blockCache.keys().next().value);
      }
      // 同じ内容のブロック（"---" など）が複数あっても区別できるよう通し番号を付ける。
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      blocks.push({ key: key + '#' + n, line: start, html });
    }
    return { blocks, misses };
  },

  /**
   * 既存の DOM とキーで突き合わせ、無いものだけ作り、順序は insertBefore で合わせる。
   * 画像・iframe・描画済みの mermaid は同じキーなら作り直されないので点滅しない。
   * @return {HTMLElement[]} 新しく入ったブロック
   */
  reconcileBlocks(host, blocks, opts = {}) {
    const old = new Map();
    for (const c of Array.from(host.childNodes)) {
      if (c.nodeType === 1 && c.dataset && c.dataset.key) old.set(c.dataset.key, c);
      else c.remove();   // エラー表示のテキストなど
    }
    const added = [];
    let cursor = host.firstElementChild;
    for (const b of blocks) {
      let node = old.get(b.key);
      if (node) {
        old.delete(b.key);
        if (node.dataset.srcLine !== String(b.line)) node.dataset.srcLine = String(b.line);
      } else {
        node = document.createElement('div');
        node.className = 'mdb';
        node.dataset.key = b.key;
        node.dataset.srcLine = String(b.line);
        // いったん <template> に入れる。template の中は画像を取りに行かないので、
        // 外部の URL を外してから文書に入れられる（直接 innerHTML に入れると即座に取得が始まる）。
        const tpl = document.createElement('template');
        tpl.innerHTML = b.html;
        if (!opts.remote) Preview.holdRemote(tpl.content);
        node.appendChild(tpl.content);
        // リンクは新しいタブで開かせる。
        for (const a of node.querySelectorAll('a[href]')) {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        }
        added.push(node);
      }
      if (node === cursor) cursor = cursor.nextElementSibling;
      else host.insertBefore(node, cursor);
    }
    for (const stale of old.values()) stale.remove();
    return added;
  },

  /** client/lib/preview-policy.js の holdRemote。 */
  holdRemote: holdRemote,

  /** このプレビューで外部の画像を出す（以降の描き直しでも出したまま）。 */
  releaseRemote(pv) {
    pv.remote = true;
    const attrs = MD_REMOTE_ATTRS.concat(['style', 'href']);
    for (const node of pv.body.querySelectorAll(attrs.map((a) => '[data-held-' + a + ']').join(','))) {
      for (const attr of attrs) {
        const v = node.getAttribute('data-held-' + attr);
        if (v === null) continue;
        node.setAttribute(attr, v);
        node.removeAttribute('data-held-' + attr);
      }
      node.classList.remove('mdimg--held');
      if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') node.load();
    }
    Preview.paintBar(pv);
  },

  /** いま表示中の図（文書順）を覚える。次に構文エラーになったブロックの代わりに薄く出す。 */
  rememberDiagrams(tab) {
    const pv = tab.pv;
    pv.lastDiagrams = Array.from(pv.body.querySelectorAll('.mermaid'))
      .map((host) => (host.classList.contains('mermaid--error') ? null : host.innerHTML));
  },

  /**
   * ```mermaid のコードブロックを SVG に差し替える。
   *
   * 打鍵のたびに全部描き直すと重いので、ソースが同じ図はキャッシュを使う。
   * また、書いている途中の図は構文エラーになるのが普通なので、失敗したときは
   * 直前に描けた図を薄く出したままにして、画面がエラー表示で点滅しないようにする。
   *
   * @param {Tab} tab プレビュータブ
   * @param {number} gen 呼び出した時点の pv.generation
   * @param {HTMLElement[]} [scope] 新しく入ったブロック（省略すると全体）
   */
  async renderDiagrams(tab, gen, scope) {
    const pv = tab.pv;
    const blocks = scope
      ? scope.flatMap((n) => Array.from(n.querySelectorAll('pre > code.language-mermaid')))
      : Array.from(pv.body.querySelectorAll('pre > code.language-mermaid'));
    if (!blocks.length) {
      Preview.rememberDiagrams(tab);
      return;
    }
    // 文書順の通し番号。前回の図（lastDiagrams）との対応と、SVG 内 id の重複回避に使う。
    const slots = Array.from(pv.body.querySelectorAll('.mermaid, pre > code.language-mermaid'));

    for (const code of blocks) {
      const pre = code.parentElement;
      if (pre) pre.classList.add('mermaidWait');
    }

    const mermaid = await Preview.loadMermaid();
    // 読み込みを待っている間に次の描画が始まっていたら、こちらは捨てる。
    if (!mermaid || gen !== pv.generation || !tab.pv) return;

    for (let b = 0; b < blocks.length; b++) {
      const code = blocks[b];
      const pre = code.parentElement;
      if (!pre || !pre.isConnected) continue;
      const i = Math.max(0, slots.indexOf(code));

      const src = code.textContent;
      let svg = Preview.diagramCache.get(src);
      if (!svg) {
        try {
          // mermaid は SVG 内の id をこの値で作る。重複すると図が壊れるので、
          // タブと通し番号で分ける（プレビューが複数開いていても衝突しない）。
          const res = await mermaid.render('mmd-' + pv.generation + '-' + i + '-' + tab.id.length, src);
          svg = res.svg;
          // 際限なく溜めない。図を書き換え続けるとキャッシュだけが増えるため。
          if (Preview.diagramCache.size > 60) Preview.diagramCache.clear();
          Preview.diagramCache.set(src, svg);
        } catch (err) {
          svg = null;
        }
        if (gen !== pv.generation || !tab.pv) return;
      }

      const host = h('div', { class: 'mermaid' });

      if (svg) {
        // mermaid 自身も securityLevel: 'strict' でラベルをエスケープしているが、
        // mermaid には過去に XSS が何度も見つかっているので、こちらでも DOMPurify を通す。
        // <style> と foreignObject は残す設定（MERMAID_PURIFY）なので図の見た目は変わらない。
        // 残した <style> は、その SVG の中にしか効かない規則だけに絞る（scopeMermaidStyles）。
        // Markdown 本文と同じく <template> の中で外部の画像（<image href>）を止めてから文書に入れる。
        const tpl = document.createElement('template');
        tpl.innerHTML = Preview.purify.sanitize(svg, MERMAID_PURIFY);
        scopeMermaidStyles(tpl.content, MERMAID_ID_RE);
        if (!pv.remote) Preview.holdRemote(tpl.content);
        host.appendChild(tpl.content);
      } else if (pv.lastDiagrams[i]) {
        host.innerHTML = pv.lastDiagrams[i];
        host.className = 'mermaid mermaid--stale';
      } else {
        host.className = 'mermaid mermaid--error';
        host.textContent = '図を解釈できません（入力の途中かもしれません）';
      }
      pre.replaceWith(host);
    }

    Preview.rememberDiagrams(tab);
    Sync.measure(tab);
    Sync.follow(tab);
    // 図の中の外部の画像を止めたなら、バーの件数に入れる（図は本文より後から描かれるため）。
    Preview.paintBar(pv);
  },

  /** HTML を iframe に流し込む。スクリプトを止めている間は位置の保持用スクリプトも動かない。 */
  renderHtml(tab, src) {
    const html = tabDoc(src);
    tab.pv.frame.srcdoc = tab.pv.scripts ? Preview.withScrollKeeper(html, tab.pv.frameScroll) : html;
  },

  /**
   * HTML プレビューでスクリプトを動かす／止める。
   * sandbox 属性の変更は次の読み込みから効くので、srcdoc を入れ直す。
   * @param {Tab} tab
   * @param {boolean} on
   */
  setScripts(tab, on) {
    const pv = tab && tab.pv;
    if (!pv || pv.mode !== 'html') return;
    pv.scripts = !!on;
    pv.frame.setAttribute('sandbox', pv.scripts ? PREVIEW_SANDBOX_SCRIPTS : PREVIEW_SANDBOX_STATIC);
    Preview.paintBar(pv);
    const src = Preview.sourceOf(tab);
    if (src && src.state) Preview.renderHtml(tab, src);
  },

  /**
   * 上端のバー。HTML では常に出してスクリプトの状態を見せ、
   * Markdown では外部の画像を止めているときだけ出す。
   */
  paintBar(pv) {
    const bar = pv.bar;
    if (pv.mode === 'html') {
      bar.el.hidden = false;
      bar.msg.textContent = pv.scripts
        ? 'スクリプトを実行しています。信頼できない HTML では止めてください。'
        : 'スクリプト・フォーム・ポップアップは止めています（見た目だけの表示）。';
      bar.btn.textContent = pv.scripts ? 'スクリプトを止める' : 'スクリプトを実行する';
      bar.el.classList.toggle('preview__bar--on', pv.scripts);
      return;
    }
    const held = pv.mode === 'markdown' && !pv.remote
      ? pv.body.querySelectorAll('[data-held-src],[data-held-srcset],[data-held-poster],[data-held-style],[data-held-href]').length
      : 0;
    bar.el.hidden = !held;
    bar.el.classList.remove('preview__bar--on');
    if (!held) return;
    bar.msg.textContent = '外部の画像など ' + held + ' 件を止めています（開いたことが相手に伝わらないように）。';
    bar.btn.textContent = '表示する';
  },

  /** client/lib/preview-policy.js の withScrollKeeper。 */
  withScrollKeeper: withScrollKeeper,

  /**
   * 入力のたびに描き直すと重いので少し待つ。
   * HTML は srcdoc の入れ替え（＝再読み込み）なので、Markdown より長めに待つ。
   */
  schedule(tab) {
    const pv = tab && tab.pv;
    const src = Preview.sourceOf(tab);
    if (!pv || !src) return;
    clearTimeout(pv.timer);
    // Markdown は差分描画で軽い（小さい文書ならさらに短く）。
    // HTML は再読み込み、drawio は図の描き直しになる。
    const len = src.state ? src.state.doc.length : 0;
    // 表は解析し直すだけ（描くのは見えている行だけ）なので短め。大きいファイルは少し待つ。
    const wait = pv.mode === 'markdown' ? (len < 30000 ? 120 : 250)
      : pv.mode === 'csv' ? (len < 200000 ? 150 : 400) : 600;
    pv.timer = setTimeout(() => { Preview.render(tab); }, wait);
  }
};

