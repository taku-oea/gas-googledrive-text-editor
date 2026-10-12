/* ------------------------------------------------------------------ *
 *  変更履歴（Drive のリビジョン）
 * ------------------------------------------------------------------ */

const History = {
  fileId: null,

  async load(force) {
    const tab = activeTab();
    if (!tab) {
      el.historyList.textContent = '';
      el.historyList.appendChild(h('div', {
        class: 'placeholder', text: 'ファイルを開くと、そのファイルの履歴を表示します。'
      }));
      el.historyFoot.textContent = '';
      History.fileId = null;
      return;
    }
    if (tab.kind === 'diff') {
      el.historyList.textContent = '';
      el.historyList.appendChild(h('div', {
        class: 'placeholder',
        text: '比較タブでは履歴を表示できません。' +
          '過去の版と比べるときは、左右の材料から「過去の版…」を選んでください。'
      }));
      el.historyFoot.textContent = '';
      History.fileId = null;
      return;
    }
    if (tab.kind !== 'text') {
      el.historyList.textContent = '';
      el.historyList.appendChild(h('div', {
        class: 'placeholder',
        text: 'このファイルは閲覧のみです。過去の版は Drive 側で確認してください。'
      }));
      el.historyFoot.textContent = tab.name;
      History.fileId = tab.id;
      return;
    }
    if (!force && History.fileId === tab.id) return;

    History.fileId = tab.id;
    el.historyList.textContent = '';
    el.historyList.appendChild(h('div', { class: 'placeholder', text: '読み込み中…' }));
    el.historyFoot.textContent = tab.name;

    try {
      const data = await Api.listRevisions(tab.id);
      if (History.fileId !== tab.id) return;   // 途中で切り替わった
      History.render(tab, data.revisions);
    } catch (err) {
      el.historyList.textContent = '';
      el.historyList.appendChild(h('div', { class: 'placeholder', text: err.message }));
    }
  },

  render(tab, revisions) {
    el.historyList.textContent = '';
    if (!revisions.length) {
      el.historyList.appendChild(h('div', {
        class: 'placeholder', text: 'このファイルの履歴はありません。'
      }));
      return;
    }

    revisions.forEach((rev, i) => {
      const when = new Date(rev.modifiedTime);
      el.historyList.appendChild(h('div', { class: 'revRow' }, [
        h('button', {
          type: 'button',
          class: 'rev',
          title: '内容をエディタに読み込みます（Drive 上のファイルはまだ変わりません）',
          onclick: () => void History.open(tab.id, rev)
        }, [
          h('span', { class: 'rev__when',
            text: (i === 0 ? '最新: ' : '') + when.toLocaleString('ja-JP') }),
          h('span', { class: 'rev__meta',
            text: [rev.lastModifyingUser, rev.size ? formatBytes(rev.size) : null]
              .filter(Boolean).join(' · ') })
        ]),
        h('button', {
          type: 'button',
          class: 'rev__diff',
          title: 'この版といまの内容を並べて比べます（読み込みません）',
          onclick: () => void Diff.withRevision(tab.id, tab.name, rev)
        }, [icon('diff')])
      ]));
    });
    el.historyFoot.textContent = tab.name + ' · ' + revisions.length + ' 版';
  },

  /**
   * 過去の版をエディタに読み込む。
   * Drive 上のファイルは書き換えない。保存すれば結果的に復元になり、
   * 競合検出も通常どおり働く。
   */
  async open(fileId, rev) {
    const tab = getTab(fileId);
    if (!tab) return;

    const go = await modal({
      title: '過去の版を読み込む',
      body: h('div', {}, [
        h('p', { text: new Date(rev.modifiedTime).toLocaleString('ja-JP') +
          ' の内容をエディタに読み込みます。' }),
        h('p', { text: 'Drive 上のファイルはまだ変わりません。' +
          'この状態で保存すると復元されます。' }),
        tab.dirty
          ? h('p', { text: 'いまの編集内容は破棄されます（未保存の変更があります）。' })
          : null
      ]),
      actions: [
        { label: '読み込む', value: true, variant: tab.dirty ? 'danger' : 'primary' },
        { label: 'キャンセル', value: false }
      ]
    });
    if (!go) return;

    try {
      const data = await Api.readRevision(fileId, rev.id);
      const t = getTab(fileId);
      if (!t) return;
      // 改行コードは現在の設定を保つ（保存時に戻される）。
      replaceTabDoc(t, normalizeEol(data.content));
      t.dirty = true;
      renderTabs();
      renderTreeStates();
      if (App.activeId === t.id) setStatusText('unsaved', '未保存（過去の版）');
      scheduleAutoSave(t.id);
      toast('読み込みました。保存すると復元されます。', 'info', 6000);
    } catch (err) {
      toast(err.message, 'error', 10000);
    }
  }
};

