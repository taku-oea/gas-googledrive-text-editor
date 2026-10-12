/* ------------------------------------------------------------------ *
 *  表プレビューの編集（セル・行・列）
 *
 *  表の上での操作は client/lib/csv.js が「本文に対する最小の変更」に直し、
 *  元のタブの CodeMirror にトランザクションとして流す。本文を組み立て直さないので
 *  触っていないセルの書き方はそのまま残り、次のものは今までの経路がそのまま効く。
 *    - 未保存の印・自動保存・下書き（onDocChanged）
 *    - 保存時の文字コード（Shift_JIS のファイルは Shift_JIS のまま）と改行コード
 *    - Undo / Redo（元のエディタの履歴に積まれる。表の上の Mod+Z はエディタへ渡す）
 *
 *  キーを受けるのは、選んでいるセルの上に透明にして重ねた 1 枚の入力欄（g.box）。
 *  セルを選んでいる間はずっとここにフォーカスがあるので、日本語入力（IME）の変換も
 *  この欄の中で始まり、始まった時点でこの欄をそのまま編集欄として見せる
 *  （表の上でいきなり日本語を打っても最初の文字を落とさない）。コピーと貼り付けも、
 *  編集できる要素の上で起きるので、どのブラウザでも copy / paste のイベントが届く。
 *
 *  操作
 *    セルを選ぶ … クリック / 矢印キー / Tab
 *    編集する   … ダブルクリック / Enter / F2（そのまま文字を打つと置き換え）
 *    確定       … Enter（下へ）/ Shift+Enter（上へ）/ Tab（右へ）/ 別の所を押す
 *    セル内改行 … Alt+Enter（Excel と同じ）
 *    やめる     … Esc
 *    消す       … Delete / Backspace
 *    コピー・切り取り・貼り付け … Mod+C / Mod+X / Mod+V（Excel からの複数セルの貼り付けにも対応）
 *    行・列の追加と削除 … 右クリック、行の追加は上のバーからも
 * ------------------------------------------------------------------ */

Object.assign(CsvGrid, {
  /** create の最後に呼ぶ。入力欄を作り、イベントをつなぐ。 */
  wireEditing(tab, g, addRowBtn) {
    const box = h('textarea', {
      class: 'csvgrid__editor csvgrid__editor--idle',
      spellcheck: 'false', autocomplete: 'off',
      'aria-label': 'セルの値（Enter で編集・Alt+Enter でセル内改行）'
    });
    g.box = box;
    g.scroller.appendChild(box);

    // 選ぶのは mousedown で。click まで待つと、編集中だった欄の blur で確定 → 表の描き直しが
    // 先に起き、押したセルの要素が入れ替わって click が届かないことがある。
    g.tbody.addEventListener('mousedown', (ev) => {
      const td = ev.target.closest('.csvgrid__td');
      if (!td) return;
      ev.preventDefault();   // フォーカスを入力欄から動かさない（文字の選択も始めない）
      const r = Number(td.parentElement.dataset.row);
      const c = Number(td.dataset.col);
      if (g.editing) CsvGrid.finishEdit(tab, true, null);
      CsvGrid.select(g, r, c);
      CsvGrid.focusSink(g);
    });
    g.tbody.addEventListener('dblclick', (ev) => {
      const td = ev.target.closest('.csvgrid__td');
      if (!td) return;
      CsvGrid.select(g, Number(td.parentElement.dataset.row), Number(td.dataset.col));
      CsvGrid.startEdit(tab, null);
    });
    g.tbody.addEventListener('contextmenu', (ev) => {
      const cell = ev.target.closest('.csvgrid__td, .csvgrid__rownum');
      if (!cell) return;
      ev.preventDefault();
      const r = Number(cell.parentElement.dataset.row);
      const c = cell.classList.contains('csvgrid__td') ? Number(cell.dataset.col) : (g.sel ? g.sel.c : 0);
      CsvGrid.select(g, r, c);
      CsvGrid.showCellMenu(tab, ev.clientX, ev.clientY);
    });
    g.thead.addEventListener('contextmenu', (ev) => {
      const th = ev.target.closest('.csvgrid__th');
      if (!th) return;
      ev.preventDefault();
      CsvGrid.showColumnMenu(tab, Number(th.dataset.col), ev.clientX, ev.clientY);
    });
    // Tab キーなどで表そのものにフォーカスが来たら、入力欄へ渡す。
    g.scroller.addEventListener('focus', () => {
      if (!g.sel && g.order.length) CsvGrid.select(g, g.order[0], 0);
      CsvGrid.focusSink(g);
    });

    box.addEventListener('keydown', (ev) => {
      if (g.editing) CsvGrid.onEditorKey(tab, ev);
      else CsvGrid.onKey(tab, ev);
    });
    // 選んでいるだけの状態で文字が入った・変換が始まったら、そのまま編集にする。
    box.addEventListener('compositionstart', () => { if (!g.editing) CsvGrid.beginTyping(tab); });
    box.addEventListener('input', (ev) => {
      if (g.editing) { CsvGrid.fitEditor(box); return; }
      if (!ev.isComposing) CsvGrid.beginTyping(tab);
    });
    box.addEventListener('blur', () => {
      if (g.editing) CsvGrid.finishEdit(tab, true, null, { blur: true });
    });
    box.addEventListener('copy', (ev) => CsvGrid.onCopy(g, ev));
    box.addEventListener('cut', (ev) => CsvGrid.onCut(tab, ev));
    box.addEventListener('paste', (ev) => CsvGrid.onPaste(tab, ev));
    addRowBtn.addEventListener('click', () => CsvGrid.appendRow(tab));
  },

  /* ---------------------------- 選択 ---------------------------- */

  /**
   * セルを選ぶ。見えている行の印だけ付け替える（描き直さない）。
   * @param {Object} g
   * @param {number} r parsed.rows の添字
   * @param {number} c 列
   */
  select(g, r, c) {
    g.sel = { r, c };
    for (const node of g.tbody.querySelectorAll('.csvgrid__td--sel')) node.classList.remove('csvgrid__td--sel');
    const td = CsvGrid.cellEl(g, r, c);
    if (td) td.classList.add('csvgrid__td--sel');
  },

  cellEl(g, r, c) {
    const tr = g.tbody.querySelector('tr[data-row="' + r + '"]');
    return tr ? tr.querySelector('td[data-col="' + c + '"]') : null;
  },

  /**
   * 選んでいるセルの上へ透明な入力欄を動かし、フォーカスを置く。
   * 中身はそのセルの値を全選択にしておく。コピーはそのまま効き、
   * 文字を打つ・変換を始めると選択が置き換わって「置き換えの編集」になる。
   */
  focusSink(g) {
    if (g.editing || !g.box || g.el.hidden) return;
    const box = g.box;
    const td = g.sel ? CsvGrid.cellEl(g, g.sel.r, g.sel.c) : null;
    if (td) CsvGrid.placeBox(g, td);
    box.value = g.sel ? CsvGrid.valueAt(g, g.sel.r, g.sel.c) : '';
    box.focus({ preventScroll: true });
    box.select();
  },

  /** 入力欄を要素の位置へ置く（表の中の座標なので、スクロールしても一緒に動く）。 */
  placeBox(g, target) {
    const sc = g.scroller.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const box = g.box;
    box.style.left = (rect.left - sc.left + g.scroller.scrollLeft) + 'px';
    box.style.top = (rect.top - sc.top + g.scroller.scrollTop) + 'px';
    box.style.width = Math.max(rect.width, g.editing ? 160 : 0) + 'px';
    box.style.minHeight = rect.height + 'px';
    box.style.height = rect.height + 'px';
  },

  /** 表示順で上下・左右に動かし、見える位置までスクロールする。 */
  move(g, dRow, dCol) {
    if (!g.order.length) return;
    const cols = Math.max(1, g.widths.length);
    let i = g.sel ? g.order.indexOf(g.sel.r) : -1;
    if (i < 0) i = 0;
    else i = Math.max(0, Math.min(g.order.length - 1, i + dRow));
    const c = Math.max(0, Math.min(cols - 1, (g.sel ? g.sel.c : 0) + dCol));
    CsvGrid.reveal(g, i, c);
    CsvGrid.select(g, g.order[i], c);
    CsvGrid.focusSink(g);
  },

  /** 表示順で i 番目の行・c 列目が見えるようにスクロールする。 */
  reveal(g, i, c) {
    const H = CsvGrid.ROW_H;
    const sc = g.scroller;
    const top = H + i * H;   // 見出しの行のぶん下がっている
    if (top < sc.scrollTop + H) sc.scrollTop = top - H;
    else if (top + H > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + H - sc.clientHeight;
    // 横は、左端に固定している行番号（52px）の陰に隠れないように。
    let left = 52;
    for (let k = 0; k < c; k++) left += g.widths[k];
    const w = g.widths[c] || 0;
    if (left - 52 < sc.scrollLeft) sc.scrollLeft = left - 52;
    else if (left + w > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = left + w - sc.clientWidth;
    CsvGrid.paint(g);   // スクロールの反映を待たずに、その行を DOM に出しておく
  },

  /** 選んでいるセルが、いま表に見えている行のものか。 */
  selVisible(g) {
    return !!g.sel && g.order.indexOf(g.sel.r) >= 0;
  },

  /* ---------------------------- キー（選んでいるだけのとき） ---------------------------- */

  onKey(tab, ev) {
    const g = tab.pv.grid;
    // 変換の始まり。compositionstart で編集に切り替わるので、ここでは何もしない。
    if (isImeKey(ev)) return;
    const mod = IS_MAC ? ev.metaKey : ev.ctrlKey;

    // Undo / Redo は元のエディタの履歴で行う（表の変更もそこに積んである）。
    if (mod && !ev.altKey && (ev.code === 'KeyZ' || ev.code === 'KeyY')) {
      ev.preventDefault();
      CsvGrid.forwardKey(tab, ev);
      return;
    }
    if (mod || ev.altKey) return;   // Mod+C / X / V は copy / cut / paste のイベントで受ける

    const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (moves[ev.key]) {
      ev.preventDefault();
      CsvGrid.move(g, moves[ev.key][0], moves[ev.key][1]);
      return;
    }
    if (ev.key === 'Tab') {
      ev.preventDefault();
      CsvGrid.move(g, 0, ev.shiftKey ? -1 : 1);
      return;
    }
    if (!CsvGrid.selVisible(g)) {
      if (ev.key === 'Enter' || ev.key === 'F2') { ev.preventDefault(); CsvGrid.move(g, 0, 0); }
      else if (ev.key.length === 1 || ev.key === 'Delete' || ev.key === 'Backspace') ev.preventDefault();
      return;
    }
    if (ev.key === 'Enter' || ev.key === 'F2') {
      ev.preventDefault();
      CsvGrid.startEdit(tab, null);
      return;
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault();
      CsvGrid.writeCell(tab, g.sel.r, g.sel.c, '');
      CsvGrid.focusSink(g);
    }
    // 文字キーは止めない。入力欄に入った時点（input）で編集に切り替わる。
  },

  /**
   * 表の上で押された Undo / Redo を、元のファイルのエディタへ渡す。
   * CodeMirror の undo コマンドは読み込んでいるバンドルから出していないので、
   * 同じキー操作をエディタに送って、エディタ自身のキー割り当てに処理させる。
   */
  forwardKey(tab, ev) {
    const src = Preview.sourceOf(tab);
    const view = src ? Panes.viewOf(src.id) : null;
    if (!view) {
      toast('元に戻すには、元のファイルをどこかのペインに出してから操作してください', 'info', 5000);
      return;
    }
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      key: ev.key, code: ev.code, keyCode: ev.keyCode,
      metaKey: ev.metaKey, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, altKey: ev.altKey,
      bubbles: true, cancelable: true
    }));
    CsvGrid.focusSink(tab.pv.grid);
  },

  /* ---------------------------- セルの編集 ---------------------------- */

  /** 選んでいるだけの状態で文字が入った・変換が始まった。入力欄の中身はそのままで編集にする。 */
  beginTyping(tab) {
    const g = tab.pv.grid;
    if (!CsvGrid.selVisible(g)) { g.box.value = ''; return; }
    CsvGrid.startEdit(tab, null, { keepValue: true });
    if (!g.editing) g.box.value = '';   // 編集できなかった（引用符が閉じていない等）
  },

  /**
   * 選んでいるセルの上に入力欄を出して編集を始める。
   * @param {Tab} tab
   * @param {string|null} initial 置き換えで始めるなら ''、今の値から始めるなら null
   * @param {{header?:boolean, c?:number, keepValue?:boolean}} [opts]
   *   header=true なら見出しの行（列名）を編集する。keepValue=true なら入力欄の中身
   *   （打ち始めた文字・変換中の文字）をそのまま使う
   */
  startEdit(tab, initial, opts = {}) {
    const g = tab.pv.grid;
    if (g.editing || !CsvGrid.sync(tab)) return;
    const header = !!opts.header;
    const r = header ? 0 : g.sel && g.sel.r;
    const c = header ? opts.c : g.sel && g.sel.c;
    if (r == null || c == null || !g.parsed.rows[r]) return;

    let target;
    if (header) {
      target = g.thead.querySelector('th[data-col="' + c + '"]');
    } else {
      const i = g.order.indexOf(r);
      if (i < 0) return;
      CsvGrid.reveal(g, i, c);
      target = CsvGrid.cellEl(g, r, c);
    }
    if (!target) return;

    const box = g.box;
    const original = CsvGrid.valueAt(g, r, c);
    g.editing = { r, c, original, header, docRef: g.docRef };
    box.classList.remove('csvgrid__editor--idle');
    CsvGrid.placeBox(g, target);
    if (!opts.keepValue) box.value = initial === null ? original : initial;
    CsvGrid.fitEditor(box);
    box.focus({ preventScroll: true });
    // 変換中に値や選択を触ると変換が壊れるので、打ち始めたときは触らない。
    if (!opts.keepValue) box.setSelectionRange(box.value.length, box.value.length);
  },

  /** 入力欄の高さを中身に合わせる（セル内改行を打つと伸びる。10 行まで）。 */
  fitEditor(box) {
    box.style.height = 'auto';
    // scrollHeight は枠線を含まないので、上下の枠（2px ずつ）を足す。
    box.style.height = Math.min(box.scrollHeight + 4, CsvGrid.ROW_H * 10) + 'px';
  },

  onEditorKey(tab, ev) {
    if (isImeKey(ev)) return;   // 変換の確定の Enter で決定しない
    if (ev.key === 'Escape') {
      ev.preventDefault();
      CsvGrid.finishEdit(tab, false, null);
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (ev.altKey) {
        // セル内の改行。
        ev.target.setRangeText('\n', ev.target.selectionStart, ev.target.selectionEnd, 'end');
        CsvGrid.fitEditor(ev.target);
        return;
      }
      CsvGrid.finishEdit(tab, true, ev.shiftKey ? [-1, 0] : [1, 0]);
      return;
    }
    if (ev.key === 'Tab') {
      ev.preventDefault();
      CsvGrid.finishEdit(tab, true, [0, ev.shiftKey ? -1 : 1]);
    }
  },

  /**
   * 編集を終える。
   * @param {Tab} tab
   * @param {boolean} commit 書き込むか
   * @param {Array<number>|null} next 確定後に動く向き（[行, 列]）
   * @param {{blur?:boolean}} [opts] blur=true なら、別の所へフォーカスが移ったので取り返さない
   */
  finishEdit(tab, commit, next, opts = {}) {
    const g = tab.pv && tab.pv.grid;
    if (!g || !g.editing) return;
    const ed = g.editing;
    g.editing = null;
    const value = g.box.value;
    g.box.classList.add('csvgrid__editor--idle');
    g.box.value = '';
    if (commit && value !== ed.original) CsvGrid.commitEdit(tab, ed, value);
    if (opts.blur) return;
    if (next) CsvGrid.move(g, next[0], next[1]);
    else CsvGrid.focusSink(g);
  },

  /**
   * 編集した値を書く。編集している間に本文が変わっていたら（裏での再読み込み・変更ログでの
   * 差し替え・別のペインでの入力）、同じセルがまだ同じ値のときだけ書く。そうでなければ
   * 別の行に書いてしまうおそれがあるので書かず、入力した値はクリップボードに残す。
   */
  commitEdit(tab, ed, value) {
    const g = tab.pv.grid;
    if (!CsvGrid.sync(tab)) return;
    if (g.docRef !== ed.docRef && CsvGrid.valueAt(g, ed.r, ed.c) !== ed.original) {
      void copyTextToClipboard(value);
      toast('編集している間に本文が変わったため、書き込みませんでした（入力した値はクリップボードに入れてあります）',
        'warn', 8000);
      return;
    }
    CsvGrid.apply(tab, csvSetCell(g.parsed, ed.r, ed.c, value, g.delim));
  },

  /** 1 つのセルに書く。 */
  writeCell(tab, r, c, value) {
    const g = tab.pv.grid;
    if (!CsvGrid.sync(tab)) return;
    CsvGrid.apply(tab, csvSetCell(g.parsed, r, c, value, g.delim));
  },

  /* ---------------------------- 本文へ流す ---------------------------- */

  /**
   * 表が元の本文と同じ版を見ているか確かめ、古ければ解析し直す。
   * エディタ側で打った直後（描き直しの待ち時間の間）に表を操作されても、
   * 古い位置で本文を書き換えないようにする。
   * @return {boolean} 編集してよいか
   */
  sync(tab) {
    const src = Preview.sourceOf(tab);
    const g = tab.pv && tab.pv.grid;
    if (!src || !g || src.kind !== 'text' || !src.loaded || !src.state) {
      toast('元のファイルを読み込めていないため、表から編集できません', 'warn', 5000);
      return false;
    }
    if (src.state.doc !== g.docRef) CsvGrid.render(tab, src);
    if (!g.parsed) return false;
    // 閉じていない引用符があると、そのセルは文末までの範囲を持つ。書き換えると後ろが全部消える。
    if (g.parsed.unclosed !== null) {
      toast('本文の ' + g.parsed.unclosed + ' 行目の引用符（"）が閉じていないため、表からは編集できません。' +
        'エディタで直してください。', 'warn', 8000);
      return false;
    }
    return true;
  },

  /**
   * 変更を元のタブへ流す。エディタに出ていればその EditorView に、出ていなければ state に当てる
   * （どちらでも onDocChanged が未保存の印・自動保存・下書きを面倒みる）。
   * @param {Tab} tab プレビュータブ
   * @param {Array<{from:number, to:number, insert:string}>} changes 解析した本文の上の位置
   * @param {{keepOrder?:boolean}} [opts] keepOrder=false なら並びを決め直す（行を足した・消したとき）
   */
  apply(tab, changes, opts = {}) {
    const src = Preview.sourceOf(tab);
    const g = tab.pv.grid;
    if (!src || !changes.length) return false;
    const spec = { changes: changes.slice().sort((a, b) => a.from - b.from), userEvent: 'input.csv' };
    g.selfEdit = opts.keepOrder !== false;
    const view = Panes.viewOf(src.id);
    if (view) {
      view.dispatch(spec);
    } else {
      src.state = src.state.update(spec).state;
      onDocChanged(src.id);
    }
    // 描き直しの予約（Preview.schedule）を待たずに、すぐ表に出す。
    CsvGrid.render(tab, src);
    return true;
  },

  /* ---------------------------- 行と列 ---------------------------- */

  /**
   * 行や列を足すと、並べ替え・絞り込みの下では足した行が見えない所へ行ってしまう。
   * 足す前に解除して、足した行がその場に見えるようにする。
   */
  clearViewOps(g) {
    if (!g.sort && !g.filter.text) return;
    g.sort = null;
    g.filter.text = '';
    g.filterInput.value = '';
    toast('並べ替えと絞り込みを解除しました（足した行が見えるように）', 'info', 3500);
  },

  /**
   * 行を足して、その行のセルを選ぶ。
   * @return {number|null} 足した行（parsed.rows の添字）
   */
  insertRow(tab, at) {
    const g = tab.pv.grid;
    if (!CsvGrid.sync(tab)) return null;
    CsvGrid.clearViewOps(g);
    const src = Preview.sourceOf(tab);
    const changes = csvInsertRow(g.parsed, at, g.delim, src.state.doc.length);
    const c = g.sel ? g.sel.c : 0;
    if (!CsvGrid.apply(tab, changes, { keepOrder: false })) return null;
    const r = Math.min(at, g.parsed.rows.length - 1);
    const i = g.order.indexOf(r);
    if (i >= 0) {
      CsvGrid.reveal(g, i, c);
      CsvGrid.select(g, r, c);
      CsvGrid.focusSink(g);
    }
    return r;
  },

  /** 上のバーの「行を追加」。末尾に足してすぐ書き始められるようにする。 */
  appendRow(tab) {
    const g = tab.pv.grid;
    if (!CsvGrid.sync(tab)) return;
    const wasEmpty = !g.parsed.rows.length;
    const r = CsvGrid.insertRow(tab, g.parsed.rows.length);
    if (r === null) return;
    // 空のファイルに見出しを付けて見ているなら、足した行は見出しの行になる。列名から書いてもらう。
    if (wasEmpty && g.header) { CsvGrid.startEdit(tab, null, { header: true, c: 0 }); return; }
    g.sel = { r, c: 0 };
    if (CsvGrid.selVisible(g)) CsvGrid.startEdit(tab, null);
  },

  deleteRow(tab, r) {
    const g = tab.pv.grid;
    if (!CsvGrid.sync(tab)) return;
    const i = g.order.indexOf(r);
    const c = g.sel ? g.sel.c : 0;
    if (!CsvGrid.apply(tab, csvDeleteRow(g.parsed, r), { keepOrder: false })) return;
    toast('行を削除しました（' + (IS_MAC ? '⌘' : 'Ctrl') + '+Z で元に戻せます）', 'info', 3500);
    if (!g.order.length) { g.sel = null; return; }
    const j = Math.max(0, Math.min(g.order.length - 1, i));
    CsvGrid.select(g, g.order[j], c);
    CsvGrid.focusSink(g);
  },

  insertColumn(tab, c) {
    const g = tab.pv.grid;
    if (!CsvGrid.sync(tab)) return;
    CsvGrid.apply(tab, csvInsertColumn(g.parsed, c, g.delim), { keepOrder: false });
    CsvGrid.focusSink(g);
  },

  deleteColumn(tab, c) {
    const g = tab.pv.grid;
    if (!CsvGrid.sync(tab)) return;
    if (g.sort && g.sort.col === c) g.sort = null;
    if (g.filter.col === c) g.filter.col = -1;
    if (!CsvGrid.apply(tab, csvDeleteColumn(g.parsed, c), { keepOrder: false })) return;
    toast('列を削除しました（' + (IS_MAC ? '⌘' : 'Ctrl') + '+Z で元に戻せます）', 'info', 3500);
    CsvGrid.focusSink(g);
  },

  /* ---------------------------- メニュー ---------------------------- */

  showCellMenu(tab, x, y) {
    const g = tab.pv.grid;
    const sel = g.sel;
    if (!sel) return;
    const row = g.parsed.rows[sel.r];
    Ctx.show(x, y, [
      { label: 'セルを編集', icon: 'rename', key: 'Enter', onClick: () => CsvGrid.startEdit(tab, null) },
      { label: 'セルをコピー', icon: 'copy', onClick: () => void copyTextToClipboard(CsvGrid.valueAt(g, sel.r, sel.c)) },
      { label: 'セルを空にする', icon: 'clear', key: 'Delete', onClick: () => CsvGrid.writeCell(tab, sel.r, sel.c, '') },
      { sep: true },
      { label: '上に行を挿入', icon: 'arrow-up', onClick: () => CsvGrid.insertRow(tab, sel.r) },
      { label: '下に行を挿入', icon: 'arrow-down', onClick: () => CsvGrid.insertRow(tab, sel.r + 1) },
      { label: 'この行を削除', icon: 'trash', danger: true, onClick: () => CsvGrid.deleteRow(tab, sel.r) },
      { sep: true },
      { label: '左に列を挿入', icon: 'columns', onClick: () => CsvGrid.insertColumn(tab, sel.c) },
      { label: '右に列を挿入', icon: 'columns', onClick: () => CsvGrid.insertColumn(tab, sel.c + 1) },
      { label: 'この列を削除', icon: 'trash', danger: true, onClick: () => CsvGrid.deleteColumn(tab, sel.c) },
      { sep: true },
      { label: '本文のこの行へ移動', icon: 'goto', disabled: !row, onClick: () => void CsvGrid.revealSource(tab, row.start) }
    ]);
  },

  showColumnMenu(tab, c, x, y) {
    const g = tab.pv.grid;
    const hasHeader = g.header && g.parsed.rows.length > 0;
    Ctx.show(x, y, [
      { label: '昇順で並べ替え', icon: 'arrow-up', onClick: () => { g.sort = { col: c, dir: 1 }; CsvGrid.layout(g); } },
      { label: '降順で並べ替え', icon: 'arrow-down', onClick: () => { g.sort = { col: c, dir: -1 }; CsvGrid.layout(g); } },
      { label: '並べ替えを解除', icon: 'reset', disabled: !g.sort, onClick: () => { g.sort = null; CsvGrid.layout(g); } },
      { sep: true },
      { label: '列名を変更', icon: 'rename', disabled: !hasHeader, onClick: () => CsvGrid.startEdit(tab, null, { header: true, c }) },
      { label: '左に列を挿入', icon: 'columns', onClick: () => CsvGrid.insertColumn(tab, c) },
      { label: '右に列を挿入', icon: 'columns', onClick: () => CsvGrid.insertColumn(tab, c + 1) },
      { label: 'この列を削除', icon: 'trash', danger: true, onClick: () => CsvGrid.deleteColumn(tab, c) }
    ]);
  },

  /* ---------------------------- コピーと貼り付け ---------------------------- */

  valueAt(g, r, c) {
    const row = g.parsed && g.parsed.rows[r];
    const cell = row && row.cells[c];
    return cell ? cell.value : '';
  },

  onCopy(g, ev) {
    if (g.editing || !CsvGrid.selVisible(g) || !ev.clipboardData) return;
    ev.preventDefault();
    ev.clipboardData.setData('text/plain', CsvGrid.valueAt(g, g.sel.r, g.sel.c));
  },

  /** 切り取り。値をクリップボードに入れてセルを空にする。 */
  onCut(tab, ev) {
    const g = tab.pv.grid;
    if (g.editing || !ev.clipboardData) return;
    ev.preventDefault();
    if (!CsvGrid.selVisible(g)) return;
    ev.clipboardData.setData('text/plain', CsvGrid.valueAt(g, g.sel.r, g.sel.c));
    CsvGrid.writeCell(tab, g.sel.r, g.sel.c, '');
    CsvGrid.focusSink(g);
  },

  /**
   * 貼り付け。1 つの値なら選んでいるセルへ。タブと改行で区切られた塊（Excel やスプレッドシートの
   * 範囲をコピーしたもの）なら、選んでいるセルを左上として表示の順に並べて書く。
   * 行が足りない・その行に列が無い所は書かない（行の順が本文と違うと、足す場所が決められないため）。
   */
  onPaste(tab, ev) {
    const g = tab.pv.grid;
    if (g.editing || !ev.clipboardData) return;
    ev.preventDefault();
    if (!CsvGrid.selVisible(g) || !CsvGrid.sync(tab)) return;
    const text = ev.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n').replace(/\n$/, '');
    if (text.indexOf('\t') < 0 && text.indexOf('\n') < 0) {
      CsvGrid.writeCell(tab, g.sel.r, g.sel.c, text);
      CsvGrid.focusSink(g);
      return;
    }
    const block = parseCsv(text, '\t').rows.map((row) => row.cells.map((cell) => cell.value));
    const start = g.order.indexOf(g.sel.r);
    const changes = [];
    let skipped = 0;
    block.forEach((values, dr) => {
      const r = g.order[start + dr];
      const row = r === undefined ? null : g.parsed.rows[r];
      values.forEach((value, dc) => {
        const c = g.sel.c + dc;
        if (!row || c >= row.cells.length) { skipped++; return; }
        changes.push(...csvSetCell(g.parsed, r, c, value, g.delim));
      });
    });
    CsvGrid.apply(tab, changes);
    CsvGrid.focusSink(g);
    if (skipped) toast(skipped + ' 個の値は、貼り付け先の行や列が無いため書きませんでした', 'warn', 6000);
  }
});
