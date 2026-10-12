/* ------------------------------------------------------------------ *
 *  全体検索
 * ------------------------------------------------------------------ */

const Search = {
  busy: false,
  /** @type {Set<string>|null} 直近の localHits で中身を探したファイル */
  searched: null,

  async run() {
    const query = el.searchInput.value.trim();
    if (query.length < 2) {
      el.searchFoot.textContent = '2 文字以上で検索してください';
      return;
    }
    if (Search.busy) return;
    if (!Tree.rootIds.length) {
      el.searchFoot.textContent = '検索するフォルダがありません';
      return;
    }

    Search.busy = true;
    el.searchResults.textContent = '';
    el.searchFoot.textContent = '';

    // 手元にある本文（開いているタブ・最近読んだファイル）はその場で探して先に出す。
    // Drive の索引は保存直後の内容を知らず、語の途中でも当たらないので、その穴を埋める。
    const local = Search.localHits(query);
    if (local.length) {
      Search.render({ query, files: local, candidates: 0, truncated: false, folders: 0, scopePartial: false }, true);
    } else {
      el.searchResults.appendChild(h('div', { class: 'placeholder', text: '検索中…' }));
    }

    try {
      const data = await Api.searchContents(query, Tree.rootIds, { caseSensitive: false });
      Search.render(Search.merge(data, local));
    } catch (err) {
      if (local.length) {
        el.searchFoot.textContent = '開いているファイルの中だけの結果です（Drive の検索に失敗: ' + err.message + '）';
      } else {
        el.searchResults.textContent = '';
        el.searchResults.appendChild(h('div', { class: 'placeholder', text: err.message }));
        el.searchFoot.textContent = '';
      }
    } finally {
      Search.busy = false;
    }
  },

  /**
   * 手元の本文を探す。開いているタブは画面に出ている最新の中身（未保存も含む）、
   * それ以外は Store に残っている保存済みの本文を見る。ルートの外のファイルは除く。
   * @param {string} query
   * @return {Array<{entry:Object, hits:Array, local:true, dirty:boolean, fromTab:boolean}>}
   */
  localHits(query) {
    const needle = query.toLowerCase();
    const out = [];
    const seen = new Set();
    /** 実際に中身を探したファイル。merge はこれに含まれるものだけを「手元で確かめた」とみなす。 */
    Search.searched = new Set();
    const inScope = (id) => {
      const root = Tree.rootOf(id);
      if (root) return Tree.rootIds.indexOf(root) >= 0;
      return !!(FileIndex.usable() && FileIndex.data.files.has(id));
    };
    const consider = (id, name, text, dirty, fromTab) => {
      if (seen.has(id)) return;
      seen.add(id);
      if (!inScope(id)) return;
      Search.searched.add(id);
      const hits = searchLines(text, needle, false);
      if (!hits.length) return;
      const node = Tree.get(id);
      const entry = (node && node.entry) || FileIndex.entryOf(id) ||
        { id, name, kind: 'text', viewer: 'editor', openable: true };
      out.push({ entry, hits, local: true, dirty, fromTab });
    };
    for (const tab of App.tabs) {
      if (tab.kind !== 'text' || !tab.loaded) continue;
      const view = Panes.viewOf(tab.id);
      consider(tab.id, tab.name, view ? view.state.doc.toString() : tabDoc(tab), tab.dirty, true);
    }
    for (const rec of Store.content.values()) consider(rec.id, rec.name, normalizeEol(rec.content), false, false);
    return out;
  },

  /**
   * Drive の結果に手元の結果を合わせる。
   * - 開いているタブは手元のほうを使う（画面の中身が一番新しい。未保存も含む）
   * - Store にだけある本文は、Drive 側の更新日時のほうが新しければ Drive の結果を使う
   * - 手元の本文（Drive と同じか新しい）で当たらなかったのに Drive 側で当たったものは、
   *   索引が古い（保存で消した語が残っている）ので落とす
   */
  merge(data, local) {
    const time = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };
    /** @type {Map<string, {at:number, tab:boolean}>} 手元の本文の更新日時 */
    // 範囲の外とみなして探さなかったもの（ツリーにも索引にも無い）は含めない。
    // 含めると、手元では探していないのに Drive の結果まで落としてしまう。
    const searched = Search.searched || new Set();
    const known = new Map();
    for (const rec of Store.content.values()) {
      if (searched.has(rec.id)) known.set(rec.id, { at: time(rec.updatedAtIso), tab: false });
    }
    for (const t of App.tabs) {
      if (t.kind === 'text' && t.loaded && searched.has(t.id)) known.set(t.id, { at: time(t.baseUpdatedAtIso), tab: true });
    }
    const remoteById = new Map(data.files.map((x) => [x.entry.id, x]));
    const newerOnDrive = (id) => {
      const k = known.get(id);
      const r = remoteById.get(id);
      return !!(k && !k.tab && r && time(r.entry.updatedAtIso) > k.at);
    };

    const files = [];
    const used = new Set();
    for (const x of local) {
      const id = x.entry.id;
      if (newerOnDrive(id)) continue;   // 下で Drive の結果を使う
      files.push(x);
      used.add(id);
    }
    for (const x of data.files) {
      const id = x.entry.id;
      if (used.has(id)) continue;
      if (known.has(id) && !newerOnDrive(id)) continue;   // 索引が古い
      files.push(x);
    }
    return Object.assign({}, data, { files });
  },

  /** 「どこを探したか」の一行。0 件のときに理由を切り分けやすくする。 */
  scopeText(data) {
    if (!data.folders) return '';
    return 'フォルダ ' + data.folders + ' 個を検索' +
      (data.scopePartial ? '（範囲が広いため一部まで）' : '');
  },

  /**
   * @param {Object} data
   * @param {boolean} [interim] 手元の結果だけを先に出している（Drive の検索を待っている）
   */
  render(data, interim) {
    el.searchResults.textContent = '';
    if (!data.files.length) {
      el.searchResults.appendChild(h('div', {
        class: 'placeholder placeholder--lines',
        text: data.candidates
          ? '候補は ' + data.candidates + ' 件見つかりましたが、本文に一致する行はありませんでした。'
          : '一致するものがありませんでした。\n' +
            'Drive の全文索引で候補を絞るため、語の途中だけでは当たりません' +
            '（「ルーティン」は当たり、「ーティ」は当たりません）。\n' +
            '保存した直後の内容は、索引への反映が遅れることがあります。'
      }));
      el.searchFoot.textContent = Search.scopeText(data);
      return;
    }

    let total = 0;
    for (const item of data.files) {
      total += item.hits.length;
      const entry = item.entry;

      el.searchResults.appendChild(h('div', { class: 'sresult' }, [
        h('button', {
          type: 'button',
          class: 'sresult__head',
          title: entry.name,
          onclick: () => void openEntry(entry, { ephemeral: false })
        }, [
          h('span', { class: 'row__icon' }, [icon('file-text', 'icon--file')]),
          h('span', { class: 'sresult__name', text: entry.name }),
          item.dirty ? h('span', { class: 'sresult__tag', text: '未保存', title: '保存前の内容から探しています' }) : null,
          h('span', { class: 'sresult__count', text: String(item.hits.length) })
        ]),
        ...item.hits.map((hit) => h('button', {
          type: 'button',
          class: 'shit',
          title: hit.text,
          onclick: () => void openAtLine(entry, hit.line, hit.column)
        }, [
          h('span', { class: 'shit__line', text: String(hit.line) }),
          h('span', { class: 'shit__text', text: hit.text.trim() })
        ]))
      ]));
    }

    if (interim) {
      el.searchFoot.textContent = total + ' 件 / ' + data.files.length + ' ファイル（開いているファイル）· Drive を検索中…';
      return;
    }
    const scope = Search.scopeText(data);
    el.searchFoot.textContent = total + ' 件 / ' + data.files.length + ' ファイル' +
      (data.truncated ? '（候補 ' + data.candidates + ' 件のうち先頭のみ）' : '') +
      (scope ? ' · ' + scope : '');
  },

  clear() {
    el.searchInput.value = '';
    el.searchResults.textContent = '';
    el.searchResults.appendChild(h('div', {
      class: 'placeholder',
      text: 'ルートフォルダの中を、サブフォルダも含めて検索します。'
    }));
    el.searchFoot.textContent = '';
  }
};

/**
 * ファイルを開いて指定の行へカーソルを移す。
 * @param {Object} entry
 * @param {number} line
 * @param {number} column
 */
async function openAtLine(entry, line, column) {
  await openEntry(entry, { ephemeral: false });
  const tab = getTab(entry.id);
  if (!tab || !Editor.view || App.activeId !== entry.id) return;

  const doc = Editor.view.state.doc;
  if (line < 1 || line > doc.lines) return;
  const target = doc.line(line);
  const pos = Math.min(target.from + Math.max(0, column - 1), target.to);

  Editor.view.dispatch({
    selection: { anchor: pos },
    effects: Editor.cm.EditorView.scrollIntoView(pos, { y: 'center' })
  });
  Editor.view.focus();
}

