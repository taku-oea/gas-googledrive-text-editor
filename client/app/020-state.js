/* ------------------------------------------------------------------ *
 *  アプリ状態
 * ------------------------------------------------------------------ */

/**
 * タブ 1 枚。EditorState をタブごとに持つので、Undo 履歴・カーソル・
 * 折りたたみ状態がタブを切り替えても保たれる。
 *
 * @typedef {{
 *   id: string, name: string, mimeType: string, size: number,
 *   baseUpdatedAtIso: string, langKey: (string|null), langLabel: string,
 *   dirty: boolean, saving: boolean, pendingSave: boolean,
 *   saveTimer: (number|null), lastSavedAt: (Date|null),
 *   conflicted: boolean, saveError: (string|null),
 *   loaded: boolean, state: (Object|null), scrollTop: number,
 *   temp: boolean
 * }} Tab
 *
 * loaded=false は「枠だけ存在して本文をまだ読んでいない」状態。
 * リロード後のセッション復元で、アクティブでないタブはこの状態から始まり、
 * 切り替えられた瞬間に readFile する。起動時の往復を 1 回に抑えるため。
 *
 * temp=true は一時メモ（tmp フォルダにあり、保存先がまだ決まっていない）。
 * ファイルとしては普通の Drive ファイルなので、自動保存も競合検出も
 * 通常のタブと同じ経路を通る。違うのは Cmd/Ctrl+S の意味だけで、
 * 一時メモでは「保存先を決めて確定する」になる（TempMemo.promote）。
 */

const App = {
  config: { maxFileSizeBytes: 5 * 1024 * 1024 },
  user: null,

  /**
   * 一時メモを置く tmp フォルダ。{id, name}。
   * 起動時点では ID しか分からないことがある（実体はまだ作っていない）。
   * @type {{id:string, name:string}|null}
   */
  tmpFolder: null,
  /**
   * 一時メモを置く「親」フォルダ。実体はこの下の <アプリ名> / tmp。
   * null なら既定（マイドライブ直下）。名前も持っているので、
   * Drive を触らずに置き場所のパスを描ける。
   * @type {{id:string, name:string}|null}
   */
  tmpParent: null,
  /** 一時メモの保存先として前回選んだフォルダ。保存ダイアログの初期値。 */
  lastSaveFolder: null,

  /** @type {Array<{id:string, name:string}>} ツリーの最上位に並べるフォルダ */
  roots: [],
  filter: '',
  selectedId: null,     // ツリーのフォーカス行（キーボードカーソル）
  /** @type {Set<string>} ツリーで選択中のノード。複数選択に対応する。 */
  selection: new Set(),
  clipboard: null,      // コピー中のファイル { id, name, kind }
  dragId: null,         // ドラッグ中のツリーノード ID
  /**
   * ツリー内でのインライン編集。
   * { mode:'rename'|'newFile'|'newFolder', nodeId, parentId }
   * VS Code は行の上で直接編集するので、モーダルを出さない。
   */
  inlineEdit: null,
  dragTabId: null,      // ドラッグ中のタブ ID
  dragPinId: null,      // ドラッグ中のピン留め（セクション内の並べ替え用）

  /**
   * 開いているタブの実体。並び順はペインが持つので（leaf.tabIds）、
   * こちらは「どのタブが存在するか」の集合として扱う。
   * @type {Tab[]}
   */
  tabs: [],
  // activeId は「アクティブなペインの表示中タブ」への getter。Panes の下で定義する。

  editorReady: false,
  booting: false,

  /**
   * 最後に表示していたテキストのタブ。ターミナルの % / %sel が指す先で、
   * ターミナルにフォーカスを移しても「さっきまで編集していたファイル」を
   * 指し続けられるように別に覚えておく。
   * @type {string|null}
   */
  lastTextTabId: null
};

