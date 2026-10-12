/* ------------------------------------------------------------------ *
 *  タブ
 * ------------------------------------------------------------------ */

/**
 * 本文をまだ読んでいないタブの枠を作る。
 * @param {string} fileId
 * @param {string} name 表示名（本文読み込み時に正式な名前で上書きされる）
 * @return {Tab}
 */
function makeTab(fileId, name, kind) {
  return {
    id: fileId,
    name: name || '読み込み中…',
    // 'diff' は比較ビュー、'preview' は Markdown / HTML / drawio のプレビュー、
    // 'term' はターミナル。どれも合成 ID のタブで、Drive 上のファイルに
    // 1 対 1 で対応しない。
    kind: (kind === 'diff' || kind === 'preview' || kind === 'term' || VIEWERS[kind])
      ? kind : 'text',
    /** 仮タブ（シングルクリックで開いた状態）。編集かダブルクリックで固定される。 */
    ephemeral: false,
    pinned: false,
    /** 改行コード。読み込み時に判定し、保存時に復元する。 */
    eol: 'LF',
    indentUnit: 2,
    indentWithTabs: false,
    preview: false,
    mimeType: '',
    size: 0,
    baseUpdatedAtIso: '',
    langKey: null,
    langLabel: '…',
    dirty: false,
    saving: false,
    pendingSave: false,
    saveTimer: null,
    lastSavedAt: null,
    conflicted: false,
    saveError: null,
    loaded: false,
    /**
     * 作成中の一時メモが最初に名乗っていた仮 ID。Drive の ID が決まったあとも、
     * この ID で引けるようにしておく（EditorState に焼き込まれているため）。
     * @type {string|null}
     */
    aliasId: null,
    /** Drive 上にまだ実体が無い（作成の往復を待っている）。保存はここでは走らせない。 */
    creating: false,
    /** 作成に失敗したときの理由。Mod+S で作り直せる。 */
    createError: null,
    /** 本文の生データ（起動時のスナップショット由来）。CM 到着後に hydrateTab で state に変える。 */
    pending: null,
    /** プレビュータブの中身（Preview.create が入れる）。それ以外のタブでは null。 */
    pv: null,
    /** ターミナルタブの中身（Term.create が入れる）。それ以外のタブでは null。 */
    term: null,
    state: null,
    scrollTop: 0,
    /** 一時メモ（tmp にあり保存先が未確定）か。 */
    temp: false
  };
}

/**
 * 一覧のエントリを、種類に応じた開き方で開く。
 * @param {Object} entry listEntries が返すファイル 1 件
 */
async function openEntry(entry, opts = {}) {
  if (!entry || !entry.openable) return;
  Perf.markOpen(entry.id);
  await openFile(entry.id, entry.name, entry.viewer === 'embed' ? entry.kind : 'text', opts);
}

/**
 * ファイルを開く。既に開いていればそのタブへ切り替えるだけ。
 *
 * ephemeral（仮タブ）は VS Code のプレビュータブと同じ挙動。
 * 一覧をシングルクリックで開いた場合、既にある仮タブを置き換えるので
 * 次々にクリックしてもタブが増えない。編集するか、ダブルクリックか、
 * 「エディタで開く」を選ぶと固定される。
 *
 * @param {string} fileId
 * @param {string} [name] 一覧から分かっていれば渡す（読み込み前の表示に使う）
 * @param {string} [kind] 'text' か VIEWERS のキー（pdf / doc / sheet / slide / drawing / media）
 * @param {{ephemeral?:boolean, pane?:string, index?:number}} [opts] index はペインの中の位置（閉じたタブを戻すとき）
 */
async function openFile(fileId, name, kind, opts = {}) {
  // CodeMirror がまだ届いていなければ待つ（ツリーは先に触れるようにしてあるため）。
  try {
    await Editor.load();
  } catch (err) {
    toast('エディタを読み込めていないため開けません: ' + err.message, 'error', 8000);
    return;
  }

  const existing = getTab(fileId);
  if (existing) {
    // すでに開いているものを固定指定で開き直したら固定する。
    if (!opts.ephemeral) existing.ephemeral = false;
    await activateTab(fileId);
    Session.save();
    return;
  }

  const tab = makeTab(fileId, name, kind);
  tab.ephemeral = !!opts.ephemeral;
  // 「一時メモかどうか」は置き場所だけで決まる。ツリー上で tmp の直下に
  // あるものは、どこから開いても一時メモとして扱う。
  const treeNode = Tree.get(fileId);
  tab.temp = !!(treeNode && Tree.isTmpRoot(treeNode.parentId));

  // 開く先は、指定がなければいま操作しているペイン。
  const leaf = (opts.pane && Panes.byId.get(opts.pane)) || Panes.active() || Panes.init();

  if (tab.ephemeral) {
    // 既にある仮タブ（未編集）を置き換える。探すのはこのペインの中だけで、
    // 別のペインで開いているものには手を出さない（VS Code と同じ）。
    // pinned は見ない。ピン留めしたファイルをサイドバーからシングルクリックで
    // 覗いた場合、そのタブは「仮」として開いているので、次のクリックで
    // 入れ替わってよい（外さないと消えない印は、仮タブであることと両立する）。
    const stale = leaf.tabIds.map(getTab).find((t) => t && t.ephemeral && !t.dirty);
    if (stale) {
      const at = leaf.tabIds.indexOf(stale.id);
      await closeTab(stale.id, { force: true, keepDraft: true });
      App.tabs.push(tab);
      // 閉じた位置に差し込むと、タブが飛び回らない。
      Panes.addTab(leaf, tab.id, at);
    } else {
      App.tabs.push(tab);
      Panes.addTab(leaf, tab.id);
    }
  } else {
    App.tabs.push(tab);
    Panes.addTab(leaf, tab.id, opts.index);
  }

  renderTabs();
  await activateTab(fileId);
  Session.save();
}

/**
 * 隣のペインで開く。
 *
 * 同じファイルを 2 枚のペインに出すことはできないので、既に開いている
 * ファイルなら、そのタブがあるペインへ移るだけにする。右にペインが
 * あればそこへ開き、無ければ分割して作る（VS Code の「横に開く」と同じ）。
 * @param {Object} entry 一覧のエントリ
 */
async function openBeside(entry) {
  if (!entry || !entry.openable) return;
  const already = Panes.leafOf(entry.id);
  if (already) {
    Panes.focus(already.id);
    await activateTab(entry.id);
    return;
  }
  const from = Panes.active();
  if (!from) return;

  const leaves = Panes.leaves();
  const next = leaves[leaves.indexOf(from) + 1] || Panes.split(from.id, 'row', true);
  if (!next) return;
  Panes.focus(next.id);
  Perf.markOpen(entry.id);
  await openFile(entry.id, entry.name,
    entry.viewer === 'embed' ? entry.kind : 'text',
    { ephemeral: false, pane: next.id });
}

/**
 * タブの本文を Drive から読む。失敗したらそのタブを閉じる。
 * @param {Tab} tab
 * @return {Promise<boolean>} 読み込めたか
 */
async function loadTabContent(tab) {
  const fileId = tab.id;

  // ビューアで開くものは iframe に URL を入れるだけなので、本文取得は不要。
  if (tab.kind !== 'text') {
    tab.loaded = true;
    return true;
  }

  // 起動時のスナップショットや getBootstrap が本文を同梱していれば、往復せずにそれを使う。
  if (tab.pending) {
    const pending = tab.pending;
    tab.pending = null;
    hydrateTab(tab, pending);
    return true;
  }

  // キャッシュ（閉じたタブ・先読み・保存済み本文）があれば 0ms で出し、裏で更新日時だけ確かめる。
  const { data, revalidate } = Store.readFile(fileId);
  if (data) {
    hydrateTab(tab, data);
    if (revalidate) {
      void revalidate.then((fresh) => { if (fresh) applyFreshContent(fileId, fresh); });
    }
    return true;
  }

  setStatusText('idle', '読み込み中…');
  let fresh;
  try {
    fresh = await revalidate;
  } catch (err) {
    toast('「' + tab.name + '」を開けませんでした: ' + err.message, 'error', 10000);
    await closeTab(fileId, { force: true });
    return false;
  }

  const t = getTab(fileId);
  if (!t) return false;   // 読み込み中に閉じられた

  hydrateTab(t, fresh);
  return true;
}

/**
 * readFile の戻り値をタブに反映する。
 * getBootstrap が本文を同梱してきた場合もここを通る。
 * @param {Tab} tab
 * @param {Object} data readFile の data
 */
function hydrateTab(tab, data) {
  if (data.encoding) TextCodec.remember(tab.id, data.encoding, data.bom, data.broken);
  // 改行コードは元の形式を覚えて \n にそろえる。
  // 以降クライアント側は常に \n で扱い、保存時にだけ戻す。
  tab.eol = detectEol(data.content) || Settings.get('defaultEol');
  const text = normalizeEol(data.content);

  applyDefaultIndent(tab, text);

  tab.name = data.name;
  tab.mimeType = data.mimeType;
  tab.size = data.size;
  tab.baseUpdatedAtIso = data.updatedAtIso;
  tab.langKey = EXT_TO_LANG[extensionOf(data.name)] || null;
  tab.state = Editor.buildState(text, tab.id);
  tab.loaded = true;
  tab.pending = null;
  Store.putContent(data);

  Editor.applyIndent(tab);
  if (TextCodec.isBroken(tab.id)) {
    // buildState が閲覧専用にしている。黙って編集できないと戸惑うので理由を出す。
    toast('「' + tab.name + '」には UTF-8 としても Shift_JIS としても読めない部分があるため、' +
      '閲覧専用で開きました（保存すると読めない部分が壊れるため）。', 'warn', 10000);
  }
  // 言語モードは本文表示のあとに当てる（先に文字を出したいので await しない）。
  void applyLanguageTo(tab.id, tab.langKey);
  // 下書きの復元提案も後追いでよい。
  void maybeRestoreDraft(tab.id, text);
}

/**
 * タブのインデント設定を決める。
 *
 * 既定値は「本文から判定できなかったときに何にするか」を決めるもの。
 * 既存ファイルの字下げを既定値で上書きすると、他人のファイルを開いて
 * 打った瞬間に流儀が混ざるので、判定できた場合はそちらを優先する。
 * 「ファイルから推定する」を切っている場合だけ、常に既定値を使う。
 *
 * @param {Tab} tab
 * @param {string} text 改行を \n にそろえた本文
 */
function applyDefaultIndent(tab, text) {
  const detected = Settings.get('detectIndentation') ? detectIndent(text) : null;
  tab.indentWithTabs = detected ? detected.useTabs : !!Settings.get('defaultIndentWithTabs');
  // スペースの幅はファイルの実体なので判定結果を尊重する。
  // タブの幅は判定できない（size が 0）ので既定値を使う。
  tab.indentUnit = (detected && detected.size) || Settings.get('defaultIndentUnit');
}

/**
 * 保存できていない下書きが残っていれば復元を提案する。
 * @param {string} fileId
 * @param {string} driveContent Drive から読んだ内容
 */
async function maybeRestoreDraft(fileId, driveContent) {
  let draft = Draft.load(fileId);
  // localStorage に無ければ（再読み込みでオリジンが変わった等）、Drive に退避した分を見る。
  if (!draft || typeof draft.content !== 'string') draft = await DraftStash.load(fileId);
  if (!draft || typeof draft.content !== 'string') return;
  if (draft.content === driveContent) {
    if (draft.fromDrive) DraftStash.drop(fileId);   // もう Drive に保存されている
    return;
  }

  const tab = getTab(fileId);
  if (!tab) return;
  // Drive に退避した分を取りに行っている間に、書き始めていることがある。
  const typed = tab.dirty;

  const restore = await modal({
    title: '未保存の下書きが見つかりました',
    body: h('div', {}, [
      h('p', { text: '「' + tab.name + '」には、前回保存できなかった編集内容が残っています（' +
        new Date(draft.at).toLocaleString('ja-JP') + '）。' }),
      h('p', { text: typed
        ? '復元すると、いま入力した内容も含めて置き換えます。破棄すると、残っている下書きは消えます。'
        : '復元すると、いま読み込んだ Drive の内容を置き換えます。' })
    ]),
    actions: [
      { label: '下書きを復元する', value: true, variant: 'primary' },
      { label: typed ? '下書きを破棄して入力を続ける' : '破棄して Drive の内容を使う', value: false }
    ]
  });

  const t = getTab(fileId);
  if (!t) return;
  if (restore) {
    replaceTabDoc(t, draft.content);
    // 下書きは「書いた時点の更新日時」を基準にしている。そのあと別の場所で更新されていれば、
    // いま読んだ日時を基準にすると相手の変更を黙って上書きしてしまうので、下書きの基準に戻して
    // 保存時の競合検出（差分を見る／上書き／読み込み）に乗せる。
    if (draft.baseUpdatedAtIso && draft.baseUpdatedAtIso !== t.baseUpdatedAtIso) {
      t.baseUpdatedAtIso = draft.baseUpdatedAtIso;
    }
    t.dirty = true;
    renderTabs();
    renderTreeStates();
    if (App.activeId === t.id) setStatusText('unsaved', '未保存（下書きを復元）');
    // setState は docChanged を起こさないので、自動保存は明示的に予約する。
    scheduleAutoSave(t.id);
  } else if (typed) {
    // localStorage の下書きはいま入力している内容のものなので残し、退避分だけ消す。
    DraftStash.drop(fileId);
  } else {
    Draft.clear(fileId);
  }
}

/**
 * 言語サポートを読み込んでタブに当てる。
 * @param {string} tabId
 * @param {string|null} langKey
 */
async function applyLanguageTo(tabId, langKey) {
  const { support, label } = await Editor.loadLanguage(langKey);
  const tab = getTab(tabId);
  if (!tab) return;
  tab.langLabel = label;
  Editor.applyLanguage(tab, support);
  // Markdown ↔ HTML と変えたら、開いているプレビューの中身も入れ替える
  // （プレビューできない形式になったらタブごと閉じる）。
  Preview.syncMode(tab.id);
  if (App.activeId === tab.id) {
    updateStatusMeta();
    updatePreviewAvailability();
  }
}

/** タブの本文を丸ごと差し替える（Undo 履歴もリセットされる）。 */
function replaceTabDoc(tab, text) {
  tab.state = Editor.buildState(text, tab.id);
  tab.loaded = true;
  if (App.activeId === tab.id && Editor.view) {
    Editor.view.setState(tab.state);
  }
  if (tab.langKey) void applyLanguageTo(tab.id, tab.langKey);
}

/** Drive から読み直して現在の内容を捨てる。 */
async function reloadTab(tabId) {
  const tab = getTab(tabId);
  if (!tab) return;
  try {
    const data = await Api.readFile(tabId);
    Store.putContent(data);
    const t = getTab(tabId);
    if (!t) return;
    t.name = data.name;
    t.size = data.size;
    t.baseUpdatedAtIso = data.updatedAtIso;
    t.mimeType = data.mimeType;
    t.langKey = EXT_TO_LANG[extensionOf(data.name)] || null;
    t.dirty = false;
    t.conflicted = false;
    t.saveError = null;
    t.lastSavedAt = null;
    // Drive の中身を読み直したので、改行コードとインデントも開いたときと
    // 同じように判定し直す（別の場所で書き換えられている可能性がある）。
    t.eol = detectEol(data.content) || Settings.get('defaultEol');
    const body = normalizeEol(data.content);
    applyDefaultIndent(t, body);
    replaceTabDoc(t, body);
    Editor.applyIndent(t);
    renderTabs();
    renderTreeStates();
    if (App.activeId === tabId) {
      el.sbName.textContent = t.name;
      el.sbSize.textContent = formatBytes(t.size);
      setStatusText('saved', '読み込み完了');
      updateCursorReadout();
    }
  } catch (err) {
    toast(err.message, 'error', 10000);
  }
}

/**
 * タブを表示する。そのタブが載っているペインが操作対象になる。
 * 切り替える前に、そのペインで開いていたタブの state とスクロール位置を保存する。
 * 本文をまだ読んでいないタブ（セッション復元直後）はここで読み込む。
 * @param {string} tabId
 */
async function activateTab(tabId) {
  let tab = getTab(tabId);
  if (!tab) return;
  tabId = tab.id;

  // どのペインにも載っていないタブ（作られた直後）は、いまのペインへ入れる。
  let leaf = Panes.leafOf(tabId) || Panes.active() || Panes.init();
  Panes.addTab(leaf, tabId);

  // ターミナルは EditorView を使わないので、CM の到着を待たない
  // （CDN に届かないときこそ開きたい画面なので、ここで止めない）。
  if (!leaf.view && tab.kind !== 'term') {
    // CM がまだ届いていない（起動直後にツリーから開いたなど）。読み込みを待って View を作る。
    try {
      await Editor.load();
    } catch (err) {
      return;
    }
    tab = getTab(tabId);
    if (!tab) return;
    leaf = Panes.leafOf(tabId) || leaf;
    // 出す本文が分かっているならその state で作る（空で作ってから
    // 差し替えると、そのペインだけレイアウトが 2 回走る）。
    Editor.mount(leaf, tab.kind === 'text' && tab.loaded ? tab.state : null);
  }
  const endSwitch = Perf.start('tab.switch');
  const wasLoaded = tab.loaded;

  // 先にこのペインで開いていたタブの状態を退避してから読み込みに入る
  // （読み込みの待ち時間中にユーザーが編集しても失わないため）。
  // 退避先があるのはテキストのタブだけ。ビューアと比較タブは EditorView を
  // 使っていないので、ここで state を持たせると別のタブの本文が混ざる。
  if (leaf.activeId !== tabId) Panes.stash(leaf);

  if (!tab.loaded) {
    renderTabs();
    const ok = await loadTabContent(tab);
    if (!ok) return;
    tab = getTab(tabId);
    if (!tab) return;
  }

  // 操作対象のペインもここで移す（focus() は描き直しまで面倒を見るが、
  // このあと自分で全部描くので状態だけ合わせる）。
  if (Panes.activeId !== leaf.id) {
    const away = Panes.active();
    if (away) Panes.stash(away);
    Panes.activeId = leaf.id;
    Panes.paint();
  }
  leaf.activeId = tabId;
  el.statusbar.hidden = false;
  el.sbName.textContent = tab.name;
  if (tab.kind === 'text') App.lastTextTabId = tab.id;

  showInPane(leaf, tab);

  renderEditorCrumbs();
  renderTabs();
  if (Views.current === 'history') void History.load();
  renderTreeStates();
  refreshStatus();
  Session.save();
  endSwitch({ loaded: wasLoaded, kind: tab.kind });
}

/**
 * タブの種別にあわせて、そのペインの中身を切り替える。
 * アクティブでないペインを描き直すときにも通る（ステータスバーなど
 * アプリ全体で 1 つしかないものは、アクティブなペインのときだけ触る）。
 * @param {Object} leaf
 * @param {Tab} tab
 */
function showInPane(leaf, tab) {
  leaf.el.emptyState.hidden = true;
  if (tab.kind === 'text') showEditor(leaf, tab);
  else if (tab.kind === 'diff') showDiff(leaf, tab);
  else if (tab.kind === 'preview') showPreview(leaf, tab);
  else if (tab.kind === 'term') showTerm(leaf, tab);
  else showViewer(leaf, tab);
}

/**
 * プレビュータブを表示する。中身はタブが持っていて、ペインへ差し込むだけ。
 * @param {Object} leaf
 * @param {Tab} tab
 */
function showPreview(leaf, tab) {
  const e = leaf.el;
  e.viewerHost.hidden = true;
  e.viewerFrame.src = 'about:blank';
  e.diffHost.hidden = true;
  e.panes.hidden = true;
  e.mdBar.hidden = true;
  e.termHost.hidden = true;
  e.previewHost.hidden = false;
  Preview.mount(leaf, tab);

  if (Panes.active() !== leaf) return;
  el.sbSize.textContent = '';
  updateStatusMeta();
  updatePreviewAvailability();
  refreshStatus();
}

/**
 * 埋め込みビューアで開く種別。本文は扱わず、Drive / Docs が出している
 * プレビュー URL を iframe に入れるだけなので、どれも閲覧専用になる。
 * キーはサーバー側 classifyMeta_ が返す kind と対応している。
 */
const VIEWERS = {
  pdf: {
    label: 'PDF', icon: 'file-pdf', iconClass: 'icon--pdf', linkLabel: 'Drive で開く',
    src: (id) => 'https://drive.google.com/file/d/' + id + '/preview',
    open: (id) => 'https://drive.google.com/file/d/' + id + '/view'
  },
  media: {
    label: 'プレビュー', icon: 'file-image', iconClass: 'icon--file', linkLabel: 'Drive で開く',
    src: (id) => 'https://drive.google.com/file/d/' + id + '/preview',
    open: (id) => 'https://drive.google.com/file/d/' + id + '/view'
  },
  doc: {
    label: 'Google ドキュメント', icon: 'file-text', iconClass: 'icon--file',
    linkLabel: 'ドキュメントで開く',
    src: (id) => 'https://docs.google.com/document/d/' + id + '/preview',
    open: (id) => 'https://docs.google.com/document/d/' + id + '/edit'
  },
  sheet: {
    label: 'Google スプレッドシート', icon: 'file-sheet', iconClass: 'icon--file',
    linkLabel: 'スプレッドシートで開く',
    src: (id) => 'https://docs.google.com/spreadsheets/d/' + id + '/preview',
    open: (id) => 'https://docs.google.com/spreadsheets/d/' + id + '/edit'
  },
  slide: {
    label: 'Google スライド', icon: 'file-slide', iconClass: 'icon--file',
    linkLabel: 'スライドで開く',
    src: (id) => 'https://docs.google.com/presentation/d/' + id + '/preview',
    open: (id) => 'https://docs.google.com/presentation/d/' + id + '/edit'
  },
  drawing: {
    label: 'Google 図形描画', icon: 'file-shapes', iconClass: 'icon--file',
    linkLabel: '図形描画で開く',
    src: (id) => 'https://docs.google.com/drawings/d/' + id + '/preview',
    open: (id) => 'https://docs.google.com/drawings/d/' + id + '/edit'
  }
};

/** テキストタブを表示する。 */
function showEditor(leaf, tab) {
  const e = leaf.el;
  e.viewerHost.hidden = true;
  e.viewerFrame.src = 'about:blank';
  e.diffHost.hidden = true;
  e.previewHost.hidden = true;
  e.termHost.hidden = true;
  e.panes.hidden = false;

  const view = Editor.mount(leaf, tab.state);
  // mount 直後は同じ state が入っているので、無駄な再構築（レイアウト 2 回目）を避ける。
  // state がまだ無い（本文を読んでいない）タブは空のまま置いておき、
  // 読み終わった paintPane / activateTab が入れ直す。
  if (tab.state && view.state !== tab.state) view.setState(tab.state);
  Perf.paintOpen(tab.id);
  // setState 直後は再レイアウト前なのでスクロール位置は次フレームで戻す。
  requestAnimationFrame(() => {
    if (leaf.activeId === tab.id && leaf.view) {
      leaf.view.scrollDOM.scrollTop = tab.scrollTop || 0;
    }
  });

  if (Panes.active() !== leaf) {
    // Markdown の入力バーは 1 組しか中身を描かないので、
    // アクティブでないペインでは畳んでおく。
    e.mdBar.hidden = true;
    return;
  }
  el.sbSize.textContent = formatBytes(tab.size);
  updateCursorReadout();
  updateStatusMeta();
  updatePreviewAvailability();
  view.focus();
}

/**
 * ビューアで開くタブ（PDF・画像・Office・Google ドキュメント類）を表示する。
 * プレビュー URL を iframe に入れるだけで、本文はこちらで扱わない（閲覧専用）。
 * 埋め込みが拒否されることもあるので、別タブで開くリンクを常に出しておく。
 */
function showViewer(leaf, tab) {
  const viewer = VIEWERS[tab.kind] || VIEWERS.media;
  const id = encodeURIComponent(tab.id);
  const e = leaf.el;

  e.panes.hidden = true;
  e.diffHost.hidden = true;
  e.previewHost.hidden = true;
  e.termHost.hidden = true;
  e.mdBar.hidden = true;

  e.viewerName.textContent = tab.name;
  e.viewerKind.textContent = viewer.label;
  e.viewerOpenLink.href = viewer.open(id);
  e.viewerOpenLink.textContent = viewer.linkLabel;
  e.viewerFallback.hidden = true;
  // 同じ URL を入れ直すと読み込み直しになるので、変わったときだけ。
  if (e.viewerFrame.src !== viewer.src(id)) e.viewerFrame.src = viewer.src(id);
  e.viewerHost.hidden = false;

  if (Panes.active() !== leaf) return;
  el.btnPreview.hidden = true;
  el.sbSize.textContent = tab.size ? formatBytes(tab.size) : '';
  updateStatusMeta();
  setStatusText('idle', '—');
}

/**
 * 比較タブを表示する。左右の材料は Diff が持っていて、
 * ペイン（MergeView）はタブごとに 1 つ作って使い回す。
 * @param {Tab} tab
 */
function showDiff(leaf, tab) {
  const e = leaf.el;
  e.viewerHost.hidden = true;
  e.viewerFrame.src = 'about:blank';
  e.panes.hidden = true;
  e.previewHost.hidden = true;
  e.termHost.hidden = true;
  e.mdBar.hidden = true;
  e.diffHost.hidden = false;
  Diff.mount(leaf, tab);

  if (Panes.active() !== leaf) return;
  el.btnPreview.hidden = true;
  el.sbSize.textContent = '';
  updateStatusMeta();
  refreshStatus();
}

