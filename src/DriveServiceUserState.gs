/**
 * DriveServiceUserState.gs — DriveService のうち ルートフォルダ・セッション・ピン留め（UserProperties に持つもの）。
 *
 * DriveService は 1 つのオブジェクトだが、長いので機能ごとのファイルに分けて足している。
 * GAS は全ファイルを 1 つのグローバルに読み込み、読み込む順は決められないので、
 * どのファイルも「無ければ作る」形にしてある（呼ばれるのは全ファイルを読み終えた後）。
 */

var DriveService = DriveService || {};

Object.assign(DriveService, {

  /* ------------------------------------------------------------------ *
   *  ルートフォルダ（ツリーに並べる複数のフォルダ）
   * ------------------------------------------------------------------ */

  /**
   * 保存されているルートフォルダの一覧を読む。
   *
   * 複数ルート対応より前は単一の基準フォルダ（PROP_BASE_FOLDER_ID）だったので、
   * それが残っていれば 1 件の配列として引き継ぎ、新しいキーへ移す。
   *
   * @return {Array<{id:string, name:string}>}
   */
  loadRoots_: function () {
    var props = PropertiesService.getUserProperties();
    var parsed = DriveService.parseRootsRaw_(props.getProperty(PROP_ROOTS));
    if (parsed !== null) return parsed;

    // 旧形式からの移行。
    var legacy = props.getProperty(PROP_BASE_FOLDER_ID);
    if (legacy) {
      var migrated = [{ id: String(legacy), name: '' }];
      DriveService.saveRoots_(migrated);
      props.deleteProperty(PROP_BASE_FOLDER_ID);
      return migrated;
    }

    return [];
  },

  /**
   * roots の生 JSON → 配列。無い／壊れていれば null（呼び出し側が旧形式を見る）。
   * getBootstrap が getProperties() でまとめて読んだ値からも使えるよう、純関数にしてある。
   * @param {string|null|undefined} raw
   * @return {Array<{id:string, name:string}>|null}
   */
  parseRootsRaw_: function (raw) {
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      var out = [];
      for (var i = 0; i < parsed.length && out.length < MAX_ROOTS; i++) {
        if (parsed[i] && parsed[i].id) {
          out.push({ id: String(parsed[i].id), name: String(parsed[i].name || '') });
        }
      }
      return out;
    } catch (e) {
      return null;
    }
  },

  /**
   * ルートフォルダの一覧を保存する。
   * @param {Array<{id:string, name:string}>} roots
   */
  saveRoots_: function (roots) {
    var list = [];
    for (var i = 0; i < roots.length && list.length < MAX_ROOTS; i++) {
      if (!roots[i] || !roots[i].id) continue;
      list.push({
        id: String(roots[i].id),
        name: String(roots[i].name || '').slice(0, 120)
      });
    }
    PropertiesService.getUserProperties().setProperty(PROP_ROOTS, JSON.stringify(list));
  },

  /**
   * 保存済みのルートに、起動時に Drive から取れた名前を反映する。
   * 開けなかったルート（一時的なエラー・権限が一時的に外れたなど）も外さずに残す
   * （名前の更新のついでに、利用者の設定からフォルダを消してしまわないため）。
   * @param {Array<{id:string, name:string}>} saved 保存済みのルート
   * @param {Array<{id:string, name:string}>} opened 今回開けたルート
   * @return {Array<{id:string, name:string}>}
   */
  renameRoots_: function (saved, opened) {
    var names = {};
    for (var i = 0; i < opened.length; i++) names[opened[i].id] = opened[i].name;
    var out = [];
    for (var j = 0; j < saved.length; j++) {
      var id = saved[j].id;
      out.push({
        id: id,
        name: Object.prototype.hasOwnProperty.call(names, id) ? names[id] : saved[j].name
      });
    }
    return out;
  },

  /**
   * ルートフォルダを 1 つ追加する。
   *
   * すでに入っている場合は名前を更新するだけ。
   * 追加できたかどうかを呼び出し側が判別できるよう added を返す。
   *
   * @param {string} folderId
   * @return {{root:{id:string,name:string}, roots:Array, added:boolean}}
   */
  addRoot_: function (folderId) {
    var access = DriveService.folderAccess_(folderId);
    var roots = DriveService.loadRoots_();

    for (var i = 0; i < roots.length; i++) {
      if (roots[i].id === access.id) {
        roots[i].name = access.name;
        DriveService.saveRoots_(roots);
        return {
          root: { id: access.id, name: access.name },
          roots: roots,
          added: false
        };
      }
    }

    if (roots.length >= MAX_ROOTS) {
      throw appError_(
        'UNKNOWN',
        '同時に開けるフォルダは ' + MAX_ROOTS + ' 個までです。' +
          'どれかを外してから追加してください。'
      );
    }

    roots.push({ id: access.id, name: access.name });
    DriveService.saveRoots_(roots);
    return {
      root: { id: access.id, name: access.name },
      roots: roots,
      added: true
    };
  },

  /**
   * ルートフォルダを 1 つ外す。フォルダ自体には触らない。
   * @param {string} folderId
   * @return {{roots:Array}}
   */
  removeRoot_: function (folderId) {
    var id = String(folderId);
    var roots = DriveService.loadRoots_();
    var kept = [];
    for (var i = 0; i < roots.length; i++) {
      if (roots[i].id !== id) kept.push(roots[i]);
    }
    DriveService.saveRoots_(kept);
    // ルートが全部無くなった＝ワークスペースを畳んだ状態。
    // タブの復元情報を残しておく意味が無いので捨てる。
    if (!kept.length) DriveService.clearSession_();
    return { roots: kept };
  },

  /* ------------------------------------------------------------------ *
   *  セッション（開いていたタブの復元用）
   * ------------------------------------------------------------------ */

  /**
   * セッションの生 JSON → オブジェクト。壊れていれば null。
   * getBootstrap / doGet は UserProperties を getProperties() で 1 回だけ読むので、
   * 「読む」と「解釈する」を分けてある（ここは解釈だけ）。
   */
  parseSessionRaw_: function (raw) {
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.tabs)) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  },

  /**
   * セッション上のアクティブタブが本文を持つ種別（text）なら、その ID を返す。
   * PDF や Google ドキュメントなどビューアで開く種別は null。
   * @param {Object|null} session
   * @return {string|null}
   */
  activeTextTabId_: function (session) {
    if (!session || !session.activeId) return null;
    var kind = null;
    if (Array.isArray(session.tabs)) {
      for (var t = 0; t < session.tabs.length; t++) {
        if (session.tabs[t] && session.tabs[t].id === session.activeId) {
          kind = session.tabs[t].kind || 'text';
          break;
        }
      }
    }
    return kind === 'text' && validId_(session.activeId) ? String(session.activeId) : null;
  },

  /**
   * セッションを保存する。
   *
   * 中身はファイル ID と表示名だけ。本文は持たせない
   * （9KB 制限に収まらないうえ、真実の保存先は常に Drive のため）。
   *
   * @param {Object} session クライアントから渡された生データ
   * @return {{tabs:number, expanded:number}}
   */
  saveSession_: function (session) {
    var src = session || {};
    var payload = {
      activeId: src.activeId ? String(src.activeId) : null,
      tabs: [],
      expanded: []
    };

    // ペインの分割。形と ID だけを受け取り、深さと枚数で蓋をする。
    var panes = DriveService.sanitizePanes_(src.panes, { leaves: 0 }, 0);
    if (panes) payload.panes = panes;

    // 画面の状態。数値・真偽値として受け取れたものだけ通す。
    var width = Number(src.sidebarWidth);
    if (isFinite(width) && width > 0) {
      payload.sidebarWidth = Math.max(120, Math.min(1200, Math.round(width)));
    }
    payload.sidebarHidden = !!src.sidebarHidden;
    if (src.view && /^(explorer|search|history|settings)$/.test(String(src.view))) {
      payload.view = String(src.view);
    }
    // クライアントが送った時刻。ブラウザに残した記録とどちらが新しいかを起動時に比べる。
    var savedAt = Number(src.savedAt);
    if (isFinite(savedAt) && savedAt > 0) payload.savedAt = Math.round(savedAt);

    var tabs = Array.isArray(src.tabs) ? src.tabs : [];
    for (var i = 0; i < tabs.length && payload.tabs.length < MAX_SESSION_TABS; i++) {
      var t = tabs[i];
      if (!t || !t.id) continue;
      var tab = {
        id: String(t.id),
        name: String(t.name == null ? '' : t.name).slice(0, 120),
        kind: SESSION_KINDS[t.kind] ? String(t.kind) : 'text',
        pinned: !!t.pinned
      };
      // ターミナルは「どのフォルダにいたか」だけ覚える（出力も履歴も持たない）。
      if (tab.kind === 'term' && t.cwd && validId_(t.cwd)) tab.cwd = String(t.cwd);
      payload.tabs.push(tab);
    }

    var expanded = Array.isArray(src.expanded) ? src.expanded : [];
    for (var j = 0; j < expanded.length && payload.expanded.length < MAX_SESSION_EXPANDED; j++) {
      if (expanded[j]) payload.expanded.push(String(expanded[j]));
    }

    // 9KB 制限に収まらない場合は、まず展開状態、次に分割、最後にタブを落とす。
    // 分割が消えてもタブは 1 枚のペインに残るので、失うものが少ない順にしている。
    var json = JSON.stringify(payload);
    while (DriveService.byteLength_(json) > MAX_SESSION_BYTES && payload.expanded.length > 0) {
      payload.expanded.pop();
      json = JSON.stringify(payload);
    }
    if (DriveService.byteLength_(json) > MAX_SESSION_BYTES && payload.panes) {
      delete payload.panes;
      json = JSON.stringify(payload);
    }
    while (DriveService.byteLength_(json) > MAX_SESSION_BYTES && payload.tabs.length > 0) {
      payload.tabs.pop();
      json = JSON.stringify(payload);
    }

    PropertiesService.getUserProperties().setProperty(PROP_SESSION, json);
    return { tabs: payload.tabs.length, expanded: payload.expanded.length };
  },

  /**
   * ペインの分割を、受け入れてよい形に直す。
   *
   * 中身はファイル ID と取り分だけで、本文も名前も持たない。壊れていたり
   * 上限を超えたりしたら落とすだけで、エラーにはしない（クライアントは
   * 記録が無ければ 1 枚から始める）。
   *
   * @param {Object} node クライアントから渡された生データ（枝か葉）
   * @param {{leaves:number}} state 葉の数を数える入れ物
   * @param {number} depth いまの深さ
   * @return {Object|null}
   */
  sanitizePanes_: function (node, state, depth) {
    if (!node || typeof node !== 'object') return null;
    if (depth > MAX_PANE_DEPTH) return null;

    if (node.t === 's' && Array.isArray(node.ch) && node.ch.length) {
      var children = [];
      for (var i = 0; i < node.ch.length; i++) {
        var child = DriveService.sanitizePanes_(node.ch[i], state, depth + 1);
        if (child) children.push(child);
      }
      if (!children.length) return null;
      // 子が 1 つだけになった枝は意味が無いので、その子で置き換える。
      if (children.length === 1) return children[0];
      return {
        t: 's',
        dir: node.dir === 'col' ? 'col' : 'row',
        size: sanitizePaneSize_(node.size),
        ch: children
      };
    }

    if (state.leaves >= MAX_PANES) return null;
    state.leaves++;

    var tabs = [];
    var src = Array.isArray(node.tabs) ? node.tabs : [];
    for (var j = 0; j < src.length && tabs.length < MAX_SESSION_TABS; j++) {
      if (src[j] && validTabId_(src[j])) tabs.push(String(src[j]));
    }
    var active = (node.active && validTabId_(node.active)) ? String(node.active) : null;
    return { t: 'l', size: sanitizePaneSize_(node.size), tabs: tabs, active: active };
  },

  /** セッションを破棄する（フォルダを切り替えたときなど）。 */
  clearSession_: function () {
    try {
      PropertiesService.getUserProperties().deleteProperty(PROP_SESSION);
    } catch (e) {
      // 消せなくても致命的ではない。
    }
  },

  /* ------------------------------------------------------------------ *
   *  ピン留め
   *
   *  セッション（PROP_SESSION）とは別の値にしている。セッションは
   *  「前回の画面」なので、タブを閉じたり端末を変えたりすれば入れ替わる。
   *  ピン留めは「よく使うファイル」の記録で寿命が違うため、
   *  9KB 制限の枠も溢れたときに落とす順番も分けておきたい。
   * ------------------------------------------------------------------ */

  /**
   * 生 JSON をピン留めの形に解釈する。壊れていれば null。
   * 本文も更新日時も持たせない（真実は常に Drive 側にある）。
   * @param {string|undefined} raw
   * @return {{items:Array<{id:string,name:string,kind:string}>, collapsed:boolean}|null}
   */
  parsePinsRaw_: function (raw) {
    if (!raw) return null;
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    if (!parsed || !Array.isArray(parsed.items)) return null;
    var items = [];
    var seen = {};
    for (var i = 0; i < parsed.items.length && items.length < MAX_PINS; i++) {
      var it = parsed.items[i];
      if (!it || !it.id || seen[it.id]) continue;
      seen[it.id] = true;
      items.push({
        id: String(it.id),
        name: String(it.name == null ? '' : it.name).slice(0, 120),
        kind: VIEW_KINDS[it.kind] ? String(it.kind) : 'text'
      });
    }
    return { items: items, collapsed: !!parsed.collapsed };
  },

  /**
   * ピン留めを保存する。クライアントの一覧をそのまま正とする
   * （並び順もユーザーが決めたものなので、サーバー側で並べ替えない）。
   *
   * @param {Object} pins クライアントから渡された生データ
   * @return {{count:number}}
   */
  savePins_: function (pins) {
    var src = pins || {};
    var list = Array.isArray(src.items) ? src.items : [];
    var payload = { items: [], collapsed: !!src.collapsed };
    var seen = {};
    for (var i = 0; i < list.length && payload.items.length < MAX_PINS; i++) {
      var it = list[i];
      if (!it || !it.id || !validId_(it.id) || seen[it.id]) continue;
      seen[it.id] = true;
      payload.items.push({
        id: String(it.id),
        name: String(it.name == null ? '' : it.name).slice(0, 120),
        kind: VIEW_KINDS[it.kind] ? String(it.kind) : 'text'
      });
    }

    // 9KB 制限に収まらない場合は後ろから落とす（上にあるものほど使っている）。
    var json = JSON.stringify(payload);
    while (DriveService.byteLength_(json) > MAX_PINS_BYTES && payload.items.length > 0) {
      payload.items.pop();
      json = JSON.stringify(payload);
    }

    if (!payload.items.length && !payload.collapsed) {
      // 空なら値ごと消す。次の起動でキーが無いのと同じ扱いになる。
      try {
        PropertiesService.getUserProperties().deleteProperty(PROP_PINS);
      } catch (e) {
        // 消せなくても致命的ではない。
      }
      return { count: 0 };
    }

    PropertiesService.getUserProperties().setProperty(PROP_PINS, json);
    return { count: payload.items.length };
  }
});
