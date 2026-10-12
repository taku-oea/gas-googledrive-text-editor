/* ---------------------- ターミナル本体 ---------------------- */

const Term = {
  seq: 0,
  /** 出力に残す塊の数。1 コマンド 1 塊なので、行数ではなくこれで抑える。 */
  MAX_BLOCKS: 240,
  /** 1 回の出力で画面に出す行数。超えた分は省く（DOM を守るため）。 */
  MAX_PRINT_LINES: 2000,
  HIST_KEY: 'gdte:termhist',
  HIST_MAX: 200,
  /** @type {Array<string>} 入力の履歴（全ターミナルで共有・localStorage に残す）。 */
  history: [],

  /* ---------- 生成と表示 ---------- */

  /** 開いているターミナルのタブ（開いた順）。 */
  tabs() { return App.tabs.filter((t) => t.kind === 'term'); },

  /**
   * ターミナルのタブを開く。置き場所は画面いちばん下の全幅の段（VS Code と同じ）。
   * @param {{cwd?:(string|null)}} [opts]
   */
  async open(opts) {
    const o = opts || {};
    const id = 'term:' + (++Term.seq);
    const count = Term.tabs().length;
    const tab = makeTab(id, count ? 'ターミナル ' + (count + 1) : 'ターミナル', 'term');
    tab.loaded = true;
    tab.term = Term.create(tab, o.cwd !== undefined ? o.cwd : Term.defaultCwd());
    App.tabs.push(tab);

    // 既にターミナルが載っているペインがあればそこへ足し（タブが並ぶ）、
    // 無ければ外周にいちばん下の全幅の段を作る（VS Code と同じ置き場所）。
    const from = Panes.active() || Panes.init();
    const hasTerm = (leaf) => leaf.tabIds.some((x) => {
      const other = getTab(x);
      return other && other.kind === 'term' && other.id !== tab.id;
    });
    const leaves = Panes.leaves();
    const target = (hasTerm(from) ? from : leaves.find(hasTerm)) ||
      (leaves.length < Panes.MAX ? Panes.splitRoot('col', true) : from);

    Panes.addTab(target || from, tab.id);
    renderTabs();
    await activateTab(tab.id);
    Term.focus(tab);
    Session.save();
    return tab;
  },

  /** 既にあれば出す、無ければ作る。出ている状態でもう一度押したらエディタへ戻る。 */
  async toggle() {
    const list = Term.tabs();
    if (!list.length) return Term.open();
    const focused = list.find((t) => t.term && t.term.input === document.activeElement);
    if (focused) {
      const pane = Term.editorPane(focused);
      if (pane && pane.view) { Panes.focus(pane.id); pane.view.focus(); }
      return focused;
    }
    const tab = list.find((t) => Panes.isVisible(t.id)) || list[0];
    await activateTab(tab.id);
    Term.focus(tab);
    return tab;
  },

  /** 開いたときの初期フォルダ。いま見ているファイルの場所を継ぐ。 */
  defaultCwd() {
    const tab = termBufferTab();
    const node = tab ? Tree.get(tab.id) : null;
    if (node && node.parentId) return node.parentId;
    const target = targetFolderId();
    return target || (Tree.rootIds.length === 1 ? Tree.rootIds[0] : null);
  },

  /**
   * 1 枚ぶんの状態と DOM を作る。DOM はタブが持ち、ペインを移っても作り直さない
   * （出力とスクロール位置がそのまま引っ越す）。
   */
  create(tab, cwd) {
    const out = h('div', { class: 'term__out' });
    const cwdEl = h('span', { class: 'term__cwd' });
    const input = h('input', {
      class: 'term__field',
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      autocapitalize: 'off',
      autocorrect: 'off',
      'aria-label': 'コマンド'
    });
    const comp = h('div', { class: 'term__comp', hidden: true });
    const prompt = h('div', { class: 'term__prompt' }, [
      cwdEl, h('span', { class: 'term__sign', text: '$' }), input
    ]);
    const host = h('div', { class: 'term' }, [out, h('div', { class: 'term__foot' }, [comp, prompt])]);

    const t = {
      tabId: tab.id,
      host, out, input, cwdEl, comp, prompt,
      /** @type {string|null} いまのフォルダ（null は仮想ルート）。 */
      cwd: cwd || null,
      /** cd - 用。 */
      prevCwd: undefined,
      /** @type {Array<Element>} 出力の塊。増えすぎたら古いものから捨てる。 */
      blocks: [],
      /** @type {Element|null} 進捗の 1 行（実行中だけ出す）。 */
      statusEl: null,
      /** 実行中か。 */
      busy: false,
      /** @type {{abort:boolean}|null} 実行中の中断フラグ。 */
      run: null,
      /** @type {{resolve:function(boolean)}|null} y/n の待ち。 */
      ask: null,
      /** 履歴をさかのぼっている位置。 */
      histAt: -1,
      histDraft: '',
      /** IME 変換中は Tab を奪わない。 */
      composing: false,
      /** @type {Object|null} 補完の状態。 */
      comp_: null,
      greeted: false
    };

    input.addEventListener('keydown', (ev) => Term.onKeyDown(t, ev));
    input.addEventListener('input', () => { Term.closeComp(t); });
    input.addEventListener('compositionstart', () => { t.composing = true; });
    input.addEventListener('compositionend', () => { t.composing = false; });
    // 出力のどこを押しても入力へ戻る（文字を選んでいるときは邪魔しない）。
    host.addEventListener('mouseup', (ev) => {
      if (ev.target.closest('button')) return;
      const sel = window.getSelection();
      if (sel && String(sel).length) return;
      input.focus();
    });

    Term.updatePrompt(t);
    return t;
  },

  /** ペインの中へ差し込む。切り替えても DOM は捨てない。 */
  mount(leaf, tab) {
    const host = leaf.el.termHost;
    for (const node of Array.from(host.children)) node.hidden = true;
    const t = tab.term;
    if (!t) return;
    if (t.host.parentElement !== host) host.appendChild(t.host);
    t.host.hidden = false;
    if (!t.greeted) {
      t.greeted = true;
      Term.text(t, 'Drive のファイルを扱うコマンドが使えます。help で一覧、Tab で補完。', 'term__dim');
    }
    Term.scrollToEnd(t);
  },

  /** タブを閉じるとき。 */
  destroy(tab) {
    const t = tab.term;
    if (!t) return;
    if (t.run) t.run.abort = true;
    if (t.ask) { t.ask.resolve(false); t.ask = null; }
    if (t.host.parentElement) t.host.remove();
    tab.term = null;
  },

  focus(tab) {
    const t = tab && tab.term;
    if (!t) return;
    // ペインへ差し込んだ直後は描画前なので、1 フレーム待ってから当てる。
    requestAnimationFrame(() => { if (t.host.isConnected) t.input.focus(); });
  },

  /** プロンプトの表示（いまのフォルダと実行中かどうか）。 */
  updatePrompt(t) {
    t.cwdEl.textContent = Vfs.pathOf(t.cwd);
    t.cwdEl.title = t.cwd ? Vfs.pathOf(t.cwd) : 'ルートフォルダが並ぶ仮想の最上位';
    t.input.placeholder = t.ask ? 'y / n' : (t.busy ? '実行中… Ctrl+C で中断' : '');
    t.prompt.classList.toggle('term__prompt--busy', !!t.busy);
  },

  /* ---------- 出力 ---------- */

  /** 出力の塊を 1 つ足す。行ごとに DOM を作らないのが速さの要。 */
  push(t, node) {
    const atEnd = t.out.scrollTop + t.out.clientHeight >= t.out.scrollHeight - 40;
    t.out.appendChild(node);
    t.blocks.push(node);
    while (t.blocks.length > Term.MAX_BLOCKS) {
      const old = t.blocks.shift();
      if (old && old.parentElement) old.remove();
    }
    if (atEnd) Term.scrollToEnd(t);
    return node;
  },

  /** そのまま出す（複数行でも 1 ノード）。 */
  text(t, text, cls) {
    const body = String(text == null ? '' : text);
    const lines = body.split('\n');
    let shown = body;
    if (lines.length > Term.MAX_PRINT_LINES) {
      shown = lines.slice(0, Term.MAX_PRINT_LINES).join('\n') +
        '\n…（あと ' + (lines.length - Term.MAX_PRINT_LINES) + ' 行は省略しました）';
    }
    return Term.push(t, h('div', { class: 'term__block ' + (cls || ''), text: shown }));
  },

  /** クリックできる行をまとめて出す。 */
  rows(t, nodes) {
    const box = h('div', { class: 'term__rows' });
    const frag = document.createDocumentFragment();
    for (const node of nodes.slice(0, Term.MAX_PRINT_LINES)) frag.appendChild(node);
    if (nodes.length > Term.MAX_PRINT_LINES) {
      frag.appendChild(h('div', { class: 'term__dim', text: '…（あと ' + (nodes.length - Term.MAX_PRINT_LINES) + ' 件は省略しました）' }));
    }
    box.appendChild(frag);
    return Term.push(t, box);
  },

  /** 打ったコマンドをそのまま残す。 */
  echo(t, line) {
    Term.push(t, h('div', { class: 'term__echo' }, [
      h('span', { class: 'term__cwd', text: Vfs.pathOf(t.cwd) }),
      h('span', { class: 'term__sign', text: '$' }),
      h('span', { class: 'term__cmd', text: line })
    ]));
  },

  /** 実行中の進み具合。同じ行を書き換えるので出力は増えない。 */
  status(t, text) {
    if (!t.statusEl) {
      t.statusEl = h('div', { class: 'term__status' });
      t.out.appendChild(t.statusEl);
    }
    t.statusEl.textContent = text;
    Term.scrollToEnd(t);
  },

  clearStatus(t) {
    if (t.statusEl && t.statusEl.parentElement) t.statusEl.remove();
    t.statusEl = null;
  },

  clear(t) {
    t.out.textContent = '';
    t.blocks = [];
    t.statusEl = null;
  },

  scrollToEnd(t) { t.out.scrollTop = t.out.scrollHeight; },

  /* ---------- 履歴 ---------- */

  loadHistory() {
    try {
      const raw = localStorage.getItem(Term.HIST_KEY);
      const list = raw ? JSON.parse(raw) : [];
      if (Array.isArray(list)) Term.history = list.filter((x) => typeof x === 'string').slice(-Term.HIST_MAX);
    } catch (err) { /* 使えなくても動く */ }
  },

  remember(line) {
    if (!line) return;
    if (Term.history[Term.history.length - 1] === line) return;
    Term.history.push(line);
    if (Term.history.length > Term.HIST_MAX) Term.history.splice(0, Term.history.length - Term.HIST_MAX);
    try { localStorage.setItem(Term.HIST_KEY, JSON.stringify(Term.history)); } catch (err) { /* 無視 */ }
  },

  /* ---------- 実行 ---------- */

  /** コマンド側へ渡す文脈。 */
  context(t) {
    return {
      term: t,
      get cwd() { return t.cwd; },
      setCwd(id) {
        t.prevCwd = t.cwd;
        t.cwd = id || null;
        Term.updatePrompt(t);
        Session.save();
      },
      check() { if (t.run && t.run.abort) throw new TermAbort(); },
      aborted() { return !!(t.run && t.run.abort); },
      status(text) { Term.status(t, text); },
      confirm(message) { return Term.ask(t, message); }
    };
  },

  /** y/n を聞く。答えは次の Enter で受け取る。 */
  ask(t, message) {
    return new Promise((resolve) => {
      // 進捗の行は役目を終えている。聞く前に消しておく（古い数字が残って見える）。
      Term.clearStatus(t);
      Term.text(t, message + '\n続けますか？ [y/N]', 'term__ask');
      t.ask = { resolve };
      Term.updatePrompt(t);
      t.input.focus();
    });
  },

  /** 一覧の行などから、実際に打ったのと同じようにコマンドを走らせる。 */
  async runFromClick(t, line) {
    if (t.busy || t.ask) return;
    t.input.value = '';
    await Term.exec(t, line);
    t.input.focus();
  },

  /** 1 行を実行して、結果を出すところまで。 */
  async exec(t, raw) {
    const line = String(raw == null ? '' : raw).trim();
    Term.echo(t, line);
    if (!line) return;
    Term.remember(line);
    t.histAt = -1;

    t.busy = true;
    t.run = { abort: false };
    Term.updatePrompt(t);
    const end = Perf.start('term.exec');
    let okMeta = true;
    try {
      await Term.runLine(t, line);
    } catch (err) {
      okMeta = false;
      if (err instanceof TermAbort) Term.text(t, '^C 中断しました', 'term__warn');
      else if (err instanceof TermError) Term.text(t, err.message, 'term__err');
      else {
        console.error(err);
        Term.text(t, (err && err.message) ? err.message : String(err), 'term__err');
      }
    } finally {
      Term.clearStatus(t);
      t.busy = false;
      t.run = null;
      Term.updatePrompt(t);
      Term.scrollToEnd(t);
      end({ ok: okMeta, cmd: line.split(/\s+/)[0] });
    }
  },

  /** 解析してパイプラインを流す。 */
  async runLine(t, line) {
    let source = line;
    let bang = false;
    // !cmd は「選択範囲を通して、その場に書き戻す」の短い書き方（Vim の !）。
    if (source.charAt(0) === '!') {
      bang = true;
      source = 'cat %sel | ' + source.slice(1);
    }
    const parsed = termParse(source);
    if (bang && !parsed.redirect) parsed.redirect = { op: '>', path: '%sel' };

    const ctx = Term.context(t);
    let stdin = null;
    let result = { text: '', rows: null };

    for (const stage of parsed.stages) {
      ctx.check();
      const argv = stage.slice();
      let name = argv.shift();
      const alias = TERM_ALIASES[name];
      if (alias) { name = alias[0]; for (let i = alias.length - 1; i >= 1; i--) argv.unshift(alias[i]); }
      const cmd = TERM_COMMANDS[name];
      if (!cmd) throw new TermError('そんなコマンドはありません: ' + name + '（help で一覧を出せます）');
      const res = await cmd.run(ctx, argv, stdin);
      result = (typeof res === 'string') ? { text: res, rows: null } : (res || { text: '', rows: null });
      stdin = typeof result.text === 'string' ? result.text : '';
    }

    if (parsed.redirect) { await Term.redirect(ctx, parsed.redirect, result.text); return; }
    if (result.rows && result.rows.length) Term.rows(t, result.rows);
    else if (result.text) Term.text(t, result.text);
  },

  /** > と >> の行き先。% なら編集中のバッファ、それ以外は Drive のファイル。 */
  async redirect(ctx, rd, text) {
    const t = ctx.term;
    let body = text == null ? '' : String(text);
    // 画面に出すときは末尾の改行を付けないが、ファイルにするときは付ける
    // （改行で終わらないテキストファイルは、次に追記したときに行が混ざる）。
    if (rd.path !== '%' && rd.path !== '%sel' && body && !/\n$/.test(body)) body += '\n';

    if (rd.path === '%' || rd.path === '%sel') {
      const tab = termBufferWrite(rd.path === '%sel', body, rd.op === '>>');
      Term.text(t, '「' + tab.name + '」に書き戻しました（' + MOD + '+Z で戻せます）。', 'term__ok');
      return;
    }

    const r = await Vfs.resolve(ctx.cwd, rd.path, { allowMissing: true });
    if (r.missing) {
      if (Vfs.isRoot(r.parentId)) throw new TermError('仮想ルートの直下にはファイルを置けません。');
      const entry = await Api.createFile(r.parentId, r.name);
      Tree.insertChild(r.parentId, entry);
      renderTree();
      await termWriteFile(Tree.get(entry.id), body);
      Term.text(t, Vfs.pathOf(entry.id) + ' を作りました（' + termLines(body).length + ' 行）。', 'term__ok');
      return;
    }

    const node = r.node;
    if (!node || node.type !== 'file') throw new TermError('ファイルではありません: ' + rd.path);
    const rec = await termReadRecord(node);
    const prev = normalizeEol(rec.content);
    let next = body;
    if (rd.op === '>>') {
      next = prev + (prev && !/\n$/.test(prev) ? '\n' : '') + body;
    } else if (prev.trim()) {
      const ok = await ctx.confirm('「' + Vfs.pathOf(node.id) + '」の中身（' + termLines(prev).length + ' 行）を置き換えます。');
      if (!ok) { Term.text(t, '（中止しました）', 'term__warn'); return; }
    }
    await termWriteFile(node, next);
    Term.text(t, Vfs.pathOf(node.id) + ' へ書き込みました（' + termLines(next).length + ' 行）。', 'term__ok');
  },

  /* ---------- エディタ側との行き来 ---------- */

  /** ファイルを出すペイン。ターミナル自身のペインは避ける。 */
  editorPane(tab) {
    const own = Panes.leafOf(tab.id);
    const others = Panes.leaves().filter((l) => l !== own);
    const withFile = others.find((l) => l.tabIds.some((id) => {
      const other = getTab(id);
      return other && other.kind !== 'term';
    }));
    if (withFile) return withFile;
    if (others.length) return others[0];
    // ターミナルしか無いなら、上に段を作ってそちらをエディタにする。
    const fresh = Panes.splitRoot('col', false);
    if (fresh) { showEmptyPane(fresh); return fresh; }
    return own;
  },

  /** ツリーのノードをエディタで開く。 */
  async openNode(tab, node, opts) {
    const o = opts || {};
    const entry = node.entry;
    if (!entry || !entry.openable) {
      throw new TermError('開けません: ' + node.name + ((entry && entry.reason) ? '（' + entry.reason + '）' : ''));
    }
    let pane = Term.editorPane(tab);
    if (o.split && Panes.leaves().length < Panes.MAX) {
      pane = Panes.split(pane.id, 'row', true) || pane;
    }
    Panes.focus(pane.id);
    if (o.line) await openAtLine(entry, o.line, o.column || 1);
    else await openEntry(entry, { ephemeral: false, pane: pane.id });
  },

  /* ---------- キー操作 ---------- */

  onKeyDown(t, ev) {
    // IME の変換中はこちらでは何もしない（Tab も Enter も変換の確定に使われる）。
    if (isImeKey(ev) || t.composing) return;

    if (ev.key === 'Tab') {
      ev.preventDefault();
      void Term.complete(t, ev.shiftKey ? -1 : 1);
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      Term.closeComp(t);
      Term.submit(t);
      return;
    }
    if (ev.key === 'Escape') {
      if (t.comp_) { ev.preventDefault(); Term.closeComp(t); }
      return;
    }
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      if (t.comp_) {
        ev.preventDefault();
        void Term.complete(t, ev.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      ev.preventDefault();
      Term.recall(t, ev.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (ev.ctrlKey && (ev.key === 'c' || ev.key === 'C')) {
      // 文字を選んでいるときはコピーに譲る（Windows の Ctrl+C）。
      const sel = window.getSelection();
      if (sel && String(sel).length) return;
      ev.preventDefault();
      if (t.ask) { const ask = t.ask; t.ask = null; ask.resolve(false); Term.updatePrompt(t); return; }
      if (t.run) { t.run.abort = true; Term.status(t, '中断しています…'); return; }
      t.input.value = '';
      Term.echo(t, '^C');
      return;
    }
    if (ev.ctrlKey && (ev.key === 'l' || ev.key === 'L')) {
      ev.preventDefault();
      Term.clear(t);
      return;
    }
    if (ev.ctrlKey && (ev.key === 'u' || ev.key === 'U')) {
      ev.preventDefault();
      t.input.value = '';
      Term.closeComp(t);
      return;
    }
  },

  /** Enter。y/n の待ち → 実行中は無視 → それ以外は実行。 */
  submit(t) {
    const value = t.input.value;
    if (t.ask) {
      const ask = t.ask;
      t.ask = null;
      t.input.value = '';
      const yes = /^(y|yes|はい)$/i.test(value.trim());
      Term.echo(t, value.trim() || '(n)');
      Term.updatePrompt(t);
      ask.resolve(yes);
      return;
    }
    if (t.busy) {
      Term.text(t, '実行中です（Ctrl+C で中断できます）。', 'term__warn');
      return;
    }
    t.input.value = '';
    void Term.exec(t, value);
  },

  /** ↑↓ の履歴。途中まで打った内容は覚えておいて、下まで戻ったら返す。 */
  recall(t, dir) {
    const list = Term.history;
    if (!list.length) return;
    if (t.histAt < 0) {
      if (dir > 0) return;
      t.histDraft = t.input.value;
      t.histAt = list.length;
    }
    const next = t.histAt + dir;
    if (next >= list.length) {
      t.histAt = -1;
      t.input.value = t.histDraft;
    } else {
      t.histAt = Math.max(0, next);
      t.input.value = list[t.histAt];
    }
    const end = t.input.value.length;
    requestAnimationFrame(() => t.input.setSelectionRange(end, end));
  }
};

