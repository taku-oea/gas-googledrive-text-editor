/* ------------------------------------------------------------------ *
 *  プレビューのスクロール連動（Markdown のみ）
 *
 *  描画時にブロックの「元の行番号」と「プレビュー上の位置」の対応表を作り、
 *  あいだは線形に補間する。行とピクセルを直接対応させないのは、
 *  見出し・表・コードブロックで 1 行あたりの高さが大きく変わるため。
 *
 *  連動する相手は「元のファイルを表示しているペインの EditorView」で、
 *  同じペインである必要はない（別のペインに並べていても効く）。元のタブが
 *  どこにも出ていなければ、連動する相手がいないので何もしない。
 *
 *  HTML プレビューは中身が別オリジンで位置を測れないので連動しない。
 * ------------------------------------------------------------------ */

const Sync = {
  enabled() {
    return Settings.get('previewScrollSync') !== false;
  },

  /** 連動相手の EditorView。元のタブが画面に出ていなければ null。 */
  viewFor(tab) {
    const src = Preview.sourceOf(tab);
    return src ? Panes.viewOf(src.id) : null;
  },

  ready(tab) {
    const pv = tab && tab.pv;
    return !!(pv && pv.mode === 'markdown' && Sync.enabled()
      && Sync.viewFor(tab) && pv.sync.marks.length >= 2);
  },

  reset(tab) {
    const pv = tab && tab.pv;
    if (!pv) return;
    pv.sync.marks = [];
    pv.sync.lock = 0;
    clearTimeout(pv.sync.lockTimer);
  },

  /** プレビュー側の位置を測り直す。描画のあとと、高さが変わったときに呼ぶ。 */
  measure(tab) {
    const pv = tab && tab.pv;
    if (!pv) return;
    const view = Sync.viewFor(tab);
    if (!Sync.enabled() || !view || pv.mode !== 'markdown') {
      pv.sync.marks = [];
      return;
    }
    // getBoundingClientRect は画面座標なので、スクロール座標へ直す。
    const base = pv.host.scrollTop - pv.host.getBoundingClientRect().top;
    const marks = [];
    for (const node of pv.body.querySelectorAll('[data-src-line]')) {
      const line = Number(node.getAttribute('data-src-line'));
      // 行番号が戻る（入れ子の要素など）ものは飛ばし、単調増加に保つ。
      if (!line || (marks.length && line <= marks[marks.length - 1].line)) continue;
      marks.push({ line, top: node.getBoundingClientRect().top + base });
    }
    if (!marks.length || marks[0].line > 1) marks.unshift({ line: 1, top: 0 });

    // 末尾の番兵。最後のブロックから文末までを補間できるようにする。
    const lastLine = marks[marks.length - 1].line;
    marks.push({
      line: Math.max(view.state.doc.lines + 1, lastLine + 1),
      top: Math.max(pv.host.scrollHeight, marks[marks.length - 1].top)
    });
    pv.sync.marks = marks;
  },

  /** 行（小数可）→ プレビューのスクロール座標 */
  topForLine(tab, line) {
    const m = tab.pv.sync.marks;
    let i = 0;
    while (i < m.length - 2 && m[i + 1].line <= line) i++;
    const span = m[i + 1].line - m[i].line;
    const r = span > 0 ? Math.min(1, Math.max(0, (line - m[i].line) / span)) : 0;
    return m[i].top + (m[i + 1].top - m[i].top) * r;
  },

  /** プレビューのスクロール座標 → 行（小数可） */
  lineForTop(tab, top) {
    const m = tab.pv.sync.marks;
    let i = 0;
    while (i < m.length - 2 && m[i + 1].top <= top) i++;
    const span = m[i + 1].top - m[i].top;
    const r = span > 0 ? Math.min(1, Math.max(0, (top - m[i].top) / span)) : 0;
    return m[i].line + (m[i + 1].line - m[i].line) * r;
  },

  /** エディタの一番上に見えている行（小数）。 */
  editorLine(view) {
    // documentTop は本文の先頭の画面座標。引くと「本文の何 px 目か」になる。
    const at = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
    const block = view.lineBlockAtHeight(at);
    const line = view.state.doc.lineAt(block.from).number;
    const r = block.height > 0 ? Math.min(1, Math.max(0, (at - block.top) / block.height)) : 0;
    return line + r;
  },

  /** エディタに合わせてプレビューを動かす。 */
  toPreview(tab) {
    const view = Sync.viewFor(tab);
    if (!view) return;
    tab.pv.host.scrollTop = Sync.topForLine(tab, Sync.editorLine(view));
  },

  /** プレビューに合わせてエディタを動かす。 */
  toEditor(tab) {
    const view = Sync.viewFor(tab);
    if (!view) return;
    const doc = view.state.doc;
    const line = Sync.lineForTop(tab, tab.pv.host.scrollTop);
    const n = Math.min(doc.lines, Math.max(1, Math.floor(line)));
    const block = view.lineBlockAt(doc.line(n).from);
    const want = block.top + block.height * (line - n);
    const now = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
    view.scrollDOM.scrollTop += want - now;
  },

  /**
   * 主導権を取る。追従側のスクロールがここに戻ってきても、
   * この間は無視されるので引っぱり合いにならない。
   */
  take(tab, who) {
    const sync = tab.pv.sync;
    sync.lock = who;
    clearTimeout(sync.lockTimer);
    sync.lockTimer = setTimeout(() => { sync.lock = 0; }, 150);
  },

  /** スクロールは連続して飛んでくるので、1 フレームに 1 回へ間引く。 */
  run(tab, fn) {
    const sync = tab.pv.sync;
    if (sync.frame) return;
    sync.frame = requestAnimationFrame(() => {
      sync.frame = 0;
      if (Sync.ready(tab)) fn();
    });
  },

  /**
   * エディタ側が動いたとき。呼ぶのは「そのペインで表示しているタブ」で、
   * そのファイルのプレビューが画面に出ていれば追従させる。
   * @param {Tab} srcTab
   */
  onEditorScroll(srcTab) {
    if (!srcTab || srcTab.kind !== 'text') return;
    const tab = Preview.forSource(srcTab.id);
    if (!tab || !Panes.isVisible(tab.id)) return;
    if (tab.pv.sync.lock === 2 || !Sync.ready(tab)) return;
    Sync.take(tab, 1);
    Sync.run(tab, () => Sync.toPreview(tab));
  },

  onPreviewScroll(tab) {
    if (!tab.pv || tab.pv.sync.lock === 1 || !Sync.ready(tab)) return;
    Sync.take(tab, 2);
    Sync.run(tab, () => Sync.toEditor(tab));
  },

  /** 描き直しや高さの変化のあと、エディタ側の位置に合わせ直す。 */
  follow(tab) {
    if (!tab.pv || tab.pv.sync.lock === 2 || !Sync.ready(tab)) return;
    Sync.take(tab, 1);
    Sync.toPreview(tab);
  }
};

/** ステータスバーのボタンの見出し。 */
const PREVIEW_LABELS = {
  markdown: 'プレビュー',
  html: 'HTML プレビュー',
  drawio: '図プレビュー',
  csv: '表プレビュー'
};

/** アクティブタブがプレビューできる種別ならボタンを出す。 */
function updatePreviewAvailability() {
  const tab = activeTab();
  const mode = Preview.mode(tab);
  // ボタンは元のファイルのタブにだけ出す。プレビュータブ側には出さない
  // （閉じるならタブの × か、もう一度 Mod+Shift+V を押す）。
  const open = tab ? Preview.forSource(tab.id) : null;

  el.btnPreview.hidden = !mode;
  el.btnPreview.textContent = PREVIEW_LABELS[mode] || 'プレビュー';
  el.btnPreview.classList.toggle('statusbar__btn--on', !!open);
  MdBar.update();
}

/**
 * プレビューの開け閉め（Mod+Shift+V とステータスバーのボタン）。
 *
 * プレビューは独立したタブなので、開くとは「隣のペインにプレビュータブを出す」、
 * 閉じるとは「そのタブを閉じる」ということになる。
 */
async function togglePreview() {
  const tab = activeTab();
  if (!tab) return;
  // プレビュータブの上で押したら、それを閉じる。
  if (tab.kind === 'preview') { await closeTab(tab.id); return; }
  if (!Preview.mode(tab)) return;

  const open = Preview.forSource(tab.id);
  if (open) { await closeTab(open.id); return; }
  await Preview.open(tab);
}

