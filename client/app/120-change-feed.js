/* ------------------------------------------------------------------ *
 *  ChangeFeed — Drive の変更ログ（changes.list）で「何が変わったか」をまとめて知る
 *
 *  これまでは展開し直したフォルダを 60 秒ごとに取り直し、タブを切り替えるたびに
 *  そのファイルの更新日時を確かめていた（フォルダ・ファイルの数だけ往復が要る）。
 *  変更ログなら 1 リクエストで、前回から変わったものがルートをまたいで全部返る。
 *
 *  - 起動後に startPageToken を 1 回取り、以降は見えている間 60 秒ごとと、
 *    画面に戻ってきたとき・フォルダを開き直したときに問い合わせる
 *  - 変わったファイルが「読み込み済みのフォルダ」の子なら、そのフォルダを取り直す
 *    （名前・置き場所・有無が変わったときだけ。更新日時とサイズだけなら行を書き換える）
 *  - 開いていて未編集のタブの中身が変わっていたら、黙って差し替える
 *  - ファイル名の索引（FileIndex）も同じ変更で書き換える
 *
 *  ログが生きている間は、ログが始まったあとに読んだ本文・一覧の再確認を省く
 *  （変わっていれば次の問い合わせで分かるため）。直接 API が使えないとき
 *  （GAS 経由）は動かず、従来どおりの再確認に任せる。
 * ------------------------------------------------------------------ */

const ChangeFeed = {
  token: null,
  /** ログを取り始めた時刻。これより後に読んだものはログで追える。 */
  since: 0,
  /** 最後に問い合わせに成功した時刻。 */
  okAt: 0,
  /** @type {Promise|null} */
  inflight: null,
  lastPollAt: 0,
  timer: 0,
  POLL_MS: 60000,
  /** 画面に戻ったときなど、続けて問い合わせないための最短間隔。 */
  MIN_GAP_MS: 5000,
  FIELDS: 'nextPageToken,newStartPageToken,changes(fileId,removed,' +
    'file(id,name,mimeType,size,modifiedTime,parents,trashed))',

  /** 直接 API が使えるなら、変更ログを取り始める。 */
  async start() {
    if (ChangeFeed.token || !Api.useDirect()) return;
    try {
      const body = await DriveApi.json('changes/startPageToken', { supportsAllDrives: true }, null, '変更ログ');
      ChangeFeed.token = body.startPageToken;
      ChangeFeed.since = Date.now();
      ChangeFeed.okAt = Date.now();
      ChangeFeed.lastPollAt = Date.now();
      ChangeFeed.schedule();
    } catch (err) {
      console.warn('Drive の変更ログを取れませんでした（従来どおり個別に確かめます）: ' + err.message);
    }
  },

  /** ログが途切れていないか。途切れたら従来の再確認に戻す。 */
  live() {
    return !!ChangeFeed.token && Api.useDirect() && Date.now() - ChangeFeed.okAt < ChangeFeed.POLL_MS * 2;
  },

  /**
   * 時刻 t 以降に読んだものなら、変化はログで追えるので再確認は要らない。
   * @param {number} t
   */
  covers(t) {
    return ChangeFeed.live() && t >= ChangeFeed.since;
  },

  schedule() {
    clearTimeout(ChangeFeed.timer);
    ChangeFeed.timer = setTimeout(() => {
      if (document.visibilityState === 'visible') void ChangeFeed.poll();
      else ChangeFeed.schedule();
    }, ChangeFeed.POLL_MS);
  },

  /**
   * 変更ログを問い合わせて反映する。直前に問い合わせたばかりなら何もしない。
   * @param {boolean} [force] 間隔を無視する
   */
  poll(force) {
    if (!ChangeFeed.token || !Api.useDirect()) return Promise.resolve();
    if (ChangeFeed.inflight) return ChangeFeed.inflight;
    if (!force && Date.now() - ChangeFeed.lastPollAt < ChangeFeed.MIN_GAP_MS) return Promise.resolve();
    ChangeFeed.lastPollAt = Date.now();
    const end = Perf.start('changes.poll');
    ChangeFeed.inflight = (async () => {
      const changes = [];
      let pageToken = ChangeFeed.token;
      let newStart = null;
      for (let page = 0; pageToken && page < 10; page++) {
        const body = await DriveApi.json('changes', {
          pageToken, fields: ChangeFeed.FIELDS, pageSize: 1000, spaces: 'drive',
          supportsAllDrives: true, includeItemsFromAllDrives: true, includeRemoved: true
        }, null, '変更ログ');
        for (const c of body.changes || []) changes.push(c);
        newStart = body.newStartPageToken || null;
        pageToken = body.nextPageToken || null;
      }
      // 10 ページで読み切れないほど溜まっていたら、ログを捨てて取り直す。
      // 細かく追うより、開いているフォルダを取り直したほうが早い。
      if (pageToken && !newStart) {
        ChangeFeed.token = null;
        for (const node of Tree.nodes.values()) {
          if (node.type === 'folder' && node.loaded && node.expanded) void revalidateFolder(node.id);
        }
        void ChangeFeed.start();
        end({ overflow: true });
        return;
      }
      ChangeFeed.token = newStart || ChangeFeed.token;
      ChangeFeed.okAt = Date.now();
      ChangeFeed.apply(changes);
      end({ n: changes.length });
    })()
      .catch((err) => {
        end({ error: err && err.code });
        // 失敗が続くと live() が false になり、従来の再確認に戻る。
        console.warn('Drive の変更ログを読めませんでした: ' + (err && err.message ? err.message : err));
      })
      .finally(() => {
        ChangeFeed.inflight = null;
        if (ChangeFeed.token) ChangeFeed.schedule();
      });
    return ChangeFeed.inflight;
  },

  /** @param {Array<Object>} changes changes.list の changes */
  apply(changes) {
    if (!changes.length) return;
    // 同じファイルが何度も出てくるので、最後の状態だけ見る。
    const latest = new Map();
    for (const c of changes) if (c.fileId) latest.set(c.fileId, c);

    const relist = new Set();
    const loadedFolder = (id) => {
      const n = id ? Tree.get(id) : null;
      return n && n.type === 'folder' && n.loaded ? n : null;
    };

    for (const [id, c] of latest) {
      const f = c.file || null;
      const gone = c.removed || !f || f.trashed;
      const node = Tree.get(id);
      const parents = (f && f.parents) || [];
      const isFolder = f ? f.mimeType === DriveApi.FOLDER : (node ? node.type === 'folder' : false);

      if (isFolder) Direct.searchScope = null;   // 全体検索が辿った階層はもう古い
      ChangeFeed.patchIndex(id, f, gone, isFolder);

      if (node) {
        const moved = !gone && node.parentId && parents.indexOf(node.parentId) < 0;
        const renamed = !gone && f.name !== node.name;
        if (gone || moved || renamed) {
          if (loadedFolder(node.parentId)) relist.add(node.parentId);
        } else if (node.type === 'file' && node.entry) {
          const iso = DriveApi.iso(f.modifiedTime);
          if (iso !== node.entry.updatedAtIso) {
            patchEntry(id, { updatedAtIso: iso, size: Number(f.size) || node.entry.size });
          }
        }
      }
      if (!gone) {
        for (const pid of parents) {
          // 新しく現れたもの・移ってきたものは、その親を取り直すと出てくる。
          if (loadedFolder(pid) && !(node && node.parentId === pid)) relist.add(pid);
        }
      }

      if (!gone && f && !isFolder) ChangeFeed.refreshTab(id, DriveApi.iso(f.modifiedTime));
    }

    for (const folderId of relist) void revalidateFolder(folderId);
  },

  /** 開いていて未編集のタブの中身が Drive 側で変わっていたら差し替える。 */
  refreshTab(id, iso) {
    const tab = getTab(id);
    const cached = Store.peek(id);
    if (cached && cached.updatedAtIso !== iso) cached.at = 0;   // 次に使うときは確かめる
    if (!tab || tab.kind !== 'text' || !tab.loaded || tab.dirty || tab.saving) return;
    if (tab.baseUpdatedAtIso === iso) return;   // 自分の保存
    void Store.dedup('read:' + id, () => Api.readFile(id, tab.baseUpdatedAtIso))
      .then((res) => {
        if (!res || res.unchanged) return;
        applyFreshContent(id, Store.putContent(res));
      })
      .catch(() => { /* 裏の更新なので黙る。開き直したときに通常経路で確かめる */ });
  },

  /** ファイル名の索引を、ログの 1 件ぶん書き換える。 */
  patchIndex(id, f, gone, isFolder) {
    if (!FileIndex.usable()) return;
    const d = FileIndex.data;
    if (gone) { FileIndex.drop(id); return; }
    const parentId = (f.parents || []).find((pid) => d.folders.has(pid));
    if (!parentId) { FileIndex.drop(id); return; }   // 索引の範囲の外へ出た
    if (isFolder) {
      // 中身は次の作り直しで拾う。名前と置き場所だけ合わせておく（パスの表示に使う）。
      d.folders.set(id, { name: f.name, parentId });
      return;
    }
    const entry = Direct.entryFromMeta(f);
    if (!entry.openable) { FileIndex.drop(id); return; }
    d.files.set(id, {
      name: entry.name, parentId, kind: entry.viewer === 'embed' ? entry.kind : 'text',
      size: entry.size, updatedAtIso: entry.updatedAtIso
    });
  }
};

/**
 * 裏で取り直した本文がキャッシュより新しかったとき、未編集のタブなら黙って差し替える。
 * 編集中・保存中は触らない（保存時の競合検出に任せる）。
 */
function applyFreshContent(fileId, fresh) {
  const tab = getTab(fileId);
  if (!tab || !tab.loaded || tab.dirty || tab.saving) return;
  if (fresh.updatedAtIso === tab.baseUpdatedAtIso) return;
  Editor.replaceDocKeepView(tab, fresh);
  patchEntry(fileId, { updatedAtIso: fresh.updatedAtIso, size: fresh.size });
}

