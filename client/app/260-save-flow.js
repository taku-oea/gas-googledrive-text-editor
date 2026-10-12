/* ------------------------------------------------------------------ *
 *  保存フロー（タブ単位）
 * ------------------------------------------------------------------ */

/** 本文が変わったとき。サーバーは呼ばず、デバウンスを張り直すだけ。 */
function onDocChanged(tabId) {
  const tab = getTab(tabId);
  if (!tab) return;

  // 表示に出る状態が実際に変わったのは最初の 1 打鍵だけ。
  // 毎回 renderTabs() すると 1 文字ごとに全タブの DOM を作り直し、
  // renderTreeStates() が全行を querySelectorAll することになる。
  const visualChanged = !tab.dirty || tab.conflicted || !!tab.saveError || tab.ephemeral;

  // 編集した時点で仮タブではなくなる（VS Code と同じ）。
  tab.ephemeral = false;
  tab.dirty = true;
  tab.conflicted = false;
  tab.saveError = null;

  if (visualChanged) {
    if (tabId === App.activeId) refreshStatus();
    renderTabs();
    renderTreeStates();
  }

  Draft.schedule(tabId);
  scheduleAutoSave(tabId);
  // プレビューは別のペインに出ていることもあるので、アクティブかどうかは見ない。
  Preview.refreshSource(tab.id);
}

/** 自動保存のデバウンスを張り直す。 */
function scheduleAutoSave(tabId) {
  const tab = getTab(tabId);
  if (!tab) return;
  tabId = tab.id;
  clearTimeout(tab.saveTimer);
  // 自動保存を切っている場合は Cmd/Ctrl+S でだけ保存する。
  if (!Settings.get('autosaveEnabled')) return;

  // 一時メモは保存先も決まっていない書き殴りなので、通常ファイルと同じ
  // 間隔で Drive を叩き続ける必要がない。取りこぼしは localStorage の
  // 下書きとウィンドウ blur 時の saveAllDirty が拾う。
  const delay = tab.temp
    ? Math.max(Settings.get('autosaveDelayMs'), TempMemo.MIN_AUTOSAVE_MS)
    : Settings.get('autosaveDelayMs');

  tab.saveTimer = setTimeout(() => { void doSave(tabId, false); }, delay);
}

/**
 * Cmd/Ctrl+S。デバウンスを飛ばして即保存する。
 *
 * 一時メモだけは意味が変わり、「保存先を決めて確定する」になる（VS Code の
 * 無題ファイルと同じ）。ただし VS Code と違って内容は既に Drive にあるので、
 * ダイアログをキャンセルしても失うものは無い。
 */
async function saveNow(tabId) {
  const tab = getTab(tabId);
  if (tab && tab.kind === 'diff') { await Diff.saveFocused(tab.id); return; }
  if (!tab || tab.kind !== 'text') return;
  tabId = tab.id;
  clearTimeout(tab.saveTimer);

  if (tab.temp) {
    if (tab.createError) { await TempMemo.retryCreate(tabId); return; }
    await TempMemo.promote(tabId);
    return;
  }

  if (!tab.dirty && !tab.saving) {
    refreshStatus();
    return;
  }
  await doSave(tabId, false);
}

/**
 * 未保存のタブをすべて保存する（ウィンドウ blur 時など）。
 * 競合中のタブは force なしで保存しても同じ競合になり、blur のたびに競合の確認が出直すだけなので外す
 * （解決は handleConflict で選んだ操作か、次の編集からの保存に任せる）。
 */
async function saveAllDirty() {
  await Promise.all(App.tabs.filter((t) => t.dirty && !t.conflicted).map((t) => doSave(t.id, false)));
}

/**
 * 実際に保存する。同一タブへの並行保存はしない
 * （保存中に編集されたら pendingSave を立て、完了後にもう一度走らせる）。
 * @param {string} tabId
 * @param {boolean} force 競合を無視して上書きするか
 */
async function doSave(tabId, force) {
  const tab = getTab(tabId);
  if (!tab || tab.kind !== 'text') return;
  tabId = tab.id;   // 作成中の一時メモから仮 ID で呼ばれることがある
  if (tab.saving) { tab.pendingSave = true; return; }
  if (tab.creating || tab.createError) {
    // Drive 上にまだファイルが無い。ID が決まった時点で TempMemo.bindCreated が保存する
    // （作成に失敗したままのタブは Mod+S で作り直すまで保存できない）。
    tab.pendingSave = true;
    return;
  }
  if (tab.renamePending) {
    // 改名が Drive 側で確定すると更新日時が進む。その前に保存すると基準日時が古くなり
    // 次回が競合になるので、確定を待ってから保存する。
    clearTimeout(tab.saveTimer);
    tab.saveTimer = setTimeout(() => { void doSave(tabId, force); }, 500);
    return;
  }

  clearTimeout(tab.saveTimer);
  const endSave = Perf.start('save.total');
  // エディタ内は常に \n。元が CRLF のファイルはここで戻す。
  const editorText = tabDoc(tab);
  const content = restoreEol(editorText, tab.eol);

  tab.saving = true;
  tab.saveError = null;
  if (tabId === App.activeId) refreshStatus();
  renderTabs();

  // 競合は saving を解除したあとで扱う。catch の中から doSave(force:true) を
  // 呼ぶと tab.saving がまだ true で即 return され、保存されないまま
  // pendingSave 経由で force なしの再保存が走り、競合が永久に解決しない。
  let conflictErr = null;

  try {
    const res = await Api.saveFile(tabId, content, tab.baseUpdatedAtIso, !!force);
    if (!getTab(tabId)) return;   // 保存中に閉じられた

    if (res.timestampVerified === false) {
      // Drive のメタデータが追いつかず、更新日時が保存前と同じまま返ってきた。
      // 次回保存で競合として誤検出されることがある。
      console.warn('保存後の更新日時を確認できませんでした: ' + tab.name);
    }

    tab.baseUpdatedAtIso = res.updatedAtIso;
    tab.size = res.size;
    tab.lastSavedAt = new Date();
    tab.conflicted = false;
    patchEntry(tabId, { updatedAtIso: res.updatedAtIso, size: res.size });
    // 保存した本文をそのままキャッシュへ（Drive 上の実体と同じ、改行コード復元後の形）。
    const savedRec = {
      id: tabId, name: res.name || tab.name, mimeType: tab.mimeType,
      size: res.size, content: content, updatedAtIso: res.updatedAtIso
    };
    Store.putContent(savedRec);
    LocalSnap.put(savedRec);

    if (tabDoc(tab) === editorText) {
      tab.dirty = false;
      Draft.clear(tabId);
    }
    if (tabId === App.activeId) {
      el.sbSize.textContent = formatBytes(res.size);
      refreshStatus();
    }
  } catch (err) {
    if (!getTab(tabId)) return;

    if (err.code === 'CONFLICT') {
      tab.conflicted = true;
      conflictErr = err;
    } else {
      tab.saveError = err.message;
      toast('「' + tab.name + '」の保存に失敗しました: ' + err.message, 'error', 10000);
      // 下書きは消さない。復元できるようにしておく。
    }
    // localStorage の下書きは再読み込みで消えることがあるので、Drive にも逃がしておく。
    DraftStash.put(tab);
  } finally {
    endSave({ len: content.length, force: !!force });
    const t = getTab(tabId);
    if (t) {
      t.saving = false;
      renderTabs();
      renderTreeStates();
      if (t.pendingSave) {
        t.pendingSave = false;
        // 競合中に force なしで再保存しても同じ競合になるだけなので走らせない。
        if (t.dirty && !t.conflicted) {
          t.saveTimer = setTimeout(() => { void doSave(tabId, false); }, 200);
        }
      }
      if (tabId === App.activeId) refreshStatus();
    }
  }

  if (conflictErr) await handleConflict(tabId, conflictErr);
}

/**
 * 競合の解決をユーザーに委ねる。
 * @param {string} tabId
 * @param {ApiError} err
 */
async function handleConflict(tabId, err) {
  const tab = getTab(tabId);
  if (!tab) return;

  const serverIso = err.detail && err.detail.serverUpdatedAtIso;
  const body = h('div', {}, [
    h('p', { text: '「' + tab.name + '」は、あなたが開いたあとに別の場所で更新されています。' }),
    h('p', {
      text: 'Drive 側の最終更新: ' +
        (serverIso ? new Date(serverIso).toLocaleString('ja-JP') : '不明')
    }),
    h('p', { text: 'どちらを残すか選んでください。編集中の内容は下書きとして保持しています。' })
  ]);

  const choice = await modal({
    title: '保存の競合を検出しました',
    body,
    actions: [
      { label: '差分を見る', value: 'diff', variant: 'primary' },
      { label: 'このまま上書き保存', value: 'overwrite', variant: 'danger' },
      { label: 'Drive 側を読み込む（編集内容は破棄）', value: 'reload' },
      { label: 'あとで決める', value: null }
    ]
  });

  if (!getTab(tabId)) return;

  if (choice === 'diff') {
    // 左に Drive 側、右に編集中の内容を出す。どちらを残すかはそこで決められる。
    setStatusText('unsaved', '未保存（競合）');
    await Diff.withSaved(tabId);
  } else if (choice === 'overwrite') {
    await doSave(tabId, true);
  } else if (choice === 'reload') {
    Draft.clear(tabId);
    await reloadTab(tabId);
  } else {
    setStatusText('unsaved', '未保存（競合）');
  }
}

