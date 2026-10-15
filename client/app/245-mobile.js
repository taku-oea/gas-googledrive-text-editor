/* ------------------------------------------------------------------ *
 *  スマホ（狭い画面）向けの切り替え
 *
 *  幅 768px 以下（と、横向きのスマホ）では次のように振る舞いを変える。
 *    - サイドバーとアクティビティバーは、ヘッダーの ☰ で開閉するドロワーになる。
 *      ファイルを開いたら自動で閉じる
 *    - ペインの分割はしない。セッションに分割の記録があっても木は崩さず、
 *      操作対象のペインだけを全面に出す（PC で開き直したときに元の分割へ戻れる）
 *    - キーボードの代わりに、ヘッダーへ「元に戻す／やり直し／保存／新規メモ」を出す
 *
 *  セッション（UserProperties）は PC とスマホで 1 つを共有している。
 *  ドロワーの開閉は Layout.sidebarHidden（PC のサイドバーの開閉）とは別に持ち、
 *  スマホで触ってもセッションへは書かない。サイドバーの幅も同じで、
 *  スマホの画面幅で丸めた値を PC へ持ち帰らないようにしている（Layout.clamp）。
 * ------------------------------------------------------------------ */

const Mobile = {
  /** スマホ扱いにする画面。横向きのスマホは幅が 768px を超えるので高さでも見る。 */
  QUERY: '(max-width: 768px), (pointer: coarse) and (max-height: 520px)',
  /** 長押しをメニューとみなすまでの時間（ms）。 */
  LONG_PRESS_MS: 500,

  on: false,
  drawerOpen: false,
  /** iOS（iPadOS を含む）。長押しで contextmenu が来ないので自前で作る。 */
  ios: false,
  /** ドロワーの中を最後に触った時刻。ファイルを開いたときに閉じるかの判断に使う。 */
  lastDrawerTouch: 0,
  _mq: null,

  init() {
    const ua = navigator.userAgent || '';
    Mobile.ios = /iP(hone|ad|od)/.test(ua) ||
      (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
    let coarse = false;
    try {
      Mobile._mq = window.matchMedia(Mobile.QUERY);
      coarse = window.matchMedia('(pointer: coarse)').matches;
    } catch (e) {
      Mobile._mq = null;
    }
    el.app.classList.toggle('app--touch', coarse);
    el.app.classList.toggle('app--ios', Mobile.ios);
    Mobile.apply(!!(Mobile._mq && Mobile._mq.matches));

    if (Mobile._mq) {
      const onChange = () => Mobile.apply(Mobile._mq.matches);
      if (Mobile._mq.addEventListener) Mobile._mq.addEventListener('change', onChange);
      else if (Mobile._mq.addListener) Mobile._mq.addListener(onChange);
    }

    el.drawerScrim.addEventListener('click', () => { Mobile.setDrawer(false); });
    // ドロワーの中で触った時刻を覚える（そこから開いたファイルなら、開いたあとで閉じる）。
    const touched = () => { Mobile.lastDrawerTouch = Date.now(); };
    el.sidebar.addEventListener('pointerdown', touched, true);
    el.activity.addEventListener('pointerdown', touched, true);
    el.paletteOverlay.addEventListener('pointerdown', touched, true);

    if (Mobile.ios) Mobile.wireLongPress();
  },

  /** スマホ表示の入り切り。画面の回転や PC のウィンドウ幅の変更でも呼ばれる。 */
  apply(on) {
    on = !!on;
    const changed = on !== Mobile.on;
    Mobile.on = on;
    el.app.classList.toggle('app--mobile', on);
    Mobile.setDrawer(false);
    if (!changed) return;
    // サイドバーの見え方と、タブバーのペイン切り替えボタンの有無が変わる。
    Layout.apply();
    renderTabs();
  },

  /** ドロワーを開く／閉じる。スマホ表示でなければ常に閉じた扱い。 */
  setDrawer(open) {
    open = !!open && Mobile.on;
    const was = Mobile.drawerOpen;
    Mobile.drawerOpen = open;
    el.app.classList.toggle('app--drawerOpen', open);
    el.drawerScrim.hidden = !open;
    if (Mobile.on) el.btnToggleSidebar.setAttribute('aria-expanded', String(open));
    if (open && !was) {
      Mobile.lastDrawerTouch = Date.now();
      renderTreeStates();
    } else if (!open && was) {
      Ctx.hide();
    }
  },

  toggleDrawer() { Mobile.setDrawer(!Mobile.drawerOpen); },

  /** サイドバー（スマホではドロワー）が見えているか。 */
  sidebarShown() { return Mobile.on ? Mobile.drawerOpen : !Layout.sidebarHidden; },

  /**
   * タブを表示する直前に呼ぶ。ドロワーから開いたものなら、ドロワーを閉じて本文を見せる。
   * 起動時のセッション復元のように、ドロワーを触っていないのに来たものでは閉じない。
   */
  onTabShown() {
    if (!Mobile.on || !Mobile.drawerOpen) return;
    if (Date.now() - Mobile.lastDrawerTouch > 15000) return;
    Mobile.setDrawer(false);
  },

  /** 元に戻す／やり直し。表示中のエディタに効かせる。 */
  history(dir) {
    const view = Editor.view;
    const tab = activeTab();
    if (!view || !tab || tab.kind !== 'text' || !Editor.cm || !Editor.cm.undo) return;
    (dir < 0 ? Editor.cm.undo : Editor.cm.redo)(view);
    view.focus();
  },

  /**
   * iOS Safari は長押しで contextmenu を出さない（Android の Chrome は出す）。
   * ツリーの行・タブ・表のセルに限って、長押しを右クリックとして配る。
   * エディタの本文は対象にしない（長押しは文字の選択に使うため）。
   */
  wireLongPress() {
    const TARGETS = '.row, .tab, .csvgrid__table td, .csvgrid__table th, #entryList';
    let timer = null;
    let start = null;
    let fired = false;

    const cancel = () => { clearTimeout(timer); timer = null; start = null; };

    document.addEventListener('touchstart', (ev) => {
      cancel();
      fired = false;
      if (ev.touches.length !== 1) return;
      const target = ev.target.closest ? ev.target.closest(TARGETS) : null;
      if (!target) return;
      const t = ev.touches[0];
      start = { x: t.clientX, y: t.clientY, target: ev.target };
      timer = setTimeout(() => {
        timer = null;
        if (!start) return;
        fired = true;
        start.target.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: start.x, clientY: start.y
        }));
      }, Mobile.LONG_PRESS_MS);
    }, { passive: true });

    document.addEventListener('touchmove', (ev) => {
      if (!start) return;
      const t = ev.touches[0];
      if (Math.abs(t.clientX - start.x) > 10 || Math.abs(t.clientY - start.y) > 10) cancel();
    }, { passive: true });

    // メニューを出したあとの指離れで click（＝ファイルを開く）が起きないよう止める。
    document.addEventListener('touchend', (ev) => {
      cancel();
      if (fired) { fired = false; ev.preventDefault(); }
    }, { passive: false });
    document.addEventListener('touchcancel', cancel, { passive: true });
  }
};
