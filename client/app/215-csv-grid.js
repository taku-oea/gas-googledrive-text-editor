/* ------------------------------------------------------------------ *
 *  表プレビュー（CSV / TSV）
 *
 *  プレビュータブの 4 つ目の形式。解析は client/lib/csv.js が行い、ここは描くだけ。
 *
 *  - 数万行でも固まらないよう、画面に見えている行（と前後の少し）だけを DOM にする。
 *    行の高さを固定にして、上下の空き行の高さでスクロール量を作る
 *  - 列の幅は先頭の数百行から見積もって固定する（スクロールのたびに幅が揺れないように）
 *  - セルは textContent で入れるだけ。共有された CSV に何が書かれていても
 *    HTML やスクリプトとしては動かない。= で始まる値も数式にはしない
 *  - 本文が同じ（CodeMirror の Text が同じもの）なら解析し直さない
 *  - 並べ替え（見出しを押す）と絞り込み（上のバー）は表示の上だけの操作で、本文は変えない
 *  - セルの編集・行や列の追加と削除は 216-csv-grid-edit.js
 * ------------------------------------------------------------------ */

const CsvGrid = {
  ROW_H: 26,
  /** 見えている範囲の前後に余分に描く行数。 */
  OVERSCAN: 12,
  /** 列の幅を見積もるのに見る行数。 */
  SAMPLE_ROWS: 400,
  DELIM_LABELS: { ',': 'カンマ区切り', '\t': 'タブ区切り', ';': 'セミコロン区切り' },

  /**
   * 表 1 枚ぶんの状態と DOM を作る（プレビュータブが持ち、ペインを移っても作り直さない）。
   * @param {Tab} tab プレビュータブ
   */
  create(tab) {
    const headerToggle = h('input', { type: 'checkbox' });
    headerToggle.checked = true;
    const info = h('span', { class: 'csvgrid__info' });
    const filterInput = h('input', {
      type: 'search', class: 'input csvgrid__filter', placeholder: '絞り込み', 'aria-label': '行を絞り込む'
    });
    const filterCol = h('select', { class: 'input csvgrid__filterCol', 'aria-label': '絞り込む列' });
    const addRow = h('button', { type: 'button', class: 'btn csvgrid__add', title: '末尾に行を足す' }, [
      icon('file-new'), h('span', { text: '行を追加' })
    ]);
    const bar = h('div', { class: 'csvgrid__bar' }, [
      h('label', { class: 'csvgrid__opt' }, [headerToggle, h('span', { text: '1 行目を見出しにする' })]),
      filterInput, filterCol, addRow,
      info
    ]);
    const colgroup = h('colgroup');
    const thead = h('thead');
    const tbody = h('tbody');
    const table = h('table', { class: 'csvgrid__table' }, [colgroup, thead, tbody]);
    const scroller = h('div', { class: 'csvgrid__scroll', tabindex: '0' }, [table]);
    const el = h('div', { class: 'csvgrid', hidden: true }, [bar, scroller]);

    const g = {
      el, bar, info, headerToggle, filterInput, filterCol, scroller, table, colgroup, thead, tbody,
      /** 1 行目を見出しにするか。 */
      header: true,
      /** 直前に解析した本文（CodeMirror の Text）。同じなら解析し直さない。 */
      docRef: null,
      name: '',
      delim: ',',
      /** @type {{rows:Array, columns:number}|null} parseCsv の結果 */
      parsed: null,
      /** 表示する行（parsed.rows の添字）の並び。見出し行は含めない。 */
      order: [],
      widths: [],
      numeric: [],
      /** 並べ替え。dir は 1（昇順）か -1（降順）。null なら本文の順。 */
      sort: null,
      /** 絞り込み。col が -1 ならすべての列から探す。 */
      filter: { text: '', col: -1 },
      filterTimer: 0,
      frame: 0,
      /** 最後に描いた範囲。同じなら DOM を触らない。 */
      painted: { from: -1, to: -1 },
      /** 選んでいるセル（r は parsed.rows の添字）。 */
      sel: null,
      /** セルを編集中なら、その入力欄と対象。 */
      editing: null,
      /** この表から本文を書き換えた直後か。そうなら並びと列の幅を保つ。 */
      selfEdit: false,
      ro: null
    };

    headerToggle.addEventListener('change', () => {
      g.header = headerToggle.checked;
      CsvGrid.layout(g);
    });
    filterInput.addEventListener('input', () => {
      clearTimeout(g.filterTimer);
      g.filterTimer = setTimeout(() => {
        g.filter.text = filterInput.value;
        CsvGrid.layout(g);
      }, 120);
    });
    filterCol.addEventListener('change', () => {
      g.filter.col = Number(filterCol.value);
      if (g.filter.text) CsvGrid.layout(g);
    });
    thead.addEventListener('click', (ev) => {
      const th = ev.target.closest('.csvgrid__th');
      if (th) CsvGrid.toggleSort(g, Number(th.dataset.col));
    });
    scroller.addEventListener('scroll', () => CsvGrid.schedulePaint(g), { passive: true });
    tbody.addEventListener('click', (ev) => CsvGrid.onClick(tab, ev));
    CsvGrid.wireEditing(tab, g, addRow);
    if (window.ResizeObserver) {
      g.ro = new ResizeObserver(() => CsvGrid.schedulePaint(g));
      g.ro.observe(scroller);
    }
    return g;
  },

  destroy(g) {
    if (!g) return;
    if (g.ro) g.ro.disconnect();
    cancelAnimationFrame(g.frame);
    clearTimeout(g.filterTimer);
    g.el.remove();
  },

  /**
   * 元のタブの本文から表を描く。本文が変わっていなければ描き直すだけ。
   * @param {Tab} tab プレビュータブ
   * @param {Tab} src 元のタブ
   */
  render(tab, src) {
    const g = tab.pv && tab.pv.grid;
    if (!g) return;
    const doc = src.state ? src.state.doc : null;
    if (doc && doc === g.docRef && src.name === g.name) {
      // 本文が変わらなかった（何も書き換えなかった操作）。印を残すと、次にエディタ側で
      // 書き換えたときに並びを保つ道へ入ってしまう。
      g.selfEdit = false;
      CsvGrid.schedulePaint(g);
      return;
    }
    const end = Perf.start('preview.csv');
    const text = tabDoc(src);
    const before = g.parsed;
    const self = g.selfEdit;
    const renamed = g.name !== src.name;
    g.selfEdit = false;
    g.docRef = doc;
    g.name = src.name;
    // 区切り文字は最初に決めたものを保つ（書き換えの途中で判定が揺れて表が崩れないように）。
    // 改名で拡張子が変わったときだけ決め直す。
    if (!before || renamed) g.delim = csvDelimiter(src.name, text);
    g.parsed = parseCsv(text, g.delim);
    if (self && before && before.rows.length === g.parsed.rows.length && before.columns === g.parsed.columns) {
      // セルを書き換えただけ。並べ替え・絞り込みの並びと列の幅はそのままにする
      // （書き換えた行が目の前から飛んでいかないように。並べ直すには見出しを押し直す）。
      CsvGrid.paintHead(g);
      CsvGrid.paintFilterCols(g);
      g.painted = { from: -1, to: -1 };
      CsvGrid.paint(g);
      CsvGrid.paintInfo(g);
    } else {
      CsvGrid.layout(g);
    }
    end({ rows: g.parsed.rows.length, cols: g.parsed.columns });
  },

  /** 見出し行・列の幅・表示する行の並びを決め直して描く。 */
  layout(g) {
    if (!g.parsed) return;
    if (g.sort && g.sort.col >= g.parsed.columns) g.sort = null;
    if (g.filter.col >= g.parsed.columns) g.filter.col = -1;
    g.order = CsvGrid.computeOrder(g);
    // 見出しにした・絞り込んだなどで見えなくなった行のセルは、選んだままにしない
    // （見えないセルを Delete で消したり、貼り付けたりしないように）。
    if (g.sel && g.order.indexOf(g.sel.r) < 0) g.sel = null;
    CsvGrid.measure(g);
    CsvGrid.paintHead(g);
    CsvGrid.paintFilterCols(g);
    g.painted = { from: -1, to: -1 };
    CsvGrid.paint(g);
    CsvGrid.paintInfo(g);
  },

  /**
   * 表示する行の並び（parsed.rows の添字）。絞り込んでから並べ替える。
   * 並べ替えは安定（同じ値なら本文の順）で、空のセルは向きにかかわらず最後。
   */
  computeOrder(g) {
    const rows = g.parsed.rows;
    const first = g.header && rows.length ? 1 : 0;
    const needle = g.filter.text.trim().toLowerCase();
    const col = g.filter.col;
    const order = [];
    for (let i = first; i < rows.length; i++) {
      if (needle) {
        const cells = rows[i].cells;
        const hit = col >= 0
          ? !!cells[col] && cells[col].value.toLowerCase().indexOf(needle) >= 0
          : cells.some((cell) => cell.value.toLowerCase().indexOf(needle) >= 0);
        if (!hit) continue;
      }
      order.push(i);
    }
    if (g.sort) {
      const c = g.sort.col;
      const dir = g.sort.dir;
      const val = (i) => { const cell = rows[i].cells[c]; return cell ? cell.value : ''; };
      order.sort((a, b) => {
        const va = val(a);
        const vb = val(b);
        // 空は向きにかかわらず最後に置く（csvCompare は空を後ろにするので、降順では反転させない）。
        if (va === '' || vb === '') return csvCompare(va, vb) || a - b;
        return dir * csvCompare(va, vb) || a - b;
      });
    }
    return order;
  },

  /** 見出しを押すたびに 昇順 → 降順 → 本文の順 と切り替える。 */
  toggleSort(g, c) {
    if (!g.sort || g.sort.col !== c) g.sort = { col: c, dir: 1 };
    else if (g.sort.dir === 1) g.sort = { col: c, dir: -1 };
    else g.sort = null;
    CsvGrid.layout(g);
  },

  /** 絞り込む列の選択肢。列の名前が変わったときだけ作り直す。 */
  paintFilterCols(g) {
    const labels = ['すべての列'];
    for (let c = 0; c < g.parsed.columns; c++) labels.push(CsvGrid.columnLabel(g, c).replace(/\n/g, ' '));
    const key = labels.join(String.fromCharCode(1));
    if (g.filterCol.dataset.key === key) return;
    g.filterCol.dataset.key = key;
    g.filterCol.textContent = '';
    labels.forEach((label, i) => {
      const opt = h('option', { value: String(i - 1), text: label });
      if (i - 1 === g.filter.col) opt.selected = true;
      g.filterCol.appendChild(opt);
    });
  },

  /** 列の幅と、数値の列（右寄せにする）を先頭の行から見積もる。 */
  measure(g) {
    const rows = g.parsed.rows;
    const cols = Math.max(1, g.parsed.columns);
    const widths = new Array(cols).fill(0);
    const numHits = new Array(cols).fill(0);
    const filled = new Array(cols).fill(0);
    const n = Math.min(rows.length, CsvGrid.SAMPLE_ROWS);
    for (let r = 0; r < n; r++) {
      const cells = rows[r].cells;
      for (let c = 0; c < cells.length; c++) {
        const v = cells[c].value;
        widths[c] = Math.max(widths[c], CsvGrid.textWidth(v));
        if (r === 0 && g.header) continue;
        if (v === '') continue;
        filled[c]++;
        if (csvNumber(v) !== null) numHits[c]++;
      }
    }
    // 1 文字 ≒ 7px（全角は倍）。狭すぎず、1 列が画面を占めない範囲に収める。
    g.widths = widths.map((w) => Math.max(56, Math.min(360, Math.round(w * 7 + 20))));
    g.numeric = filled.map((f, c) => f > 0 && numHits[c] / f >= 0.8);
  },

  /** 見積もり用の幅（半角 1・全角 2）。改行を含むセルは一番長い行で見る。 */
  textWidth(v) {
    let best = 0;
    let cur = 0;
    for (let i = 0; i < v.length && i < 200; i++) {
      const code = v.charCodeAt(i);
      if (code === 10) { best = Math.max(best, cur); cur = 0; continue; }
      cur += code > 0xff && !(code >= 0xff61 && code <= 0xff9f) ? 2 : 1;
    }
    return Math.max(best, cur);
  },

  /** 列の見出し。見出し行が無ければ A, B, C … を出す。 */
  columnLabel(g, c) {
    if (g.header && g.parsed.rows.length) {
      const cell = g.parsed.rows[0].cells[c];
      if (cell && cell.value !== '') return cell.value;
    }
    let s = '';
    let n = c;
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  },

  paintHead(g) {
    const cols = g.widths.length;
    g.colgroup.textContent = '';
    g.colgroup.appendChild(h('col', { style: 'width: 52px' }));
    for (let c = 0; c < cols; c++) g.colgroup.appendChild(h('col', { style: 'width: ' + g.widths[c] + 'px' }));
    const total = 52 + g.widths.reduce((a, b) => a + b, 0);
    g.table.style.width = total + 'px';

    const tr = h('tr', {}, [h('th', { class: 'csvgrid__corner' })]);
    for (let c = 0; c < cols; c++) {
      const label = CsvGrid.columnLabel(g, c);
      const sorted = g.sort && g.sort.col === c ? g.sort.dir : 0;
      tr.appendChild(h('th', {
        class: 'csvgrid__th' + (g.numeric[c] ? ' csvgrid__num' : '') + (sorted ? ' csvgrid__th--sorted' : ''),
        'data-col': String(c),
        title: label + '（押すと 昇順 → 降順 → 元の順）',
        'aria-sort': sorted === 1 ? 'ascending' : sorted === -1 ? 'descending' : null
      }, [
        h('span', { class: 'csvgrid__thLabel', text: label.replace(/\n/g, ' ') }),
        sorted ? h('span', { class: 'csvgrid__sortMark', text: sorted === 1 ? '▲' : '▼' }) : null
      ]));
    }
    g.thead.textContent = '';
    g.thead.appendChild(tr);
  },

  paintInfo(g) {
    const total = g.parsed.rows.length - (g.header && g.parsed.rows.length ? 1 : 0);
    const shown = g.order.length;
    g.info.textContent = (shown !== total ? total + ' 行中 ' + shown + ' 行' : total + ' 行') +
      ' × ' + g.parsed.columns + ' 列 · ' + (CsvGrid.DELIM_LABELS[g.delim] || '区切り');
    g.info.classList.toggle('csvgrid__info--warn', g.parsed.unclosed !== null);
    if (g.parsed.unclosed !== null) {
      g.info.textContent += ' · 本文の ' + g.parsed.unclosed + ' 行目の引用符が閉じていないため、表からは編集できません';
    }
  },

  schedulePaint(g) {
    if (g.frame) return;
    g.frame = requestAnimationFrame(() => { g.frame = 0; CsvGrid.paint(g); });
  },

  /** 見えている範囲の行だけを描く。 */
  paint(g) {
    if (!g.parsed || g.el.hidden) return;
    const H = CsvGrid.ROW_H;
    const total = g.order.length;
    const view = g.scroller.clientHeight || 600;
    // 見出しの行（sticky）のぶんだけ、本体の先頭はずれている。
    const top = Math.max(0, g.scroller.scrollTop - H);
    const from = Math.max(0, Math.floor(top / H) - CsvGrid.OVERSCAN);
    const to = Math.min(total, Math.ceil((top + view) / H) + CsvGrid.OVERSCAN);
    if (from === g.painted.from && to === g.painted.to) return;
    g.painted = { from, to };

    const cols = g.widths.length;
    const frag = document.createDocumentFragment();
    frag.appendChild(CsvGrid.spacer(cols, from * H));
    for (let i = from; i < to; i++) frag.appendChild(CsvGrid.rowEl(g, i));
    frag.appendChild(CsvGrid.spacer(cols, (total - to) * H));
    g.tbody.textContent = '';
    g.tbody.appendChild(frag);
    if (!total) {
      g.tbody.appendChild(h('tr', {}, [h('td', {
        class: 'csvgrid__empty', colspan: String(cols + 1),
        text: g.filter.text.trim() ? '一致する行がありません'
          : g.parsed.rows.length ? '見出しの行しかありません' : '中身がありません'
      })]));
    }
  },

  spacer(cols, height) {
    return h('tr', { class: 'csvgrid__spacer', 'aria-hidden': 'true' },
      [h('td', { colspan: String(cols + 1), style: 'height: ' + height + 'px' })]);
  },

  /**
   * 表示順で i 番目の行。
   * @param {Object} g
   * @param {number} i g.order の添字
   */
  rowEl(g, i) {
    const r = g.order[i];
    const row = g.parsed.rows[r];
    const tr = h('tr', { 'data-row': String(r) });
    tr.appendChild(h('th', {
      class: 'csvgrid__rownum',
      title: '本文の ' + row.line + ' 行目へ',
      text: String(r + (g.header ? 0 : 1))
    }));
    const cols = g.widths.length;
    for (let c = 0; c < cols; c++) {
      const cell = row.cells[c];
      const v = cell ? cell.value : '';
      const selected = !!g.sel && g.sel.r === r && g.sel.c === c;
      const td = h('td', {
        class: 'csvgrid__td' + (g.numeric[c] ? ' csvgrid__num' : '') + (cell ? '' : ' csvgrid__td--missing') +
          (selected ? ' csvgrid__td--sel' : ''),
        'data-col': String(c)
      });
      // 改行は 1 行に畳んで見せる（行の高さを固定にしているため）。全文はツールチップで。
      td.textContent = v.indexOf('\n') >= 0 ? v.replace(/\n/g, ' ↵ ') : v;
      if (v.length > 30 || v.indexOf('\n') >= 0) td.title = v;
      tr.appendChild(td);
    }
    return tr;
  },

  /** 行番号を押したら、エディタのその行へ移る（セルを選ぶのは mousedown。216-csv-grid-edit.js）。 */
  onClick(tab, ev) {
    const g = tab.pv.grid;
    const num = ev.target.closest('.csvgrid__rownum');
    if (!num) return;
    const r = Number(num.parentElement.dataset.row);
    const row = g.parsed && g.parsed.rows[r];
    if (row) void CsvGrid.revealSource(tab, row.start);
  },

  /**
   * 元のファイルのその位置へカーソルを移す。元のタブがどこにも出ていなければ、元のペインで出す。
   * @param {Tab} tab プレビュータブ
   * @param {number} pos 本文上の位置
   */
  async revealSource(tab, pos) {
    const src = Preview.sourceOf(tab);
    if (!src) return;
    let view = Panes.viewOf(src.id);
    if (!view) {
      await activateTab(src.id);
      view = Panes.viewOf(src.id);
    }
    if (!view) return;
    const at = Math.min(pos, view.state.doc.length);
    view.dispatch({ selection: { anchor: at }, effects: Editor.cm.EditorView.scrollIntoView(at, { y: 'center' }) });
    view.focus();
  }
};
