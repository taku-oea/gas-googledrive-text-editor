/* ------------------------------------------------------------------ *
 *  ペインの木（エディタの分割）
 *
 *  leaf（葉）が 1 枚ぶんのエディタ領域で、split（枝）がその入れ子の分割。
 *  VS Code と同じで、同じ向きの分割が続くときは枝を深くせず 1 つの枝に
 *  並べる（左右に 3 枚置いても木の深さは 1 のまま）。
 *
 *  同じファイルを 2 枚のペインに出すことはできない。タブは常にどこか 1 つの
 *  leaf にだけ属するので、EditorState はこれまでどおりタブが 1 つ持てば足りる。
 *  「1 つの文書を複数のビューで共有して同期する」必要が無いぶん、状態の持ち方は
 *  分割していなかった頃とほとんど変わらない。
 *
 *  タブバー・パンくず・ビューア・比較ビューは leaf ごとに 1 組ずつ持つ。
 *  ステータスバーとプレビューはアプリ全体で 1 つのままで、前者はアクティブな
 *  ペインを映し、後者は開いたペインの中へ move する。
 *
 *  木の形の操作（並べる・差し込む・畳む・保存と復元）は client/lib/pane-tree.js の
 *  純粋な関数に任せ、ここではノードの DOM を作る・組む・消すことと、フォーカスや
 *  セッションの保存といった画面側の後始末だけを行う。
 * ------------------------------------------------------------------ */

const Panes = {
  /** 同時に開けるペインの上限。 */
  MAX: 6,
  /** ペインの最小の大きさ（px）。境目をドラッグしてもこれ以下には縮めない。 */
  MIN_PX: 120,

  /** @type {Object|null} 木のルート（leaf か split） */
  root: null,
  /** @type {string|null} 操作対象のペイン */
  activeId: null,
  /** @type {Map<string, Object>} id からノードを引く */
  byId: new Map(),
  _seq: 0,

  newId() { return 'pane' + (++Panes._seq); },

  /** 最初の 1 枚を作る。2 回目以降は何もしない。 */
  init() {
    if (Panes.root) return Panes.root;
    const leaf = Panes.createLeaf();
    Panes.root = leaf;
    Panes.activeId = leaf.id;
    Panes.layout();
    return leaf;
  },

  /** ひな型から 1 枚ぶんの DOM を作る。 */
  createLeaf() {
    const tpl = document.getElementById('tplPaneLeaf');
    const root = tpl.content.firstElementChild.cloneNode(true);
    const map = {};
    for (const node of root.querySelectorAll('[data-el]')) map[node.dataset.el] = node;

    const leaf = {
      id: Panes.newId(),
      type: 'leaf',
      parent: null,
      /** @type {Array<string>} このペインに並ぶタブ（この順で描く） */
      tabIds: [],
      /** @type {string|null} このペインで表示しているタブ */
      activeId: null,
      /** @type {Object|null} このペインの EditorView */
      view: null,
      /** 兄弟との取り分（flex-grow）。合計がいくつでも構わない。 */
      size: 1,
      root,
      el: map
    };
    root.dataset.paneId = leaf.id;

    // どこを押してもそのペインが操作対象になる（VS Code と同じ）。
    // capture で拾うのは、タブやエディタ側で止められる前に効かせるため。
    root.addEventListener('mousedown', () => Panes.focus(leaf.id), true);
    root.addEventListener('focusin', () => Panes.focus(leaf.id));

    wirePaneDrop(leaf);
    Panes.byId.set(leaf.id, leaf);
    return leaf;
  },

  active() { return Panes.byId.get(Panes.activeId) || null; },

  /** 木を左上から順に辿って leaf を並べる。 */
  leaves(from) { return paneLeaves(from || Panes.root); },

  /** 分割しているか（2 枚以上あるか）。 */
  isSplit() { return Panes.leaves().length > 1; },

  /** タブが載っているペイン。 */
  leafOf(tabId) { return paneLeafOf(Panes.root, tabId); },

  /** そのタブがいま画面に出ているか（載っているペインの表示中タブか）。 */
  isVisible(tabId) {
    const leaf = Panes.leafOf(tabId);
    return !!leaf && leaf.activeId === tabId;
  },

  /**
   * そのタブを表示している EditorView。出ていなければ null。
   *
   * 分割前は「アクティブなタブか」を見て Editor.view を触っていたが、
   * 別のペインで表示中のタブにも効かせる必要があるのでこちらに寄せる。
   * @param {string} tabId
   * @return {Object|null}
   */
  viewOf(tabId) {
    const leaf = Panes.leafOf(tabId);
    return (leaf && leaf.activeId === tabId) ? leaf.view : null;
  },

  /** タブをペインに足す。index を省くと末尾。 */
  addTab(leaf, tabId, index) { paneAddTab(leaf, tabId, index); },

  /** タブをペインから外す。表示中だったら隣のタブに送る。 */
  removeTab(tabId) { return paneRemoveTab(Panes.root, tabId); },

  /**
   * 操作対象のペインを変える。表示しているタブはどちらも変えない。
   * @param {string} leafId
   */
  focus(leafId) {
    if (!Panes.byId.has(leafId) || Panes.activeId === leafId) return;
    // 離れるペインの編集中の状態を、そのタブへ書き戻しておく。
    const prev = Panes.active();
    if (prev) Panes.stash(prev);
    Panes.activeId = leafId;
    Panes.paint();
    onActivePaneChanged();
  },

  /** ペインの表示中タブへ、いまの state とスクロール位置を書き戻す。 */
  stash(leaf) {
    if (!leaf || !leaf.view || !leaf.activeId) return;
    const tab = getTab(leaf.activeId);
    if (!tab || tab.kind !== 'text' || !tab.loaded) return;
    tab.state = leaf.view.state;
    tab.scrollTop = leaf.view.scrollDOM.scrollTop;
  },

  /**
   * ペインを分割して、新しい空のペインを作る。
   *
   * 同じファイルを 2 枚に出せない（＝分割しても中身は複製されない）ので、
   * ここで作るのは常に空のペインになる。何を開くかは呼び出し側が決める。
   *
   * @param {string} leafId 分割元
   * @param {'row'|'col'} dir row=左右, col=上下
   * @param {boolean} [after] true（既定）なら右／下に作る
   * @return {Object|null} 作った leaf
   */
  split(leafId, dir, after) {
    const leaf = Panes.byId.get(leafId);
    if (!leaf || leaf.type !== 'leaf') return null;
    if (Panes.leaves().length >= Panes.MAX) {
      toast('ペインは ' + Panes.MAX + ' 枚までです', 'info', 3000);
      return null;
    }
    if (after === undefined) after = true;

    const fresh = Panes.createLeaf();
    Panes.root = paneInsertBeside(Panes.root, leaf, fresh, dir, after, Panes.createSplit);

    Panes.layout();
    Panes.focus(fresh.id);
    Session.save();
    return fresh;
  },

  /**
   * 木全体を分割して、いちばん外側に新しいペインを作る。
   *
   * 普通の split はそのペインの中を割るので、たとえば左右に 3 列並べたあとで
   * 「下に全幅の段」を作ることができない（左列の中にしか作れない）。
   * 外周に落としたときだけこちらを通し、木の根に対して割る。
   *
   * @param {'row'|'col'} dir row=左右に足す, col=上下に足す
   * @param {boolean} after true なら右／下、false なら左／上
   * @return {Object|null} 作った leaf
   */
  splitRoot(dir, after) {
    if (!Panes.root) return null;
    if (Panes.leaves().length >= Panes.MAX) {
      toast('ペインは ' + Panes.MAX + ' 枚までです', 'info', 3000);
      return null;
    }
    const fresh = Panes.createLeaf();
    Panes.root = paneInsertOutside(Panes.root, fresh, dir, after, Panes.createSplit);

    Panes.layout();
    Panes.focus(fresh.id);
    Session.save();
    return fresh;
  },

  /** 枝を 1 つ作る。 */
  createSplit(dir, parent, size) {
    const node = {
      id: Panes.newId(),
      type: 'split',
      parent: parent || null,
      dir: dir === 'col' ? 'col' : 'row',
      children: [],
      size: size > 0 ? size : 1,
      root: h('div', { class: 'paneNode' }),
      /** 子と子の間の境目。掴んでいる最中に作り直さないよう使い回す。 */
      sashes: []
    };
    Panes.byId.set(node.id, node);
    return node;
  },

  /**
   * ペインを閉じる。中のタブを先に閉じるので、未保存があれば確認が出る。
   * 最後の 1 枚は閉じない（空のペインとして残す）。
   * @param {string} leafId
   * @param {{force?:boolean}} [opts]
   * @return {Promise<boolean>} 実際に閉じたか
   */
  async close(leafId, opts) {
    const leaf = Panes.byId.get(leafId);
    if (!leaf || leaf.type !== 'leaf' || !Panes.isSplit()) return false;

    for (const id of leaf.tabIds.slice()) {
      const ok = await closeTab(id, opts || {});
      if (!ok) return false;         // 途中でキャンセルされたらペインごと残す
    }
    // 最後のタブを閉じた時点で畳まれていることがある。
    if (Panes.byId.has(leafId)) Panes.drop(leaf);
    return true;
  },

  /** ペインを木から外して畳む（中のタブはもう無い前提）。 */
  drop(leaf) {
    if (!leaf.parent) return;               // 最後の 1 枚は残す
    if (leaf.view) { leaf.view.destroy(); leaf.view = null; }
    // 子が 1 つだけになった枝は、その子を自分の位置へ繰り上げて消す（pane-tree.js）。
    const res = paneDetach(Panes.root, leaf);
    Panes.root = res.root;
    Panes.byId.delete(leaf.id);
    leaf.root.remove();
    if (res.collapsed) {
      Panes.byId.delete(res.collapsed.id);
      res.collapsed.root.remove();
    }

    if (!Panes.byId.has(Panes.activeId)) {
      const next = Panes.leaves()[0];
      Panes.activeId = next ? next.id : null;
    }
    Panes.layout();
    onActivePaneChanged();
    Session.save();
  },

  /**
   * 木の形どおりに DOM を組み直す。
   *
   * 既にその位置にある要素は動かさない。ビューアや HTML プレビューの iframe は
   * DOM から外して入れ直すと読み込み直しになるので、分割で親が変わるペイン以外は
   * 触らないようにしている。
   */
  layout() {
    if (!Panes.root) return;
    Panes.sync(el.paneRoot, [Panes.build(Panes.root)]);
    el.paneRoot.classList.toggle('paneRoot--split', Panes.isSplit());
    Panes.paint();
    // 幅が変わっても window の resize は起きないので、測り直しを促しておく。
    for (const leaf of Panes.leaves()) {
      if (leaf.view) leaf.view.requestMeasure();
    }
    Diff.remeasureActive();
  },

  /** ノードの DOM を整えて返す（枝なら中身も再帰的に組む）。 */
  build(node) {
    node.root.style.flex = node.size + ' 1 0%';
    if (node.type === 'leaf') return node.root;

    node.root.className = 'paneNode paneNode--' + node.dir;
    const wanted = [];
    node.children.forEach((child, i) => {
      if (i > 0) wanted.push(Panes.sashFor(node, i - 1));
      wanted.push(Panes.build(child));
    });
    Panes.sync(node.root, wanted);
    return node.root;
  },

  /** 親の子要素を wanted の並びに合わせる。既にその位置にあるものは触らない。 */
  sync(host, wanted) {
    for (let i = 0; i < wanted.length; i++) {
      if (host.children[i] !== wanted[i]) host.insertBefore(wanted[i], host.children[i] || null);
    }
    while (host.children.length > wanted.length) host.lastElementChild.remove();
  },

  /** 枝 node の i 番目の境目。 */
  sashFor(node, i) {
    if (!node.sashes[i]) {
      const sash = h('div', { class: 'paneSash' });
      sash.addEventListener('mousedown', (ev) => startSashDrag(ev, node, i));
      node.sashes[i] = sash;
    }
    node.sashes[i].className = 'paneSash paneSash--' + node.dir;
    return node.sashes[i];
  },

  /** アクティブなペインの見た目を更新する。 */
  paint() {
    for (const leaf of Panes.leaves()) {
      leaf.root.classList.toggle('paneLeaf--active', leaf.id === Panes.activeId);
    }
  },

  /**
   * セッションに残す形。タブ ID と表示中タブ、取り分だけを持つ。
   * 取り分は 9KB 制限のある置き場所に入るので、小数 2 桁で足りる。
   * @param {function(string): boolean} [keep] 残してよいタブ ID か
   */
  serialize(keep) { return paneSerialize(Panes.root, keep); },

  /**
   * セッションの形からペインを組み直す。復元できるタブだけを載せる。
   * @param {Object|null} data Panes.serialize() の形
   * @param {function(string): boolean} keep そのタブ ID を載せてよいか
   * @return {boolean} 組み直したか（false ならこれまでどおり 1 枚）
   */
  restore(data, keep) {
    const root = paneRestore(data, keep, {
      max: Panes.MAX,
      makeLeaf: Panes.createLeaf,
      makeSplit: Panes.createSplit,
      forget: (node) => { Panes.byId.delete(node.id); }
    });
    if (!root) return false;

    // 組み直す前のペインは捨てる（起動直後に用意した空の 1 枚）。
    const discard = (n) => {
      if (!n) return;
      if (n.type === 'leaf' && n.view) n.view.destroy();
      Panes.byId.delete(n.id);
      if (n.root) n.root.remove();
      if (n.children) n.children.forEach(discard);
    };
    discard(Panes.root);

    Panes.root = root;
    const first = Panes.leaves()[0];
    Panes.activeId = first ? first.id : null;
    Panes.layout();
    return true;
  }
};

/** アクティブなペインに並んでいるタブ。 */
function paneTabs() {
  const leaf = Panes.active();
  return leaf ? leaf.tabIds.map(getTab).filter(Boolean) : [];
}

/**
 * アクティブなペインの表示中タブ。
 *
 * 分割前からある `App.activeId` は「いま編集しているタブ」という意味なので、
 * アクティブなペインの表示中タブへ委譲する。これで「アクティブか」を見ていた
 * 既存の判定はそのまま意味が通る。別のペインに出ているタブにも効かせたい処理
 * （テーマの差し替えなど）だけ Panes.viewOf / Panes.isVisible に直してある。
 */
Object.defineProperty(App, 'activeId', {
  get() {
    const leaf = Panes.active();
    return leaf ? leaf.activeId : null;
  },
  set(value) {
    const leaf = Panes.active();
    if (leaf) leaf.activeId = value;
  }
});

/**
 * タブを引く。作成中の一時メモは Drive の ID が決まる前に開いているので、
 * そのときの仮 ID（aliasId）でも引けるようにする。EditorState の updateListener には
 * 作った時点の ID が焼き込まれていて、あとから差し替えられないため。
 *
 * id が無いときは必ず null を返すこと。aliasId の既定値が null なので、
 * getTab(null) を素通しすると「aliasId が null のタブ」＝先頭のタブに
 * 当たってしまう（空のペインの状態を別のファイルへ書き戻す事故になる）。
 */
const getTab = (id) => (id ? App.tabs.find((t) => t.id === id || t.aliasId === id) || null : null);
const activeTab = () => getTab(App.activeId);

/**
 * 開いているタブとサイドバーの位置をサーバー（UserProperties）に覚えさせる。
 *
 * localStorage は HtmlService のサンドボックス iframe だとオリジンが
 * 変わりうるためリロードをまたいで残る保証がない。セッションは
 * 確実に残るサーバー側へ置く。
 *
 * 保存はデバウンスして投げっぱなしにする（失敗しても次の変更で再送される）。
 */
const Session = {
  _timer: null,
  /** 最後にサーバーへ送った内容。同じなら送らない（タブ切替のたびに 1 往復していた）。 */
  _lastSent: null,
  LOCAL_PREFIX: 'gdte:session:',

  save() {
    // サーバーへはデバウンスして送るが、このブラウザには今すぐ書く。
    // 操作の直後にリロードされると google.script.run の送信が間に合わず、
    // 最後の 1 操作が抜けていた（localStorage の書き込みは同期で、離脱に負けない）。
    Session.mirror();
    clearTimeout(Session._timer);
    Session._timer = setTimeout(() => {
      Session._timer = null;
      Session.send(false);
    }, 1500);
  },

  /** 利用者ごとのキー。同じブラウザで別のアカウントに切り替えても混ざらない。 */
  localKey() {
    const email = App.user && App.user.email;
    return email ? Session.LOCAL_PREFIX + email : null;
  },

  mirror() {
    const key = Session.localKey();
    if (!key || !Boot.treePainted) return;   // 起動の途中（まだ何も復元していない）は書かない
    try {
      localStorage.setItem(key, JSON.stringify(Object.assign(Session.payload(), { savedAt: Date.now() })));
    } catch (e) { /* 容量・無効化。サーバー側の記録だけになる */ }
  },

  /**
   * このブラウザの記録のほうが新しければ、サーバーの記録と差し替える
   * （起動時のスナップショットと getBootstrap の応答の両方に使う）。
   * @param {Object} data getBootstrap の data と同じ形
   */
  preferLocal(data) {
    const email = data && data.user && data.user.email;
    if (!email) return;
    let local = null;
    try { local = JSON.parse(localStorage.getItem(Session.LOCAL_PREFIX + email) || 'null'); } catch (e) { return; }
    if (!local || !Array.isArray(local.tabs) || !local.savedAt) return;
    const remoteAt = (data.session && Number(data.session.savedAt)) || 0;
    if (local.savedAt > remoteAt) data.session = local;
  },

  /** 内容が前回送ったものと違うときだけ送る。 */
  send(swallow) {
    const payload = Session.payload();
    const json = JSON.stringify(payload);
    if (json === Session._lastSent) return;
    Session._lastSent = json;
    // 比較は中身だけで行い、時刻は送るときに足す（どちらの記録が新しいかを起動時に比べる）。
    Api.saveSession(Object.assign({}, payload, { savedAt: Date.now() })).catch((err) => {
      Session._lastSent = null;   // 失敗したら次の変更で送り直す
      if (!swallow) console.warn('セッションの保存に失敗しました: ' + err.message);
    });
  },

  /**
   * デバウンス待ちを飛ばして今すぐ保存する。
   * タブを開いた直後にリロードされるとデバウンスが発火せず取りこぼすため、
   * ページが隠れるタイミングで呼ぶ。
   */
  flush() {
    if (!Session._timer) return;
    clearTimeout(Session._timer);
    Session._timer = null;
    Session.send(true);   // 離脱直前なので失敗は握りつぶす
  },

  /** 記録する内容。ファイル ID・表示名・種別、展開中フォルダ、画面の状態。 */
  payload() {
    // 作成中の一時メモはまだ Drive に無い（ID が仮）。記録しても復元できないので外す。
    // 比較タブも外す（貼り付けた文字列や過去の版は Drive 上に実体が無く復元できない）。
    const saved = App.tabs.filter((t) => !t.creating && t.kind !== 'diff');
    const savedIds = new Set(saved.map((t) => t.id));
    const active = activeTab();
    const skipActive = !!active && (active.creating || active.kind === 'diff');
    return {
      activeId: skipActive ? null : App.activeId,
      tabs: saved.map((t) => ({
        // プレビュータブの id は合成（preview:<元の id>）なので、
        // 記録するのは元のファイル ID にする。復元側で組み立て直す。
        id: t.kind === 'preview' ? t.pv.src : t.id,
        name: t.name, kind: t.kind, pinned: t.pinned, temp: t.temp,
        // ターミナルは「どのフォルダにいたか」だけ覚える（出力も履歴も持たない）。
        cwd: (t.kind === 'term' && t.term && t.term.cwd) ? t.term.cwd : undefined
      })),
      // どのタブがどのペインに載っていたか。復元できないタブは載せない。
      panes: Panes.serialize((id) => savedIds.has(id)),
      expanded: Tree.expandedIds(),
      sidebarWidth: Layout.width,
      sidebarHidden: Layout.sidebarHidden,
      view: Views.current
    };
  }
};

