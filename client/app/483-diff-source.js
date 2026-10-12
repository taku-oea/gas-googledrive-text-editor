/* ------------------------------------------------------------------ *
 *  Diff（続き）— 比べる材料を選ぶ
 * ------------------------------------------------------------------ */

Object.assign(Diff, {

  /* -------------------------------------------------- *
   *  材料を選ぶ
   * -------------------------------------------------- */

  sourceMenu(tab, which, anchor) {
    const d = tab.diff;
    const side = d[which];
    const label = which === 'a' ? '左' : '右';
    const items = [];
    const openTexts = App.tabs.filter((t) => t.kind === 'text');

    items.push({
      label: '開いているタブの内容…', icon: 'file-text',
      disabled: !openTexts.length,
      onClick: () => { void Diff.pickFromTabs(tab, which); }
    });
    items.push({
      label: 'Drive のファイル…', icon: 'drive',
      onClick: () => { void Diff.pickFromFiles(tab, which); }
    });
    if (side.fileId) {
      items.push({
        label: '「' + side.name + '」の過去の版…', icon: 'history',
        onClick: () => { void Diff.pickFromRevisions(tab, which, side.fileId, side.name); }
      });
    }
    items.push({
      label: 'テキストを貼り付け…', icon: 'paste',
      onClick: () => { void Diff.pickPaste(tab, which); }
    });
    items.push({
      label: 'クリップボードから読み込む', icon: 'copy',
      onClick: () => { void Diff.pickClipboard(tab, which); }
    });

    if (side.fileId && side.origin !== 'file') {
      items.push({ sep: true });
      items.push({
        label: 'Drive 上の保存済み内容に切り替え', icon: 'drive',
        onClick: () => { void Diff.useFile(tab, which, side.fileId, side.name); }
      });
    }
    if (side.fileId && side.origin !== 'buffer' && getTab(side.fileId)) {
      if (side.origin === 'file') items.push({ sep: true });
      items.push({
        label: '開いているタブの内容に切り替え', icon: 'file-text',
        onClick: () => { void Diff.useTabContent(tab, which, side.fileId); }
      });
    }

    items.push({ sep: true });
    const write = Diff.writeBackLabel(tab, which);
    if (side.target === 'drive' || side.target === 'tab') {
      items.push({
        label: side.target === 'drive' ? label + 'を Drive に保存' : label + 'をタブへ反映',
        icon: 'save', disabled: !write,
        onClick: () => { void Diff.writeBack(tab, which); }
      });
    }
    items.push({
      label: label + 'の内容を新しいファイルに保存…', icon: 'file-new',
      disabled: d.normalize || !Diff.contentOf(tab, which).length,
      onClick: () => { void Diff.guarded(tab, () => Diff.saveAs(tab, which)); }
    });
    items.push({
      label: label + 'の内容をコピー', icon: 'copy',
      disabled: !Diff.contentOf(tab, which).length,
      onClick: () => { void Diff.copyContent(tab, which); }
    });
    items.push({ sep: true });
    items.push({
      label: label + 'を空にする', icon: 'clear',
      disabled: side.origin === 'empty',
      onClick: () => { void Diff.setSide(tab, which, makeDiffSide()); }
    });
    items.push({ label: '左右を入れ替え', icon: 'swap', onClick: () => { void Diff.swap(tab); } });

    const rect = anchor.getBoundingClientRect();
    Ctx.show(rect.left, rect.bottom + 2, items);
  },

  /**
   * 一覧から 1 つ選んでもらう。8 件を超えるときだけ絞り込み欄を出す。
   * @param {string} title
   * @param {Array<{name:string, hint?:string, icon?:string, value:*}>} rows
   * @param {string} emptyText
   * @return {Promise<*>} 選ばれた value（キャンセルなら null）
   */
  pickRow(title, rows, emptyText) {
    const list = h('div', { class: 'diffPick__list' });
    const input = h('input', {
      type: 'text', class: 'input input--filter', placeholder: '名前で絞り込み',
      spellcheck: 'false', autocomplete: 'off'
    });
    let closeWith = null;

    const paint = () => {
      const needle = input.value.trim().toLowerCase();
      const shown = needle
        ? rows.filter((r) => (r.name + ' ' + (r.hint || '')).toLowerCase().includes(needle))
        : rows;
      list.textContent = '';
      if (!shown.length) {
        list.appendChild(h('div', {
          class: 'diffPick__empty', text: rows.length ? '一致するものがありません' : emptyText
        }));
        return;
      }
      for (const row of shown.slice(0, 300)) {
        list.appendChild(h('button', {
          type: 'button', class: 'diffPick__item',
          onclick: () => { if (closeWith) closeWith(row.value); }
        }, [
          h('span', { class: 'diffPick__icon' }, [icon(row.icon || 'file-text')]),
          h('span', { class: 'diffPick__name', text: row.name }),
          h('span', { class: 'diffPick__hint', text: row.hint || '' })
        ]));
      }
    };

    input.addEventListener('input', paint);
    const withFilter = rows.length > 8;
    paint();

    return modal({
      title,
      wide: true,
      body: h('div', { class: 'diffPick' }, [withFilter ? input : null, list]),
      actions: [{ label: 'キャンセル', value: null }],
      onOpen: (ctl) => {
        closeWith = ctl.close;
        if (withFilter) input.focus();
      }
    });
  },

  async pickFromTabs(tab, which) {
    const rows = App.tabs
      .filter((t) => t.kind === 'text')
      .map((t) => ({
        name: t.name,
        hint: (t.dirty ? '未保存の編集あり' : '編集中の内容') +
          (Tree.get(t.id) ? ' · ' + Tree.pathOf(t.id) : ''),
        icon: 'file-text',
        value: t.id
      }));
    const id = await Diff.pickRow('開いているタブの内容', rows, '開いているテキストのタブがありません。');
    if (!id) return;
    await Diff.useTabContent(tab, which, id);
  },

  async pickFromFiles(tab, which) {
    const rows = Tree.allFiles()
      .filter((n) => n.entry && n.entry.viewer === 'editor')
      .map((n) => ({ name: n.name, hint: Tree.pathOf(n.id), icon: 'file-text', value: n.id }));
    const id = await Diff.pickRow('Drive のファイル', rows,
      'ツリーに読み込まれているテキストファイルがありません（フォルダを展開してください）。');
    if (!id) return;
    await Diff.useFile(tab, which, id, null);
  },

  /**
   * 過去の版を選んでもらう。
   * @return {Promise<Object|null>} listRevisions の 1 件（キャンセルなら null）
   */
  async chooseRevision(fileId, name) {
    let revs;
    try {
      revs = (await Api.listRevisions(fileId)).revisions || [];
    } catch (err) {
      toast('履歴を取得できませんでした: ' + err.message, 'error', 9000);
      return null;
    }
    if (!revs.length) {
      toast('このファイルには履歴がありません。', 'info', 4000);
      return null;
    }
    const rows = revs.map((rev, i) => ({
      name: new Date(rev.modifiedTime).toLocaleString('ja-JP') + (i === 0 ? '（最新）' : ''),
      hint: [rev.lastModifyingUser, rev.size ? formatBytes(rev.size) : null]
        .filter(Boolean).join(' · '),
      icon: 'history',
      value: rev.id
    }));
    const id = await Diff.pickRow('「' + name + '」の過去の版', rows, '');
    if (!id) return null;
    return revs.find((r) => r.id === id) || null;
  },

  async pickFromRevisions(tab, which, fileId, name) {
    const rev = await Diff.chooseRevision(fileId, name);
    if (!rev || !getTab(tab.id)) return;
    Diff.setBusy(tab, which, '過去の版を読み込み中…');
    try {
      await Diff.setSide(tab, which, await diffSideFromRevision(fileId, name, rev));
    } catch (err) {
      toast('過去の版を読めませんでした: ' + err.message, 'error', 9000);
      Diff.renderBar(tab);
    }
  },

  async pickPaste(tab, which) {
    const side = tab.diff[which];
    const area = h('textarea', {
      class: 'diffPaste', spellcheck: 'false',
      placeholder: 'ここに貼り付け（' + MOD + ' + V）'
    });
    area.value = side.origin === 'text' ? side.content : '';
    const nameInput = h('input', {
      type: 'text', class: 'input', placeholder: '表示名（省略可）',
      spellcheck: 'false', autocomplete: 'off',
      value: side.origin === 'text' ? side.name : ''
    });

    const ok = await modal({
      title: (which === 'a' ? '左' : '右') + 'に入れるテキスト',
      wide: true,
      body: h('div', { class: 'diffPick' }, [area, nameInput]),
      actions: [
        { label: 'この内容で比較', value: true, variant: 'primary' },
        { label: 'キャンセル', value: false }
      ],
      onOpen: () => { area.focus(); }
    });
    if (!ok) return;

    const name = nameInput.value.trim() || ('貼り付け ' + (++Diff.pasteSeq));
    await Diff.setSide(tab, which, diffSideFromText(area.value, name));
  },

  async pickClipboard(tab, which) {
    let text = null;
    try {
      text = await navigator.clipboard.readText();
    } catch (e) {
      text = null;
    }
    if (typeof text !== 'string' || !text.length) {
      // サンドボックス iframe では読み取り権限が無いことがある。手で貼れる欄を出す。
      toast('クリップボードを読めませんでした。貼り付け用の入力欄を開きます。', 'info', 4000);
      await Diff.pickPaste(tab, which);
      return;
    }
    await Diff.setSide(tab, which, diffSideFromText(text, 'クリップボード'));
  },

  async useFile(tab, which, fileId, name) {
    Diff.setBusy(tab, which, '読み込み中…');
    try {
      await Diff.setSide(tab, which, await diffSideFromFile(fileId, name));
    } catch (err) {
      toast(err.message, 'error', 9000);
      Diff.renderBar(tab);
    }
  },

  async useTabContent(tab, which, tabId) {
    const t = getTab(tabId);
    if (!t || t.kind !== 'text') {
      toast('そのタブは閉じられています。', 'error', 5000);
      return;
    }
    await Diff.setSide(tab, which, diffSideFromTab(t));
  }
});
