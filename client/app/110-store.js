/* ------------------------------------------------------------------ *
 *  Store — 本文のクライアント側キャッシュ（LRU + stale-while-revalidate）
 *
 *  サーバー往復は温でも 1〜2 秒かかる。一度読んだ本文はタブを閉じても
 *  ここに残し、開き直し・タブ切替・hover 先読み済みのファイルは 0ms で出す。
 *  出したあとは裏で更新日時だけ確かめ（readFile に knownUpdatedAtIso を渡すと
 *  一致なら本文を送ってこない）、変わっていて未編集なら黙って差し替える。
 *  真実の保存先は常に Drive で、ここが消えても遅くなるだけ。
 * ------------------------------------------------------------------ */

// Store の芯（inflight / content / contentChars / MAX_ENTRIES / MAX_CHARS / PREFETCH_MAX / FRESH_MS / negative / dedup / putContent / peek / touch / drop / isOpen / evict など）は client/lib/store-cache.js。ここでは残りを足す。
Object.assign(Store, {
  /**
   * 本文を読む。キャッシュがあれば即返し、古ければ裏で確かめる。
   * @param {string} id
   * @param {{prefetch?:boolean}} [opts] 先読みなら失敗を覚えて叩き続けない
   * @return {{data:(Object|null), revalidate:(Promise<Object|null>|null)}}
   *   data       … 即時に使えるキャッシュ（無ければ null → revalidate を await する）
   *   revalidate … サーバー確認。内容が変わっていれば新しい data、同じなら null
   */
  readFile(id, opts) {
    const prefetch = !!(opts && opts.prefetch);
    const cached = Store.touch(id);
    if (prefetch) {
      const until = Store.negative.get(id);
      if (until && until > Date.now()) return { data: cached, revalidate: null };
    }
    const fetchIt = (known) => Store.dedup('read:' + id, async () => {
      const end = Perf.start(cached ? 'store.revalidate' : (prefetch ? 'store.prefetch' : 'store.miss'));
      try {
        const res = known ? await Api.readFile(id, known) : await Api.readFile(id);
        if (res && res.unchanged) {
          if (cached) cached.at = Date.now();
          end({ unchanged: true });
          return null;
        }
        end({ len: res.content.length });
        return Store.putContent(res);
      } catch (err) {
        end({ error: err && err.code });
        if (prefetch) Store.negative.set(id, Date.now() + 30000);
        throw err;
      }
    });
    if (cached) {
      const fresh = Date.now() - cached.at < Store.FRESH_MS;
      // 変更ログで追えている本文は確かめない（変わっていれば ChangeFeed が差し替える）。
      // 代わりにログを 1 回問い合わせる（直前に問い合わせていれば何もしない）。
      const covered = !prefetch && !fresh && ChangeFeed.covers(cached.at);
      if (covered) void ChangeFeed.poll();
      return {
        data: cached,
        revalidate: (prefetch || fresh || covered) ? null : fetchIt(cached.updatedAtIso).catch(() => null)
      };
    }
    return { data: null, revalidate: fetchIt(null) };
  },

  /**
   * 開いているのに本文をまだ読んでいないタブを、起動直後の空き時間に 1 往復でまとめて読む。
   * 以前はタブを切り替えた瞬間に readFile を呼んでいたので、切替のたびに 1〜2 秒待っていた。
   */
  prefetchTabs() {
    const ids = App.tabs
      .filter((t) => t.kind === 'text' && !t.loaded && !t.pending && !Store.peek(t.id))
      .map((t) => t.id)
      .slice(0, 20);
    if (!ids.length) return;
    const run = async () => {
      // 直接 API が使える設定なら、トークンが届く（getBootstrap）まで待って REST で読む。
      if (App.config && App.config.directDrive && !DriveApi.ready() && Boot.ready) await Boot.ready;
      const end = Perf.start('store.prefetchTabs');
      try {
        const got = await Api.readFilesMulti(ids);
        let n = 0;
        for (const d of Object.values(got || {})) {
          if (d && typeof d.content === 'string') { Store.putContent(d); n++; }
        }
        end({ asked: ids.length, got: n });
        renderTabs();   // 「未読み込み」の斜体を外す
      } catch (err) {
        end({ error: true });
        console.warn('タブの先読みに失敗しました: ' + err.message);
      }
    };
    if (window.requestIdleCallback) requestIdleCallback(() => { void run(); }, { timeout: 3000 });
    else setTimeout(() => { void run(); }, 300);
  }
});

// 開いているタブの本文は追い出さない（タブは Store の外にあるので、ここで差し込む）。
Store.isOpen = (id) => !!getTab(id);

/**
 * ツリー行の hover 先読み。
 * ポインタが 150ms 止まったファイルは本文を、300ms 止まった未読込フォルダは一覧を
 * 裏で取っておく。クリックされた時点で手元にあれば 0ms で出せる。
 * 省データ設定や遅い回線では動かさない。
 */
const Prefetch = {
  timer: 0,
  id: null,

  slowNet() {
    const c = navigator.connection;
    return !!(c && (c.saveData || /2g$/.test(c.effectiveType || '')));
  },

  onOver(row) {
    const id = row.dataset.nodeId;
    if (id === Prefetch.id) return;   // 同じ行の中で子要素をまたいだだけ
    Prefetch.cancel();
    Prefetch.id = id;
    const node = Tree.get(id);
    if (!node || Prefetch.slowNet()) return;

    if (node.type === 'file') {
      const e = node.entry;
      if (!e || !e.openable || e.viewer !== 'editor' || e.size > Store.PREFETCH_MAX || Store.peek(id)) return;
      Prefetch.timer = setTimeout(() => {
        const r = Store.readFile(id, { prefetch: true });
        if (r.revalidate) r.revalidate.catch(() => { /* 先読みの失敗は無視 */ });
      }, 150);
    } else if (!node.loaded && !node.loading && !Tree.isTmpRoot(id)) {
      Prefetch.timer = setTimeout(() => { void prefetchFolder(id); }, 300);
    }
  },

  cancel() {
    clearTimeout(Prefetch.timer);
    Prefetch.timer = 0;
    Prefetch.id = null;
  }
};

/** 未読込フォルダの一覧を裏で取り込む（展開はしない。次のクリックで即開く）。 */
async function prefetchFolder(folderId) {
  const node = Tree.get(folderId);
  if (!node || node.loaded || node.loading) return;
  try {
    const data = await Store.dedup('list:' + folderId, () => Api.listEntries(folderId, false));
    const n = Tree.get(folderId);
    if (!n || n.loaded || n.loading) return;   // その間に通常の読み込みが走った
    Tree.ingest(folderId, data);
    if (n.expanded) renderTree();
  } catch (err) {
    // 先読みの失敗は無視。クリック時に通常経路で読んで、そこでエラーを出す。
  }
}

/** 展開済みフォルダの一覧が古ければ、裏で取り直して変わっていたときだけ描き直す。 */
async function revalidateFolder(folderId) {
  const node = Tree.get(folderId);
  if (!node || !node.loaded || node.loading || Tree.isTmpRoot(folderId)) return;
  try {
    const data = await Store.dedup('list:' + folderId, () => Api.listEntries(folderId, false));
    const n = Tree.get(folderId);
    if (!n || n.loading) return;
    if (folderSig(data) === n.sig) { n.listedAt = Date.now(); return; }
    Tree.ingest(folderId, data);
    renderTree();
  } catch (err) {
    // 裏の確認なので黙る。
  }
}

