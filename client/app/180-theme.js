/* ------------------------------------------------------------------ *
 *  テーマ（ライト / ダーク / システム）
 *
 *  設定値は 'system' / 'light' / 'dark' の 3 つ。'system' のときは OS の
 *  prefers-color-scheme に従い、OS 側を切り替えたらその場で追従する。
 *
 *  最初の適用は index.html の <head> のインラインスクリプトが済ませている
 *  （CSS より前に <html data-theme> を付けるので、ライト設定の人に
 *  一瞬ダークが出ることがない）。ここはその続きで、設定変更と OS の変更に
 *  応じて付け替え、CSS 変数では届かない 3 か所も一緒に切り替える。
 *    - CodeMirror … themeCompartment を差し替える
 *    - Mermaid    … SVG に色を焼き込むので initialize し直して描き直す
 *    - drawio     … dark を URL に載せているので iframe を読み込み直す
 * ------------------------------------------------------------------ */

/** 設定に持てる値。並び順はメニューに出す順。 */
const THEME_MODES = ['system', 'light', 'dark'];
const THEME_LABELS = { system: 'システムに合わせる', light: 'ライト', dark: 'ダーク' };
const THEME_ICONS = { system: 'monitor', light: 'sun', dark: 'moon' };

const Theme = {
  /** 設定値。@type {'system'|'light'|'dark'} */
  mode: THEME_MODES.indexOf(window.__THEME_MODE) >= 0 ? window.__THEME_MODE : 'system',
  /** 実際に当てている配色。head が付けた属性から読む。@type {'light'|'dark'} */
  resolved: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
  /** prefers-color-scheme の MediaQueryList。@type {MediaQueryList|null} */
  mq: null,
  /** 一度でも apply したか。初回は「変わっていなくても当て直す」ため。 */
  ready: false,

  /**
   * 設定値を反映する。Settings.apply から毎回呼ばれるので、
   * 変わっていなければ何もしない（CodeMirror の再構成は安くない）。
   * @param {string} mode
   */
  use(mode) {
    const next = THEME_MODES.indexOf(mode) >= 0 ? mode : 'system';
    Theme.listen();
    const changed = next !== Theme.mode || !Theme.ready;
    Theme.mode = next;
    if (changed) Theme.apply();
  },

  /** OS の配色変更を拾う。登録は 1 回だけで、効かせるのは 'system' のときだけ。 */
  listen() {
    if (Theme.mq || !window.matchMedia) return;
    Theme.mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => { if (Theme.mode === 'system') Theme.apply(); };
    // addEventListener が無い古い Safari 向けに addListener も見る。
    if (Theme.mq.addEventListener) Theme.mq.addEventListener('change', onChange);
    else if (Theme.mq.addListener) Theme.mq.addListener(onChange);
  },

  /**
   * 設定値から実際の配色を決める。
   * matchMedia が使えない環境は、これまでと同じダークにしておく。
   * @return {'light'|'dark'}
   */
  resolve() {
    if (Theme.mode === 'light' || Theme.mode === 'dark') return Theme.mode;
    return (Theme.mq && Theme.mq.matches) ? 'light' : 'dark';
  },

  /** いまの設定を画面に当てる。 */
  apply() {
    const resolved = Theme.resolve();
    const changed = resolved !== Theme.resolved || !Theme.ready;
    Theme.resolved = resolved;
    Theme.ready = true;
    document.documentElement.setAttribute('data-theme', resolved);
    // 設定値だけ変わって見た目が同じ場合（system → 同じ色の明示指定）も
    // ボタンの見出しは変わるので、こちらは毎回更新する。
    Theme.renderButton();
    if (!changed) return;
    Editor.setTheme(resolved);
    Preview.onThemeChange();
  },

  /**
   * ユーザーが選んだときの入口。保存はサーバーへ（Settings.set →
   * Settings.apply → Theme.use）。ここから直接 apply は呼ばない。
   * @param {'system'|'light'|'dark'} mode
   */
  select(mode) {
    if (THEME_MODES.indexOf(mode) < 0 || mode === Theme.mode) return;
    Settings.set('themeMode', mode);
  },

  /** ヘッダーのボタンを、いまの設定にあわせて描き直す。 */
  renderButton() {
    if (!el.btnTheme) return;
    el.btnTheme.textContent = '';
    el.btnTheme.appendChild(icon(THEME_ICONS[Theme.mode] || 'theme'));
    el.btnTheme.title = '外観: ' + (THEME_LABELS[Theme.mode] || '')
      + (Theme.mode === 'system' ? '（いまは' + (Theme.resolved === 'dark' ? 'ダーク' : 'ライト') + '）' : '');
  }
};

/** ヘッダーのボタン／コマンドパレットから開く、外観のメニュー。 */
function showThemeMenu() {
  showMenuAt(el.btnTheme, THEME_MODES.map((mode) => ({
    label: THEME_LABELS[mode]
      + (mode === 'system' ? '（いまは' + (Theme.resolved === 'dark' ? 'ダーク' : 'ライト') + '）' : ''),
    icon: mode === Theme.mode ? 'check' : THEME_ICONS[mode],
    onClick: () => Theme.select(mode)
  })));
}

