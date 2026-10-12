/* ---------------------- ツリーの描画 ---------------------- */

function renderTree() {
  const endRender = Perf.start('tree.renderAll');
  const needle = App.filter.trim().toLowerCase();
  el.entryList.textContent = '';

  const frag = document.createDocumentFragment();

  // ピン留めは絞り込みの対象外。読み込んでいない階層のファイルも並んでいるので、
  // 絞り込み結果に混ぜると「一致したものが全部出ている」という読み方が崩れる。
  if (!needle) appendPinRows(frag);

  // ルートが 1 つも無くてもピン留めは使える（ファイル ID だけで開けるため）。
  if (!Tree.allRootIds().length) {
    frag.appendChild(h('div', {
      class: 'placeholder',
      text: 'フォルダが選択されていません。ヘッダーの「フォルダを管理」から追加してください。'
    }));
    el.entryList.appendChild(frag);
    el.sidebarFoot.textContent = Pins.items.length ? 'ピン留め ' + Pins.items.length + ' 件' : '';
    endRender({ rows: el.entryList.childElementCount, filtered: false });
    return;
  }

  if (needle) {
    // 絞り込み中は階層を無視して、読み込み済みのファイルを平坦に並べる。
    const hits = Tree.matchingFiles(needle);
    for (const node of hits) frag.appendChild(buildTreeRow(node, 0, true, null));
    if (!hits.length) {
      frag.appendChild(h('div', {
        class: 'placeholder placeholder--lines',
        text: '「' + App.filter + '」に一致するファイルはありません。\n（読み込み済みの階層のみが対象です）'
      }));
    }
    el.sidebarFoot.textContent = '絞り込み ' + hits.length + ' 件';
  } else {
    const rows = Tree.flatten();
    const edit = App.inlineEdit;

    for (const { node, depth, path } of rows) {
      frag.appendChild(buildTreeRow(node, depth, false, path));

      // 新規作成の入力行は、対象フォルダの直下（子より前）に出す。
      if (edit && !edit.nodeId && edit.parentId === node.id) {
        frag.appendChild(buildInlineEditRow(
          null, depth + 1, edit.mode === 'newFolder' ? 'folder-new' : 'file-new', ''));
      }
    }
    const files = rows.filter((r) => r.node.type === 'file').length;
    const folders = rows.filter((r) => r.node.type === 'folder' && !Tree.isRoot(r.node.id)).length;
    const truncated = Tree.allRootIds().some((id) => {
      const n = Tree.get(id);
      return n && n.truncated;
    });
    el.sidebarFoot.textContent =
      'ルート ' + Tree.rootIds.length + ' / フォルダ ' + folders + ' / ファイル ' + files +
      (truncated ? ' · 件数が多いため一部のみ表示' : '');
  }

  el.entryList.appendChild(frag);
  renderTreeStates();
  endRender({ rows: el.entryList.childElementCount, filtered: !!needle });
}

/**
 * ツリーの 1 行を作る。
 * @param {TreeNode} node
 * @param {number} depth
 * @param {boolean} flat 絞り込み表示か（インデントとパス表示が変わる）
 * @return {HTMLElement}
 */
function buildTreeRow(node, depth, flat, path) {
  const isFolder = node.type === 'folder';
  const entry = node.entry;
  const openable = isFolder || (entry && entry.openable);

  const twisty = h('button', {
    type: 'button',
    class: 'row__twisty' +
      (isFolder ? (node.expanded ? ' row__twisty--open' : '') : ' row__twisty--leaf') +
      (node.loading ? ' row__twisty--busy' : ''),
    tabindex: isFolder ? null : '-1',
    title: isFolder ? (node.expanded ? '折りたたむ' : '展開') : null,
    onclick: (ev) => {
      ev.stopPropagation();
      if (isFolder) void toggleFolder(node.id);
    }
  }, isFolder ? [icon('chevron')] : []);

  const isTmpRoot = Tree.isTmpRoot(node.id);
  const rowIcon = isTmpRoot
    ? icon('memo')
    : isFolder
    ? icon(node.expanded ? 'folder-open' : 'folder', 'icon--folder')
    : VIEWERS[entry.kind]
      ? icon(VIEWERS[entry.kind].icon, VIEWERS[entry.kind].iconClass)
    : entry.kind === 'google' ? icon('blocked', 'icon--muted')
    : entry.openable ? icon('file-text', 'icon--file')
    : icon('warning', 'icon--warn');

  // ツールチップはここで作らない。パス組み立てと toLocaleString（Intl は遅い）を
  // 行数ぶん実行することになり、絞り込みの 1 打鍵ごとにそれが走ってしまう。
  // 実際にホバーされたときだけ組み立てる（buildTooltip / mouseover の委譲）。
  // この行がインライン編集中なら、名前の代わりに入力欄を出す。
  if (App.inlineEdit && App.inlineEdit.mode === 'rename' && App.inlineEdit.nodeId === node.id) {
    return buildInlineEditRow(node, depth, isFolder ? 'folder-open' : 'file-text', node.name);
  }

  const main = h('button', {
    type: 'button',
    class: 'row__main',
    onclick: (ev) => {
      const mods = { meta: ev.metaKey || ev.ctrlKey, shift: ev.shiftKey };
      selectNode(node.id, mods);
      // 修飾キー付きは選択操作なので、開いたり畳んだりしない。
      if (mods.meta || mods.shift) return;
      if (isFolder) void toggleFolder(node.id);
      else if (!entry.openable) toast(entry.reason, 'warn');
      // シングルクリックは仮タブ。次のクリックで枠が入れ替わるのでタブが増えない。
      else void openEntry(entry, { ephemeral: true });
    },
    ondblclick: () => {
      // ダブルクリックで固定する（VS Code と同じ）。
      if (isFolder || !entry.openable) return;
      void openEntry(entry, { ephemeral: false });
    }
  }, [
    h('span', { class: 'row__icon' }, [rowIcon]),
    h('span', { class: 'row__name', text: node.name }),
    flat
      ? h('span', { class: 'row__meta', text: parentNameOf(node) })
      : (!isFolder ? h('span', { class: 'row__meta', text: formatRelative(entry.updatedAtIso) }) : null)
  ]);

  const isTreeRoot = Tree.isRoot(node.id);
  // フォルダ行にはホバーで新規作成のボタンを出す（VS Code と同じ位置）。
  // 一時メモのセクションだけは、作れるものが一時メモしかないので 1 つだけ出す。
  const actions = isTmpRoot
    ? h('div', { class: 'row__actions' }, [
        h('button', {
          type: 'button', class: 'row__act', title: '新しい一時メモ',
          onclick: (ev) => { ev.stopPropagation(); void TempMemo.create(); }
        }, [icon('memo')]),
        h('button', {
          type: 'button', class: 'row__act', title: '再読み込み',
          onclick: (ev) => { ev.stopPropagation(); void TempMemo.refresh(); }
        }, [icon('refresh')])
      ])
    : isFolder
    ? h('div', { class: 'row__actions' }, [
        h('button', {
          type: 'button', class: 'row__act', title: '新規ファイル',
          onclick: (ev) => { ev.stopPropagation(); startInlineCreate('newFile', node.id); }
        }, [icon('file-new')]),
        h('button', {
          type: 'button', class: 'row__act', title: '新規フォルダ',
          onclick: (ev) => { ev.stopPropagation(); startInlineCreate('newFolder', node.id); }
        }, [icon('folder-new')])
      ])
    : h('div', { class: 'row__actions' }, [
        h('button', {
          type: 'button', class: 'row__act', title: '名前を変更 (F2)',
          onclick: (ev) => { ev.stopPropagation(); startInlineRename(node); }
        }, [icon('rename')]),
        h('button', {
          type: 'button', class: 'row__act row__act--danger', title: 'ゴミ箱へ移動',
          onclick: (ev) => { ev.stopPropagation(); void doTrash(node); }
        }, [icon('trash')])
      ]);

  const row = h('div', {
    class: 'row' + (openable ? '' : ' row--disabled') + (isTreeRoot ? ' row--treeRoot' : '') +
      (isTmpRoot ? ' row--tmpRoot' : ''),
    'data-node-id': node.id,
    'data-type': node.type,
    'data-path': path || null,
    // ルートはツリーの土台なので動かさない（外すのは「フォルダを管理」から）。
    draggable: isTreeRoot ? null : 'true',
    oncontextmenu: (ev) => {
      ev.preventDefault();
      // 選択の外を右クリックしたら、その行だけの選択に切り替える。
      if (!App.selection.has(node.id)) selectNode(node.id, {});
      else { App.selectedId = node.id; renderTreeStates(); }
      showNodeMenu(ev.clientX, ev.clientY, node);
    }
  }, [twisty, main, actions]);

  // インデントはトグルの左マージンで表現する。行自体は全幅のままにしておくと、
  // ホバーや選択のハイライトが端まで届いて VS Code と同じ見え方になる。
  if (!flat && depth > 0) twisty.style.marginLeft = (depth * 13) + 'px';
  wireDragAndDrop(row, node);
  return row;
}

/**
 * 行の上で直接名前を編集する入力欄を持つ行を作る。
 *
 * @param {TreeNode|null} node 改名なら対象ノード、新規作成なら null
 * @param {number} depth インデント段数
 * @param {string} iconName スプライトのシンボル名
 * @param {string} initial 初期値
 * @return {HTMLElement}
 */
function buildInlineEditRow(node, depth, iconName, initial) {
  const edit = App.inlineEdit;
  const input = h('input', {
    type: 'text',
    class: 'row__edit',
    value: initial,
    spellcheck: 'false',
    autocomplete: 'off'
  });

  const errorNode = h('div', { class: 'rowError', hidden: true });
  let busy = false;

  const finish = async () => {
    if (busy) return;
    const name = input.value.trim();
    if (!name || (node && name === node.name)) { cancel(); return; }

    busy = true;
    input.disabled = true;
    try {
      await commitInlineEdit(edit, name);
      App.inlineEdit = null;
      renderTree();
    } catch (err) {
      // 失敗しても行は残す。名前を直して再挑戦できるようにする。
      busy = false;
      input.disabled = false;
      input.classList.add('row__edit--invalid');
      errorNode.hidden = false;
      errorNode.textContent = err.message;
      input.focus();
      input.select();
    }
  };

  const cancel = () => {
    App.inlineEdit = null;
    renderTree();
  };

  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    // 変換の確定に使った Enter / Escape で名前を確定・取り消ししない。
    if (isImeKey(ev)) return;
    if (ev.key === 'Enter') { ev.preventDefault(); void finish(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', () => {
    // 少し遅らせるのは、Enter での確定処理と競合させないため。
    setTimeout(() => { if (!busy && App.inlineEdit === edit) void finish(); }, 100);
  });
  input.addEventListener('input', () => {
    input.classList.remove('row__edit--invalid');
    errorNode.hidden = true;
  });

  const twisty = h('span', { class: 'row__twisty row__twisty--leaf' });
  if (depth > 0) twisty.style.marginLeft = (depth * 13) + 'px';

  const row = h('div', { class: 'row row--editing' }, [
    twisty,
    h('span', { class: 'row__icon' }, [icon(iconName, 'icon--folder')]),
    input
  ]);

  // フォーカスは描画後に当てる。
  requestAnimationFrame(() => {
    input.focus();
    const dot = input.value.lastIndexOf('.');
    if (edit.mode === 'rename' && dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  });

  return h('div', {}, [row, errorNode]);
}

/**
 * インライン編集を確定する。失敗したら例外を投げて呼び出し側に残させる。
 * @param {Object} edit App.inlineEdit
 * @param {string} name
 */
async function commitInlineEdit(edit, name) {
  if (edit.mode === 'rename') {
    const node = Tree.get(edit.nodeId);
    if (!node) return;
    // 形式の誤りはその場（入力行）で返す。サーバー側でも同じ検証をしている。
    const newName = Direct.validName(name);
    if (node.type !== 'folder') Direct.assertOpenableName(newName, '名前の変更');
    if (newName === node.name) return;

    const oldName = node.name;
    const parentId = node.parentId;
    const tab = getTab(node.id);
    const paint = (label) => {
      node.name = label;
      if (node.entry) node.entry.name = label;
      if (tab) {
        tab.name = label;
        renderTabs();
        if (App.activeId === tab.id) el.sbName.textContent = label;
      }
      if (parentId) sortChildren(parentId);
      renderTree();
    };
    // 画面は先に変えて、往復は待たない（結果はトーストで知らせる）。
    void optimistic({
      apply: () => {
        if (tab) tab.renamePending = true;   // 改名は更新日時を進めるので、確定まで保存を待たせる
        paint(newName);
        return () => { if (tab) tab.renamePending = false; paint(oldName); };
      },
      commit: () => (node.type === 'folder'
        ? Api.renameFolder(node.id, newName)
        : Api.renameFile(node.id, newName)),
      onCommit: (updated) => {
        node.name = updated.name;
        if (node.type !== 'folder') {
          if (node.entry) Object.assign(node.entry, updated);
          if (tab) tab.renamePending = false;
          syncRenamedTab(updated);
        }
        if (parentId) sortChildren(parentId);
        renderTree();
      },
      success: () => '「' + oldName + '」を「' + newName + '」に変更しました',
      failure: '名前を変更できませんでした'
    }).catch(() => { /* トースト済み */ });
    return;
  }

  const parent = Tree.get(edit.parentId);
  if (!parent) return;

  // 作成は Drive が付ける ID が要るので待つ。ただし以前のように一覧を取り直さず、
  // 返ってきた 1 件をツリーへ差し込む（往復 2 回 → 1 回）。
  if (edit.mode === 'newFolder') {
    const folderName = Direct.validName(name);
    const created = await Api.createFolder(edit.parentId, folderName);
    Tree.insertChild(edit.parentId, { id: created.id, name: created.name, type: 'folder' });
    parent.expanded = true;
    App.selectedId = created.id;
    renderTree();
    Session.save();
    toast('フォルダ「' + created.name + '」を作成しました', 'info', 3500);
  } else {
    const fileName = Direct.validName(name);
    Direct.assertOpenableName(fileName, '作成');
    const entry = await Api.createFile(edit.parentId, fileName);
    Tree.insertChild(edit.parentId, entry);
    parent.expanded = true;
    App.selectedId = entry.id;
    renderTree();
    Session.save();
    // 作ったばかりで中身が空だと分かっているので、開くときに readFile を呼ばせない。
    Store.putContent({ id: entry.id, name: entry.name, mimeType: entry.mimeType || '',
      size: 0, content: '', updatedAtIso: entry.updatedAtIso });
    toast('「' + entry.name + '」を作成しました', 'info', 3500);
    await openEntry(entry, { ephemeral: false });
  }
}

/** 改名したファイルが開かれていれば、タブ側も追随させる。 */
function syncRenamedTab(updated) {
  const tab = getTab(updated.id);
  if (!tab) return;
  tab.name = updated.name;
  // setName は Drive の更新日時も変えるので、基準値を更新しないと次回保存が必ず競合する。
  tab.baseUpdatedAtIso = updated.updatedAtIso;
  const langKey = EXT_TO_LANG[extensionOf(updated.name)] || null;
  if (langKey !== tab.langKey) {
    tab.langKey = langKey;
    void applyLanguageTo(tab.id, langKey);
  }
  renderTabs();
  if (App.activeId === tab.id) {
    el.sbName.textContent = tab.name;
    renderEditorCrumbs();
    updateStatusMeta();
    updatePreviewAvailability();
  }
  Session.save();
}

/** インライン編集を開始する。 */
function startInlineRename(node) {
  if (Tree.isRoot(node.id)) {
    toast('ルートフォルダの名前はここでは変更できません（Drive 側で操作してください）', 'warn');
    return;
  }
  App.inlineEdit = { mode: 'rename', nodeId: node.id, parentId: node.parentId };
  renderTree();
}

/** 新規作成の入力行をフォルダの中に生やす。 */
function startInlineCreate(mode, folderId) {
  const parent = Tree.get(folderId);
  if (!parent) return;
  parent.expanded = true;
  App.inlineEdit = { mode, nodeId: null, parentId: folderId };
  if (!parent.loaded) {
    void loadFolder(folderId, false);
  } else {
    renderTree();
  }
}

function parentNameOf(node) {
  const parent = node.parentId ? Tree.get(node.parentId) : null;
  return parent ? parent.name : '';
}

/**
 * ホバー時にだけ組み立てるツールチップ。
 * @param {TreeNode} node
 * @param {string|null} path flatten が引き継いだパス（絞り込み表示では null）
 * @return {string}
 */
function buildTooltip(node, path) {
  const full = path || Tree.pathOf(node.id);
  if (node.type === 'folder') return full;
  const entry = node.entry;
  if (!entry) return full;
  if (!entry.openable) return node.name + '\n\n' + entry.reason;
  return full + '\n' + formatBytes(entry.size) +
    '\n更新: ' + new Date(entry.updatedAtIso).toLocaleString('ja-JP');
}

/** 選択中・開いている・未保存を行に反映する。 */
function renderTreeStates() {
  // ツリーにフォーカスがあるときだけキーボードカーソルの枠を出す。
  const focused = el.entryList.contains(document.activeElement);
  for (const row of el.entryList.querySelectorAll('.row[data-node-id]')) {
    const id = row.getAttribute('data-node-id');
    const tab = getTab(id);
    row.classList.toggle('row--open', !!tab);
    row.classList.toggle('row--active',
      App.selection.has(id) || id === App.activeId);
    row.classList.toggle('row--dirty', !!(tab && tab.dirty));
    row.classList.toggle('row--cursor', focused && id === App.selectedId);
  }
}

/** 保存や改名のあと、ツリー上の情報だけを書き換える（再取得しない）。 */
function patchEntry(fileId, patch) {
  const node = Tree.get(fileId);
  if (node) {
    if (patch.name) node.name = patch.name;
    if (node.entry) Object.assign(node.entry, patch);
  }
  // 同じファイルがピン留めにも出ていることがあるので、行は全部書き換える。
  if (patch.name) Pins.rename(fileId, patch.name);
  for (const row of el.entryList.querySelectorAll('[data-node-id="' + CSS.escape(fileId) + '"]')) {
    const isPin = row.classList.contains('row--pin');
    if (patch.name) {
      const nameNode = row.querySelector('.row__name');
      if (nameNode) nameNode.textContent = patch.name;
    }
    // ピン留めの行の meta は更新日時ではなく置き場所なので触らない。
    if (patch.updatedAtIso && !isPin) {
      const meta = row.querySelector('.row__meta');
      if (meta && !App.filter) meta.textContent = formatRelative(patch.updatedAtIso);
    }
  }
}

/**
 * 新規作成・貼り付けの対象フォルダ。
 * ファイルが選ばれていればその親、フォルダが選ばれていればそのフォルダ。
 * @return {string}
 */
function targetFolderId() {
  const fallback = Tree.rootIds[0] || null;
  const node = App.selectedId ? Tree.get(App.selectedId) : null;
  if (!node) return fallback;
  if (node.type === 'folder') return node.id;
  return node.parentId || fallback;
}

/**
 * フォルダを再読み込みして描画し直す。
 * @param {string} folderId
 */
async function refreshFolder(folderId) {
  const node = Tree.get(folderId);
  if (!node) return;
  node.expanded = true;
  await loadFolder(folderId, true);
}

/** 全ルートを取り直す。読み込んでいない「一時メモ」は触らない。 */
async function refreshAllRoots() {
  const ids = Tree.rootIds.slice();
  const tmp = Tree.tmpRootId ? Tree.get(Tree.tmpRootId) : null;
  if (tmp && tmp.loaded) ids.push(tmp.id);
  await Promise.all(ids.map((id) => loadFolder(id, true)));
}

/** ヘッダーに開いているフォルダの要約を出す。 */
function renderRootsSummary() {
  if (!App.roots.length) {
    el.rootsSummary.textContent = 'フォルダ未選択';
    el.rootsSummary.title = '';
    return;
  }
  const names = App.roots.map((r) => r.name);
  el.rootsSummary.textContent = names.length === 1
    ? names[0]
    : names[0] + ' 他 ' + (names.length - 1) + ' 件';
  el.rootsSummary.title = names.join('\n');
}

/**
 * 一時メモの置き場所の表示を、いまの値に合わせる。
 * フォルダ管理画面（初回に必ず出る）と設定画面の 2 か所に同じものを出しているので、
 * 変えたときは必ずここを通す。
 */
function renderTmpLocation() {
  const path = TempMemo.locationText();
  el.pickerTmpPath.textContent = path;
  el.pickerTmpPath.title = path;
  el.btnTmpFolderReset.hidden = !App.tmpParent;
  el.btnTmpFolder.disabled = TempMemo._relocating;
  el.btnTmpFolderReset.disabled = TempMemo._relocating;
  if (Views.current === 'settings') Settings.render();
}

