/* =====================================================================
   Drive テキストエディタ — クライアント（フェーズ 2）

   設計上の約束:
   - 編集操作はすべてここで完結させる。サーバーを呼ぶのは
     一覧 / 読み込み / 保存 の 3 つだけ（作成・改名・削除はユーザーの明示操作時のみ）。
   - 保存はデバウンス 2 秒。タブごとに独立して走る。
   - 未保存内容は localStorage に下書きとして持ち、保存失敗時に復元できるようにする。
   - HtmlService は IFRAME サンドボックス。Service Worker は登録できないので
     オフライン対応はしない。
   ===================================================================== */

/* ------------------------------------------------------------------ *
 *  DOM 参照
 * ------------------------------------------------------------------ */

try { performance.mark('module-eval-start'); } catch (e) { /* 計測は任意 */ }

const $ = (id) => document.getElementById(id);

const el = {
  app: $('app'),
  header: $('header'),
  main: $('main'),
  sidebar: $('sidebar'),
  activity: $('activity'),
  paneExplorer: $('paneExplorer'),
  paneSearch: $('paneSearch'),
  paneHistory: $('paneHistory'),
  paneSettings: $('paneSettings'),
  searchInput: $('searchInput'),
  searchResults: $('searchResults'),
  searchFoot: $('searchFoot'),
  btnSearchClear: $('btnSearchClear'),
  historyList: $('historyList'),
  historyFoot: $('historyFoot'),
  btnHistoryRefresh: $('btnHistoryRefresh'),
  settingsBody: $('settingsBody'),
  settingsFoot: $('settingsFoot'),
  btnSettingsReset: $('btnSettingsReset'),
  btnToggleSidebar: $('btnToggleSidebar'),
  sidebarSplitter: $('sidebarSplitter'),
  rootsSummary: $('rootsSummary'),
  btnChangeFolder: $('btnChangeFolder'),
  btnTheme: $('btnTheme'),
  btnKeys: $('btnKeys'),
  status: $('status'),
  statusText: $('status').querySelector('.status__text'),
  userEmail: $('userEmail'),

  btnNewMemo: $('btnNewMemo'),
  btnNewFile: $('btnNewFile'),
  btnNewFolder: $('btnNewFolder'),
  btnCollapseAll: $('btnCollapseAll'),
  btnRefresh: $('btnRefresh'),
  filterInput: $('filterInput'),
  btnFilterClear: $('btnFilterClear'),
  entryList: $('entryList'),
  sidebarFoot: $('sidebarFoot'),

  // ペインの木そのもの。中の要素は leaf ごとに 1 組ずつあるので、
  // el.tabbar のような名前は「いまアクティブなペインのもの」を返す
  // getter として下で定義する（PANE_ELS）。
  paneRoot: $('paneRoot'),

  btnPreview: $('btnPreview'),
  statusbar: $('statusbar'),
  sbName: $('sbName'),
  sbLang: $('sbLang'),
  sbSize: $('sbSize'),
  sbCursor: $('sbCursor'),
  sbIndent: $('sbIndent'),
  sbEol: $('sbEol'),
  sbEnc: $('sbEnc'),

  bootOverlay: $('bootOverlay'),
  bootMessage: $('bootMessage'),
  bootHint: $('bootHint'),
  bootError: $('bootError'),
  btnBootRetry: $('btnBootRetry'),

  pickerOverlay: $('pickerOverlay'),
  pickerTitle: $('pickerTitle'),
  pickerNote: $('pickerNote'),
  pickerCurrent: $('pickerCurrent'),
  pickerCurrentLabel: $('pickerCurrentLabel'),
  pickerAddLabel: $('pickerAddLabel'),
  pickerRefLabel: $('pickerRefLabel'),
  pickerNameWrap: $('pickerNameWrap'),
  pickerName: $('pickerName'),
  pickerTmp: $('pickerTmp'),
  pickerTmpPath: $('pickerTmpPath'),
  btnTmpFolder: $('btnTmpFolder'),
  btnTmpFolderReset: $('btnTmpFolderReset'),
  btnPickerClose: $('btnPickerClose'),
  tree: $('tree'),
  rootList: $('rootList'),
  folderRefInput: $('folderRefInput'),
  btnResolveRef: $('btnResolveRef'),
  resolvedBox: $('resolvedBox'),
  pickerSelected: $('pickerSelected'),
  btnConfirmFolder: $('btnConfirmFolder'),

  modalOverlay: $('modalOverlay'),
  modal: $('modalOverlay').querySelector('.modal'),
  modalTitle: $('modalTitle'),
  modalBody: $('modalBody'),
  modalActions: $('modalActions'),

  btnCommands: $('btnCommands'),
  ctxMenu: $('ctxMenu'),
  paletteOverlay: $('paletteOverlay'),
  paletteInput: $('paletteInput'),
  paletteList: $('paletteList'),
  paletteFoot: $('paletteFoot'),
  toasts: $('toasts')
};

/**
 * ペインごとに 1 組ずつある要素の名前。
 *
 * `el.tabbar` のように書いたときは「いまアクティブなペインのもの」を返す。
 * ペインを指定して触りたいときは `leaf.el.tabbar` を使うこと
 * （renderTabs や showEditor のように、アクティブでないペインも描く側はそちら）。
 *
 * Panes.init() の前は null を返す。ここで実体を作らないのは、
 * ペインが 1 枚とは限らず、どれを指すかがアクティブ状態で決まるため。
 */
const PANE_ELS = [
  'tabbar', 'editorCrumbs', 'mdBar', 'panes', 'editorHost', 'previewHost',
  'termHost', 'diffHost', 'diffBar', 'diffBody',
  'viewerHost', 'viewerFrame', 'viewerName', 'viewerKind', 'viewerOpenLink', 'viewerFallback',
  'emptyState', 'drop'
];
for (const key of PANE_ELS) {
  Object.defineProperty(el, key, {
    get() {
      const leaf = Panes.active();
      return leaf ? leaf.el[key] : null;
    }
  });
}

/**
 * アプリの中のドラッグ（タブ・ツリーの行・ピン留め）で使う型。
 * text/plain を使わないのは、エディタ本文の上で落ちたときに CodeMirror が
 * テキストの貼り付けとして受け取ってしまうため。
 */
const DRAG_TYPE = 'application/x-drive-text-editor';

