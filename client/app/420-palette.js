/* ------------------------------------------------------------------ *
 *  コマンドパレット / クイックオープン
 *
 *  Cmd+P  … ファイルをあいまい検索して開く
 *  Cmd+Shift+P … コマンドを検索して実行
 *
 *  VS Code の操作感の中心。ここに登録しておけば、機能を増やしても
 *  UI に置き場所を探さなくて済む。
 * ------------------------------------------------------------------ */

/**
 * @typedef {{
 *   id: string, label: string, hint?: string, icon?: string, key?: string,
 *   when?: function(): boolean, run: function(): void
 * }} Command
 */

/** @return {Command[]} 実行できるコマンドの一覧。 */
function commandRegistry() {
  const tab = activeTab();
  const isText = !!tab && tab.kind === 'text';
  const isDiff = !!tab && tab.kind === 'diff';
  /** 過去の版・Drive 上の内容と比べられるか（一時メモと作成中は実体がまだ無い）。 */
  const hasSaved = isText && !tab.temp && !tab.creating;

  return [
    { id: 'memo.new', label: '新しい一時メモ', icon: 'memo', key: MOD + '+Alt+N',
      hint: '保存先はあとで決める', run: () => void TempMemo.create() },
    { id: 'memo.promote', label: 'この一時メモの保存先を決める…', icon: 'save',
      key: MOD + '+S', when: () => isText && tab.temp,
      run: () => void TempMemo.promote(App.activeId) },
    { id: 'memo.show', label: '一時メモの一覧を開く', icon: 'memo',
      run: () => void showTempSection() },
    { id: 'file.new', label: '新規ファイル', icon: 'file-new', hint: '選択中のフォルダに作成',
      run: () => startInlineCreate('newFile', targetFolderId()) },
    { id: 'folder.new', label: '新規フォルダ', icon: 'folder-new',
      run: () => startInlineCreate('newFolder', targetFolderId()) },
    { id: 'root.add', label: 'フォルダを管理（追加・削除）', icon: 'folders',
      run: () => Picker.open(null) },
    { id: 'tree.refresh', label: 'すべて再読み込み', icon: 'refresh',
      run: () => void refreshAllRoots() },
    { id: 'tree.collapse', label: 'ツリーをすべて折りたたむ', icon: 'collapse',
      run: () => { collapseAllFolders(); } },
    { id: 'quickopen', label: 'ファイルを開く…', icon: 'search', key: MOD + '+P',
      run: () => Palette.open('file') },
    { id: 'tab.reopen', label: '閉じたタブを開き直す', icon: 'file-text', key: 'Alt+Shift+T',
      when: () => ClosedTabs.stack.length > 0, run: () => void ClosedTabs.reopen() },
    { id: 'draft.stashes', label: '退避した下書きを確認する', icon: 'save',
      hint: '保存できなかった編集内容', when: () => DraftStash.known.size > 0,
      run: () => void DraftStash.showList() },

    { id: 'term.toggle',
      label: Term.tabs().length ? 'ターミナルへ移る / 戻る' : 'ターミナルを開く',
      icon: 'terminal', key: 'Ctrl+` / ' + MOD + '+Alt+T',
      hint: 'Drive をパスで辿って、まとめて動かす（help で一覧）',
      run: () => void Term.toggle() },
    { id: 'term.new', label: '新しいターミナル', icon: 'terminal',
      hint: '画面下に段を足して開く',
      when: () => Term.tabs().length > 0 && Term.tabs().length < 4,
      run: () => void Term.open() },
    { id: 'term.here', label: 'このファイルの場所でターミナルを開く', icon: 'terminal',
      when: () => isText && !!Tree.get(tab.id) && !!Tree.get(tab.id).parentId,
      run: () => void Term.open({ cwd: Tree.get(tab.id).parentId }) },

    { id: 'file.save', label: '保存', icon: 'save', key: MOD + '+S',
      when: () => isText && !tab.temp, run: () => void saveNow(App.activeId) },
    { id: 'file.saveAll', label: 'すべて保存', icon: 'save',
      when: () => App.tabs.some((t) => t.dirty), run: () => void saveAllDirty() },
    { id: 'file.reload', label: 'Drive から読み直す（編集内容は破棄）', icon: 'reload',
      when: () => isText, run: () => void reloadTab(App.activeId) },
    { id: 'tab.close', label: 'タブを閉じる', icon: 'close',
      when: () => !!tab, run: () => void closeTab(App.activeId) },
    { id: 'tab.closeOthers', label: '他のタブを閉じる', icon: 'clear',
      hint: '同じペインの中だけ',
      when: () => paneTabs().length > 1,
      run: () => void closeTabs(paneTabs().filter((t) => t.id !== App.activeId && !t.pinned)) },

    { id: 'pane.splitRight', label: 'ペインを右に分割', icon: 'columns', key: MOD + '+\\',
      hint: '同じファイルは 2 枚に出せないので、新しいペインは空で始まる',
      when: () => Panes.leaves().length < Panes.MAX,
      run: () => splitActivePane('row') },
    { id: 'pane.splitDown', label: 'ペインを下に分割', icon: 'rows', key: MOD + '+Shift+\\',
      when: () => Panes.leaves().length < Panes.MAX,
      run: () => splitActivePane('col') },
    { id: 'pane.rootBottom', label: '全幅のペインを下に足す', icon: 'rows',
      hint: 'いまの分割の外側に作るので、横いっぱいの段になる',
      when: () => Panes.leaves().length < Panes.MAX,
      run: () => { const fresh = Panes.splitRoot('col', true); if (fresh) showEmptyPane(fresh); } },
    { id: 'pane.rootRight', label: '全高のペインを右に足す', icon: 'columns',
      hint: 'いまの分割の外側に作るので、縦いっぱいの列になる',
      when: () => Panes.leaves().length < Panes.MAX,
      run: () => { const fresh = Panes.splitRoot('row', true); if (fresh) showEmptyPane(fresh); } },
    { id: 'pane.next', label: '次のペインへ', icon: 'columns', key: 'Alt+1 〜 6',
      when: () => Panes.isSplit(), run: () => focusNextPane(1) },
    { id: 'pane.close', label: 'このペインを閉じる', icon: 'close',
      hint: '中のタブも閉じる', when: () => Panes.isSplit(),
      run: () => void Panes.close(Panes.activeId) },
    { id: 'tab.pin', label: tab && tab.pinned ? 'ピン留めを外す' : 'ピン留めする', icon: 'pin',
      hint: 'サイドバーの「ピン留め」に並び、次に開くときは 1 クリック',
      when: () => !!tab, run: () => Pins.toggleTab(tab) },
    { id: 'pin.show', label: 'ピン留めの一覧を開く', icon: 'pin',
      hint: Pins.items.length ? Pins.items.length + ' 件' : 'まだありません',
      run: () => showPinSection() },

    { id: 'view.sidebar', label: 'サイドバーの表示切り替え', icon: 'sidebar', key: MOD + '+B',
      run: () => Layout.toggleSidebar() },
    { id: 'view.wrap', label: '行の折り返しを切り替え', icon: 'wrap', key: 'Alt+Z',
      run: () => { Editor.toggleWrap(); } },
    { id: 'view.preview',
      label: (PREVIEW_LABELS[Preview.mode(tab)] || 'プレビュー') + 'の切り替え',
      icon: 'preview', key: MOD + '+Shift+V',
      when: () => isText && !!Preview.mode(tab), run: () => void togglePreview() },
    { id: 'view.previewSync',
      label: Settings.get('previewScrollSync')
        ? 'プレビューの左右連動を切る' : 'プレビューの左右連動を入れる',
      icon: 'preview',
      when: () => isText && tab.langKey === 'markdown',
      run: () => {
        Settings.set('previewScrollSync', !Settings.get('previewScrollSync'));
        toast('プレビューの左右連動を' + (Settings.get('previewScrollSync') ? '入れました' : '切りました'),
          'info', 3000);
      } },
    { id: 'view.mdbar',
      label: Settings.get('mdToolbar')
        ? 'Markdown の入力バーを隠す' : 'Markdown の入力バーを出す',
      icon: 'preview',
      when: () => isText && tab.langKey === 'markdown',
      run: () => { Settings.set('mdToolbar', !Settings.get('mdToolbar')); } },
    { id: 'view.theme',
      label: '外観を変更（ライト / ダーク / システム）',
      icon: THEME_ICONS[Theme.mode] || 'theme',
      hint: 'いまは' + (THEME_LABELS[Theme.mode] || ''),
      run: () => showThemeMenu() },
    { id: 'view.keys', label: 'キーボードショートカット一覧', icon: 'keyboard',
      run: () => showKeyHelp() },
    { id: 'view.search', label: '全体検索を開く', icon: 'search', key: MOD + '+Shift+F',
      run: () => { Views.show('search'); el.searchInput.focus(); } },
    { id: 'view.history', label: '変更履歴を開く', icon: 'history',
      when: () => !!tab, run: () => Views.show('history') },
    { id: 'view.settings', label: '設定を開く', icon: 'settings',
      run: () => Views.show('settings') },
    { id: 'view.autosave',
      label: Settings.get('autosaveEnabled') ? '自動保存を切る' : '自動保存を入れる',
      icon: 'timer',
      run: () => {
        Settings.set('autosaveEnabled', !Settings.get('autosaveEnabled'));
        toast('自動保存を' + (Settings.get('autosaveEnabled') ? '入れました' : '切りました'),
          'info', 3000);
      } },

    { id: 'edit.find', label: '検索・置換', icon: 'search', key: MOD + '+F',
      when: () => isText,
      run: () => { if (Editor.view) Editor.cm.openSearchPanel(Editor.view); } },
    { id: 'edit.gotoLine', label: '行番号へ移動', icon: 'goto', key: MOD + '+Alt+G',
      when: () => isText,
      run: () => { if (Editor.view) Editor.cm.gotoLine(Editor.view); } },
    { id: 'edit.indent', label: 'インデント設定を変更', icon: 'indent-in',
      when: () => isText, run: () => showIndentMenu() },
    { id: 'edit.eol', label: '改行コードを変更', icon: 'eol',
      when: () => isText, run: () => showEolMenu() },
    { id: 'edit.lang', label: '言語モードを変更', icon: 'braces',
      when: () => isText, run: () => showLangMenu() },

    { id: 'diff.open', label: '比較ビューを開く', icon: 'diff',
      hint: '左右の材料はあとから選ぶ（貼り付けでもよい）',
      run: () => void Diff.open() },
    { id: 'diff.withSaved', label: 'このファイルを Drive 上の内容と比較', icon: 'diff',
      hint: '未保存の編集が何を変えるかを見る',
      when: () => hasSaved, run: () => void Diff.withSaved(App.activeId) },
    { id: 'diff.withRevision', label: 'このファイルを過去の版と比較…', icon: 'history',
      when: () => hasSaved, run: () => void Diff.pickRevisionAndCompare(App.activeId, tab.name) },
    { id: 'diff.withFile', label: 'このファイルを別のファイルと比較…', icon: 'diff',
      when: () => isText, run: () => void Diff.fromTab(App.activeId, 'file') },
    { id: 'diff.withPaste', label: 'このファイルを貼り付けたテキストと比較…', icon: 'paste',
      when: () => isText, run: () => void Diff.fromTab(App.activeId, 'paste') },
    { id: 'diff.withTab', label: 'このファイルを他のタブと比較…', icon: 'file-text',
      when: () => isText && App.tabs.filter((t) => t.kind === 'text').length > 1,
      run: () => void Diff.fromTab(App.activeId, 'tab') },
    { id: 'diff.next', label: '次の差分へ', icon: 'arrow-down', key: 'F7',
      when: () => isDiff, run: () => { Diff.nav(tab, 1); } },
    { id: 'diff.prev', label: '前の差分へ', icon: 'arrow-up', key: 'Shift+F7',
      when: () => isDiff, run: () => { Diff.nav(tab, -1); } },
    { id: 'diff.swap', label: '比較の左右を入れ替え', icon: 'swap',
      when: () => isDiff, run: () => void Diff.swap(tab) },
    { id: 'diff.mode',
      label: tab && isDiff && tab.diff.mode === 'unified'
        ? '比較を並列表示にする' : '比較をインライン表示にする',
      icon: 'columns',
      when: () => isDiff,
      run: () => void Diff.setMode(tab, tab.diff.mode === 'unified' ? 'split' : 'unified') },
    { id: 'diff.normalize',
      label: tab && isDiff && tab.diff.normalize
        ? '比較で空白の違いを見る' : '比較で空白の違いを無視する',
      icon: 'equal',
      when: () => isDiff, run: () => void Diff.toggleNormalize(tab) },

    { id: 'perf.show', label: 'パフォーマンス計測を表示', icon: 'timer',
      hint: '起動と操作の所要時間（p50 / p95）', run: () => Perf.show() }
  ].filter((c) => !c.when || c.when());
}

/** ツリーのフォルダを全部畳む（ルートは残す）。 */
function collapseAllFolders() {
  for (const node of Tree.nodes.values()) {
    if (node.type === 'folder' && !Tree.isRoot(node.id)) node.expanded = false;
  }
  renderTree();
  Session.save();
}

