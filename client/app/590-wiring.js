/* ------------------------------------------------------------------ *
 *  イベント配線
 * ------------------------------------------------------------------ */

el.btnBootRetry.addEventListener('click', () => { void boot(); });
el.btnChangeFolder.addEventListener('click', () => { Picker.open(null); });
el.btnTheme.addEventListener('click', showThemeMenu);
el.btnKeys.addEventListener('click', showKeyHelp);
el.btnCommands.addEventListener('click', () => { Palette.open('command'); });
el.btnPreview.addEventListener('click', () => { void togglePreview(); });

el.sbIndent.addEventListener('click', showIndentMenu);
el.sbEol.addEventListener('click', showEolMenu);
el.sbEnc.addEventListener('click', showEncodingMenu);
el.sbLang.addEventListener('click', showLangMenu);
el.sbCursor.addEventListener('click', () => {
  if (Editor.view && Editor.cm) Editor.cm.gotoLine(Editor.view);
});

// プレビューの iframe から届くメッセージ。プレビュータブごとに iframe があるので、
// どのタブのものかは contentWindow で見分ける。
//   ・drawio … embed.diagrams.net からの init
//   ・HTML  … 中身の縦位置（srcdoc を入れ替えても同じところを見ていられるように覚える）
window.addEventListener('message', (ev) => {
  const dio = Drawio.tabForSource(ev.source);
  if (dio) {
    if (ev.origin === DRAWIO_ORIGIN) Drawio.onMessage(dio, ev.data);
    return;
  }

  // HTML プレビューは allow-same-origin 無しの sandbox なので、送り主は必ず 'null'。
  const data = ev.data;
  if (ev.origin !== 'null' || !data || data.__preview !== 'scroll') return;
  const tab = App.tabs.find((t) =>
    t.kind === 'preview' && t.pv && t.pv.frame.contentWindow === ev.source);
  if (tab) tab.pv.frameScroll = Number(data.top) || 0;
});

wireSplitter(el.sidebarSplitter, {
  onDrag: (clientX) => {
    const rect = el.main.getBoundingClientRect();
    Layout.setWidth(clientX - rect.left, false);
  },
  onEnd: () => { Session.save(); },
  onReset: () => { Layout.setWidth(Layout.DEFAULT_WIDTH, true); }
});

el.btnToggleSidebar.addEventListener('click', () => { Layout.toggleSidebar(); });

// ---- アクティビティバー ----
// ツールチップのショートカット表記は OS で変わるので、ここで組み立てる。
const VIEW_KEYS = { explorer: MOD + '+Shift+E', search: MOD + '+Shift+F' };
for (const btn of el.activity.querySelectorAll('.activity__btn')) {
  const view = btn.dataset.view;
  const key = VIEW_KEYS[view];
  btn.title = (btn.dataset.title || '') + (key ? '（' + key + '）' : '');
  btn.addEventListener('click', () => { Views.show(view); });
}

// ---- 全体検索 ----
el.searchInput.addEventListener('keydown', (ev) => {
  if (isImeKey(ev)) return;
  if (ev.key === 'Enter') { ev.preventDefault(); void Search.run(); }
  else if (ev.key === 'Escape') { ev.preventDefault(); Search.clear(); }
});
el.btnSearchClear.addEventListener('click', () => { Search.clear(); });

// ---- 変更履歴 ----
el.btnHistoryRefresh.addEventListener('click', () => { void History.load(true); });

// ---- 設定 ----
el.btnSettingsReset.addEventListener('click', () => { Settings.reset(); });

// 画面を狭めたときに、サイドバーが広すぎる状態で固定されないようにする。
window.addEventListener('resize', () => {
  const clamped = Layout.clamp(Layout.width);
  if (clamped !== Layout.width) Layout.setWidth(clamped, true);
});

// Drive / Docs のプレビューが埋め込みを拒否した場合に案内を出す。
el.btnPickerClose.addEventListener('click', () => { Picker.close(); });
// 一時メモの置き場所（フォルダ管理画面から）。選び終わったらこの画面へ戻る。
el.btnTmpFolder.addEventListener('click', () => { void TempMemo.relocate({ back: true }); });
el.btnTmpFolderReset.addEventListener('click', () => { void TempMemo.setLocation(null); });
el.btnConfirmFolder.addEventListener('click', () => { void Picker.confirm(); });
el.btnResolveRef.addEventListener('click', () => { void Picker.resolveRef(); });
// 保存先を選ぶモードでは、ファイル名の Enter がそのまま決定。
el.pickerName.addEventListener('keydown', (ev) => {
  if (isImeKey(ev)) return;
  if (ev.key === 'Enter') { ev.preventDefault(); void Picker.confirm(); }
});
// 保存先を選ぶモードは Escape でキャンセルできる（ルート管理は
// ルートが 1 つも無いうちは閉じさせないので、ここでは扱わない）。
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || el.pickerOverlay.hidden || Picker.mode !== 'choose') return;
  ev.preventDefault();
  ev.stopPropagation();
  Picker.close();
}, true);
el.folderRefInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); void Picker.resolveRef(); }
});

el.btnNewMemo.addEventListener('click', () => { void TempMemo.create(); });
el.btnNewFile.addEventListener('click', () => { startInlineCreate('newFile', targetFolderId()); });
el.btnNewFolder.addEventListener('click', () => { startInlineCreate('newFolder', targetFolderId()); });
el.btnRefresh.addEventListener('click', () => { void refreshAllRoots(); });
el.btnCollapseAll.addEventListener('click', collapseAllFolders);

let filterTimer = null;
el.filterInput.addEventListener('input', () => {
  App.filter = el.filterInput.value;
  el.btnFilterClear.hidden = !App.filter;
  // renderTree() は全ノード走査 + ソート + DOM 再構築なので、1 打鍵ごとには走らせない。
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => { filterTimer = null; renderTree(); }, 120);
});
el.filterInput.addEventListener('keydown', (ev) => {
  if (isImeKey(ev)) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    clearFilter();
  } else if (ev.key === 'Enter') {
    // 絞り込み結果が 1 件ならそれを開く。
    ev.preventDefault();
    const hits = Tree.matchingFiles(App.filter.trim().toLowerCase())
      .filter((n) => n.entry && n.entry.openable);
    if (hits.length === 1) void openEntry(hits[0].entry, { ephemeral: false });
  }
});
el.btnFilterClear.addEventListener('click', clearFilter);

function clearFilter() {
  clearTimeout(filterTimer);
  filterTimer = null;
  App.filter = '';
  el.filterInput.value = '';
  el.btnFilterClear.hidden = true;
  renderTree();
}

// ツリー余白へのファイルドロップ。ルートが 1 つのときだけ受ける
// （複数あるとどこへ入れるのか決められないため）。
el.entryList.addEventListener('dragover', (ev) => {
  if (ev.target.closest('.row')) return;
  if (!isFileDrag(ev) || Tree.rootIds.length !== 1) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'copy';
  el.entryList.classList.add('sidebar__list--dropRoot');
});
el.entryList.addEventListener('dragleave', () => {
  el.entryList.classList.remove('sidebar__list--dropRoot');
});
el.entryList.addEventListener('drop', (ev) => {
  el.entryList.classList.remove('sidebar__list--dropRoot');
  if (ev.target.closest('.row')) return;
  if (!isFileDrag(ev) || Tree.rootIds.length !== 1) return;
  ev.preventDefault();
  void uploadFiles(ev.dataTransfer.files, Tree.rootIds[0]);
});

// ブラウザがファイルを開いてしまうのを防ぐ（アプリ外へのドロップ）。
window.addEventListener('dragover', (ev) => { if (isFileDrag(ev)) ev.preventDefault(); });
window.addEventListener('drop', (ev) => { if (isFileDrag(ev)) ev.preventDefault(); });

el.entryList.addEventListener('keydown', onTreeKeyDown);
el.entryList.addEventListener('focusin', renderTreeStates);
el.entryList.addEventListener('focusout', () => {
  // 別のフォーカス先が確定してから塗り直す。
  setTimeout(renderTreeStates, 0);
});

// ツールチップは実際にホバーされた行にだけ後付けする。
el.entryList.addEventListener('mouseover', (ev) => {
  const row = ev.target.closest ? ev.target.closest('.row[data-node-id]') : null;
  if (!row) { Prefetch.cancel(); return; }
  Prefetch.onOver(row);
  if (row.dataset.tipReady) return;
  row.dataset.tipReady = '1';
  const node = Tree.get(row.dataset.nodeId);
  const main = row.querySelector('.row__main');
  if (node && main) main.title = buildTooltip(node, row.dataset.path || null);
});

el.entryList.addEventListener('mouseleave', () => { Prefetch.cancel(); });

// 押した瞬間に本文の取得を始める（click 確定より 100〜200ms 早い）。hover が短くて先読みが
// 間に合わなかったファイルでも、その分だけ表示が早くなる。
el.entryList.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  const row = ev.target.closest ? ev.target.closest('.row[data-node-id]') : null;
  if (!row) return;
  const node = Tree.get(row.dataset.nodeId);
  if (!node || node.type !== 'file' || !node.entry || !node.entry.openable || node.entry.viewer !== 'editor') return;
  if (node.entry.size > Store.PREFETCH_MAX || Store.peek(node.id)) return;
  Prefetch.cancel();
  const r = Store.readFile(node.id, { prefetch: true });
  if (r.revalidate) r.revalidate.catch(() => { /* クリック側の通常経路でエラーを出す */ });
});

// ツリーの余白を右クリックしたらルートフォルダのメニューを出す。
el.entryList.addEventListener('contextmenu', (ev) => {
  if (ev.target.closest('.row')) return;   // 行の上は行側で処理済み
  ev.preventDefault();
  showRootMenu(ev.clientX, ev.clientY);
});

// ---- コマンドパレット ----
el.paletteInput.addEventListener('input', () => { Palette.render(); });
el.paletteInput.addEventListener('keydown', (ev) => {
  if (isImeKey(ev)) return;
  if (ev.key === 'ArrowDown') { ev.preventDefault(); Palette.move(1); }
  else if (ev.key === 'ArrowUp') { ev.preventDefault(); Palette.move(-1); }
  else if (ev.key === 'Enter') { ev.preventDefault(); Palette.run(Palette.index); }
  else if (ev.key === 'Escape') { ev.preventDefault(); Palette.close(); }
  else if (ev.key === 'Tab') { ev.preventDefault(); Palette.move(ev.shiftKey ? -1 : 1); }
});
el.paletteOverlay.addEventListener('mousedown', (ev) => {
  // 枠の外を押したら閉じる。
  if (!ev.target.closest('.palette__box')) Palette.close();
});

// メニューは外側クリック・スクロール・Escape で閉じる。
document.addEventListener('mousedown', (ev) => {
  if (Ctx.open && !ev.target.closest('#ctxMenu')) Ctx.hide();
}, true);
document.addEventListener('keydown', (ev) => {
  if (Ctx.open && ev.key === 'Escape') { ev.preventDefault(); Ctx.hide(); }
}, true);
el.entryList.addEventListener('scroll', () => { Ctx.hide(); });
window.addEventListener('resize', () => { Ctx.hide(); Diff.remeasureActive(); });

// エディタの外にフォーカスがあるときの Cmd/Ctrl+S と、Cmd/Ctrl+P。
document.addEventListener('keydown', (ev) => {
  // 新しい一時メモ。Cmd+N / Ctrl+N はブラウザが握っていて奪えないので
  // Alt を足した組み合わせにしている。
  // ev.key ではなく ev.code を見るのは、macOS の Option+N が
  // デッドキー（˜）になって ev.key が 'n' にならないため。
  if ((ev.metaKey || ev.ctrlKey) && ev.altKey && ev.code === 'KeyN') {
    ev.preventDefault();
    // ここで止めないと、このあと CodeMirror の keymap にも届いて
    // 1 回の打鍵で 2 枚できてしまう（この listener は capture 登録）。
    ev.stopPropagation();
    void TempMemo.create();
    return;
  }

  // ターミナル。VS Code と同じ Ctrl+` に加えて Cmd/Ctrl+Alt+T でも開ける
  // （JIS 配列の ` は半角/全角キーと同じ位置で、IME に取られることがあるため）。
  if (!ev.metaKey && ev.ctrlKey && !ev.altKey && !ev.shiftKey && ev.code === 'Backquote') {
    ev.preventDefault();
    ev.stopPropagation();
    void Term.toggle();
    return;
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.altKey && ev.code === 'KeyT') {
    ev.preventDefault();
    ev.stopPropagation();
    void Term.toggle();
    return;
  }
  // 閉じたタブを開き直す。Cmd/Ctrl+Shift+T はブラウザが握っていて奪えない。
  // ev.code を見るのは、macOS の Option+Shift+T が ˇ になって ev.key が 't' にならないため。
  if (!ev.metaKey && !ev.ctrlKey && ev.altKey && ev.shiftKey && ev.code === 'KeyT') {
    ev.preventDefault();
    ev.stopPropagation();
    void ClosedTabs.reopen();
    return;
  }

  // ペインを選ぶ。Cmd+1〜9 はブラウザがタブ切り替えに使っていて奪えないので
  // Alt+数字にしている。macOS の Option+数字は特殊文字になるため ev.code で見る。
  if (ev.altKey && !ev.metaKey && !ev.ctrlKey && /^Digit[1-6]$/.test(ev.code)) {
    const target = Panes.leaves()[Number(ev.code.slice(5)) - 1];
    if (target) {
      ev.preventDefault();
      ev.stopPropagation();
      focusPane(target);
    }
    return;
  }

  if (!(ev.metaKey || ev.ctrlKey) || ev.altKey) return;
  const key = ev.key.toLowerCase();

  // Cmd+\ でペインを分割（Shift を足すと下）。ブラウザは使っていない。
  if (key === '\\') {
    ev.preventDefault();
    ev.stopPropagation();
    splitActivePane(ev.shiftKey ? 'col' : 'row');
    return;
  }

  if (key === 'p') {
    // Cmd+P はクイックオープン、Cmd+Shift+P はコマンドパレット。
    // ブラウザの印刷ダイアログを奪うので capture で止める。
    ev.preventDefault();
    Palette.open(ev.shiftKey ? 'command' : 'file');
    return;
  }
  if (ev.shiftKey && key === 'e') {
    // Cmd+Shift+E でエクスプローラの絞り込みへ。
    ev.preventDefault();
    if (Views.current !== 'explorer' || Layout.sidebarHidden) Views.show('explorer');
    el.filterInput.focus();
    el.filterInput.select();
    return;
  }
  if (ev.shiftKey && key === 'f') {
    // Cmd+Shift+F で全体検索。CM の検索パネル（Cmd+F）とは別物。
    ev.preventDefault();
    if (Views.current !== 'search' || Layout.sidebarHidden) Views.show('search');
    el.searchInput.focus();
    el.searchInput.select();
    return;
  }
  if (key === 's' && !ev.shiftKey) {
    ev.preventDefault();
    void saveNow(App.activeId);
  } else if (key === 'b' && !ev.shiftKey) {
    ev.preventDefault();
    Layout.toggleSidebar();
  }
}, true);

// タブ切り替え・ウィンドウ blur で保留中の保存を確定させる。
window.addEventListener('blur', () => { void saveAllDirty(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    void saveAllDirty();
    Session.flush();
    Pins.flush();
  } else {
    // 別のタブで作業して戻ってきた。その間の変更をまとめて拾う。
    void ChangeFeed.poll();
  }
});

// サンドボックス iframe では抑止できないこともあるが、可能なら警告を出す。
window.addEventListener('beforeunload', (ev) => {
  if (App.tabs.some((t) => t.dirty || (t.kind === 'diff' && Diff.hasUnsaved(t)))) {
    ev.preventDefault();
    ev.returnValue = '';
  }
});

// 想定外の例外を握りつぶさず画面に出す。
window.addEventListener('unhandledrejection', (ev) => {
  console.error(ev.reason);
  const msg = ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason);
  toast('処理中にエラーが発生しました: ' + msg, 'error', 10000);
});

// ペインを 1 枚だけ作っておく。この時点では中身は空で、
// セッションに分割の記録があれば applyBootstrap の中で組み直す。
Panes.init();

void boot();
