/* ---------------------- 補完（Tab） ---------------------- */

/**
 * Tab 補完。
 *
 * 候補は基本的にツリー（Tree.nodes）から同期で作るので、読み込み済みの階層なら
 * 押した瞬間に出る。未読込のフォルダをまたぐときだけ 1 往復（listEntriesMulti）。
 *
 * 日本語のファイル名では「共通する頭を伸ばす」がほとんど効かない（「議事録_…」と
 * 「会議メモ」に共通の頭は無い）ので、伸ばせないときは一覧を出して Tab で
 * 送っていく方式にしてある。伸ばせるとき（英数字）は bash と同じように伸ばす。
 */
Object.assign(Term, {

  /** 補完の文脈（いまカーソルがどの語の上にいて、何を補えばよいか）。 */
  compContext(t) {
    const value = t.input.value;
    const pos = t.input.selectionStart == null ? value.length : t.input.selectionStart;
    const tokens = termTokenize(value);

    let token = null;
    for (const tk of tokens) {
      if (!tk.op && pos >= tk.start && pos <= tk.end) { token = tk; break; }
    }
    const start = token ? token.start : pos;
    const end = token ? token.end : pos;
    const text = token ? token.text : '';
    const quote = token ? token.quote : '';

    let argIndex = 0;
    let cmdName = null;
    let afterRedirect = false;
    for (const tk of tokens) {
      if (tk.start >= start) break;
      if (tk.op) {
        if (tk.text === '|') { argIndex = 0; cmdName = null; afterRedirect = false; }
        else afterRedirect = true;
        continue;
      }
      if (afterRedirect) { afterRedirect = false; continue; }
      if (argIndex === 0) cmdName = tk.text;
      argIndex++;
    }

    const alias = TERM_ALIASES[cmdName];
    const cmd = TERM_COMMANDS[alias ? alias[0] : cmdName] || null;
    let kind;
    if (afterRedirect) kind = 'path';
    else if (argIndex === 0) kind = 'command';
    else kind = (cmd && cmd.complete) || 'path';

    return { start, end, text, quote, kind, cmd, argIndex };
  },

  /** 候補を作る。@return {Promise<Array<{label, value, trail, hint}>>} */
  async candidates(t, comp) {
    const text = comp.text;

    // オプションの補完（- で始めたとき）。
    if (text.charAt(0) === '-' && comp.cmd && comp.cmd.flags) {
      const keys = Object.keys(comp.cmd.flags);
      const body = text.replace(/^-+/, '');
      return keys
        .filter((k) => k.indexOf(body) === 0)
        .map((k) => ({
          label: (k.length === 1 ? '-' : '--') + k,
          value: (k.length === 1 ? '-' : '--') + k,
          trail: ' ',
          hint: comp.cmd.flags[k] === 'value' ? '値をとります' : ''
        }));
    }

    if (comp.kind === 'command') {
      const lower = text.toLowerCase();
      const names = Object.keys(TERM_COMMANDS).concat(Object.keys(TERM_ALIASES));
      return names
        .filter((n) => n.toLowerCase().indexOf(lower) === 0)
        .sort()
        .map((n) => {
          const alias = TERM_ALIASES[n];
          const cmd = TERM_COMMANDS[alias ? alias[0] : n];
          return {
            label: n, value: n, trail: ' ',
            hint: alias ? (alias.join(' ') + ' と同じ') : (cmd ? cmd.desc : '')
          };
        });
    }

    if (Array.isArray(comp.kind)) {
      return comp.kind
        .filter((v) => String(v).indexOf(text) === 0)
        .map((v) => ({ label: String(v), value: String(v), trail: ' ', hint: '' }));
    }
    if (typeof comp.kind === 'function') {
      const list = comp.kind(t) || [];
      return list
        .filter((v) => String(v).indexOf(text) === 0)
        .map((v) => ({ label: String(v), value: String(v), trail: ' ', hint: '' }));
    }

    return Term.pathCandidates(t, comp);
  },

  /** パスの候補。ディレクトリ部分を辿ってから、最後の 1 段を名前で絞る。 */
  async pathCandidates(t, comp) {
    const text = comp.text;

    // % / %sel（編集中のバッファ）。
    if (text.charAt(0) === '%') {
      const tab = termBufferTab();
      const name = tab ? tab.name : '（テキストのタブが必要です）';
      return [
        { label: '%', value: '%', trail: ' ', hint: name + ' の全体' },
        { label: '%sel', value: '%sel', trail: ' ', hint: name + ' の選択範囲' }
      ].filter((c) => c.value.indexOf(text) === 0);
    }

    const slash = text.lastIndexOf('/');
    const dirPart = slash >= 0 ? text.slice(0, slash + 1) : '';
    const prefix = slash >= 0 ? text.slice(slash + 1) : text;

    let baseId;
    if (!dirPart) baseId = t.cwd;
    else {
      try {
        const r = await Vfs.resolve(t.cwd, dirPart);
        if (r.node && r.node.type !== 'folder') return [];
        baseId = r.id;
      } catch (err) {
        return [];
      }
    }
    await Vfs.ensure(baseId);

    const ch = Vfs.children(baseId);
    const wantDir = comp.kind === 'dir';
    const pool = ch.folders.map((n) => ({ node: n, dir: true }))
      .concat(wantDir ? [] : ch.files.map((n) => ({ node: n, dir: false })));

    const lower = prefix.toLowerCase();
    let hit = pool.filter((x) => x.node.name.toLowerCase().indexOf(lower) === 0);
    // 前方一致で当たらなければ部分一致でも拾う（日本語の名前では中ほどを覚えていることが多い）。
    if (!hit.length && prefix) hit = pool.filter((x) => x.node.name.toLowerCase().indexOf(lower) >= 0);

    const out = hit.map((x) => ({
      label: x.node.name + (x.dir ? '/' : ''),
      value: dirPart + x.node.name + (x.dir ? '/' : ''),
      trail: x.dir ? '' : ' ',
      hint: x.dir ? '' : (x.node.entry ? formatBytes(x.node.entry.size || 0) : ''),
      dim: !x.dir && x.node.entry && !x.node.entry.openable
    }));

    // .. と ~ は打ち始めたときだけ出す（毎回いちばん上にあると邪魔）。
    if (prefix.charAt(0) === '.' && '..'.indexOf(prefix) === 0) {
      out.unshift({ label: '../', value: dirPart + '../', trail: '', hint: '1 つ上' });
    }
    if (!dirPart && prefix.charAt(0) === '~' && Tree.tmpRootId) {
      out.unshift({ label: '~/', value: '~/', trail: '', hint: '一時メモ' });
    }
    return out;
  },

  /** Tab / Shift+Tab。 */
  async complete(t, delta) {
    if (t.busy || t.ask) return;
    if (t.comp_ && t.comp_.items.length) { Term.cycle(t, delta); return; }

    const comp = Term.compContext(t);
    // 未読込のフォルダをまたぐときは往復が入る。その間に打ち直していたら捨てる。
    const before = t.input.value;
    let items;
    try {
      items = await Term.candidates(t, comp);
    } catch (err) {
      Term.showComp(t, comp, [], (err && err.message) || '候補を作れませんでした');
      return;
    }
    if (t.input.value !== before) return;

    if (!items.length) { Term.showComp(t, comp, [], '候補がありません'); return; }
    if (items.length === 1) { Term.insert(t, comp, items[0]); Term.closeComp(t); return; }

    const lcp = Term.commonPrefix(items.map((i) => i.value));
    if (lcp.length > comp.text.length) {
      // 伸ばせるところまで伸ばして、一覧は出しておく（bash と同じ）。
      Term.insertRaw(t, comp, lcp);
      comp.text = lcp;
      Term.showComp(t, comp, items, '');
      t.comp_.index = -1;
      return;
    }
    Term.showComp(t, comp, items, '');
    Term.cycle(t, delta > 0 ? 1 : -1, true);
  },

  /** 候補を順に当てていく。 */
  cycle(t, delta, first) {
    const comp = t.comp_;
    if (!comp || !comp.items.length) return;
    const n = comp.items.length;
    comp.index = first && comp.index < 0
      ? (delta > 0 ? 0 : n - 1)
      : ((comp.index + delta) % n + n) % n;
    Term.insert(t, comp, comp.items[comp.index]);
    Term.paintComp(t);
  },

  /** 候補を入力欄へ入れる。引用が要る名前は自動でくるむ。 */
  insert(t, comp, item) {
    Term.insertRaw(t, comp, item.value, item.trail);
  },

  insertRaw(t, comp, value, trail) {
    const body = termQuote(value) + (trail || '');
    const line = t.input.value;
    t.input.value = line.slice(0, comp.start) + body + line.slice(comp.end);
    comp.end = comp.start + body.length;
    const caret = comp.end;
    t.input.setSelectionRange(caret, caret);
  },

  commonPrefix(list) {
    if (!list.length) return '';
    let out = list[0];
    for (const s of list) {
      let i = 0;
      while (i < out.length && i < s.length && out.charAt(i).toLowerCase() === s.charAt(i).toLowerCase()) i++;
      out = out.slice(0, i);
      if (!out) break;
    }
    return out;
  },

  /** 候補の一覧を出す。 */
  showComp(t, comp, items, message) {
    t.comp_ = {
      start: comp.start, end: comp.end, text: comp.text,
      items: items || [], index: -1, message: message || ''
    };
    Term.paintComp(t);
  },

  paintComp(t) {
    const comp = t.comp_;
    const box = t.comp;
    box.textContent = '';
    if (!comp) { box.hidden = true; return; }

    if (!comp.items.length) {
      box.appendChild(h('div', { class: 'term__compNote', text: comp.message || '候補がありません' }));
      box.hidden = false;
      return;
    }

    const list = h('div', { class: 'term__compList' });
    const shown = comp.items.slice(0, 200);
    shown.forEach((item, i) => {
      list.appendChild(h('button', {
        type: 'button',
        class: 'term__compItem' + (i === comp.index ? ' term__compItem--on' : '') +
          (item.dim ? ' term__compItem--dim' : ''),
        title: item.hint || '',
        onmousedown: (ev) => {
          // mousedown で処理する（click だと入力欄から focus が外れてしまう）。
          ev.preventDefault();
          comp.index = i;
          Term.insert(t, comp, item);
          Term.closeComp(t);
          t.input.focus();
        }
      }, [
        h('span', { class: 'term__compLabel', text: item.label }),
        item.hint ? h('span', { class: 'term__compHint', text: item.hint }) : null
      ]));
    });

    const foot = comp.items.length + ' 件' +
      (comp.items.length > 200 ? '（200 件まで表示）' : '') +
      ' · Tab で次へ / Shift+Tab で前へ / Esc で閉じる';
    box.appendChild(list);
    box.appendChild(h('div', { class: 'term__compFoot', text: foot }));
    box.hidden = false;

    const on = list.querySelector('.term__compItem--on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  },

  closeComp(t) {
    if (!t.comp_ && t.comp.hidden) return;
    t.comp_ = null;
    t.comp.textContent = '';
    t.comp.hidden = true;
  }
});

/** ターミナルのタブをセッションから戻す。 */
function restoreTermTab(saved) {
  const id = String(saved.id);
  const n = parseInt(id.slice('term:'.length), 10);
  if (n > 0) Term.seq = Math.max(Term.seq, n);
  const tab = makeTab(id, saved.name || 'ターミナル', 'term');
  tab.loaded = true;
  // 前に見ていたフォルダがまだあるなら、そこから始める。
  tab.term = Term.create(tab, saved.cwd && Tree.get(saved.cwd) ? saved.cwd : null);
  App.tabs.push(tab);
  return tab;
}

/** ターミナルのタブをペインに出す。 */
function showTerm(leaf, tab) {
  const e = leaf.el;
  e.viewerHost.hidden = true;
  e.viewerFrame.src = 'about:blank';
  e.diffHost.hidden = true;
  e.previewHost.hidden = true;
  e.panes.hidden = true;
  e.mdBar.hidden = true;
  e.termHost.hidden = false;
  Term.mount(leaf, tab);

  if (Panes.active() !== leaf) return;
  el.btnPreview.hidden = true;
  el.sbSize.textContent = '';
  updateStatusMeta();
  refreshStatus();
}

Term.loadHistory();

