/* ------------------------------------------------------------------ *
 *  Diff（続き）— 操作・書き戻し・保存
 * ------------------------------------------------------------------ */

Object.assign(Diff, {

  /** タブバーの印（未書き戻し）と状態表示を更新する。 */
  touchStatus(tab) {
    renderTabs();
    if (App.activeId === tab.id) refreshStatus();
  },

  /** 読み込み中であることを材料の説明欄に出す。 */
  setBusy(tab, which, text) {
    tab.diff[which].sub = text;
    Diff.renderBar(tab);
  },

  /** 片側の材料を差し替える。書き戻していない変更があれば確認する。 */
  async setSide(tab, which, side) {
    if (!getTab(tab.id)) return;
    const d = tab.diff;
    if (d[which].dirty) {
      const go = await modal({
        title: '書き戻していない変更があります',
        body: (which === 'a' ? '左' : '右') + '側には、まだ書き戻していない変更があります。' +
          '材料を差し替えると失われます。',
        actions: [
          { label: '差し替える', value: true, variant: 'danger' },
          { label: 'キャンセル', value: false, variant: 'primary' }
        ]
      });
      if (!go) { Diff.renderBar(tab); return; }
    }
    // もう片側の編集結果は持ち越す。
    Diff.captureContents(tab);
    d[which] = side;
    d[which].dirty = false;
    tab.name = Diff.tabName(tab);
    Diff.touchStatus(tab);
    await Diff.rebuild(tab);
  },

  async swap(tab) {
    const d = tab.diff;
    Diff.captureContents(tab);
    const a = d.a;
    d.a = d.b;
    d.b = a;
    d.revert = d.revert === 'a-to-b' ? 'b-to-a' : 'a-to-b';
    tab.name = Diff.tabName(tab);
    renderTabs();
    await Diff.rebuild(tab);
  },

  /* -------------------------------------------------- *
   *  表示の切り替え
   * -------------------------------------------------- */

  async setMode(tab, mode) {
    const d = tab.diff;
    if (d.mode === mode) return;
    Diff.captureContents(tab);
    d.mode = mode;
    await Diff.rebuild(tab);
  },

  /** 畳みは作り直さずに切り替えられる（reconfigure が効く）。 */
  toggleCollapse(tab) {
    const d = tab.diff;
    d.collapse = !d.collapse;
    if (d.view && d.mode === 'split') {
      d.view.reconfigure({ collapseUnchanged: d.collapse ? Diff.COLLAPSE : undefined });
      Diff.renderBar(tab);
    } else {
      void Diff.rebuild(tab);
    }
  },

  flipRevert(tab) {
    const d = tab.diff;
    d.revert = d.revert === 'a-to-b' ? 'b-to-a' : 'a-to-b';
    if (d.view && d.mode === 'split') d.view.reconfigure({ revertControls: d.revert });
    Diff.renderBar(tab);
  },

  async toggleNormalize(tab) {
    const d = tab.diff;
    if (!d.normalize && (d.a.dirty || d.b.dirty)) {
      const go = await modal({
        title: '整形して比較しますか',
        body: '書き戻していない変更があります。整形して比較している間は' +
          '表示が整形後の内容になるため、変更は破棄されます。',
        actions: [
          { label: '整形して比較', value: true, variant: 'danger' },
          { label: 'キャンセル', value: false, variant: 'primary' }
        ]
      });
      if (!go) return;
      d.a.dirty = false;
      d.b.dirty = false;
    } else {
      Diff.captureContents(tab);
    }
    d.normalize = !d.normalize;
    await Diff.rebuild(tab);
  },

  /* -------------------------------------------------- *
   *  書き戻し
   * -------------------------------------------------- */

  /**
   * 書き込みを 1 本に絞って走らせる。走っている間は次の呼び出しを受けない
   * （ボタン連打や Mod+S の重なりで、同じ基準日時のまま 2 回保存して
   * 2 回目が必ず競合になる・同じ内容のファイルが 2 つできるのを防ぐ）。
   */
  async guarded(tab, fn) {
    if (tab.diff.writing) return;
    tab.diff.writing = true;
    try {
      await fn();
    } finally {
      const t = getTab(tab.id);
      if (t && t.diff) t.diff.writing = false;
    }
  },

  /** 片側を書き戻す。行き先は DiffSide.target が持っている。 */
  writeBack(tab, which) {
    return Diff.guarded(tab, () => Diff.writeBackNow(tab, which));
  },

  async writeBackNow(tab, which) {
    const d = tab.diff;
    const side = d[which];
    if (d.normalize) {
      toast('「空白を無視」で比較している間は書き戻せません（表示が整形後の内容のため）。', 'error', 8000);
      return;
    }
    if (side.target === 'tab') {
      const t = getTab(side.fileId);
      if (!t || t.kind !== 'text') {
        toast('反映先のタブが見つかりません。「新しいファイルに保存」を使ってください。', 'error', 7000);
        return;
      }
      const content = Diff.contentOf(tab, which);
      if (tabDoc(t) === content) {
        side.dirty = false;
        Diff.renderBar(tab);
        toast('タブの内容と同じです。', 'info', 3000);
        return;
      }
      replaceTabDoc(t, content);
      t.dirty = true;
      // もう片側が同じファイルの Drive 上の内容なら、その版を見たうえで決めた内容なので、
      // タブの基準日時をその版まで進めて競合を解く（進めないと次の保存がまた競合になる）。
      advanceBaseFromDiff(t, d[which === 'a' ? 'b' : 'a']);
      Draft.schedule(t.id);
      renderTabs();
      renderTreeStates();
      if (App.activeId === t.id) setStatusText('unsaved', '未保存（比較ビューから反映）');
      scheduleAutoSave(t.id);
      side.content = content;
      side.dirty = false;
      side.sub = '開いているタブ · 未保存の編集あり';
      Diff.renderBar(tab);
      Diff.touchStatus(tab);
      toast('「' + t.name + '」のタブへ反映しました（保存は通常どおり走ります）', 'info', 5000);
      return;
    }
    if (side.target === 'drive' && side.fileId) {
      await Diff.saveToDrive(tab, which, false);
      return;
    }
    await Diff.saveAs(tab, which);
  },

  /** フォーカスしている側を書き戻す（Mod+S）。 */
  async saveFocused(tabId) {
    const tab = getTab(tabId);
    if (!tab || tab.kind !== 'diff') return;
    const d = tab.diff;
    const which = Diff.focusedSide(tab);
    const other = which === 'a' ? 'b' : 'a';
    if (d[which].dirty) { await Diff.writeBack(tab, which); return; }
    if (d[other].dirty) { await Diff.writeBack(tab, other); return; }
    toast('書き戻す変更はありません。', 'info', 2500);
  },

  async saveToDrive(tab, which, force) {
    const side = tab.diff[which];
    const content = Diff.contentOf(tab, which);
    const body = restoreEol(content, side.eol);
    const before = side.sub;
    Diff.setBusy(tab, which, '保存中…');

    try {
      const res = await Api.saveFile(side.fileId, body, side.updatedAtIso, !!force);
      if (!getTab(tab.id)) return;
      side.updatedAtIso = res.updatedAtIso;
      side.size = res.size;
      side.name = res.name || side.name;
      side.content = content;
      side.dirty = false;
      side.sub = 'Drive 上の内容 · ' + new Date(res.updatedAtIso).toLocaleString('ja-JP');

      const rec = {
        id: side.fileId, name: side.name, mimeType: side.mimeType,
        size: res.size, content: body, updatedAtIso: res.updatedAtIso
      };
      Store.putContent(rec);
      LocalSnap.put(rec);
      patchEntry(side.fileId, { updatedAtIso: res.updatedAtIso, size: res.size });
      Diff.syncOpenTab(side.fileId, rec);
      tab.name = Diff.tabName(tab);
      Diff.renderBar(tab);
      Diff.touchStatus(tab);
      toast('「' + side.name + '」を保存しました', 'info', 4000);
    } catch (err) {
      if (!getTab(tab.id)) return;
      side.sub = before;
      Diff.renderBar(tab);

      if (err.code === 'CONFLICT') {
        const serverIso = err.detail && err.detail.serverUpdatedAtIso;
        const go = await modal({
          title: '保存の競合を検出しました',
          body: h('div', {}, [
            h('p', { text: '「' + side.name + '」は、比較を開いたあとに別の場所で更新されています。' }),
            h('p', {
              text: 'Drive 側の最終更新: ' +
                (serverIso ? new Date(serverIso).toLocaleString('ja-JP') : '不明')
            }),
            h('p', { text: '上書きすると、その更新は失われます。' })
          ]),
          actions: [
            { label: 'このまま上書き保存', value: 'overwrite', variant: 'danger' },
            { label: 'Drive 側を読み込み直す', value: 'reload' },
            { label: 'キャンセル', value: null, variant: 'primary' }
          ]
        });
        if (go === 'overwrite') await Diff.saveToDrive(tab, which, true);
        else if (go === 'reload') await Diff.useFile(tab, which, side.fileId, side.name);
        return;
      }
      toast('保存に失敗しました: ' + err.message, 'error', 10000);
    }
  },

  /** 同じファイルを開いているタブがあれば、保存した内容に追随させる。 */
  syncOpenTab(fileId, rec) {
    const t = getTab(fileId);
    if (!t || t.kind !== 'text') return;
    if (t.dirty) {
      toast('「' + t.name + '」のタブには未保存の編集があるため、そちらは書き換えていません。',
        'warn', 9000);
      return;
    }
    Editor.replaceDocKeepView(t, rec);
    renderTabs();
  },

  /** 片側の内容を新しいファイルとして保存する（貼り付けた文字列の書き出しにも使う）。 */
  async saveAs(tab, which) {
    const d = tab.diff;
    const side = d[which];
    if (d.normalize) {
      toast('「空白を無視」で比較している間は書き出せません（表示が整形後の内容のため）。', 'error', 8000);
      return;
    }
    const content = Diff.contentOf(tab, which);
    const choice = await Picker.choose({
      title: (which === 'a' ? '左' : '右') + 'の内容を保存',
      note: '新しいファイルとして保存します。比較ビューはそのまま残ります。',
      name: Diff.suggestName(side),
      folder: TempMemo.defaultFolder()
    });
    if (!choice || !getTab(tab.id)) return;

    Diff.setBusy(tab, which, '保存中…');
    try {
      const entry = await Api.createFile(choice.folderId, choice.name);
      const body = restoreEol(content, side.eol);
      const res = await Api.saveFile(entry.id, body, entry.updatedAtIso, true);
      Tree.insertChild(choice.folderId, entry);
      renderTree();
      Store.putContent({
        id: entry.id, name: entry.name, mimeType: entry.mimeType || '',
        size: res.size, content: body, updatedAtIso: res.updatedAtIso
      });
      App.lastSaveFolder = { id: choice.folderId, name: choice.folderName };
      toast('「' + entry.name + '」に保存しました', 'info', 5000);
      if (!getTab(tab.id)) return;
      // 保存できたので、この側の材料を新しいファイルに切り替える（次からは普通に保存できる）。
      side.dirty = false;
      await Diff.setSide(tab, which, await diffSideFromFile(entry.id, entry.name));
    } catch (err) {
      toast('保存できませんでした: ' + err.message, 'error', 10000);
      Diff.renderBar(tab);
    }
  },

  /** 書き出すときのファイル名の候補。 */
  suggestName(side) {
    if (side.name && side.origin !== 'empty' && side.origin !== 'text') {
      const dot = side.name.lastIndexOf('.');
      const base = dot > 0 ? side.name.slice(0, dot) : side.name;
      const ext = dot > 0 ? side.name.slice(dot) : '.txt';
      return base + ' (比較)' + ext;
    }
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return '比較 ' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + '.txt';
  },

  async copyContent(tab, which) {
    const text = Diff.contentOf(tab, which);
    try {
      await navigator.clipboard.writeText(text);
      toast((which === 'a' ? '左' : '右') + 'の内容をコピーしました（' + formatBytes(text.length) + '）',
        'info', 3000);
    } catch (e) {
      toast('ブラウザの制限でクリップボードへ書き込めませんでした。', 'error', 6000);
    }
  },

  /* -------------------------------------------------- *
   *  編集の検知
   * -------------------------------------------------- */

  onEdited(tabId, which) {
    const tab = getTab(tabId);
    if (!tab || tab.kind !== 'diff') return;
    const d = tab.diff;
    if (!d.normalize) d[which].dirty = true;
    // 打鍵ごとにバーを組み直さない（差分の数が変わるのを待ってから描く）。
    if (d.barTimer) return;
    d.barTimer = setTimeout(() => {
      d.barTimer = null;
      const t = getTab(tabId);
      if (!t || t.kind !== 'diff') return;
      Diff.refreshStats(t);
      Diff.renderBar(t);
      Diff.touchStatus(t);
    }, 150);
  },

  /** 書き戻していない変更があるか（タブを閉じるときとページを離れるときに見る）。 */
  hasUnsaved(tab) {
    return !!(tab.diff && (tab.diff.a.dirty || tab.diff.b.dirty));
  }
});

/**
 * タブへ反映したとき、比べた相手が同じファイルの Drive 上の内容（origin:'file'）なら、
 * タブの基準日時をその内容の更新日時に進め、競合の印を外す。
 *
 * 進めるのは比べた版そのものの日時だけ。比較を開いたあとに別の人が保存していれば
 * Drive の更新日時はそれより新しいので、次の保存は従来どおり競合として止まる。
 * タブの基準のほうが新しい（比較を開いたあとにタブを保存した）ときは戻さない。
 * @param {Tab} t 反映先のタブ
 * @param {DiffSide} other 反映した側と反対の材料
 * @return {boolean} 進めたか
 */
function advanceBaseFromDiff(t, other) {
  if (!other || other.origin !== 'file' || other.fileId !== t.id || !other.updatedAtIso) return false;
  const next = Date.parse(other.updatedAtIso);
  const cur = Date.parse(t.baseUpdatedAtIso || '');
  if (isNaN(next) || (!isNaN(cur) && next < cur)) return false;
  t.baseUpdatedAtIso = other.updatedAtIso;
  t.conflicted = false;
  return true;
}
