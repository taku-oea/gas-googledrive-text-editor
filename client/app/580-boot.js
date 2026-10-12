/* ------------------------------------------------------------------ *
 *  起動
 * ------------------------------------------------------------------ */

async function boot() {
  if (App.booting) return;
  App.booting = true;
  try {
    await bootOnce();
  } finally {
    App.booting = false;
  }
}

/**
 * 起動の進み具合。
 *
 * 以前は getBootstrap（サーバー往復）と CodeMirror（CDN）の両方が揃うまで
 * 何も描かなかった。いまは 3 つの材料を別々に受け取り、揃った順に描く。
 *   - スナップショット（doGet が HTML に埋めた前回の状態）… モジュール評価直後に同期で描く
 *   - getBootstrap の応答 … 届いたらスナップショットとの差分だけ描き直す
 *   - CodeMirror … 届いたら、表示するタブの本文で EditorView を 1 回だけ作る
 */
const Boot = {
  snapshot: null,     // 適用済みスナップショット（getBootstrap と同じ形）
  bootstrap: null,    // 届いた getBootstrap の応答
  wantActiveId: null, // セッション上のアクティブタブ
  mounted: false,     // EditorView を作って最初のタブを出したか
  treePainted: false,
  bootLogged: false,
  ready: null,        // getBootstrap が届いた（または諦めた）ときに解決する Promise
  _ready: null
};

/** doGet が埋め込んだスナップショットを取り出す（1 回だけ。GC できるように window から外す）。 */
const Snapshot = {
  take() {
    const s = window.__BOOT;
    window.__BOOT = null;
    if (!(s && s.v === 1 && s.config && Array.isArray(s.roots) && s.roots.length)) return null;
    Session.preferLocal(s);
    // 直接 API で保存した本文はサーバーのスナップショットに載らないので、
    // このブラウザに残した保存済み本文のほうが新しければそれを使う。
    // 文字コード判定より前のスナップショットは、Shift_JIS を UTF-8 として読んで化けている
    // ことがある。そのまま出すと、編集した時点で化けた本文を保存してしまう。
    if (s.activeFile && !s.activeFile.encoding && String(s.activeFile.content || '').indexOf('\ufffd') >= 0) {
      s.activeFile = null;
    }
    const activeId = s.session && s.session.activeId;
    if (activeId) {
      const local = LocalSnap.get(activeId);
      if (local && (!s.activeFile || local.updatedAtIso > s.activeFile.updatedAtIso)) {
        s.activeFile = Object.assign({}, local, { unchanged: false, fromCache: true });
      }
    }
    return s;
  }
};

async function bootOnce() {
  el.bootError.hidden = true;
  el.btnBootRetry.hidden = true;
  el.bootOverlay.hidden = true;
  const t0 = Date.now();
  Perf.mark('boot-start');
  if (!Boot.ready) Boot.ready = new Promise((resolve) => { Boot._ready = resolve; });

  // サーバー往復と CDN 取得は互いに独立なので同時に走らせ、どちらも待たずに先へ進む。
  const bootP = takeBootstrapPromise().then((d) => { Perf.mark('bootstrap-resolved'); return d; });
  const cmP = Editor.load().then(
    () => { Perf.mark('cm-ready'); showActiveIfPossible(); },
    (err) => { showVendorError(err); }
  );

  // 前回の状態が HTML に埋まっていれば、サーバーを待たずにここで描く（同期）。
  if (!Boot.snapshot) {
    const snap = Snapshot.take();
    if (snap) {
      Boot.snapshot = snap;
      applyBootstrap(snap, { snapshot: true });
      Perf.mark('snapshot-painted');
      showActiveIfPossible();
    } else {
      setStatusText('idle', '読み込み中…');
    }
  }

  let data;
  try {
    data = await bootP;
  } catch (err) {
    onBootstrapFailed(err, !!Boot.snapshot);
    if (Boot._ready) Boot._ready();
    return;
  }
  if (!Boot.bootLogged) {
    Boot.bootLogged = true;
    console.log('[perf] boot: サーバー往復 ' + (Date.now() - t0) + 'ms' +
      (Boot.snapshot ? '（スナップショットで先に描画済み）' : ''));
  }
  Boot.bootstrap = data;
  Session.preferLocal(data);
  applyBackend(data);
  if (Boot._ready) Boot._ready();
  if (Boot.snapshot) reconcile(Boot.snapshot, data);
  else applyBootstrap(data, { snapshot: false });
  showActiveIfPossible();
  FileIndex.warmUp();
  void ChangeFeed.start();
  void DraftStash.sync();
  Draft.sweep();

  // CM の失敗は showVendorError が表示済み。ここでは待つだけ。
  await cmP.catch(() => { /* 表示済み */ });
}

/**
 * getBootstrap（またはスナップショット）の内容を画面に反映する。await を含まない。
 * @param {Object} data getBootstrap の data と同じ形
 * @param {{snapshot:boolean}} opts snapshot=true なら「前回の状態」なので警告類は出さない
 */
function applyBootstrap(data, opts) {
  const snapshot = !!(opts && opts.snapshot);
  App.config = data.config;
  App.user = data.user || { email: '' };
  App.roots = data.roots || [];
  App.tmpParent = data.tmpParent || null;
  App.lastSaveFolder = data.lastSaveFolder || null;
  Settings.init(data.settings, data.config.defaultSettings);
  // ピン留めはファイル ID だけで開けるので、ルートの有無に関係なく先に入れる。
  Pins.init(data.pins);
  el.userEmail.textContent = App.user.email || '';
  renderRootsSummary();
  Views.restore(data.session);

  if (!App.roots.length) {
    // 初回、または保存済みフォルダが全部開けなくなった場合。
    Tree.reset([]);
    renderTree();
    renderTabs();
    Layout.restore(data.session);
    if (!snapshot) {
      Perf.finishBoot();
      Picker.open((data.rootErrors || []).length
        ? '前回のフォルダを開けませんでした。追加し直してください。'
        : null);
    }
    return;
  }

  Tree.reset(App.roots);
  // 一時メモのセクション。tmp フォルダを一度でも使っていれば ID が返ってくる
  // （まだなら、実際に使うまでフォルダを作らない）。
  if (data.tmpFolderId) TempMemo.adopt({ id: data.tmpFolderId, name: 'tmp' });
  App.selectedId = App.roots[0].id;

  // ルートと展開済みフォルダの中身は folderEntries にまとめて入ってくる。
  if (data.folderEntries) ingestFolderEntries(data.session, data.folderEntries);
  else if (!snapshot) void fetchTreeFallback(data.session);
  restoreTabShells(data.session, data.activeFile);
  // セッションにも tab.pinned が入っているが、正はピン留めの一覧の方。
  Pins.sync();

  // DOM への書き込みをまとめてから、Layout.restore が幅を 1 回だけ実測する。
  renderTree();
  renderTabs();
  Layout.restore(data.session);
  if (!Boot.treePainted) { Boot.treePainted = true; Perf.mark('tree-painted'); }

  if (!snapshot) {
    // 開けなくなったルートがあれば知らせる（残りのルートで作業は続けられる）。
    for (const bad of data.rootErrors || []) {
      toast('「' + (bad.name || bad.id) + '」を開けませんでした: ' + bad.error, 'warn', 12000);
    }
  }
}

/**
 * listEntriesMulti 形式の一覧をツリーへ取り込む。
 * 親から順に取り込まないと子ノードが存在せず ingest が空振りするので、
 * 取り込めなかったぶんは次のパスで拾い、変化が無くなるまで繰り返す。
 */
function ingestFolderEntries(session, multi) {
  const expanded = (session && Array.isArray(session.expanded)) ? session.expanded : [];
  const expandedSet = new Set(expanded);
  const pending = new Map(Object.entries(multi || {}));
  for (let pass = 0; pass < 8 && pending.size; pass++) {
    let progressed = false;
    for (const [folderId, data] of Array.from(pending)) {
      const node = Tree.get(folderId);
      if (!node) continue;
      // ルートは畳んだ状態も覚えている。セッションに展開情報があるなら従う。
      if (Tree.isRoot(folderId)) {
        if (expanded.length) node.expanded = expandedSet.has(folderId);
      } else {
        node.expanded = true;
      }
      Tree.ingest(folderId, data);
      pending.delete(folderId);
      progressed = true;
    }
    if (!progressed) break;   // 親が消えている等。残りは諦める
  }
}

/** getBootstrap が一覧を同梱してこなかった場合の予備（1 往復増える）。 */
async function fetchTreeFallback(session) {
  const expanded = (session && Array.isArray(session.expanded)) ? session.expanded : [];
  const wanted = Tree.rootIds.concat(expanded.filter((id) => !Tree.isRoot(id)));
  if (!wanted.length) return;
  try {
    const multi = await Api.listEntriesMulti(wanted);
    ingestFolderEntries(session, multi);
    renderTree();
  } catch (err) {
    console.warn('ツリーの復元に失敗しました: ' + err.message);
  }
}

/**
 * 前回開いていたタブの枠を並べる。本文は読まない（アクティブなタブの本文が
 * 同梱されていれば pending に置き、CM が届いた時点で state にする）。
 */
function restoreTabShells(session, activeFile) {
  if (session && Array.isArray(session.tabs)) {
    for (const t of session.tabs) {
      // getTab で既存タブと突き合わせる。再実行や reconcile で二重に積まない。
      if (!t || !t.id || t.kind === 'preview' || getTab(t.id)) continue;
      // ターミナルは Drive 上に実体が無いので、本文の読み込みも言語判定も要らない。
      if (t.kind === 'term') { restoreTermTab(t); continue; }
      const tab = makeTab(t.id, t.name, t.kind);
      // 本文を読む前でも形式が分かるように、拡張子から言語を仮置きする
      // （プレビューを戻すのに要る。正しい値は hydrateTab が入れ直す）。
      tab.langKey = EXT_TO_LANG[extensionOf(t.name || '')] || null;
      tab.pinned = !!t.pinned;
      tab.temp = !!t.temp;
      App.tabs.push(tab);
    }
    // プレビュータブは元のファイルのタブが要るので、全部並べてから作る。
    for (const t of session.tabs) {
      if (!t || !t.id || t.kind !== 'preview') continue;
      const src = getTab(t.id);
      if (!src || getTab(Preview.idFor(t.id))) continue;
      const mode = Preview.mode(src);
      if (!mode) continue;
      const tab = makeTab(Preview.idFor(t.id), src.name, 'preview');
      tab.pv = Preview.create(tab, src, mode);
      App.tabs.push(tab);
    }
  }
  restorePanes(session);

  if (!Boot.wantActiveId) {
    Boot.wantActiveId = (session && session.activeId) || (App.tabs[0] && App.tabs[0].id) || null;
  }
  if (activeFile) {
    Store.putContent(activeFile);
    const t = getTab(activeFile.id);
    if (t && t.kind === 'text' && !t.loaded) t.pending = activeFile;
  }
}

/**
 * セッションのペイン構成を戻す。
 *
 * 復元するのは「どのタブがどのペインに載っていたか」だけで、本文は載せない。
 * 記録が無い・壊れているときはこれまでどおり 1 枚で始める。スナップショットの
 * あとに getBootstrap で 2 回目が来るが、そのときは作り直さない
 * （待っている間にユーザーが分割やタブの移動をしている可能性があるため）。
 * @param {Object|null} session
 */
function restorePanes(session) {
  // 起動時に 1 枚だけ用意してある空のペインは、記録どおりに組み直してよい。
  // すでにタブが載っている・ビューを作ってあるなら、待っている間にユーザーが
  // 何かを開いたということなので触らない。
  const untouched = !Panes.root ||
    (Panes.root.type === 'leaf' && !Panes.root.tabIds.length && !Panes.root.view);
  if (untouched) {
    const known = new Set(App.tabs.map((t) => t.id));
    const placed = new Set();
    // 同じタブが 2 つのペインに書かれていても、載せるのは最初の 1 つだけ。
    const keep = (id) => {
      if (!known.has(id) || placed.has(id)) return false;
      placed.add(id);
      return true;
    };
    if (!(session && session.panes && Panes.restore(session.panes, keep))) Panes.init();
  }

  // どのペインにも載っていないタブは、最初のペインの末尾へ回す
  // （記録が無い・壊れていた・2 回目でタブだけ増えた、のいずれも）。
  const first = Panes.leaves()[0] || Panes.init();
  for (const tab of App.tabs) {
    if (!Panes.leafOf(tab.id)) Panes.addTab(first, tab.id);
  }
  for (const leaf of Panes.leaves()) {
    if (!leaf.activeId) leaf.activeId = leaf.tabIds[0] || null;
  }
}

/**
 * CM とデータの両方が揃っていれば、表示するタブの本文で EditorView を作って出す。
 * cm-ready・スナップショット適用・getBootstrap 到着のそれぞれから呼ばれ、最初に条件が揃った 1 回だけ動く。
 */
function showActiveIfPossible() {
  if (!Editor.cm || Boot.mounted) return;
  if (!Boot.snapshot && !Boot.bootstrap) return;   // データがまだ無い
  Boot.mounted = true;

  // 起動中にユーザーが自分でファイルを開いていたら、そちらを優先してもう触らない。
  // セッションから戻したペインにも「表示する予定のタブ」は入っているので、
  // App.activeId だけでは区別がつかない。実際に View を作ったかどうかで見る。
  if (App.editorReady && App.activeId) {
    Perf.finishBoot();
    Store.prefetchTabs();
    return;
  }
  const tab = Boot.wantActiveId ? getTab(Boot.wantActiveId) : null;
  if (tab && tab.kind === 'text' && tab.pending && !tab.loaded) {
    hydrateTab(tab, tab.pending);
  }
  // 最初に出すタブが載っているペインを先にアクティブにしてから View を作る。
  // その state で作れば、起動時のレイアウトが 1 回で済む。
  const leaf = (tab && Panes.leafOf(tab.id)) || Panes.active() || Panes.init();
  Panes.activeId = leaf.id;
  Panes.paint();
  Editor.mount(leaf, tab && tab.kind === 'text' && tab.loaded ? tab.state : null);
  if (!App.tabs.length) {
    showEmptyState();
    Perf.finishBoot();
    return;
  }
  void restoreActive();
}

/**
 * 開けるタブが見つかるまで順に試す（削除済み・権限が外れたファイルは activateTab が閉じる）。
 * 全滅したら空の状態で終わる。
 */
async function restoreActive() {
  const order = App.tabs.map((t) => t.id);
  if (Boot.wantActiveId) order.unshift(Boot.wantActiveId);
  for (const id of order) {
    if (!getTab(id)) continue;         // すでに失敗して閉じられた
    await activateTab(id);
    if (App.activeId) {
      Perf.finishBoot();
      Store.prefetchTabs();
      void paintOtherPanes();
      return;
    }
  }
  showEmptyState();
  Perf.finishBoot();
  void paintOtherPanes();
}

/**
 * アクティブでないペインの中身を、起動を終えたあとに順に埋める。
 *
 * 起動時のスナップショットには最初に出すファイル 1 件の本文しか入っていない
 * （全ペインぶん入れると HTML が膨らんで、その場で描ける速さが落ちる）。
 * 残りはここで readFile して、読めたペインから順に出す。
 */
async function paintOtherPanes() {
  for (const leaf of Panes.leaves()) {
    if (leaf === Panes.active()) continue;
    await paintPane(leaf);
  }
}

/**
 * ペインの表示中タブを、アクティブなペインを動かさずに描く。
 * @param {Object} leaf
 */
async function paintPane(leaf) {
  const tab = getTab(leaf.activeId);
  if (!tab) { showEmptyPane(leaf); return; }
  if (!leaf.view && Editor.cm) Editor.mount(leaf, null);
  if (!tab.loaded) {
    const ok = await loadTabContent(tab);
    // 読めなかったタブは closeTab 済み。ペインごと畳まれていることもある。
    if (!ok || !Panes.byId.has(leaf.id) || leaf.activeId !== tab.id) return;
  }
  showInPane(leaf, tab);
  renderPaneTabs(leaf);
  renderPaneCrumbs(leaf);
}

/**
 * スナップショットで描いた画面を、届いた getBootstrap の内容と突き合わせる。
 * 変わったところだけ描き直す。編集中のタブの本文には触らない（保存時の競合検出に任せる）。
 */
function reconcile(snap, fresh) {
  const ids = (xs) => (xs || []).map((r) => r.id).join(',');
  if (ids(fresh.roots) !== ids(snap.roots)) {
    // ルート構成が変わった（別端末で追加・削除した等、稀）。丸ごと描き直す。
    applyBootstrap(fresh, { snapshot: false });
    return;
  }

  App.config = fresh.config;
  App.user = fresh.user || App.user;
  App.tmpParent = fresh.tmpParent || null;
  App.lastSaveFolder = fresh.lastSaveFolder || null;
  el.userEmail.textContent = (App.user && App.user.email) || '';

  let treeDirty = false;
  for (const r of fresh.roots) {
    const node = Tree.get(r.id);
    if (node && node.name !== r.name) { node.name = r.name; treeDirty = true; }
  }
  App.roots = fresh.roots;
  renderRootsSummary();

  if (JSON.stringify(fresh.settings) !== JSON.stringify(snap.settings)) {
    Settings.init(fresh.settings, fresh.config.defaultSettings);
  }
  if (fresh.tmpFolderId && fresh.tmpFolderId !== snap.tmpFolderId) {
    TempMemo.adopt({ id: fresh.tmpFolderId, name: 'tmp' });
    treeDirty = true;
  }

  // 別の端末でピン留めを変えていれば、そちらに合わせる。
  // ただしこの 1 往復のあいだにユーザーが触っていたら、こちらの方が新しいので残す。
  if (!Pins.touched &&
      JSON.stringify(fresh.pins || null) !== JSON.stringify(snap.pins || null)) {
    Pins.init(fresh.pins);
    treeDirty = true;
  }

  // フォルダ単位で署名を比べ、変わったものだけ取り込む。
  const snapEntries = snap.folderEntries || {};
  const changed = {};
  for (const [fid, listing] of Object.entries(fresh.folderEntries || {})) {
    if (folderSig(listing) === folderSig(snapEntries[fid])) continue;
    changed[fid] = listing;
    treeDirty = true;
  }
  if (Object.keys(changed).length) ingestFolderEntries(fresh.session, changed);
  if (treeDirty) renderTree();

  // 別端末で開いたタブがあれば足す（閉じたものはこちらでは消さない）。
  const before = App.tabs.length;
  restoreTabShells(fresh.session, null);
  if (App.tabs.length !== before) { Pins.sync(); renderTabs(); }

  const af = fresh.activeFile;
  const tab = af && getTab(af.id);
  if (af) Store.putContent(af);
  if (tab && tab.kind === 'text') {
    if (!tab.loaded) {
      tab.pending = af;   // まだ表示前なら新しい方を使う
    } else if (af.updatedAtIso !== tab.baseUpdatedAtIso) {
      if (tab.dirty || tab.saving) {
        toast('このファイルは Drive 側で更新されています。保存時に確認します。', 'warn', 8000);
      } else {
        Editor.replaceDocKeepView(tab, af);
      }
    }
  }

  for (const bad of fresh.rootErrors || []) {
    toast('「' + (bad.name || bad.id) + '」を開けませんでした: ' + bad.error, 'warn', 12000);
  }
}

/** getBootstrap が失敗したとき。スナップショットで描けていれば操作は続けさせる。 */
function onBootstrapFailed(err, hadSnapshot) {
  const msg = (err && err.message) ? err.message : String(err);
  console.error(err);
  if (hadSnapshot) {
    toast('最新の状態を取得できませんでした（前回の内容を表示しています）: ' + msg, 'error', 12000);
    setStatusText('error', '再接続できません');
    return;
  }
  el.bootMessage.textContent = '起動に失敗しました';
  el.bootError.hidden = false;
  el.bootError.textContent = msg;
  el.btnBootRetry.hidden = false;
  el.bootOverlay.hidden = false;
}

/** CodeMirror が読めなかったとき。編集自体ができないので、原因を出して再試行させる。 */
function showVendorError(err) {
  console.error(err);
  el.bootMessage.textContent = 'エディタの読み込みに失敗しました';
  el.bootError.hidden = false;
  el.bootError.textContent =
    'CodeMirror などのライブラリを取得できませんでした。\n' +
    'ライブラリの配信元に届かないか、中身が改ざん検査（SRI）に通らなかった可能性があります。\n\n' +
    String(err && err.message ? err.message : err);
  el.btnBootRetry.hidden = false;
  el.bootOverlay.hidden = false;
}

