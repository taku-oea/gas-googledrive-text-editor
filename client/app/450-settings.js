/* ------------------------------------------------------------------ *
 *  設定
 * ------------------------------------------------------------------ */

const Settings = {
  values: null,
  /**
   * サーバーから受け取る前に参照されても壊れないよう、ここにも既定を持つ。
   * 正となる定義はサーバー側の defaultSettings_()。
   */
  defaults: {
    autosaveDelayMs: 2000,
    autosaveEnabled: true,
    fontSize: 12.5,
    fontFamily: '',
    lineWrap: true,
    themeMode: 'system',
    previewScrollSync: true,
    mdToolbar: true,
    tmpRetentionDays: 30,
    tmpExtension: 'txt',
    detectIndentation: true,
    defaultIndentWithTabs: false,
    defaultIndentUnit: 2,
    defaultEol: 'LF'
  },
  saveTimer: null,
  /** いま <html> に当てているフォントの並び。変わったときだけ差し替えて測り直す。 */
  fontStackApplied: null,
  /** フォント名 → この端末で見つかったか。起動中にフォントは増えない前提で 1 回だけ測る。 */
  fontFound: new Map(),
  fontProbe: null,

  init(values, defaults) {
    if (defaults) Settings.defaults = defaults;
    Settings.values = Object.assign({}, Settings.defaults, values || {});
    Settings.apply();
  },

  get(key) {
    return Settings.values ? Settings.values[key] : (Settings.defaults || {})[key];
  },

  /** 設定を画面に反映する。 */
  apply() {
    const v = Settings.values;
    if (!v) return;

    // フォントサイズは CSS 変数で CodeMirror ごと変える。
    el.app.style.setProperty('--editor-font-size', v.fontSize + 'px');

    // フォントは端末に入っているものを名前で指すだけ（ダウンロードしない）。
    // モーダルなど #app の外にも等幅の箇所があるので、<html> に当てる。
    const stack = fontStack(v.fontFamily);
    if (Settings.fontStackApplied !== stack) {
      Settings.fontStackApplied = stack;
      document.documentElement.style.setProperty('--font-mono', stack);
      Settings.remeasureText();
    }

    // 折り返しは全タブに効かせる。CM 到着前なら値だけ覚えておく（buildState がこれを使う）。
    if (Editor.view) {
      if (Editor.wrapEnabled !== v.lineWrap) Editor.setWrap(v.lineWrap);
    } else {
      Editor.wrapEnabled = v.lineWrap !== false;
    }

    // 配色。変わっていなければ Theme 側が何もしない。
    Theme.use(v.themeMode);

    // 入力バーの出し入れと、連動を切ったときの後始末。
    MdBar.update();
    for (const tab of App.tabs) {
      if (tab.kind !== 'preview' || !tab.pv) continue;
      if (!v.previewScrollSync) Sync.reset(tab);
      else Sync.measure(tab);
    }
  },

  /** 字の幅が変わるので、各ペインの CodeMirror と比較ビューに測り直させる。 */
  remeasureText() {
    const run = () => {
      for (const leaf of Panes.leaves()) {
        if (leaf.view) leaf.view.requestMeasure();
      }
      Diff.remeasureActive();
    };
    run();
    // 端末のフォントでも描画に間に合わないことがあるので、読み終えたらもう一度。
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(run, () => {});
  },

  /** そのフォントがこの端末にあるか（canvas で幅を比べる）。 */
  hasFont(name) {
    if (!Settings.fontFound.has(name)) {
      let found = false;
      try {
        if (!Settings.fontProbe) Settings.fontProbe = document.createElement('canvas').getContext('2d');
        const ctx = Settings.fontProbe;
        found = isFontInstalled(name, (font, text) => {
          ctx.font = font;
          return ctx.measureText(text).width;
        });
      } catch (_) {
        found = false;
      }
      Settings.fontFound.set(name, found);
    }
    return Settings.fontFound.get(name);
  },

  set(key, value) {
    if (!Settings.values) return;
    Settings.values[key] = value;
    Settings.apply();
    Settings.render();
    Settings.persist();
  },

  /** サーバーへ保存する。値の丸めはサーバー側でも行う。 */
  persist() {
    clearTimeout(Settings.saveTimer);
    Settings.saveTimer = setTimeout(() => {
      Settings.saveTimer = null;
      Api.saveSettings(Settings.values)
        .then((clean) => { Settings.values = clean; Settings.apply(); })
        .catch((err) => toast('設定を保存できませんでした: ' + err.message, 'error', 8000));
    }, 600);
  },

  /**
   * 期間を過ぎた一時メモを今すぐゴミ箱へ移す。
   * @param {HTMLButtonElement} button 押されたボタン（二重実行を防ぐ）
   */
  async sweepTemp(button) {
    button.disabled = true;
    const label = button.textContent;
    button.textContent = '片付けています…';
    try {
      const data = await Api.sweepTempFiles();
      toast(data.trashed
        ? '一時メモ ' + data.trashed + ' 件を Drive のゴミ箱へ移しました'
        : '片付ける一時メモはありませんでした', 'info', 5000);
      const node = Tree.tmpRootId ? Tree.get(Tree.tmpRootId) : null;
      if (data.trashed && node && node.loaded) await TempMemo.load(true);
    } catch (err) {
      toast(err.message, 'error', 10000);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  },

  reset() {
    Settings.values = Object.assign({}, Settings.defaults);
    Settings.apply();
    Settings.render();
    Settings.persist();
    toast('設定を既定に戻しました', 'info', 3000);
  },

  render() {
    if (!Settings.values) return;
    const v = Settings.values;
    el.settingsBody.textContent = '';

    const block = (label, desc, control) => h('div', { class: 'setting' }, [
      h('label', { class: 'setting__label', text: label }),
      desc ? h('p', { class: 'setting__desc', text: desc }) : null,
      h('div', { class: 'setting__row' }, control)
    ]);

    // 自動保存の ON/OFF
    const autoOn = h('input', { type: 'checkbox' });
    autoOn.checked = v.autosaveEnabled;
    autoOn.addEventListener('change', () => Settings.set('autosaveEnabled', autoOn.checked));
    el.settingsBody.appendChild(block(
      '自動保存',
      '切ると Cmd/Ctrl+S でだけ保存します。下書きは切っていても localStorage に残ります。',
      [autoOn, h('span', { class: 'setting__value', text: v.autosaveEnabled ? 'ON' : 'OFF' })]
    ));

    // 自動保存の間隔
    const delay = h('input', {
      type: 'range', min: '500', max: '10000', step: '500', value: String(v.autosaveDelayMs)
    });
    const delayLabel = h('span', {
      class: 'setting__value', text: (v.autosaveDelayMs / 1000).toFixed(1) + ' 秒'
    });
    delay.addEventListener('input', () => {
      delayLabel.textContent = (Number(delay.value) / 1000).toFixed(1) + ' 秒';
    });
    delay.addEventListener('change', () => Settings.set('autosaveDelayMs', Number(delay.value)));
    el.settingsBody.appendChild(block(
      '自動保存までの待ち時間',
      '入力が止まってからこの時間だけ待って保存します。',
      [delay, delayLabel]
    ));

    // 配色。システムに合わせる場合は OS の設定に追従する。
    const theme = h('select', { class: 'input' });
    for (const mode of THEME_MODES) {
      const opt = h('option', { value: mode, text: THEME_LABELS[mode] });
      if (v.themeMode === mode) opt.selected = true;
      theme.appendChild(opt);
    }
    theme.addEventListener('change', () => Settings.set('themeMode', theme.value));
    el.settingsBody.appendChild(block(
      '外観',
      'ヘッダーのアイコンからも切り替えられます。'
        + '「システムに合わせる」にすると OS の設定（ライト／ダーク）に追従します'
        + '（いまは' + (Theme.resolved === 'dark' ? 'ダーク' : 'ライト') + '）。',
      [theme]
    ));

    // フォント。端末に入っているものを名前で指すだけで、ダウンロードはしない。
    // 候補は見つかったものを上にまとめ、無いものも選べるようにしておく
    // （設定はアカウントに保存されるので、別の端末には入っていることがある）。
    const CUSTOM = '*';   // cleanFontFamily が落とす記号なので、フォント名とは重ならない
    const family = cleanFontFamily(v.fontFamily);
    const isPreset = !family || FONT_PRESETS.some((p) => p.name === family);
    const fontSel = h('select', { class: 'input' });
    fontSel.appendChild(h('option', { value: '', text: '既定（SF Mono / Menlo / Consolas など）' }));
    const foundGroup = h('optgroup', { label: 'この端末で見つかったフォント' });
    const missingGroup = h('optgroup', { label: 'この端末では見つからないフォント' });
    for (const p of FONT_PRESETS) {
      const opt = h('option', { value: p.name, text: p.name + (p.note ? '（' + p.note + '）' : '') });
      if (family === p.name) opt.selected = true;
      (Settings.hasFont(p.name) ? foundGroup : missingGroup).appendChild(opt);
    }
    if (foundGroup.children.length) fontSel.appendChild(foundGroup);
    if (missingGroup.children.length) fontSel.appendChild(missingGroup);
    const customOpt = h('option', { value: CUSTOM, text: 'その他（名前を入力）…' });
    if (!isPreset) customOpt.selected = true;
    fontSel.appendChild(customOpt);

    const fontName = h('input', {
      type: 'text', class: 'input', value: family, spellcheck: 'false',
      placeholder: '例: HackGen Console NF, Menlo'
    });
    fontName.hidden = isPreset;
    const sample = h('div', { class: 'setting__sample', text: '0Oo 1lI| {}[] => != 日本語とｶﾀｶﾅ' });
    const usable = family ? family.split(', ').find((n) => Settings.hasFont(n)) : null;
    const fontNote = !family ? null : h('p', {
      class: 'setting__note setting__note--' + (usable ? 'ok' : 'warn'),
      text: usable
        ? 'この端末では「' + usable + '」で表示しています。'
        : 'この端末では見つからないため、既定のフォントで表示しています。' +
          'インストールした直後は、ブラウザを再起動すると使えるようになります。'
    });

    fontSel.addEventListener('change', () => {
      if (fontSel.value !== CUSTOM) {
        Settings.set('fontFamily', fontSel.value);
        return;
      }
      fontName.hidden = false;
      fontName.focus();
      fontName.select();
    });
    // 打っている間は見本だけ変え、確定（Enter・フォーカスが外れる）で保存する。
    fontName.addEventListener('input', () => {
      sample.style.fontFamily = fontStack(fontName.value);
    });
    fontName.addEventListener('change', () => Settings.set('fontFamily', cleanFontFamily(fontName.value)));
    el.settingsBody.appendChild(block(
      'エディタのフォント',
      'この端末にインストールされているフォントを名前で使います（ダウンロードはしないので、' +
        'アプリは重くなりません）。カンマで区切って並べると、先に見つかったものを使います。' +
        '入っていない端末では既定のフォントで表示します。' +
        'Safari は後からインストールしたフォントを使えません（Safari の仕様）。',
      [fontSel, fontName, sample, fontNote]
    ));

    // フォントサイズ
    const font = h('input', {
      type: 'range', min: '9', max: '24', step: '0.5', value: String(v.fontSize)
    });
    const fontLabel = h('span', { class: 'setting__value', text: v.fontSize + ' px' });
    font.addEventListener('input', () => {
      fontLabel.textContent = font.value + ' px';
      el.app.style.setProperty('--editor-font-size', font.value + 'px');
    });
    font.addEventListener('change', () => Settings.set('fontSize', Number(font.value)));
    el.settingsBody.appendChild(block('エディタのフォントサイズ', null, [font, fontLabel]));

    // 折り返し
    const wrap = h('input', { type: 'checkbox' });
    wrap.checked = v.lineWrap;
    wrap.addEventListener('change', () => Settings.set('lineWrap', wrap.checked));
    el.settingsBody.appendChild(block(
      '長い行を折り返す',
      'Alt+Z でも切り替えられます。',
      [wrap, h('span', { class: 'setting__value', text: v.lineWrap ? 'ON' : 'OFF' })]
    ));

    // プレビューのスクロール連動（Markdown のみ）
    const sync = h('input', { type: 'checkbox' });
    sync.checked = v.previewScrollSync;
    sync.addEventListener('change', () => Settings.set('previewScrollSync', sync.checked));
    el.settingsBody.appendChild(block(
      'プレビューを左右で連動させる',
      'Markdown プレビューで、エディタとプレビューのスクロール位置をそろえます。' +
        'HTML プレビューは中身が別オリジンのため連動しません。',
      [sync, h('span', { class: 'setting__value', text: v.previewScrollSync ? 'ON' : 'OFF' })]
    ));

    // Markdown の入力バー
    const mdbar = h('input', { type: 'checkbox' });
    mdbar.checked = v.mdToolbar;
    mdbar.addEventListener('change', () => Settings.set('mdToolbar', mdbar.checked));
    el.settingsBody.appendChild(block(
      'Markdown の入力バーを出す',
      '.md のファイルを開いているときだけ、見出し・太字・表などのボタンを上に出します。',
      [mdbar, h('span', { class: 'setting__value', text: v.mdToolbar ? 'ON' : 'OFF' })]
    ));

    // 既定のインデント。ファイルから判定できなかったときに使う。
    const indentSel = h('select', { class: 'input' });
    for (const useTabs of [false, true]) {
      for (const size of [2, 4, 8]) {
        const value = (useTabs ? 'tab' : 'space') + ':' + size;
        const opt = h('option', {
          value: value,
          text: (useTabs ? 'タブ: ' : 'スペース: ') + size
        });
        if (v.defaultIndentWithTabs === useTabs && v.defaultIndentUnit === size) {
          opt.selected = true;
        }
        indentSel.appendChild(opt);
      }
    }
    indentSel.addEventListener('change', () => {
      const [kind, size] = indentSel.value.split(':');
      // 2 つまとめて変えたいので set を 2 回呼ばず values を直接書く
      // （set のたびにサーバーへ送るデバウンスが走るため）。
      Settings.values.defaultIndentWithTabs = kind === 'tab';
      Settings.values.defaultIndentUnit = Number(size);
      Settings.apply();
      Settings.render();
      Settings.persist();
    });
    el.settingsBody.appendChild(block(
      '既定のインデント',
      'ファイルから字下げを判定できなかったとき（新規ファイルなど）に使います。' +
        '開いているファイルはステータスバーから個別に変えられます。',
      [indentSel]
    ));

    // 判定を切ると、既存ファイルの字下げも既定値で開く。
    const detect = h('input', { type: 'checkbox' });
    detect.checked = v.detectIndentation;
    detect.addEventListener('change', () => Settings.set('detectIndentation', detect.checked));
    el.settingsBody.appendChild(block(
      'インデントをファイルから判定する',
      '切ると、既存ファイルでも常に上の既定値で開きます。' +
        '入れておくと、他の人が書いた字下げに自動で合わせます。',
      [detect, h('span', { class: 'setting__value', text: v.detectIndentation ? 'ON' : 'OFF' })]
    ));

    // 既定の改行コード。改行が 1 つも無いファイルと新規ファイルに効く。
    const eolSel = h('select', { class: 'input' });
    for (const [value, label] of [['LF', 'LF（Unix / macOS）'], ['CRLF', 'CRLF（Windows）']]) {
      const opt = h('option', { value: value, text: label });
      if (v.defaultEol === value) opt.selected = true;
      eolSel.appendChild(opt);
    }
    eolSel.addEventListener('change', () => Settings.set('defaultEol', eolSel.value));
    el.settingsBody.appendChild(block(
      '既定の改行コード',
      '改行が 1 つも無いファイル（新規・1 行だけ）に使います。' +
        '既存ファイルの改行コードは、中身から判定したものを優先します。',
      [eolSel]
    ));

    // 一時メモの置き場所。選ぶのは親フォルダで、実体はその下の <アプリ名> / tmp。
    // ユーザーが選んだフォルダをそのまま使わないのは、保存期間を過ぎたら
    // ゴミ箱へ移す掃除が、そこに元からあったファイルを巻き込まないようにするため。
    const tmpPath = h('span', { class: 'setting__path', text: TempMemo.locationText() });
    const tmpMove = h('button', { type: 'button', class: 'btn', text: '変更…' });
    tmpMove.disabled = TempMemo._relocating;
    tmpMove.addEventListener('click', () => { void TempMemo.relocate(); });
    const tmpReset = h('button', { type: 'button', class: 'btn btn--ghost', text: '既定に戻す' });
    tmpReset.hidden = !App.tmpParent;
    tmpReset.disabled = TempMemo._relocating;
    tmpReset.addEventListener('click', () => { void TempMemo.setLocation(null); });
    el.settingsBody.appendChild(block(
      '一時メモの置き場所',
      '選んだフォルダの下にアプリ専用のフォルダを作り、その中に一時メモを置きます。' +
        '変えると、いまある一時メモもそこへ移します（Drive 上のファイル ID は変わらないので、' +
        '開いているタブはそのまま使えます）。',
      [tmpPath, tmpMove, tmpReset]
    ));

    // 一時メモの拡張子。言語モードは拡張子から決まるので、無拡張は選ばせない。
    const ext = h('select', { class: 'input' });
    for (const [value, label] of [['txt', '.txt（プレーンテキスト）'], ['md', '.md（Markdown）']]) {
      const opt = h('option', { value: value, text: label });
      if (v.tmpExtension === value) opt.selected = true;
      ext.appendChild(opt);
    }
    ext.addEventListener('change', () => Settings.set('tmpExtension', ext.value));
    el.settingsBody.appendChild(block(
      '一時メモの形式',
      '新しい一時メモを作るときの拡張子です。既にあるメモの名前は変わりません。',
      [ext]
    ));

    // 一時メモの保存期間。溜まりっぱなしを防ぐための掃除。
    const keep = h('input', {
      type: 'range', min: '0', max: '180', step: '5', value: String(v.tmpRetentionDays)
    });
    const keepText = (n) => (Number(n) === 0 ? '無期限' : Number(n) + ' 日');
    const keepLabel = h('span', { class: 'setting__value', text: keepText(v.tmpRetentionDays) });
    keep.addEventListener('input', () => { keepLabel.textContent = keepText(keep.value); });
    keep.addEventListener('change', () => Settings.set('tmpRetentionDays', Number(keep.value)));
    el.settingsBody.appendChild(block(
      '一時メモを残す期間',
      '保存先を決めないままこの期間を過ぎた一時メモは、Drive のゴミ箱へ移します' +
        '（完全削除はしません）。0 にすると何も消しません。' +
        '中身が空のまま残ったメモは、この設定に関わらず 1 日で片付けます。',
      [keep, keepLabel]
    ));

    // 手動の掃除。設定を変えた直後に効かせたいことがある。
    const sweepBtn = h('button', { type: 'button', class: 'btn', text: 'いま片付ける' });
    sweepBtn.addEventListener('click', () => { void Settings.sweepTemp(sweepBtn); });
    el.settingsBody.appendChild(block(
      '一時メモを今すぐ片付ける',
      '上の期間を過ぎたメモを、待たずにゴミ箱へ移します。',
      [sweepBtn]
    ));

    el.settingsFoot.textContent = '設定はあなたのアカウントに保存されます';
  }
};

