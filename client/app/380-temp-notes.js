/* ------------------------------------------------------------------ *
 *  一時メモ（とっさのメモ）
 *
 *  タブバーの空いているところをダブルクリック（または Mod+Alt+N）で、
 *  マイドライブの「Googleドライブテキストエディタ / tmp」に実ファイルを作る。
 *
 *  最初から実ファイルにしてあるのが要点で、
 *    - 自動保存・競合検出・下書き・セッション復元が通常タブと同じ経路を通る
 *    - セッションはサーバー（UserProperties）にあるので、別の端末で開くと
 *      書きかけのメモがタブごと復元される
 *  という 2 つがそのまま手に入る。保存先を決めるまでは tmp に置いたまま、
 *  Cmd/Ctrl+S で保存先を聞いて、そのフォルダへ移す（promote）。
 * ------------------------------------------------------------------ */

const TempMemo = {
  /**
   * 一時メモの自動保存はここまで待つ（ミリ秒）。
   * 保存先が決まっていない書き殴りに、通常ファイルと同じ 2 秒で
   * Drive を叩き続ける必要はない。下書きは localStorage 側が持っている。
   */
  MIN_AUTOSAVE_MS: 5000,

  /**
   * 二重起動よけ。
   *
   * Mod+S はエディタ内で押すと document の listener と CodeMirror の keymap の
   * 両方から saveNow が走る（通常の保存は二度呼ばれても実害が無いのでそのまま）。
   * 一時メモは保存ダイアログを開くので、素通しすると 2 枚開いてしまう。
   * キーの連打で一時メモが何枚もできるのも、同じ理由で防いでいる。
   */
  _creating: false,
  /** @type {string|null} 保存先を聞いている最中のタブ ID */
  _promoting: null,

  /**
   * サーバーから返った tmp フォルダを覚え、ツリーの「一時メモ」に反映する。
   * フォルダが作り直されて ID が変わった場合は、古いノードを捨てる。
   * @param {{id:string, name:string}} folder
   */
  adopt(folder) {
    if (!folder || !folder.id) return;
    const prevId = App.tmpFolder ? App.tmpFolder.id : null;
    if (prevId && prevId !== folder.id) {
      const prev = Tree.get(prevId);
      const wasExpanded = !!(prev && prev.expanded);
      Tree.remove(prevId);
      Tree.tmpRootId = null;
      App.tmpFolder = { id: folder.id, name: folder.name || 'tmp' };
      Tree.setTmpRoot(App.tmpFolder);
      const next = Tree.get(folder.id);
      if (next) next.expanded = wasExpanded;
      return;
    }
    App.tmpFolder = { id: folder.id, name: folder.name || 'tmp' };
    Tree.setTmpRoot(App.tmpFolder);
  },

  /** 置き場所を変えている最中か（ボタンの二度押しを防ぐ）。 */
  _relocating: false,

  /**
   * 一時メモの置き場所を表す表示用のパス。
   * 親フォルダの名前を覚えてあるので、Drive を触らずに描ける。
   * @return {string}
   */
  locationText() {
    const cfg = App.config || {};
    const app = cfg.tmpAppFolderName || 'Googleドライブテキストエディタ';
    const tmp = cfg.tmpFolderName || 'tmp';
    const base = (App.tmpParent && App.tmpParent.name) ? App.tmpParent.name : 'マイドライブ';
    return base + ' / ' + app + ' / ' + tmp;
  },

  /**
   * 置き場所を選び直す。
   *
   * 選ぶのは「親フォルダ」で、実体はその下の <アプリ名> / tmp。
   * 掃除（保存期間を過ぎたらゴミ箱へ）の対象を必ずアプリが作ったフォルダに
   * 閉じるため、ユーザーが選んだフォルダをそのまま tmp にはしない。
   *
   * @param {{back?:boolean}} [opts] back=true なら、選び終わったあとフォルダ管理画面へ戻る
   * @return {Promise<boolean>} 変えたか
   */
  async relocate(opts) {
    if (TempMemo._relocating) return false;
    const cfg = App.config || {};
    const app = cfg.tmpAppFolderName || 'Googleドライブテキストエディタ';
    const choice = await Picker.choose({
      title: '一時メモの置き場所',
      note: '選んだフォルダの下に「' + app + ' / ' + (cfg.tmpFolderName || 'tmp') +
        '」を作り、そこを一時メモの置き場所にします。' +
        (App.tmpFolder ? 'いまある一時メモも、そこへ移します。' : ''),
      confirmLabel: 'ここを一時メモの置き場所にする',
      nameless: true,
      back: !!(opts && opts.back),
      folder: App.tmpParent
    });
    if (!choice) return false;

    // 一時メモのフォルダ自身を親に選ぶと、その下にもう 1 つ tmp ができてしまう。
    if (App.tmpFolder && choice.folderId === App.tmpFolder.id) {
      toast('いまの一時メモのフォルダそのものは選べません。置き場所にしたいフォルダ（その親）を選んでください。',
        'warn', 9000);
      return false;
    }
    return TempMemo.setLocation(choice.folderId);
  },

  /**
   * 置き場所をサーバーへ伝え、結果を画面へ反映する。
   *
   * まだ一度も一時メモを使っていなければ、サーバーは記録するだけで
   * Drive にフォルダを作らない（次に作るときにその場所へできる）。
   *
   * @param {string|null} parentId null で既定（マイドライブ）へ戻す
   * @return {Promise<boolean>}
   */
  async setLocation(parentId) {
    if (TempMemo._relocating) return false;
    TempMemo._relocating = true;
    renderTmpLocation();
    if (App.tmpFolder) toast('一時メモの置き場所を変えています…', 'info', 4000);

    let data;
    let failure = null;
    try {
      data = await Api.setTempFolder(parentId || null);
    } catch (err) {
      failure = err;
    }

    // 成功でも失敗でも、まず押せない状態を解いてから結果を知らせる。
    TempMemo._relocating = false;
    if (data) App.tmpParent = data.parent || null;
    renderTmpLocation();

    if (failure) {
      toast('一時メモの置き場所を変えられませんでした: ' + failure.message, 'error', 12000);
      return false;
    }

    if (data.unchanged) {
      toast('一時メモの置き場所は変わっていません', 'info', 3000);
      return false;
    }
    // 実体がまだ無い（一度も一時メモを使っていない）。次に作るときにこの場所へできる。
    if (!data.folder) {
      toast('一時メモの置き場所を「' + TempMemo.locationText() + '」にしました', 'info', 6000);
      return true;
    }

    // ツリーの「一時メモ」を新しいフォルダに差し替える。開いていたなら中身も読み直す
    // （ファイル ID は変わらないので、開いているタブはそのまま使える）。
    const node = Tree.tmpRootId ? Tree.get(Tree.tmpRootId) : null;
    const wasLoaded = !!(node && node.loaded);
    TempMemo.adopt(data.folder);
    if (wasLoaded) await TempMemo.load(true);
    else renderTree();
    Session.save();

    toast('一時メモの置き場所を「' + TempMemo.locationText() + '」にしました' +
      (data.moved ? '（' + data.moved + ' 件を移動）' : ''), 'info', 7000);
    if (data.failed) {
      toast(data.failed + ' 件は移動できませんでした。元のフォルダに残っています。' +
        'もう一度同じフォルダを選ぶと、残りを移し直します。', 'warn', 14000);
    }
    if (data.hasMore) {
      toast('一度に移せるのは ' + ((App.config || {}).maxTmpMoveFiles || 300) +
        ' 件までです。もう一度同じフォルダを選ぶと、続きを移します。', 'warn', 14000);
    }
    return true;
  },

  /**
   * 「一時メモ」セクションの中身を読む。loadFolder から呼ばれる。
   *
   * listEntries ではなく専用 API を使うのは、tmp フォルダの実体がまだ
   * 無いことがあるのと、古いメモの掃除をここで一緒に走らせるため。
   *
   * @param {boolean} [force] 一覧キャッシュを無視する
   * @return {Promise<boolean>} 成功したか
   */
  async load(force) {
    const node = Tree.tmpRootId ? Tree.get(Tree.tmpRootId) : null;
    if (node) { node.loading = true; renderTree(); }

    try {
      const data = await Api.listTempEntries(!!force);
      TempMemo.adopt(data.folder);
      Tree.ingest(App.tmpFolder.id, data.entries);
      if (data.swept) {
        toast('保存期間を過ぎた一時メモ ' + data.swept +
          ' 件を Drive のゴミ箱へ移しました', 'info', 6000);
      }
      return true;
    } catch (err) {
      const n = Tree.tmpRootId ? Tree.get(Tree.tmpRootId) : null;
      if (n) { n.loading = false; n.expanded = false; }
      toast('一時メモを開けませんでした: ' + err.message, 'error', 10000);
      return false;
    } finally {
      const n = Tree.tmpRootId ? Tree.get(Tree.tmpRootId) : null;
      if (n) n.loading = false;
      renderTree();
    }
  },

  /** 「一時メモ」セクションを取り直す。 */
  async refresh() {
    const node = Tree.tmpRootId ? Tree.get(Tree.tmpRootId) : null;
    if (node) node.expanded = true;
    await TempMemo.load(true);
    Session.save();
  },

  /**
   * 一時メモを 1 枚作って開く。
   */
  async create() {
    try {
      await Editor.load();
    } catch (err) {
      toast('エディタを読み込めていないため作成できません: ' + err.message, 'error', 8000);
      return;
    }
    if (TempMemo._creating) {
      toast('一時メモを作成しています。少し待ってください。', 'info', 2500);
      return;
    }
    TempMemo._creating = true;

    // Drive の往復（1〜3 秒）を待たずに、空のタブを先に開いて入力できるようにする。
    // ID が決まるまでは仮 ID で動かし、返ってきた時点で bindCreated が差し替える。
    const tab = makeTab(TempMemo.tempId(), TempMemo.placeholderName(), 'text');
    tab.temp = true;
    tab.creating = true;
    App.tabs.push(tab);
    Panes.addTab(Panes.active() || Panes.init(), tab.id);
    hydrateTab(tab, {
      name: tab.name,
      mimeType: 'text/plain',
      size: 0,
      updatedAtIso: '',
      content: ''
    });
    renderTabs();
    await activateTab(tab.id);

    let data;
    try {
      data = await Api.createTempFile();
    } catch (err) {
      TempMemo.onCreateFailed(tab, err);
      return;
    } finally {
      TempMemo._creating = false;
    }
    TempMemo.bindCreated(tab, data);
  },

  /** まだ Drive に無いタブの仮 ID。Drive のファイル ID には ':' が入らないので衝突しない。 */
  tempId() {
    return 'new:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  },

  /**
   * 作成中に見せておく名前。サーバーの createTempFile_ と同じ規則で作る
   * （実際の名前は Drive の応答で上書きされるので、多少ずれても実害はない）。
   */
  placeholderName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const ext = Settings.get('tmpExtension') || 'txt';
    return 'メモ ' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + p(d.getMinutes()) + '.' + ext;
  },

  /**
   * Drive 上のファイルが出来たので、仮 ID のタブを実 ID に結びつける。
   * 待っている間に入力された内容はそのまま残し、必要なら続けて保存する。
   *
   * @param {Tab} tab 仮 ID で開いてあるタブ
   * @param {{entry:Object, folder:Object, swept:number}} data createTempFile の応答
   */
  bindCreated(tab, data) {
    const entry = data.entry;
    TempMemo.adopt(data.folder);

    // 待っている間に閉じられていた。空なら作った実体を片付け、
    // 何か書かれていたなら捨てずに Drive の一時メモとして残す。
    if (tab.discardAfterCreate || !App.tabs.includes(tab)) {
      const text = tabDoc(tab);
      if (text.trim()) {
        Draft.clear(tab.id);
        Api.saveFile(entry.id, restoreEol(text, tab.eol), entry.updatedAtIso, true)
          .then(() => toast('閉じた一時メモ「' + entry.name +
            '」の内容は Drive に保存しました（サイドバーの「一時メモ」から開けます）', 'info', 8000))
          .catch((err) => toast('閉じた一時メモを保存できませんでした: ' + err.message, 'error', 12000));
      } else {
        Api.trashFile(entry.id)
          .catch((err) => console.warn('空の一時メモを片付けられませんでした: ' + err.message));
      }
      return;
    }

    const aliasId = tab.id;
    Draft.clear(aliasId);   // 仮 ID で書かれた下書きは実 ID 側へ書き直す
    tab.aliasId = aliasId;
    tab.id = entry.id;
    tab.creating = false;
    tab.createError = null;
    tab.name = entry.name;
    tab.mimeType = entry.mimeType;
    tab.size = entry.size;
    tab.baseUpdatedAtIso = entry.updatedAtIso;
    tab.langKey = EXT_TO_LANG[extensionOf(entry.name)] || null;
    if (App.activeId === aliasId) App.activeId = entry.id;

    TempMemo.attachToTree(entry);
    renderTree();
    renderTabs();
    if (App.activeId === entry.id) {
      el.sbName.textContent = tab.name;
      renderEditorCrumbs();
      updateStatusMeta();
      updatePreviewAvailability();
    }
    void applyLanguageTo(tab.id, tab.langKey);
    Session.save();

    // 待っている間に書かれていれば、そのまま保存する。
    if (tab.dirty || tab.pendingSave) {
      tab.pendingSave = false;
      void doSave(tab.id, false);
    } else {
      Store.putContent({ id: entry.id, name: entry.name, mimeType: entry.mimeType,
        size: 0, content: '', updatedAtIso: entry.updatedAtIso });
      refreshStatus();
    }

    toast('一時メモ「' + entry.name + '」を作成しました', 'info', 3500);
    if (data.swept) {
      toast('保存期間を過ぎた一時メモ ' + data.swept +
        ' 件を Drive のゴミ箱へ移しました', 'info', 6000);
    }
  },

  /**
   * 作成に失敗した。入力が無ければタブを閉じ、何か書かれていれば
   * 内容を失わないようタブを残して再試行できるようにする。
   * @param {Tab} tab
   * @param {Error} err
   */
  onCreateFailed(tab, err) {
    const message = (err && err.message) ? err.message : String(err);
    tab.creating = false;
    tab.createError = message;

    if (!App.tabs.includes(tab)) return;   // 待っている間に閉じられた
    if (!tabDoc(tab).trim()) {
      void closeTab(tab.id, { force: true });
      toast('一時メモを作成できませんでした: ' + message, 'error', 10000);
      return;
    }
    renderTabs();
    refreshStatus();
    toast('一時メモの保存先を作れませんでした: ' + message +
      '\n入力した内容はこのタブに残っています（' + MOD + '+S で作り直せます）。', 'error', 14000);
  },

  /**
   * 作成に失敗したタブで、もう一度 Drive 上のファイルを作る。
   * 成功したら、いま入力されている内容をそのまま保存する。
   * @param {string} tabId
   */
  async retryCreate(tabId) {
    const tab = getTab(tabId);
    if (!tab || !tab.createError) return;
    if (TempMemo._creating) return;
    TempMemo._creating = true;

    tab.creating = true;
    tab.createError = null;
    tab.pendingSave = true;   // 実 ID が決まったら、いまの内容を保存する
    refreshStatus();

    let data;
    try {
      data = await Api.createTempFile();
    } catch (err) {
      TempMemo.onCreateFailed(tab, err);
      return;
    } finally {
      TempMemo._creating = false;
    }
    TempMemo.bindCreated(tab, data);
  },

  /**
   * 作ったばかりの一時メモを「一時メモ」セクションに並べる。  /**
   * 作ったばかりの一時メモを「一時メモ」セクションに並べる。
   * まだ一度も開いていないセクションには足さない（展開時に読まれる）。
   * @param {Object} entry
   */
  attachToTree(entry) {
    const root = Tree.tmpRootId ? Tree.get(Tree.tmpRootId) : null;
    if (!root || !root.loaded) return;
    Tree.nodes.set(entry.id, {
      id: entry.id, name: entry.name, type: 'file', parentId: root.id, entry: entry,
      expanded: false, loaded: true, loading: false,
      childFolderIds: [], childFileIds: []
    });
    if (root.childFileIds.indexOf(entry.id) < 0) root.childFileIds.push(entry.id);
    sortChildren(root.id);
  },

  /**
   * 保存ダイアログに入れる既定のファイル名。
   *
   * 本文の 1 行目から作る。とっさのメモは 1 行目が用件になっていることが
   * 多いので、「メモ 2026-09-11 1430.txt」のままより後から探しやすい。
   * @param {Tab} tab
   * @return {string}
   */
  suggestName(tab) {
    const ext = extensionOf(tab.name) || 'txt';
    const firstLine = tabDoc(tab).split('\n').find((line) => line.trim()) || '';
    const base = firstLine
      .replace(/^[#>\-*\s]+/, '')        // Markdown の見出し記号や箇条書き
      .replace(/[\\/:*?"<>|]/g, ' ')     // ファイル名に使えない文字
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
    return base ? base + '.' + ext : tab.name;
  },

  /** 保存先の初期選択。前回の保存先 → ツリーで選んでいる場所、の順。 */
  defaultFolder() {
    if (App.lastSaveFolder && App.lastSaveFolder.id) return App.lastSaveFolder;
    const id = targetFolderId();
    if (!id || Tree.isTmpRoot(id)) return null;
    const node = Tree.get(id);
    return node ? { id: node.id, name: node.name } : null;
  },

  /**
   * 一時メモの保存先を決めて確定する（Cmd/Ctrl+S）。
   * @param {string} tabId
   */
  async promote(tabId) {
    const tab = getTab(tabId);
    if (!tab || !tab.temp || tab.kind !== 'text') return;
    if (tab.creating) {
      toast('一時メモを作成しています。少し待ってからもう一度お試しください。', 'info', 3000);
      return;
    }
    if (TempMemo._promoting) return;

    TempMemo._promoting = tabId;
    let choice;
    try {
      // ダイアログを開く前に tmp へ書いておく。選んでいる途中で
      // ブラウザが落ちても、書いた内容は Drive に残っている状態にする。
      if (tab.dirty) await doSave(tabId, false);
      if (!getTab(tabId)) return;

      choice = await Picker.choose({
        title: '一時メモの保存先',
        note: 'いまは「一時メモ」に入っています。選んだフォルダへ移動します。' +
          'キャンセルしても内容は一時メモとして残ります。',
        name: TempMemo.suggestName(tab),
        folder: TempMemo.defaultFolder()
      });
    } finally {
      TempMemo._promoting = null;
    }

    if (!choice) {
      toast('一時メモのまま残しました（サイドバーの「一時メモ」から開けます）', 'info', 5000);
      return;
    }
    await TempMemo.commit(tabId, choice.folderId, choice.name, false);
  },

  /**
   * 保存 → 改名 → 移動をサーバーへ 1 往復で投げ、結果を画面に反映する。
   * @param {string} tabId
   * @param {string} folderId
   * @param {string} name
   * @param {boolean} force 競合を無視して上書きするか
   */
  async commit(tabId, folderId, name, force) {
    const tab = getTab(tabId);
    if (!tab) return;

    const editorText = tabDoc(tab);
    const content = restoreEol(editorText, tab.eol);

    tab.saving = true;
    renderTabs();
    if (tabId === App.activeId) refreshStatus();

    let data;
    try {
      data = await Api.promoteTempFile(tabId, folderId, name, content,
        tab.baseUpdatedAtIso, !!force);
    } catch (err) {
      const failed = getTab(tabId);
      if (failed) {
        failed.saving = false;
        renderTabs();
        if (tabId === App.activeId) refreshStatus();
      }
      if (err.code === 'CONFLICT') {
        await TempMemo.resolveConflict(tabId, folderId, name, err);
        return;
      }
      toast('保存できませんでした: ' + err.message, 'error', 10000);
      TempMemo.flushPendingSave(tabId);
      return;
    }

    const t = getTab(tabId);
    if (!t) return;
    const entry = data.entry;

    if (data.timestampVerified === false) {
      // Drive のメタデータが追いつかず、更新日時が保存前と同じまま返ってきた。
      // 次回保存で競合として誤検出されることがある（doSave と同じ扱い）。
      console.warn('保存後の更新日時を確認できませんでした: ' + entry.name);
    }

    t.saving = false;
    // 保存先に「一時メモ」自身を選ぶこともできる（名前だけ付け直す使い方）。
    // その場合は一時メモのまま。一時メモかどうかは置き場所だけで決まる。
    t.temp = Tree.isTmpRoot(data.folder.id);
    t.name = entry.name;
    Pins.rename(tabId, entry.name);
    t.mimeType = entry.mimeType;
    t.size = entry.size;
    t.baseUpdatedAtIso = entry.updatedAtIso;
    t.lastSavedAt = new Date();
    t.conflicted = false;
    t.saveError = null;
    // 保存中に書き足されていれば dirty のままにして、次の自動保存に任せる。
    if (tabDoc(t) === editorText) {
      t.dirty = false;
      Draft.clear(tabId);
    }

    // 拡張子が変わると言語モードも変わる（.txt → .md など）。
    const langKey = EXT_TO_LANG[extensionOf(entry.name)] || null;
    if (langKey !== t.langKey) {
      t.langKey = langKey;
      void applyLanguageTo(tabId, langKey);
    }

    // ツリーの追随。移動元（一時メモ）からは消し、移動先が読み込み済みなら
    // 取り直す。開いていないフォルダは触らない（展開時に読まれるので、
    // ここで往復を増やす意味がない）。
    Tree.remove(tabId);
    const dest = Tree.get(data.folder.id);
    if (dest && dest.loaded) {
      // 祖先まで開かないと、保存したファイルが一覧に現れない
      // （flatten は畳まれたフォルダの下を出さない）。
      for (let n = dest; n; n = n.parentId ? Tree.get(n.parentId) : null) n.expanded = true;
      await loadFolder(data.folder.id, true);
    } else {
      renderTree();
    }

    App.lastSaveFolder = { id: data.folder.id, name: data.folder.name };

    renderTabs();
    renderTreeStates();
    if (tabId === App.activeId) {
      el.sbName.textContent = t.name;
      el.sbSize.textContent = formatBytes(t.size);
      renderEditorCrumbs();
      updateStatusMeta();
      updatePreviewAvailability();
      refreshStatus();
    }
    Session.save();
    toast('「' + t.name + '」を「' + data.folder.name + '」に保存しました', 'info', 4000);

    TempMemo.flushPendingSave(tabId);

    // 保存先がツリーに無いと、保存した瞬間に一覧から消えたように見える。
    if (!Tree.get(data.folder.id)) await TempMemo.offerAddRoot(data.folder);
  },

  /**
   * commit の間に自動保存（doSave）が来ていたら、ここで走らせる。
   * doSave は saving 中だと pendingSave を立てて帰るだけなので、拾わないと
   * 次の入力か blur まで最新の内容が保存されない。
   * @param {string} tabId
   */
  flushPendingSave(tabId) {
    const t = getTab(tabId);
    if (!t || !t.pendingSave || t.saving) return;
    t.pendingSave = false;
    // 競合中に force なしで保存しても同じ競合になるだけ（doSave と同じ扱い）。
    if (t.dirty && !t.conflicted) {
      clearTimeout(t.saveTimer);
      t.saveTimer = setTimeout(() => { void doSave(tabId, false); }, 200);
    }
  },

  /**
   * 保存先が競合した（別の場所で更新されていた）ときの確認。
   * @param {string} tabId
   * @param {string} folderId
   * @param {string} name
   * @param {ApiError} err
   */
  async resolveConflict(tabId, folderId, name, err) {
    const tab = getTab(tabId);
    if (!tab) return;
    const serverIso = err.detail && err.detail.serverUpdatedAtIso;

    const go = await modal({
      title: '別の場所で更新されています',
      body: h('div', {}, [
        h('p', { text: '「' + tab.name + '」は、この画面で開いたあとに別の場所で更新されています。' }),
        h('p', {
          text: 'Drive 側の最終更新: ' +
            (serverIso ? new Date(serverIso).toLocaleString('ja-JP') : '不明')
        }),
        h('p', { text: '同じ一時メモを別の端末でも開いていると起こります。' +
          'このまま保存すると、そちらの変更が失われます。' })
      ]),
      actions: [
        { label: 'この内容で保存する', value: true, variant: 'danger' },
        { label: 'キャンセル', value: false, variant: 'primary' }
      ]
    });
    if (go) await TempMemo.commit(tabId, folderId, name, true);
  },

  /**
   * ツリーに入っていないフォルダへ保存したときに、追加するか聞く。
   * @param {{id:string, name:string}} folder
   */
  async offerAddRoot(folder) {
    const go = await modal({
      title: 'このフォルダをツリーに追加しますか',
      body: h('div', {}, [
        h('p', { text: '「' + folder.name + '」はサイドバーに表示されていないため、' +
          '保存したファイルが一覧から見えません。' }),
        h('p', { text: '追加すると、いま開いているフォルダはそのまま残ります。' })
      ]),
      actions: [
        { label: '追加する', value: true, variant: 'primary' },
        { label: 'そのままにする', value: false }
      ]
    });
    if (go) await addFolderAsRoot(folder.id);
  }
};

/**
 * エクスプローラの「一時メモ」を開いて見せる。
 * まだ一度も使っていなければ、ここで tmp フォルダを用意する。
 */
async function showTempSection() {
  // Views.show は同じビューをもう一度指すとサイドバーを畳む。
  // ここでは必ず見せたいので、畳まれる条件のときだけ呼ぶ。
  if (Views.current !== 'explorer' || !Mobile.sidebarShown()) Views.show('explorer');

  const node = Tree.tmpRootId ? Tree.get(Tree.tmpRootId) : null;
  if (node && node.loaded) {
    node.expanded = true;
    renderTree();
  } else {
    if (node) node.expanded = true;
    const ok = await TempMemo.load(false);
    if (!ok) return;
    const loaded = Tree.get(Tree.tmpRootId);
    if (loaded) { loaded.expanded = true; renderTree(); }
  }

  App.selectedId = Tree.tmpRootId;
  renderTreeStates();
  Session.save();
}

/**
 * ツリーの「一時メモ」から直接、保存先を決める。
 * 本文が要るので、いったんタブとして開いてから promote に渡す。
 * @param {TreeNode} node
 */
async function promoteFromTree(node) {
  if (!node || !node.entry || !node.entry.openable) return;
  await openEntry(node.entry, { ephemeral: false });
  const tab = getTab(node.id);
  if (!tab) return;
  // このメニューは tmp 直下の行にしか出ないので、確実に一時メモ扱いにする。
  tab.temp = true;
  await TempMemo.promote(node.id);
}

