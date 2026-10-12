/* ------------------------------------------------------------------ *
 *  ステータスバーのメニューとパンくず
 * ------------------------------------------------------------------ */

/**
 * 要素の位置にあわせてメニューを出す。
 * Ctx.show が画面外へはみ出さない位置に補正するので、
 * 画面下端のステータスバーから呼べば自動的に上向きに開く。
 */
function showMenuAt(target, items) {
  const rect = target.getBoundingClientRect();
  Ctx.show(rect.left, rect.top, items);
}

/** インデント設定のメニュー。 */
function showIndentMenu() {
  const tab = activeTab();
  if (!tab || tab.kind !== 'text') return;

  const items = [];
  for (const size of [2, 4, 8]) {
    items.push({
      label: 'スペース: ' + size,
      icon: (!tab.indentWithTabs && tab.indentUnit === size) ? 'check' : '',
      onClick: () => setIndent(tab, false, size)
    });
  }
  items.push({ sep: true });
  for (const size of [2, 4, 8]) {
    items.push({
      label: 'タブ: ' + size,
      icon: (tab.indentWithTabs && tab.indentUnit === size) ? 'check' : '',
      onClick: () => setIndent(tab, true, size)
    });
  }
  items.push(
    { sep: true },
    {
      label: 'インデントをスペースへ変換',
      icon: 'indent-in',
      onClick: () => void convertIndent(tab, false)
    },
    {
      label: 'インデントをタブへ変換',
      icon: 'indent-out',
      onClick: () => void convertIndent(tab, true)
    },
    { sep: true },
    {
      // 毎回同じものに直しているなら、そこから既定にできるほうが早い。
      label: 'この設定を既定にする',
      icon: 'settings',
      onClick: () => {
        Settings.values.defaultIndentWithTabs = tab.indentWithTabs;
        Settings.values.defaultIndentUnit = tab.indentUnit;
        Settings.apply();
        Settings.render();
        Settings.persist();
        toast('既定のインデントを「' +
          (tab.indentWithTabs ? 'タブ: ' : 'スペース: ') + tab.indentUnit +
          '」にしました', 'info', 3500);
      }
    }
  );
  showMenuAt(el.sbIndent, items);
}

function setIndent(tab, useTabs, size) {
  tab.indentWithTabs = useTabs;
  tab.indentUnit = size;
  Editor.applyIndent(tab);
  updateStatusMeta();
}

/**
 * 既存の行頭の字下げを、いまの設定にあわせて書き換える。
 * @param {Tab} tab
 * @param {boolean} toTabs
 */
async function convertIndent(tab, toTabs) {
  if (!Editor.view || App.activeId !== tab.id) return;
  const width = tab.indentUnit;
  const text = tabDoc(tab);

  const converted = text.split('\n').map((line) => {
    const m = line.match(/^[\t ]+/);
    if (!m) return line;
    // 一度スペース幅に直してから、目的の形式で組み直す。
    let columns = 0;
    for (const ch of m[0]) columns += ch === '\t' ? width : 1;
    const levels = Math.floor(columns / width);
    const rest = columns % width;
    const head = toTabs ? '\t'.repeat(levels) + ' '.repeat(rest) : ' '.repeat(columns);
    return head + line.slice(m[0].length);
  }).join('\n');

  if (converted === text) {
    toast('変換の必要はありませんでした', 'info', 2500);
    return;
  }

  Editor.view.dispatch({
    changes: { from: 0, to: Editor.view.state.doc.length, insert: converted }
  });
  tab.indentWithTabs = toTabs;
  Editor.applyIndent(tab);
  updateStatusMeta();
}

/** 改行コードのメニュー。 */
/**
 * 文字コードを選ぶ。読み込み時の判定を上書きし、次の保存からその文字コードで書く。
 * 本文（画面の文字）は変えない。
 */
function showEncodingMenu() {
  const tab = activeTab();
  if (!tab || tab.kind !== 'text') return;
  // BOM は UTF-8 のときだけ意味がある（Shift_JIS にしたら外す）。
  const current = TextCodec.label(tab.id);
  // 読めなかったファイルは保存できない（Api.saveFile で止まる）。切り替えても未保存のまま
  // 自動保存が毎回失敗するだけなので、選べなくする。
  const broken = TextCodec.isBroken(tab.id);

  const items = [
    [TextCodec.UTF8, false, 'UTF-8'],
    [TextCodec.UTF8, true, 'UTF-8 (BOM)（Excel で開く CSV など）'],
    [TextCodec.SJIS, false, 'Shift_JIS（Windows / Excel の CSV など）']
  ].map(([enc, bom, label]) => ({
    label,
    icon: current === enc + (bom ? ' (BOM)' : '') ? 'check' : '',
    disabled: broken,
    onClick: () => {
      if (broken) return;
      if (TextCodec.get(tab.id) === enc && TextCodec.hasBom(tab.id) === bom) return;
      TextCodec.remember(tab.id, enc, bom);
      updateStatusMeta();
      // 文字コードはファイルの中身（バイト列）そのものなので、変えたら保存対象になる。
      onDocChanged(tab.id);
      toast('文字コードを ' + TextCodec.label(tab.id) + ' にしました（保存時に反映されます）', 'info', 3500);
    }
  }));
  if (broken) {
    items.push({ sep: true }, {
      label: '読めない部分があるため変更できません（閲覧専用）', icon: '', disabled: true, onClick: () => {}
    });
  }
  showMenuAt(el.sbEnc, items);
}

function showEolMenu() {
  const tab = activeTab();
  if (!tab || tab.kind !== 'text') return;

  const items = ['LF', 'CRLF'].map((eol) => ({
    label: eol + (eol === 'LF' ? '（Unix / macOS）' : '（Windows）'),
    icon: tab.eol === eol ? 'check' : '',
    onClick: () => {
      if (tab.eol === eol) return;
      tab.eol = eol;
      updateStatusMeta();
      // 改行コードはファイルの内容そのものなので、変えたら保存対象になる。
      onDocChanged(tab.id);
      toast('改行コードを ' + eol + ' にしました（保存時に反映されます）', 'info', 3500);
    }
  }));

  items.push({ sep: true }, {
    label: 'この設定を既定にする',
    icon: 'settings',
    onClick: () => {
      Settings.set('defaultEol', tab.eol);
      toast('既定の改行コードを ' + tab.eol + ' にしました', 'info', 3500);
    }
  });

  showMenuAt(el.sbEol, items);
}

/** 言語モードのメニュー。拡張子から外れる場合に手で選ぶ。 */
function showLangMenu() {
  const tab = activeTab();
  if (!tab || tab.kind !== 'text') return;

  const items = [{
    label: 'プレーンテキスト',
    icon: !tab.langKey ? 'check' : '',
    onClick: () => { tab.langKey = null; void applyLanguageTo(tab.id, null); }
  }, { sep: true }];

  for (const key of Object.keys(LANGUAGES)) {
    items.push({
      label: LANGUAGES[key].label,
      icon: tab.langKey === key ? 'check' : '',
      onClick: () => { tab.langKey = key; void applyLanguageTo(tab.id, key); }
    });
  }
  showMenuAt(el.sbLang, items);
}

/** エディタ上部のパンくず。ペインごとに、そのペインで表示中のファイルを出す。 */
function renderEditorCrumbs() {
  for (const leaf of Panes.leaves()) renderPaneCrumbs(leaf);
}

/**
 * ペイン 1 枚ぶんのパンくず。ツリーのパスから作る。
 * @param {Object} leaf
 */
function renderPaneCrumbs(leaf) {
  const tab = getTab(leaf.activeId);
  const host = leaf.el.editorCrumbs;
  host.textContent = '';
  // 比較タブは「左 ⇄ 右」でファイルの場所が 1 つに決まらないので出さない。
  // ターミナルはツリー上の場所を持たない（いまのフォルダはプロンプトに出る）。
  if (!tab || tab.kind === 'diff' || tab.kind === 'term') { host.hidden = true; return; }

  // プレビューは自分がツリーに載っていないので、元のファイルの場所を出す。
  const target = tab.kind === 'preview' ? Preview.sourceOf(tab) : tab;
  if (!target) { host.hidden = true; return; }

  // ツリーに載っていないファイル（絞り込み経由など）は名前だけ出す。
  const path = Tree.get(target.id) ? Tree.pathOf(target.id) : target.name;
  const parts = path.split(' / ');

  parts.forEach((name, i) => {
    const isLast = i === parts.length - 1;
    if (i > 0) host.appendChild(h('span', { class: 'crumbs__sep', text: '›' }));
    host.appendChild(h('button', {
      type: 'button',
      class: 'crumbs__item' + (isLast ? ' crumbs__item--current' : ''),
      text: name,
      title: name
    }));
  });
  host.hidden = false;
}

