/* ------------------------------------------------------------------ *
 *  フォルダ選択画面
 * ------------------------------------------------------------------ */

const Picker = {
  selected: null,
  rootLoaded: false,

  /**
   * 'roots'  … ツリーに並べるフォルダの管理（追加・削除）
   * 'choose' … 保存先のフォルダとファイル名を 1 つ選ぶ
   *
   * 同じ画面を使い回しているのは、どちらの用途でも必要なものが同じだから。
   * 遅延ロードのドライブツリーと、ツリーに出てこないフォルダを
   * URL / ID で指定する経路の 2 つを、二重に作る意味がない。
   */
  mode: 'roots',
  /** @type {function(*): void|null} choose モードの解決関数。 */
  _resolve: null,
  /** choose モードでファイル名を聞かない（フォルダだけ選ぶ）か。 */
  _nameless: false,
  /** 選び終わったあと、閉じずにフォルダ管理画面へ戻るか。 */
  _back: false,

  open(note) {
    // 保存先の選択が待っている最中にルート管理を開かれたら、
    // 待っている側をキャンセル扱いで先に返す（await が残らないように）。
    if (Picker._resolve) {
      const pending = Picker._resolve;
      Picker._resolve = null;
      pending(null);
    }
    Picker.mode = 'roots';
    el.pickerTitle.textContent = '編集するフォルダ';
    el.pickerCurrentLabel.textContent = 'いま開いているフォルダ';
    el.pickerAddLabel.textContent = 'ドライブから選んで追加';
    el.pickerRefLabel.textContent = 'URL または ID で追加';
    el.btnConfirmFolder.textContent = 'このフォルダを追加';
    el.pickerCurrent.hidden = false;
    el.pickerNameWrap.hidden = true;
    el.pickerNote.hidden = !note;
    if (note) el.pickerNote.textContent = note;
    // 一時メモの置き場所は、この画面（初回に必ず出る）からも変えられる。
    el.pickerTmp.hidden = false;
    renderTmpLocation();
    // ルートが 1 つも無いうちは閉じさせない。
    el.btnPickerClose.hidden = !App.roots.length;
    Picker.setSelected(null);
    Picker.renderRootList();
    el.pickerOverlay.hidden = false;
    if (!Picker.rootLoaded) {
      Picker.rootLoaded = true;
      void Picker.renderRoot();
    }
  },

  /**
   * 保存先のフォルダとファイル名を選んでもらう。
   *
   * nameless=true ならファイル名は聞かず、フォルダだけを選ぶ画面になる
   * （一時メモの置き場所の変更がこれ）。back=true のときは、決めても
   * やめても overlay を閉じずにフォルダ管理画面へ戻る。初回起動時は
   * ルートを 1 つも選んでいないので、ここで閉じると行き先が無くなるため。
   *
   * @param {{title:string, note?:string, name?:string, nameless?:boolean,
   *          confirmLabel?:string, back?:boolean,
   *          folder:({id:string,name:string}|null)}} opts
   * @return {Promise<{folderId:string, folderName:string, name:string}|null>}
   *         キャンセルなら null
   */
  choose(opts) {
    return new Promise((resolve) => {
      // 前の選択がまだ待っているなら、そちらはキャンセル扱いで先に閉じる。
      // 放置すると呼び出し側の await が永久に返らない。
      if (Picker._resolve) Picker._resolve(null);
      Picker.mode = 'choose';
      Picker._resolve = resolve;
      Picker._nameless = !!opts.nameless;
      Picker._back = !!opts.back;

      el.pickerTitle.textContent = opts.title;
      el.pickerCurrentLabel.textContent = 'よく使うフォルダ';
      el.pickerAddLabel.textContent = 'ドライブから選ぶ';
      el.pickerRefLabel.textContent = 'URL または ID で指定';
      el.btnConfirmFolder.textContent = opts.confirmLabel || 'ここに保存';
      el.pickerCurrent.hidden = false;
      el.pickerTmp.hidden = true;
      el.pickerNote.hidden = !opts.note;
      if (opts.note) el.pickerNote.textContent = opts.note;
      el.btnPickerClose.hidden = false;

      el.pickerNameWrap.hidden = !!opts.nameless;
      el.pickerName.value = opts.nameless ? '' : (opts.name || '');

      Picker.setSelected(opts.folder || null);
      Picker.renderRootList();
      el.pickerOverlay.hidden = false;
      if (!Picker.rootLoaded) {
        Picker.rootLoaded = true;
        void Picker.renderRoot();
      }

      if (opts.nameless) return;
      // 名前はたいてい直すので、そちらへフォーカスを置いて拡張子の手前まで選ぶ。
      setTimeout(() => {
        el.pickerName.focus();
        const dot = el.pickerName.value.lastIndexOf('.');
        el.pickerName.setSelectionRange(0, dot > 0 ? dot : el.pickerName.value.length);
      }, 0);
    });
  },

  /**
   * 上段のフォルダ一覧。
   * roots モードでは「外す」ボタン付き、choose モードでは候補として選べる行。
   */
  renderRootList() {
    el.rootList.textContent = '';

    if (Picker.mode === 'choose') {
      const seen = new Set();
      const candidates = [];
      if (App.lastSaveFolder && App.lastSaveFolder.id) {
        candidates.push(Object.assign({ recent: true }, App.lastSaveFolder));
        seen.add(App.lastSaveFolder.id);
      }
      for (const root of App.roots) {
        if (seen.has(root.id)) continue;
        seen.add(root.id);
        candidates.push(root);
      }

      if (!candidates.length) {
        el.rootList.appendChild(h('div', {
          class: 'rootList__empty',
          text: '候補がありません。下のツリーから選んでください。'
        }));
        return;
      }
      for (const folder of candidates) {
        const picked = !!Picker.selected && Picker.selected.id === folder.id;
        el.rootList.appendChild(h('button', {
          type: 'button',
          class: 'rootRow rootRow--pick' + (picked ? ' rootRow--picked' : ''),
          onclick: () => {
            Picker.setSelected({ id: folder.id, name: folder.name });
            Picker.renderRootList();
          }
        }, [
          icon('folder', 'icon--folder'),
          h('span', { class: 'rootRow__name', text: folder.name, title: folder.name }),
          folder.recent ? h('span', { class: 'rootRow__meta', text: '前回の保存先' }) : null
        ]));
      }
      return;
    }

    if (!App.roots.length) {
      el.rootList.appendChild(h('div', {
        class: 'rootList__empty',
        text: 'まだ何も開いていません。下から追加してください。'
      }));
      return;
    }
    for (const root of App.roots) {
      el.rootList.appendChild(h('div', { class: 'rootRow' }, [
        icon('folder', 'icon--folder'),
        h('span', { class: 'rootRow__name', text: root.name, title: root.name }),
        h('button', {
          type: 'button',
          class: 'rootRow__remove',
          title: 'このフォルダを閉じる',
          onclick: () => { void Picker.remove(root); }
        }, [icon('close', 'icon--sm')])
      ]));
    }
  },

  /** ルートを外す。配下に未保存のタブがあれば確認する。 */
  async remove(root) {
    const ok = await removeRootWithConfirm(root.id, root.name);
    if (ok) Picker.renderRootList();
  },

  /**
   * 閉じる。choose モードならキャンセル扱いで null を返す。
   * 呼び出し側を待たせたままにしないよう、閉じ方が何であれ必ずここを通す。
   */
  close() {
    const resolve = Picker._resolve;
    const back = Picker._back;
    Picker._resolve = null;
    Picker._nameless = false;
    Picker._back = false;
    el.pickerNameWrap.hidden = true;
    Picker.mode = 'roots';
    // 戻り先があるなら overlay は開いたまま、フォルダ管理の表示に戻す。
    if (back) Picker.open(null);
    else el.pickerOverlay.hidden = true;
    if (resolve) resolve(null);
  },

  setSelected(folder) {
    Picker.selected = folder;
    el.pickerSelected.textContent = folder
      ? '選択中: ' + folder.name
      : 'フォルダが選択されていません';
    el.btnConfirmFolder.disabled = !folder;
  },

  async renderRoot() {
    el.tree.textContent = '';
    el.tree.appendChild(h('div', { class: 'tree__note', text: '読み込み中…' }));
    try {
      const data = await Api.listPickerRoots();
      el.tree.textContent = '';

      for (const root of data.roots) {
        // マイドライブだけ最初から開いておく。共有ドライブは数が多いことがあるので、
        // 開かれたときに取りに行く。
        el.tree.appendChild(Picker.buildNode(root, null, root.kind === 'myDrive'));
      }

      if (!data.sharedDrivesAvailable) {
        el.tree.appendChild(h('div', {
          class: 'tree__note',
          text: '共有ドライブの一覧を取得できませんでした。' +
            '右の「URL または ID を貼り付け」から指定してください。'
        }));
      }
    } catch (err) {
      el.tree.textContent = '';
      el.tree.appendChild(h('div', { class: 'tree__note', text: err.message }));
    }
  },

  /**
   * ツリーのノードを 1 つ作る。
   *
   * 「子フォルダを持つか」はここでは調べない。調べるとフォルダ数ぶんの API 呼び出しが
   * 増えて遅延ロードの意味が無くなるため、常に展開可能として描画し、
   * 展開して空だったときに「サブフォルダはありません」を出す。
   */
  buildNode(folder, preloadedChildren, expanded) {
    const children = h('div', { class: 'tree__children' });
    let loaded = false;

    const toggle = h('button', { type: 'button', class: 'tree__toggle', title: '展開' },
      [icon('chevron', 'icon--sm')]);


    const label = h('button', {
      type: 'button',
      class: 'tree__label',
      title: folder.kind === 'sharedDrive' ? folder.name + '（共有ドライブ）' : folder.name,
      onclick: () => {
        for (const n of el.tree.querySelectorAll('.tree__label--selected')) {
          n.classList.remove('tree__label--selected');
        }
        label.classList.add('tree__label--selected');
        Picker.setSelected({ id: folder.id, name: folder.name });
      }
    }, [
      icon(
        folder.kind === 'sharedDrive' ? 'shared-drive'
          : folder.kind === 'myDrive' ? 'drive'
          : 'folder',
        folder.kind ? 'icon--muted' : 'icon--folder'
      ),
      h('span', { class: 'tree__labelText', text: folder.name })
    ]);

    const fill = (list) => {
      children.textContent = '';
      if (!list.length) {
        children.appendChild(h('div', { class: 'tree__note', text: 'サブフォルダはありません' }));
        return;
      }
      for (const sub of list) children.appendChild(Picker.buildNode(sub, null, false));
    };

    const expand = async () => {
      children.hidden = false;
      toggle.classList.add('tree__toggle--open');
      if (loaded) return;
      loaded = true;
      children.textContent = '';
      children.appendChild(h('div', { class: 'tree__note', text: '読み込み中…' }));
      toggle.classList.add('tree__toggle--busy');
      try {
        const data = await Api.listFolderChildren(folder.id);
        fill(data.folders);
        if (data.truncated) {
          children.appendChild(h('div', { class: 'tree__note', text: '（一部のみ表示）' }));
        }
      } catch (err) {
        loaded = false;   // 失敗したら再試行できるようにする
        children.textContent = '';
        children.appendChild(h('div', { class: 'tree__note', text: err.message }));
      } finally {
        toggle.classList.remove('tree__toggle--busy');
      }
    };

    toggle.addEventListener('click', () => {
      if (children.hidden) void expand();
      else {
        children.hidden = true;
        toggle.classList.remove('tree__toggle--open');
      }
    });

    if (preloadedChildren) { loaded = true; fill(preloadedChildren); }
    children.hidden = !expanded;
    if (expanded) {
      toggle.classList.add('tree__toggle--open');
      // 子が渡されていないのに開いた状態で描くなら、ここで取りに行く。
      if (!loaded) void expand();
    }

    return h('div', { class: 'tree__node' }, [
      h('div', { class: 'tree__rowWrap' }, [toggle, label]),
      children
    ]);
  },

  async resolveRef() {
    const text = el.folderRefInput.value.trim();
    if (!text) return;
    el.resolvedBox.hidden = false;
    el.resolvedBox.className = 'picker__resolved';
    el.resolvedBox.textContent = '確認中…';
    el.btnResolveRef.disabled = true;
    try {
      const data = await Api.resolveFolderRef(text);
      el.resolvedBox.textContent = '';
      el.resolvedBox.appendChild(h('div', {}, [
        h('div', {}, [icon('folder', 'icon--folder'), h('span', { text: ' ' + data.name })]),
        h('div', {
          style: 'color:var(--fg-2);font-size:11px;margin-top:3px;',
          text: data.breadcrumb.map((c) => c.name).join(' › ')
        })
      ]));
      Picker.setSelected({ id: data.id, name: data.name });
      for (const n of el.tree.querySelectorAll('.tree__label--selected')) {
        n.classList.remove('tree__label--selected');
      }
    } catch (err) {
      el.resolvedBox.className = 'picker__resolved picker__resolved--error';
      el.resolvedBox.textContent = err.message;
    } finally {
      el.btnResolveRef.disabled = false;
    }
  },

  /**
   * 決定ボタン。
   * roots モードでは選択中のフォルダをルートに追加し、
   * choose モードでは呼び出し側へフォルダ名とファイル名を返して閉じる。
   */
  async confirm() {
    if (!Picker.selected) return;

    if (Picker.mode === 'choose') {
      let name = '';
      if (!Picker._nameless) {
        name = el.pickerName.value.trim();
        if (!name) {
          toast('ファイル名を入力してください', 'warn', 3000);
          el.pickerName.focus();
          return;
        }
      }
      const folder = Picker.selected;
      const resolve = Picker._resolve;
      const back = Picker._back;
      Picker._resolve = null;
      Picker._nameless = false;
      Picker._back = false;
      Picker.mode = 'roots';
      el.pickerNameWrap.hidden = true;
      if (back) Picker.open(null);
      else el.pickerOverlay.hidden = true;
      if (resolve) resolve({ folderId: folder.id, folderName: folder.name, name: name });
      return;
    }

    el.btnConfirmFolder.disabled = true;
    const prevLabel = el.btnConfirmFolder.textContent;
    el.btnConfirmFolder.textContent = '追加しています…';
    try {
      const added = await addFolderAsRoot(Picker.selected.id);
      if (added) {
        toast(added.added
          ? '「' + added.root.name + '」を追加しました'
          : '「' + added.root.name + '」はすでに開いています', 'info', 3000);
        el.btnPickerClose.hidden = false;
      }
    } finally {
      el.btnConfirmFolder.disabled = false;
      el.btnConfirmFolder.textContent = prevLabel;
    }
  }
};

/**
 * フォルダをツリーのルートとして追加する。
 * 追加なので、開いているタブは閉じない。
 *
 * @param {string} folderId
 * @return {Promise<{root:{id:string,name:string}, added:boolean}|null>} 失敗なら null
 */
async function addFolderAsRoot(folderId) {
  // 「一時メモ」は既に最上段の固定セクションとして出ている。
  // 通常のルートとしても足すと、同じノードが 2 行に出てしまう。
  if (Tree.isTmpRoot(folderId)) {
    toast('「一時メモ」はサイドバーの最上段に常に出ています', 'info', 4000);
    return null;
  }
  try {
    const data = await Api.addRoot(folderId);
    App.roots = data.roots;
    Tree.addRoot(data.root);
    Tree.ingest(data.root.id, data.entries);
    renderRootsSummary();
    if (!el.pickerOverlay.hidden) Picker.renderRootList();
    renderTree();
    Session.save();
    return { root: data.root, added: data.added };
  } catch (err) {
    toast(err.message, 'error', 10000);
    return null;
  }
}

/**
 * ルートを外す。配下に未保存のタブがあれば確認し、開いていたタブは閉じる。
 * @param {string} rootId
 * @param {string} rootName
 * @return {Promise<boolean>} 実際に外したか
 */
async function removeRootWithConfirm(rootId, rootName) {
  if (Tree.isTmpRoot(rootId)) {
    toast('「一時メモ」は外せません。保存期間は設定から変えられます。', 'warn', 5000);
    return false;
  }
  const openInside = App.tabs.filter(
    (t) => t.id === rootId || isInsideFolder(t.id, rootId) || Tree.rootOf(t.id) === rootId);
  const dirtyInside = openInside.filter((t) => t.dirty);

  if (dirtyInside.length) {
    await saveAllDirty();
  }
  const stillDirty = openInside.filter((t) => t.dirty);

  if (openInside.length) {
    const go = await modal({
      title: 'フォルダを閉じる',
      body: h('div', {}, [
        h('p', { text: '「' + rootName + '」をツリーから外します（Drive 上のフォルダは消えません）。' }),
        h('p', { text: 'このフォルダで開いているタブ（' +
          openInside.map((t) => t.name).join('、') + '）も閉じられます。' }),
        stillDirty.length
          ? h('p', { text: 'うち ' + stillDirty.map((t) => t.name).join('、') +
              ' は保存が完了していません。変更は下書きにのみ残ります。' })
          : null
      ]),
      actions: [
        { label: '閉じる', value: true, variant: stillDirty.length ? 'danger' : 'primary' },
        { label: 'キャンセル', value: false }
      ]
    });
    if (!go) return false;
  }

  try {
    const data = await Api.removeRoot(rootId);
    App.roots = data.roots;
  } catch (err) {
    toast(err.message, 'error', 10000);
    return false;
  }

  for (const tab of openInside) await closeTab(tab.id, { force: true });
  Tree.removeRoot(rootId);
  if (App.selectedId === rootId || !Tree.get(App.selectedId)) {
    App.selectedId = Tree.rootIds[0] || null;
  }
  renderRootsSummary();
  renderTree();
  Session.save();

  if (!App.roots.length) Picker.open('開いているフォルダがありません。追加してください。');
  return true;
}

/** ツリーのルート行から呼ぶ「このフォルダを閉じる」。 */
async function doRemoveRoot(node) {
  const ok = await removeRootWithConfirm(node.id, node.name);
  if (ok && !el.pickerOverlay.hidden) Picker.renderRootList();
}

/**
 * タブが 1 枚も開いていない状態にする。
 * ビューアを畳み忘れると、テキストタブへ戻ったときに前のファイルが残る。
 */
/**
 * ペインの中身を空にする（そのペインのタブが 0 枚になったとき）。
 * @param {Object} leaf
 */
function showEmptyPane(leaf) {
  if (!leaf) return;
  if (leaf.view) leaf.view.setState(Editor.buildState('', null));
  const e = leaf.el;
  e.viewerHost.hidden = true;
  e.viewerFrame.src = 'about:blank';
  e.diffHost.hidden = true;
  e.previewHost.hidden = true;
  e.termHost.hidden = true;
  e.panes.hidden = false;
  e.mdBar.hidden = true;
  e.editorCrumbs.hidden = true;
  e.emptyState.hidden = false;

  if (Panes.active() !== leaf) return;
  el.btnPreview.hidden = true;
  el.statusbar.hidden = true;
  refreshStatus();
}

/** アクティブなペインを空にする。 */
function showEmptyState() {
  showEmptyPane(Panes.active());
}

