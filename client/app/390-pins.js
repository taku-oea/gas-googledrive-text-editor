/* ------------------------------------------------------------------ *
 *  ピン留め（よく使うファイルを最上段に置く）
 *
 *  エクスプローラの最上段に「ピン留め」セクションを出し、そこから 1 クリックで
 *  開けるようにする。狙いは深い階層へ行き直す手間を無くすこと。ツリーは
 *  1 階層ずつの遅延ロードで、名前の絞り込みもクイックオープン（Mod+P）も
 *  「読み込み済みの階層」しか対象にしない。3 段開かないと辿り着けないファイルは、
 *  毎回そこまで開いて降りるしかない。
 *
 *  「一時メモ」と違い Drive 上のフォルダではない。ファイルの置き場所は変えずに
 *  参照だけを持ち上げるもので、記録するのはファイル ID・表示名・種別の 3 つだけ
 *  （本文も更新日時も持たない。真実の保存先は常に Drive）。
 *
 *  Tree のノードにしていないのは、Tree が「1 ノード = 1 つの親」を前提に
 *  しているため。同じファイルが元のフォルダとピン留めの両方に出る以上、
 *  ノードとして持たせると親が上書きされ、移動・削除・絞り込みが壊れる。
 *  そこで状態はこのモジュールが持ち、描画だけを renderTree に相乗りさせる。
 *
 *  タブの「ピン留め」（「他のタブを閉じる」の対象外にする旗）は、この一覧を正として
 *  タブへ写す（Pins.sync）。同じ名前で別物が 2 つあると使う側が混乱するため、
 *  入口がタブでもツリーでも、行き先は同じこの一覧にする。
 * ------------------------------------------------------------------ */

const Pins = {
  /** ピン留めできる数。サーバー側（MAX_PINS）と揃える。 */
  MAX: 40,

  /** @type {Array<{id:string, name:string, kind:string}>} 画面に出る順（上から）。 */
  items: [],

  /** セクションを畳んでいるか。サーバーに覚えさせる。 */
  collapsed: false,

  /**
   * この画面で一度でも変更したか。
   * 起動直後の突き合わせ（reconcile）で、サーバー側の古い内容に
   * 戻してしまわないための目印。
   */
  touched: false,

  _timer: null,
  /** 最後にサーバーへ送った内容。同じなら送らない。 */
  _lastSent: null,

  /**
   * 起動時（スナップショット / getBootstrap）の内容を読み込む。
   * @param {{items:Array, collapsed:boolean}|null} data
   */
  init(data) {
    const src = (data && typeof data === 'object') ? data : {};
    const list = Array.isArray(src.items) ? src.items : [];
    const items = [];
    const seen = new Set();
    for (const it of list) {
      if (!it || !it.id || seen.has(it.id) || items.length >= Pins.MAX) continue;
      seen.add(it.id);
      items.push(Pins.normalize(it));
    }
    Pins.items = items;
    Pins.collapsed = !!src.collapsed;
    // 読んだ直後はサーバーと同じ内容なので、送り返さない。
    Pins._lastSent = JSON.stringify(Pins.payload());
    Pins.sync();
  },

  /** 記録する 3 つだけに削る。種別は VIEWERS のキーか 'text'。 */
  normalize(item) {
    return {
      id: String(item.id),
      name: String(item.name == null ? '' : item.name),
      kind: VIEWERS[item.kind] ? String(item.kind) : 'text'
    };
  },

  has(id) { return Pins.indexOf(id) >= 0; },
  get(id) { return Pins.items.find((p) => p.id === id) || null; },
  indexOf(id) { return Pins.items.findIndex((p) => p.id === id); },

  /**
   * 1 件足す。既にあれば何もしない。
   * 上限に達したら黙って古いものを落とさず断る（消えたことに気づけないため）。
   * @return {boolean} 足したか
   */
  addOne(item) {
    if (!item || !item.id || Pins.has(item.id)) return false;
    if (Pins.items.length >= Pins.MAX) {
      toast('ピン留めは ' + Pins.MAX + ' 件までです。使わないものを外してください。', 'warn', 6000);
      return false;
    }
    Pins.items.push(Pins.normalize(item));
    return true;
  },

  /** ツリーのノードをまとめて足す（右クリック・ドロップから）。 */
  addNodes(nodes) {
    let added = 0;
    for (const node of nodes) {
      if (!node || node.type !== 'file') continue;
      const entry = node.entry;
      if (entry && !entry.openable) continue;   // 開けないものを置いても使えない
      if (Pins.addOne({
        id: node.id,
        name: node.name,
        kind: entry && entry.viewer === 'embed' ? entry.kind : 'text'
      })) added++;
    }
    if (added) {
      Pins.collapsed = false;   // 足したのに見えないと「効いていない」と思われる
      Pins.changed();
    }
    return added;
  },

  remove(id) {
    const index = Pins.indexOf(id);
    if (index < 0) return false;
    Pins.items.splice(index, 1);
    Pins.changed();
    return true;
  },

  /**
   * フォルダごとゴミ箱へ移したときに、その中のピン留めも外す。
   * ツリーに読み込まれていないものは配下かどうか判定できないので残る
   * （開けなくなった行として残り、右クリックで外せる）。
   * @param {string} folderId
   */
  removeUnder(folderId) {
    const gone = Pins.items.filter((p) => isInsideFolder(p.id, folderId));
    if (!gone.length) return;
    const ids = new Set(gone.map((p) => p.id));
    Pins.items = Pins.items.filter((p) => !ids.has(p.id));
    Pins.changed();
  },

  /** 並べ替え（ドラッグ / メニューの「上へ」「下へ」）。to は移動後に入れる位置。 */
  moveTo(id, to) {
    const from = Pins.indexOf(id);
    if (from < 0) return;
    const dest = Math.max(0, Math.min(Pins.items.length - 1, to));
    if (from === dest) return;
    const [moved] = Pins.items.splice(from, 1);
    Pins.items.splice(dest, 0, moved);
    Pins.changed();
  },

  /** すべて外す。件数があるときだけ確認する。 */
  async clear() {
    if (!Pins.items.length) return;
    if (Pins.items.length > 1) {
      const go = await modal({
        title: 'ピン留めをすべて外す',
        body: Pins.items.length + ' 件のピン留めを外します。ファイル自体は消えません。',
        actions: [
          { label: 'すべて外す', value: true, variant: 'primary' },
          { label: 'やめる', value: false }
        ]
      });
      if (!go) return;
    }
    Pins.items = [];
    Pins.changed();
  },

  /** 表示名を追随させる（改名・一時メモの保存先確定・開いたときの実名）。 */
  rename(id, name) {
    const item = Pins.get(id);
    if (!item || !name || item.name === name) return;
    item.name = String(name);
    Pins.changed();
  },

  toggleCollapsed() {
    Pins.collapsed = !Pins.collapsed;
    renderTree();
    Pins.save();
  },

  /**
   * タブ側の pinned 旗をこの一覧に合わせる。
   * 比較タブと作成中の一時メモは Drive 上の実体（確定した ID）が無いので、
   * タブの中だけで完結する旗として触らずに残す。
   */
  sync() {
    for (const tab of App.tabs) {
      if (tab.kind === 'diff' || tab.creating) continue;
      tab.pinned = Pins.has(tab.id);
    }
  },

  /** タブからの切り替え（右クリック・コマンドパレット）。 */
  toggleTab(tab) {
    if (!tab) return;
    if (tab.kind === 'diff' || tab.creating) {
      tab.pinned = !tab.pinned;
      renderTabs();
      Session.save();
      return;
    }
    if (Pins.has(tab.id)) { Pins.remove(tab.id); return; }
    if (Pins.addOne({ id: tab.id, name: tab.name, kind: tab.kind || 'text' })) {
      // ピン留めしたタブが次のクリックで入れ替わってしまうと意味がないので固定する。
      tab.ephemeral = false;
      Pins.collapsed = false;
      Pins.changed();
    }
  },

  /** ツリーの行からの切り替え。 */
  toggleNode(node) {
    if (!node || node.type !== 'file') return;
    if (Pins.has(node.id)) Pins.remove(node.id);
    else Pins.addNodes([node]);
  },

  /**
   * ピン留めから開く。
   * 記録してある名前は最後に見た時点のものなので、開けたら実名に合わせる
   * （別の端末や Drive 側で改名されていても、次からは正しい名前で並ぶ）。
   */
  async open(item, opts) {
    await openFile(item.id, item.name, item.kind, opts);
    const tab = getTab(item.id);
    if (tab && tab.name) Pins.rename(item.id, tab.name);
  },

  /** 一覧が変わったあとの共通処理。 */
  changed() {
    Pins.touched = true;
    Pins.sync();
    renderTree();
    renderTabs();
    Pins.save();
    // セッションにもタブごとの pinned が入っている。内容が同じなら送られない。
    Session.save();
  },

  payload() {
    return {
      items: Pins.items.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
      collapsed: Pins.collapsed
    };
  },

  /** 保存はデバウンスして投げっぱなしにする（失敗しても次の変更で送り直される）。 */
  save() {
    clearTimeout(Pins._timer);
    Pins._timer = setTimeout(() => { Pins._timer = null; Pins.send(false); }, 800);
  },

  send(swallow) {
    const payload = Pins.payload();
    const json = JSON.stringify(payload);
    if (json === Pins._lastSent) return;
    Pins._lastSent = json;
    Api.savePins(payload).catch((err) => {
      Pins._lastSent = null;   // 失敗したら次の変更で送り直す
      if (!swallow) console.warn('ピン留めの保存に失敗しました: ' + err.message);
    });
  },

  /** デバウンス待ちを飛ばして今すぐ保存する（ページが隠れるとき）。 */
  flush() {
    if (!Pins._timer) return;
    clearTimeout(Pins._timer);
    Pins._timer = null;
    Pins.send(true);
  }
};

/**
 * 「ピン留め」セクションの行を足す。0 件なら何も出さない
 * （「一時メモ」も一度も使っていなければ出ないのと同じ）。
 * @param {DocumentFragment} frag
 */
function appendPinRows(frag) {
  frag.appendChild(buildPinHeaderRow());
  if (Pins.collapsed) return;
  if (!Pins.items.length) {
    // 空でも枠は出す（「一時メモ」と同じ位置に常にあるべきもの）。
    // 代わりに入口を書いておく。枠だけ空で置かれていると、
    // どうすれば何かが並ぶのかが分からない。
    frag.appendChild(h('div', {
      class: 'placeholder placeholder--lines placeholder--inline',
      text: 'よく使うファイルをここに。\nタブやファイルを' + (Mobile.on ? '長押し' : '右クリック') + ' →「ピン留めする」'
    }));
    return;
  }
  for (const item of Pins.items) frag.appendChild(buildPinRow(item));
}

/**
 * いまピン留めの対象にできるアクティブタブ。
 * Drive 上の実体が無いもの（比較タブ・作成中の一時メモ）は対象外。
 * @return {Tab|null}
 */
function pinnableTab() {
  const tab = activeTab();
  if (!tab || tab.kind === 'diff' || tab.creating) return null;
  return tab;
}

/** 「ピン留め」の見出し行。ルート行と同じ見た目で、外せない固定セクションとして出す。 */
function buildPinHeaderRow() {
  const twisty = h('button', {
    type: 'button',
    class: 'row__twisty' + (Pins.collapsed ? '' : ' row__twisty--open'),
    title: Pins.collapsed ? '展開' : '折りたたむ',
    onclick: (ev) => { ev.stopPropagation(); Pins.toggleCollapsed(); }
  }, [icon('chevron')]);

  const main = h('button', {
    type: 'button',
    class: 'row__main',
    title: 'ピン留め\nよく使うファイルをここに置いておけます（' +
      Pins.items.length + ' / ' + Pins.MAX + ' 件）',
    onclick: () => Pins.toggleCollapsed()
  }, [
    h('span', { class: 'row__icon' }, [icon('pin')]),
    h('span', { class: 'row__name', text: 'ピン留め' }),
    // 0 件のときに「0 件」と出しても何も伝わらないので、そのときは出さない。
    Pins.items.length
      ? h('span', { class: 'row__meta', text: Pins.items.length + ' 件' })
      : null
  ]);

  // 見出しのボタンは「いま開いているファイルを留める」。空の枠から 1 クリックで
  // 始められるようにするためで、これが無いと右クリックを知らないと使えない。
  const tab = pinnableTab();
  const actions = h('div', { class: 'row__actions' }, [
    tab
      ? h('button', {
          type: 'button', class: 'row__act',
          title: tab.pinned ? '「' + tab.name + '」のピン留めを外す'
            : '「' + tab.name + '」をピン留め',
          onclick: (ev) => { ev.stopPropagation(); Pins.toggleTab(tab); }
        }, [icon(tab.pinned ? 'pin-off' : 'pin')])
      : null,
    Pins.items.length
      ? h('button', {
          type: 'button', class: 'row__act', title: 'ピン留めをすべて外す',
          onclick: (ev) => { ev.stopPropagation(); void Pins.clear(); }
        }, [icon('clear')])
      : null
  ]);

  const row = h('div', {
    class: 'row row--treeRoot row--pinRoot',
    oncontextmenu: (ev) => {
      ev.preventDefault();
      const active = pinnableTab();
      Ctx.show(ev.clientX, ev.clientY, [
        active
          ? { label: (active.pinned ? 'ピン留めを外す: ' : 'このタブをピン留め: ') + active.name,
              icon: active.pinned ? 'pin-off' : 'pin',
              onClick: () => Pins.toggleTab(active) }
          : null,
        active ? { sep: true } : null,
        { label: Pins.collapsed ? '展開' : '折りたたむ', icon: 'chevron',
          onClick: () => Pins.toggleCollapsed() },
        { sep: true },
        { label: 'ピン留めをすべて外す', icon: 'clear', disabled: !Pins.items.length,
          danger: true, onClick: () => void Pins.clear() }
      ].filter(Boolean));
    }
  }, [twisty, main, actions]);

  // ツリーからファイルをここへ落としてもピン留めできる。移動ではないので dropEffect は copy。
  const draggedFiles = () => {
    const node = App.dragId ? Tree.get(App.dragId) : null;
    if (!node || node.type !== 'file') return [];
    return App.selection.has(node.id) ? actionableSelection().filter(Boolean) : [node];
  };
  row.addEventListener('dragover', (ev) => {
    if (!draggedFiles().length) return;
    ev.preventDefault();
    // dropEffect は effectAllowed に含まれる値でないとドロップが取りやめになる。
    ev.dataTransfer.dropEffect =
      /copy/i.test(ev.dataTransfer.effectAllowed || '') ? 'copy' : 'move';
    row.classList.add('row--dropTarget');
  });
  row.addEventListener('dragleave', () => { row.classList.remove('row--dropTarget'); });
  row.addEventListener('drop', (ev) => {
    row.classList.remove('row--dropTarget');
    const nodes = draggedFiles();
    if (!nodes.length) return;
    ev.preventDefault();
    ev.stopPropagation();
    const added = Pins.addNodes(nodes);
    if (!added) toast('すでにピン留めされています', 'info', 3000);
  });

  return row;
}

/** ピン留め 1 件の行。ツリーのファイル行と同じ操作（1 クリックで仮タブ、ダブルクリックで固定）。 */
function buildPinRow(item) {
  const viewer = VIEWERS[item.kind];
  const node = Tree.get(item.id);   // ツリーに読み込まれていれば置き場所も出せる
  const open = (ephemeral) => { void Pins.open(item, { ephemeral }); };

  const twisty = h('button', {
    type: 'button', class: 'row__twisty row__twisty--leaf', tabindex: '-1'
  }, []);
  twisty.style.marginLeft = '13px';

  const main = h('button', {
    type: 'button',
    class: 'row__main',
    title: (node ? Tree.pathOf(item.id) : item.name) + '\nピン留め',
    onclick: () => open(true),
    ondblclick: () => open(false)
  }, [
    h('span', { class: 'row__icon' }, [
      viewer ? icon(viewer.icon, viewer.iconClass) : icon('file-text', 'icon--file')
    ]),
    h('span', { class: 'row__name', text: item.name }),
    h('span', { class: 'row__meta', text: node ? parentNameOf(node) : '' })
  ]);

  const actions = h('div', { class: 'row__actions' }, [
    h('button', {
      type: 'button', class: 'row__act', title: 'ピン留めを外す',
      onclick: (ev) => { ev.stopPropagation(); Pins.remove(item.id); }
    }, [icon('pin-off')])
  ]);

  const row = h('div', {
    class: 'row row--pin',
    // ツリーの行と同じ属性にしておくと、開いている・編集中の色付け
    // （renderTreeStates）と先読み（Prefetch）がそのまま効く。
    'data-node-id': item.id,
    'data-type': 'file',
    'data-tip-ready': '1',   // ツールチップはここで作ってあるので後付けさせない
    draggable: 'true',
    oncontextmenu: (ev) => { ev.preventDefault(); showPinMenu(ev.clientX, ev.clientY, item); }
  }, [twisty, main, actions]);

  wirePinDrag(row, item);
  return row;
}

/** ピン留め 1 件の右クリックメニュー。 */
function showPinMenu(x, y, item) {
  const index = Pins.indexOf(item.id);
  const node = Tree.get(item.id);
  Ctx.show(x, y, [
    { label: 'エディタで開く', icon: 'open', onClick: () => void Pins.open(item, { ephemeral: false }) },
    { sep: true },
    { label: '上へ', icon: 'arrow-up', disabled: index <= 0,
      onClick: () => Pins.moveTo(item.id, index - 1) },
    { label: '下へ', icon: 'arrow-down', disabled: index < 0 || index >= Pins.items.length - 1,
      onClick: () => Pins.moveTo(item.id, index + 1) },
    { sep: true },
    { label: 'パスをコピー', icon: 'copy',
      onClick: () => void copyTextToClipboard(node ? Tree.pathOf(item.id) : item.name) },
    { label: 'Drive で開く', icon: 'open',
      onClick: () => {
        window.open('https://drive.google.com/file/d/' + encodeURIComponent(item.id) + '/view',
          '_blank', 'noopener');
      } },
    { sep: true },
    { label: 'ピン留めを外す', icon: 'pin-off', onClick: () => Pins.remove(item.id) }
  ]);
}

/** ピン留めの並べ替え（セクションの中だけで動かす）。 */
function wirePinDrag(row, item) {
  row.addEventListener('dragstart', (ev) => {
    App.dragPinId = item.id;
    row.classList.add('row--dragging');
    ev.dataTransfer.effectAllowed = 'move';
    // 一部ブラウザは何かセットしないと dragstart を無効にする。
    try { ev.dataTransfer.setData(DRAG_TYPE, 'pin:' + item.id); } catch (e) { /* 無視 */ }
  });
  row.addEventListener('dragend', () => {
    App.dragPinId = null;
    row.classList.remove('row--dragging');
    for (const r of el.entryList.querySelectorAll('.row--dropTarget')) {
      r.classList.remove('row--dropTarget');
    }
  });
  row.addEventListener('dragover', (ev) => {
    if (!App.dragPinId || App.dragPinId === item.id) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    row.classList.add('row--dropTarget');
  });
  row.addEventListener('dragleave', () => { row.classList.remove('row--dropTarget'); });
  row.addEventListener('drop', (ev) => {
    row.classList.remove('row--dropTarget');
    if (!App.dragPinId || App.dragPinId === item.id) return;
    ev.preventDefault();
    ev.stopPropagation();
    Pins.moveTo(App.dragPinId, Pins.indexOf(item.id));
    App.dragPinId = null;
  });
}

/** エクスプローラの「ピン留め」を開いて見せる（コマンドパレットから）。 */
function showPinSection() {
  // Views.show は同じビューをもう一度指すとサイドバーを畳む。
  // ここでは必ず見せたいので、畳まれる条件のときだけ呼ぶ。
  if (Views.current !== 'explorer' || !Mobile.sidebarShown()) Views.show('explorer');
  if (Pins.collapsed) { Pins.collapsed = false; Pins.save(); }
  renderTree();
  el.entryList.scrollTop = 0;
}

