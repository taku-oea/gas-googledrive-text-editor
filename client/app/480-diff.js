/* ------------------------------------------------------------------ *
 *  比較ビュー（WinMerge 相当）
 *
 *  責務は「2 つの文字列を並べて差分を見せ、片側へ寄せられるようにする」
 *  ことだけ。左右の材料（DiffSide）はファイルであることを前提にしない。
 *  開いているタブの編集中の内容・Drive 上の保存済み内容・過去の版・
 *  貼り付けた文字列・空のどれでも、同じ画面で組み合わせて比べられる。
 *
 *  差分の計算と描画は @codemirror/merge に任せる（Diff.load で遅延読み込み。
 *  依存は vendor バンドルに入っているので、増えるのは merge 自身のぶんだけ）。
 *    並列（MergeView）     … 外側 1 つがスクロール領域なので左右がずれない
 *    インライン（unified） … 1 つのエディタに元の行をウィジェットで重ねる
 *
 *  比較タブは kind:'diff' の Tab として持つ。本文（state）を持たないので、
 *  保存・言語モード・プレビュー・自動保存といった text 用の処理は素通りする。
 *  セッションには記録しない（材料が Drive 上に無いことがあり復元できない）。
 * ------------------------------------------------------------------ */

/**
 * 比較の片側。「どこから来た文字列か」だけを持つ。
 *
 *   file     … Drive 上の保存済み内容（Drive へ書き戻せる）
 *   revision … Drive のリビジョン（過去の版。書き戻す先は無い）
 *   buffer   … 開いているタブの編集中の内容（タブへ反映できる）
 *   text     … 貼り付けた文字列（Drive 上に実体が無い）
 *   empty    … 空
 *
 * @typedef {{
 *   origin: ('file'|'revision'|'buffer'|'text'|'empty'),
 *   fileId: (string|null), revisionId: (string|null),
 *   name: string, sub: string, content: string,
 *   eol: ('LF'|'CRLF'), updatedAtIso: string, size: number,
 *   mimeType: string, langKey: (string|null),
 *   target: ('drive'|'tab'|null), dirty: boolean
 * }} DiffSide
 */

/**
 * @param {Object} [patch]
 * @return {DiffSide}
 */
function makeDiffSide(patch) {
  return Object.assign({
    origin: 'empty',
    fileId: null,
    revisionId: null,
    name: '空',
    sub: 'クリックして材料を選ぶ（貼り付けも可）',
    content: '',
    eol: 'LF',
    updatedAtIso: '',
    size: 0,
    mimeType: '',
    langKey: null,
    /** 書き戻す先。'drive' は Drive のファイル、'tab' は開いているタブ、null は無し。 */
    target: null,
    dirty: false
  }, patch || {});
}

/**
 * Drive 上の保存済み内容を片側にする。
 * 比較は「いまの Drive の中身」と比べたいので、キャッシュがあっても
 * 更新確認（readFile の unchanged 判定）を待つ。
 * @param {string} fileId
 * @param {string} [fallbackName] 読めなかったときのメッセージ用
 * @return {Promise<DiffSide>}
 */
async function diffSideFromFile(fileId, fallbackName) {
  const { data, revalidate } = Store.readFile(fileId);
  let d = data;
  if (revalidate) {
    const fresh = await revalidate.catch((err) => { if (d) return null; throw err; });
    if (fresh) d = fresh;
  }
  if (!d) throw new ApiError('NOT_FOUND', '「' + (fallbackName || fileId) + '」を読み込めませんでした。');
  return makeDiffSide({
    origin: 'file',
    fileId: d.id,
    name: d.name,
    sub: 'Drive 上の内容 · ' + new Date(d.updatedAtIso).toLocaleString('ja-JP'),
    content: normalizeEol(d.content),
    eol: detectEol(d.content) || Settings.get('defaultEol'),
    updatedAtIso: d.updatedAtIso,
    size: d.size,
    mimeType: d.mimeType || '',
    langKey: EXT_TO_LANG[extensionOf(d.name)] || null,
    target: 'drive'
  });
}

/**
 * Drive のリビジョン（過去の版）を片側にする。
 * @param {string} fileId
 * @param {string} name
 * @param {{id:string, modifiedTime:string, size:(number|undefined), lastModifyingUser:(string|undefined)}} rev
 * @return {Promise<DiffSide>}
 */
async function diffSideFromRevision(fileId, name, rev) {
  const data = await Api.readRevision(fileId, rev.id);
  const content = (data && typeof data.content === 'string') ? data.content : '';
  return makeDiffSide({
    origin: 'revision',
    fileId,
    revisionId: rev.id,
    name: name,
    sub: '過去の版 · ' + new Date(rev.modifiedTime).toLocaleString('ja-JP') +
      (rev.lastModifyingUser ? ' · ' + rev.lastModifyingUser : ''),
    content: normalizeEol(content),
    eol: detectEol(content) || Settings.get('defaultEol'),
    size: content.length,
    langKey: EXT_TO_LANG[extensionOf(name)] || null,
    target: null
  });
}

/**
 * 開いているタブの編集中の内容を片側にする（保存していない変更も含む）。
 * @param {Tab} t
 * @return {DiffSide}
 */
function diffSideFromTab(t) {
  return makeDiffSide({
    origin: 'buffer',
    fileId: t.id,
    name: t.name,
    sub: t.dirty ? '開いているタブ · 未保存の編集あり' : '開いているタブ',
    content: tabDoc(t),
    eol: t.eol,
    updatedAtIso: t.baseUpdatedAtIso,
    size: t.size,
    mimeType: t.mimeType || '',
    langKey: t.langKey,
    target: 'tab'
  });
}

/**
 * 貼り付けた文字列を片側にする。Drive 上に実体は無い。
 * @param {string} text
 * @param {string} [name]
 * @return {DiffSide}
 */
function diffSideFromText(text, name) {
  const body = normalizeEol(String(text == null ? '' : text));
  const lines = body ? body.split('\n').length : 0;
  return makeDiffSide({
    origin: 'text',
    name: name || '貼り付けたテキスト',
    sub: '貼り付け · ' + lines + ' 行 · ' + formatBytes(body.length),
    content: body,
    eol: Settings.get('defaultEol'),
    size: body.length,
    target: null
  });
}

const Diff = {
  /** @type {Object|null} @codemirror/merge */
  mod: null,
  _p: null,
  /** 比較タブの通し番号（合成 ID に使う。Drive のファイル ID とは衝突しない）。 */
  seq: 0,
  /** 貼り付けた材料の通し番号（表示名に使う）。 */
  pasteSeq: 0,
  /** 大きいファイルでも待たされないよう、走査の上限を決めておく（超えたら簡易比較）。 */
  DIFF_CONFIG: { scanLimit: 3000 },
  COLLAPSE: { margin: 3, minSize: 4 },

  /* -------------------------------------------------- *
   *  読み込み
   * -------------------------------------------------- */

  /** @codemirror/merge を読む。失敗しても比較以外の機能は動き続ける。 */
  load() {
    if (Diff._p) return Diff._p;
    Diff._p = (async () => {
      const v = await Vendor.load();
      if (!v.loadMerge) {
        throw new Error('この版のライブラリには比較ビューが入っていません（バンドルを作り直してください）');
      }
      Diff.mod = await v.loadMerge();
      return Diff.mod;
    })();
    Diff._p.catch(() => { Diff._p = null; });
    return Diff._p;
  },

  /* -------------------------------------------------- *
   *  タブを開く入口
   * -------------------------------------------------- */

  /**
   * 比較タブを開く。左右は省略できる（空で開いて、あとから貼り付ける）。
   * @param {DiffSide} [a] 左
   * @param {DiffSide} [b] 右
   * @param {{mode?:('split'|'unified')}} [opts]
   * @return {Promise<Tab|null>}
   */
  async open(a, b, opts) {
    try {
      await Editor.load();
      await Diff.load();
    } catch (err) {
      toast('比較ビューを読み込めませんでした: ' + err.message, 'error', 9000);
      return null;
    }

    const id = 'diff:' + (++Diff.seq);
    const tab = makeTab(id, '比較', 'diff');
    tab.loaded = true;
    tab.diff = {
      a: a || makeDiffSide(),
      b: b || makeDiffSide(),
      /** 'split'（並列）か 'unified'（インライン）。 */
      mode: (opts && opts.mode) || 'split',
      /** コピー方向。'a-to-b' は左から右へ。 */
      revert: 'a-to-b',
      /** 同じ行を畳むか。 */
      collapse: true,
      /** 空白の違いを無視して比較するか（表示も整形後になるため閲覧のみ）。 */
      normalize: false,
      /** @type {HTMLElement|null} このタブ専用のペイン。タブを切り替えても捨てない。 */
      host: null,
      /** @type {Object|null} MergeView（並列）か EditorView（インライン）。 */
      view: null,
      stats: { count: 0, del: 0, ins: 0, precise: true },
      barTimer: null,
      /** 書き戻しが走っている間 true（二重送信の防止）。 */
      writing: false
    };
    // 言語サポートは作る前にそろえる（ハイライト無しで作ってしまわないように）。
    const keys = [tab.diff.a.langKey, tab.diff.b.langKey].filter(Boolean);
    if (keys.length) await Promise.all(keys.map((k) => Editor.loadLanguage(k)));
    tab.name = Diff.tabName(tab);
    App.tabs.push(tab);
    Panes.addTab(Panes.active() || Panes.init(), tab.id);
    renderTabs();
    await activateTab(id);
    Session.save();
    return tab;
  },

  /** 開いているタブの内容と、Drive 上の保存済み内容を比べる。 */
  async withSaved(tabId) {
    const t = getTab(tabId);
    if (!t || t.kind !== 'text') return;
    if (t.temp || t.creating) {
      toast('この一時メモはまだ Drive に確定していないため、保存済みの内容がありません。', 'info', 5000);
      return;
    }
    let left;
    try {
      left = await diffSideFromFile(t.id, t.name);
    } catch (err) {
      toast('Drive 上の内容を読めませんでした: ' + err.message, 'error', 9000);
      return;
    }
    if (!getTab(tabId)) return;
    await Diff.open(left, diffSideFromTab(getTab(tabId)));
  },

  /** 2 つの Drive ファイルを比べる（ツリーで 2 件選んだとき）。 */
  async twoFiles(idA, nameA, idB, nameB) {
    let sides;
    try {
      sides = await Promise.all([
        diffSideFromFile(idA, nameA),
        diffSideFromFile(idB, nameB)
      ]);
    } catch (err) {
      toast('比較するファイルを読めませんでした: ' + err.message, 'error', 9000);
      return;
    }
    await Diff.open(sides[0], sides[1]);
  },

  /** 過去の版と、いまの内容（開いていればタブの編集中の内容）を比べる。 */
  async withRevision(fileId, name, rev) {
    let left;
    try {
      left = await diffSideFromRevision(fileId, name, rev);
    } catch (err) {
      toast('過去の版を読めませんでした: ' + err.message, 'error', 9000);
      return;
    }
    const t = getTab(fileId);
    let right;
    if (t && t.kind === 'text') {
      right = diffSideFromTab(t);
    } else {
      try {
        right = await diffSideFromFile(fileId, name);
      } catch (err) {
        toast('いまの内容を読めませんでした: ' + err.message, 'error', 9000);
        return;
      }
    }
    await Diff.open(left, right);
  },

  /**
   * Drive のファイルを左に置き、右の材料はこれから選ぶ。
   * @param {string} fileId
   * @param {string} name
   * @param {('file'|'paste'|'tab')} pick 右に何を入れるか
   */
  async fromFile(fileId, name, pick) {
    let left;
    try {
      left = await diffSideFromFile(fileId, name);
    } catch (err) {
      toast('ファイルを読めませんでした: ' + err.message, 'error', 9000);
      return;
    }
    const tab = await Diff.open(left, makeDiffSide());
    if (!tab) return;
    if (pick === 'file') await Diff.pickFromFiles(tab, 'b');
    else if (pick === 'paste') await Diff.pickPaste(tab, 'b');
    else if (pick === 'tab') await Diff.pickFromTabs(tab, 'b');
  },

  /**
   * 開いているタブの編集中の内容を左に置き、右の材料はこれから選ぶ。
   * @param {string} tabId
   * @param {('file'|'paste'|'tab')} pick
   */
  async fromTab(tabId, pick) {
    const t = getTab(tabId);
    if (!t || t.kind !== 'text') return;
    const tab = await Diff.open(diffSideFromTab(t), makeDiffSide());
    if (!tab) return;
    if (pick === 'file') await Diff.pickFromFiles(tab, 'b');
    else if (pick === 'paste') await Diff.pickPaste(tab, 'b');
    else if (pick === 'tab') await Diff.pickFromTabs(tab, 'b');
  },

  /** 過去の版を選んで、いまの内容と比べる（履歴パネル・コマンドからの入口）。 */
  async pickRevisionAndCompare(fileId, name) {
    const rev = await Diff.chooseRevision(fileId, name);
    if (rev) await Diff.withRevision(fileId, name, rev);
  },

  /* -------------------------------------------------- *
   *  表示
   * -------------------------------------------------- */

  /** タブに出す名前。 */
  tabName(tab) {
    const d = tab.diff;
    return Diff.sideLabel(d.a) + ' ⇄ ' + Diff.sideLabel(d.b);
  },

  sideLabel(side) {
    return side.origin === 'empty' ? '（空）' : side.name;
  }
};


