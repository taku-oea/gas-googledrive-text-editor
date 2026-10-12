/* ------------------------------------------------------------------ *
 *  DraftStash — 保存に失敗した内容を Drive にも退避する
 *
 *  下書き（Draft）は localStorage にしか無く、HtmlService の iframe は再読み込みで
 *  オリジンが変わることがあるので、保存に失敗したまま閉じると失われうる。
 *  そこで保存に失敗したときだけ、マイドライブの「<アプリ名> / drafts」に
 *  プレーンテキストとして書いておく（Drive で直接開いても読める）。
 *
 *  - 目印は appProperties（gdteDraft=1, gdteDraftFor=<元の fileId>）。
 *    起動後に 1 本の files.list で一覧を取り、そのファイルを開いたときに復元を提案する
 *  - 要らなくなったら（保存できた・捨てた・元のファイルを消した）Draft.clear から消す。
 *    消すのはこの仕組みが作った退避ファイルだけで、ゴミ箱を経由せず削除する
 *  - 直接 API が使えないとき（GAS 経由）は何もしない（localStorage の下書きだけになる）
 * ------------------------------------------------------------------ */

const DraftStash = {
  /** サーバーの TMP_APP_FOLDER_NAME と同じ。 */
  APP_FOLDER: 'Googleドライブテキストエディタ',
  FOLDER: 'drafts',
  /** 同じファイルを続けて退避しない間隔（自動保存の失敗が続いても書き込みを増やさない）。 */
  THROTTLE_MS: 15000,
  folderId: null,
  /** @type {Promise<string>|null} 探し中・作成中のフォルダ（同時に失敗しても 1 つだけ作る） */
  folderP: null,
  /** @type {Map<string, {stashId:string, at:number, base:string, name:string}>} 元の fileId → 退避ファイル */
  known: new Map(),
  /** @type {Map<string, number>} 一覧が届く前に Draft.clear された fileId → 時刻 */
  clearedAt: new Map(),
  /** @type {Map<string, {at:number, content:string, timer:number}>} */
  last: new Map(),
  /** @type {Map<string, Promise>} ファイルごとの書き込みを直列にする */
  chains: new Map(),
  /** @type {Promise|null} 起動後の一覧取得 */
  ready: null,
  told: false,

  usable() { return Api.useDirect(); },

  /** 起動後に一度だけ、退避ファイルの一覧を取る。 */
  sync() {
    if (DraftStash.ready || !DraftStash.usable()) return DraftStash.ready;
    DraftStash.ready = (async () => {
      const body = await DriveApi.json('files', {
        q: "appProperties has { key='gdteDraft' and value='1' } and trashed = false",
        fields: 'files(id,name,appProperties)', pageSize: 100, spaces: 'drive'
      }, null, '退避した下書き');
      for (const f of body.files || []) {
        const p = f.appProperties || {};
        if (!p.gdteDraftFor) continue;
        const rec = { stashId: f.id, at: Number(p.gdteAt) || 0, base: p.gdteBase || '', name: p.gdteName || f.name };
        const cleared = DraftStash.clearedAt.get(p.gdteDraftFor);
        DraftStash.known.set(p.gdteDraftFor, rec);
        // 一覧が届く前に保存できていたものは、もう要らない。
        if (cleared && cleared > rec.at) DraftStash.drop(p.gdteDraftFor);
      }
      DraftStash.clearedAt.clear();
      const waiting = Array.from(DraftStash.known.keys()).filter((id) => !getTab(id));
      if (waiting.length) {
        toast('保存できなかった内容を Drive に退避したファイルが ' + waiting.length + ' 件あります。' +
          'コマンドパレットの「退避した下書きを確認する」から開けます。', 'warn', 12000);
      }
    })().catch((err) => {
      console.warn('退避した下書きの一覧を取れませんでした: ' + err.message);
    });
    return DraftStash.ready;
  },

  /** 「<アプリ名> / drafts」を探し、無ければ作る。 */
  folder() {
    if (DraftStash.folderId) return Promise.resolve(DraftStash.folderId);
    if (!DraftStash.folderP) {
      DraftStash.folderP = DraftStash.findOrCreateFolder()
        .then((id) => { DraftStash.folderId = id; return id; })
        .finally(() => { DraftStash.folderP = null; });
    }
    return DraftStash.folderP;
  },

  async findOrCreateFolder() {
    const child = async (parent, name) => {
      const body = await DriveApi.json('files', {
        q: "'" + parent + "' in parents and name = '" + DriveApi.escQ(name) + "' and mimeType = '" +
          DriveApi.FOLDER + "' and trashed = false",
        fields: 'files(id)', pageSize: 1
      }, null, 'フォルダ');
      if (body.files && body.files[0]) return body.files[0].id;
      const made = await DriveApi.json('files', { fields: 'id' },
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, parents: [parent], mimeType: DriveApi.FOLDER }) }, 'フォルダ');
      return made.id;
    };
    const app = await child('root', (App.config && App.config.tmpAppFolderName) || DraftStash.APP_FOLDER);
    return child(app, DraftStash.FOLDER);
  },

  /**
   * 保存に失敗した内容を退避する。短い間に何度も呼ばれたら、最後の内容を少し遅れて書く。
   * @param {Tab} tab
   */
  put(tab) {
    if (!tab || tab.kind !== 'text' || !tab.loaded || String(tab.id).indexOf('new:') === 0) return;
    if (!DraftStash.usable()) return;
    const id = tab.id;
    const content = tabDoc(tab);
    const prev = DraftStash.last.get(id);
    if (prev && prev.content === content) return;
    const wait = prev ? prev.at + DraftStash.THROTTLE_MS - Date.now() : 0;
    if (wait > 0) {
      clearTimeout(prev.timer);
      prev.timer = setTimeout(() => { const t = getTab(id); if (t && t.dirty) DraftStash.put(t); }, wait);
      return;
    }
    DraftStash.last.set(id, { at: Date.now(), content, timer: 0 });
    const job = () => DraftStash.write(id, tab.name, content, tab.baseUpdatedAtIso);
    const chain = (DraftStash.chains.get(id) || Promise.resolve()).then(job, job);
    DraftStash.chains.set(id, chain);
  },

  async write(fileId, name, content, base) {
    try {
      const at = Date.now();
      const props = { gdteDraft: '1', gdteDraftFor: fileId, gdteBase: base || '', gdteAt: String(at),
        gdteName: String(name || '').slice(0, 100) };
      const meta = { appProperties: props, mimeType: 'text/plain' };
      const existing = DraftStash.known.get(fileId);
      if (!existing) {
        meta.name = (name || fileId) + '.下書き.txt';
        meta.parents = [await DraftStash.folder()];
      }
      const boundary = 'gdte_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      const body =
        '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(meta) + '\r\n--' + boundary + '\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' +
        content + '\r\n--' + boundary + '--';
      const saved = await DriveApi.upload(existing ? 'files/' + encodeURIComponent(existing.stashId) : 'files',
        { uploadType: 'multipart', fields: 'id' },
        { method: existing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body },
        '下書きの退避');
      DraftStash.known.set(fileId, { stashId: saved.id, at, base: base || '', name: name || '' });
      if (!DraftStash.told) {
        DraftStash.told = true;
        toast('保存できなかった内容を、Drive の「' + DraftStash.APP_FOLDER + ' / ' + DraftStash.FOLDER +
          '」にも退避しました。保存できた時点で消えます。', 'info', 8000);
      }
    } catch (err) {
      console.warn('下書きを Drive に退避できませんでした: ' + err.message);
    }
  },

  /**
   * 退避した内容を読む（そのファイルを開いたときの復元提案用）。
   * @return {Promise<{content:string, at:number, baseUpdatedAtIso:string}|null>}
   */
  async load(fileId) {
    if (DraftStash.ready) await DraftStash.ready;
    const rec = DraftStash.known.get(fileId);
    if (!rec || !DraftStash.usable()) return null;
    try {
      const content = await DriveApi.text('files/' + encodeURIComponent(rec.stashId), { alt: 'media' }, '退避した下書き');
      return { content: normalizeEol(content), at: rec.at, baseUpdatedAtIso: rec.base, fromDrive: true };
    } catch (err) {
      if (err && err.code === 'NOT_FOUND') DraftStash.known.delete(fileId);
      return null;
    }
  },

  /** 要らなくなった退避ファイルを消す。一覧が届く前なら時刻だけ覚えておく。 */
  drop(fileId) {
    const last = DraftStash.last.get(fileId);
    if (last) clearTimeout(last.timer);
    DraftStash.last.delete(fileId);
    const pending = DraftStash.chains.get(fileId);
    if (!pending && !DraftStash.known.has(fileId)) {
      if (!DraftStash.ready) DraftStash.clearedAt.set(fileId, Date.now());
      return;
    }
    // 書き込みが走っていれば、それが終わってから消す。最初の書き込み（POST）の途中だと
    // まだ known に載っていないので、どれを消すかは順番が回ってきた時点で見る。
    const job = async () => {
      const rec = DraftStash.known.get(fileId);
      if (!rec) return;
      DraftStash.known.delete(fileId);
      if (!DraftStash.usable()) return;
      try {
        await DriveApi.http('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(rec.stashId),
          { method: 'DELETE' }, '退避した下書き');
      } catch (err) {
        console.warn('退避した下書きを消せませんでした: ' + err.message);
      }
    };
    const chain = (pending || Promise.resolve()).then(job, job);
    DraftStash.chains.set(fileId, chain);
  },

  /** 退避ファイルの一覧を出し、元のファイルを開けるようにする。 */
  async showList() {
    if (DraftStash.ready) await DraftStash.ready;
    const items = Array.from(DraftStash.known.entries());
    if (!items.length) {
      toast('Drive に退避した下書きはありません', 'info', 3500);
      return;
    }
    let close = null;
    const list = h('div', { class: 'stashList' }, items.map(([fileId, rec]) => h('button', {
      type: 'button',
      class: 'btn btn--ghost stashList__item',
      onclick: () => { if (close) close(fileId); }
    }, [
      h('span', { class: 'stashList__name', text: rec.name || fileId }),
      h('span', { class: 'stashList__at', text: rec.at ? new Date(rec.at).toLocaleString('ja-JP') : '' })
    ])));
    const picked = await modal({
      title: '退避した下書き',
      body: h('div', {}, [
        h('p', { text: '保存できなかった編集内容です。ファイルを開くと、復元するかどうかを選べます。' }),
        list
      ]),
      actions: [{ label: '閉じる', value: null }],
      onOpen: (api) => { close = api.close; const first = list.querySelector('button'); if (first) first.focus(); }
    });
    if (!picked) return;
    const rec = DraftStash.known.get(picked);
    await openFile(picked, rec ? rec.name : '', 'text', { ephemeral: false });
  }
};

