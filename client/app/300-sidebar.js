/* ------------------------------------------------------------------ *
 *  サイドバー（フォルダツリー）
 *
 *  ルートは基準フォルダ。1 階層ずつ遅延ロードし、展開状態はセッションに残す。
 *  ノードはフラットな Map で持ち、描画時に再帰的に並べ直す。
 *  ネストした DOM にしないのは、ドラッグ＆ドロップと絞り込みの扱いが単純になるため。
 * ------------------------------------------------------------------ */

// Tree（client/lib/tree-model.js）から消えたノードの後始末。
// ファイル名の索引と閉じたタブの記録はモデルの外にあるので、ここで差し込む。
Tree.onRemoved = (id) => {
  FileIndex.drop(id);
  ClosedTabs.forget(id);
};

/**
 * フォルダの中身を読み込む。
 * @param {string} folderId
 * @param {boolean} [force] キャッシュを無視する
 * @return {Promise<boolean>} 成功したか
 */
async function loadFolder(folderId, force) {
  const node = Tree.get(folderId);
  if (!node) return false;
  // 一時メモは listEntries ではなく専用 API を通す。フォルダの実体がまだ
  // 無いことがあるのと、古いメモの掃除を一緒に走らせるため。
  if (Tree.isTmpRoot(folderId)) return TempMemo.load(force);
  node.loading = true;
  renderTree();
  try {
    const data = await Store.dedup('list:' + folderId + (force ? ':force' : ''),
      () => Api.listEntries(folderId, !!force));
    Tree.ingest(folderId, data);
    return true;
  } catch (err) {
    node.loading = false;
    node.expanded = false;
    toast('「' + node.name + '」を開けませんでした: ' + err.message, 'error', 10000);
    return false;
  } finally {
    node.loading = false;
    renderTree();
  }
}

/** フォルダを開閉する。初回展開時にだけ読み込む。 */
async function toggleFolder(folderId) {
  const node = Tree.get(folderId);
  if (!node || node.type !== 'folder') return;

  if (node.expanded) {
    node.expanded = false;
    renderTree();
    Session.save();
    return;
  }

  node.expanded = true;
  if (!node.loaded) {
    await loadFolder(folderId, false);
  } else {
    renderTree();
    // 変更ログで追えているなら、フォルダを取り直す代わりにログを 1 回見る。
    if (ChangeFeed.covers(node.listedAt || 0)) void ChangeFeed.poll();
    else if (Date.now() - (node.listedAt || 0) > 60000) void revalidateFolder(folderId);
  }
  Session.save();
}

