/* ------------------------------------------------------------------ *
 *  サイドバーのビュー切り替え（アクティビティバー）
 * ------------------------------------------------------------------ */

const Views = {
  current: 'explorer',

  panes: {
    explorer: 'paneExplorer',
    search: 'paneSearch',
    history: 'paneHistory',
    settings: 'paneSettings'
  },

  /** セッションに記録されたビューを（サイドバーの開閉には触らず）復元する。 */
  restore(session) {
    if (!session || !Views.panes[session.view]) return;
    Views.current = session.view;
    for (const [key, id] of Object.entries(Views.panes)) el[id].hidden = key !== session.view;
    for (const btn of el.activity.querySelectorAll('.activity__btn')) {
      btn.classList.toggle('activity__btn--on', btn.dataset.view === session.view);
    }
    if (session.view === 'settings') Settings.render();
  },

  /**
   * @param {'explorer'|'search'|'history'|'settings'} name
   */
  show(name) {
    // 同じアイコンをもう一度押したらサイドバーを畳む（VS Code と同じ）。
    // スマホではサイドバーはドロワーなので、開閉は Mobile が持つ。
    if (Views.current === name && Mobile.sidebarShown()) {
      Layout.toggleSidebar();
      return;
    }
    if (!Mobile.sidebarShown()) Layout.toggleSidebar();

    Views.current = name;
    for (const [key, id] of Object.entries(Views.panes)) {
      el[id].hidden = key !== name;
    }
    for (const btn of el.activity.querySelectorAll('.activity__btn')) {
      btn.classList.toggle('activity__btn--on', btn.dataset.view === name);
    }

    if (name === 'search') el.searchInput.focus();
    else if (name === 'history') void History.load();
    else if (name === 'settings') Settings.render();
    // スマホでは一覧にフォーカスを置かない（置いても使い道がなく、キーボードの枠が出るだけ）。
    else if (!Mobile.on) el.entryList.focus();

    Session.save();
  }
};

