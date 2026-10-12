/* ------------------------------------------------------------------ *
 *  保存ステータス表示（アクティブタブの状態を映す）
 * ------------------------------------------------------------------ */

function refreshStatus() {
  const tab = activeTab();
  if (!tab) {
    el.status.dataset.state = 'idle';
    el.statusText.textContent = App.tabs.length ? '' : '—';
    return;
  }
  if (tab.kind === 'diff') {
    // 比較タブは Drive 上のファイルに 1 対 1 で対応しないので、
    // 「書き戻していない変更があるか」だけを出す。
    const unsaved = Diff.hasUnsaved(tab);
    el.status.dataset.state = unsaved ? 'unsaved' : 'idle';
    el.statusText.textContent = unsaved ? '比較 · 書き戻していない変更' : '比較';
    return;
  }
  if (tab.kind === 'preview') {
    // プレビューは元のファイルを映しているだけ。保存の状態は元のタブ側に出る。
    const src = Preview.sourceOf(tab);
    el.status.dataset.state = 'idle';
    el.statusText.textContent = 'プレビュー' + (src ? ' · ' + src.name : '');
    return;
  }
  if (tab.kind === 'term') {
    const busy = !!(tab.term && tab.term.busy);
    el.status.dataset.state = busy ? 'saving' : 'idle';
    el.statusText.textContent = busy ? 'コマンドを実行中…' : 'ターミナル';
    return;
  }
  if (tab.creating) {
    el.status.dataset.state = 'saving';
    el.statusText.textContent = '一時メモを作成中…';
  } else if (tab.createError) {
    el.status.dataset.state = 'error';
    el.statusText.textContent = '保存先を作れません · ' + MOD + '+S で再試行';
  } else if (tab.saving) {
    el.status.dataset.state = 'saving';
    el.statusText.textContent = '保存中…';
  } else if (tab.saveError) {
    el.status.dataset.state = 'error';
    el.statusText.textContent = '保存失敗';
  } else if (tab.conflicted) {
    el.status.dataset.state = 'error';
    el.statusText.textContent = '競合';
  } else if (tab.dirty) {
    el.status.dataset.state = 'unsaved';
    el.statusText.textContent = '未保存';
  } else if (tab.temp) {
    // 保存はされている（tmp にある）が、置き場所がまだ決まっていない状態。
    el.status.dataset.state = 'saved';
    el.statusText.textContent = '一時メモ · ' + MOD + '+S で保存先を決める';
  } else if (tab.lastSavedAt) {
    el.status.dataset.state = 'saved';
    el.statusText.textContent = '保存済み ' + formatClock(tab.lastSavedAt);
  } else {
    el.status.dataset.state = 'saved';
    el.statusText.textContent = '保存済み';
  }
}

function setStatusText(state, text) {
  el.status.dataset.state = state;
  el.statusText.textContent = text;
}

