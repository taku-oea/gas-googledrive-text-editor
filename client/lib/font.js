/**
 * client/lib/font.js — エディタのフォント（名前の丸め・CSS の font-family・インストール済みかの判定）。
 *
 * フォントはダウンロードしない。端末に入っているものを名前で指すだけなので、
 * 選んでもアプリの通信量は増えず、入っていない端末では既定の等幅フォントに落ちる。
 * 依存の無い純粋な部分を client/app から切り出した ES モジュール。
 */

/** 1 つの設定に並べられる名前の数と、1 つの名前の長さの上限。サーバー側と同じ値。 */
export const FONT_MAX_NAMES = 4;
export const FONT_MAX_NAME_LENGTH = 64;

/**
 * 設定の候補に出すフォント。name は CSS の font-family に書く名前。
 * note はどこに入っているか（無印は各自でインストールするもの）。
 */
export const FONT_PRESETS = [
  { name: 'HackGen Console NF', note: '' },
  { name: 'HackGen35 Console NF', note: '' },
  { name: 'HackGen Console', note: '' },
  { name: 'HackGen35 Console', note: '' },
  { name: 'UDEV Gothic', note: '' },
  { name: 'PlemolJP', note: '' },
  { name: 'Cica', note: '' },
  { name: 'Myrica M', note: '' },
  { name: 'JetBrains Mono', note: '' },
  { name: 'Fira Code', note: '' },
  { name: 'Source Code Pro', note: '' },
  { name: 'BIZ UDGothic', note: 'Windows 標準' },
  { name: 'MS Gothic', note: 'Windows 標準' },
  { name: 'Cascadia Mono', note: 'Windows 11 標準' },
  { name: 'Consolas', note: 'Windows 標準' },
  { name: 'Menlo', note: 'macOS 標準' },
  { name: 'Monaco', note: 'macOS 標準' },
  { name: 'Osaka-Mono', note: 'macOS' },
  { name: 'Noto Sans Mono', note: 'Linux / ChromeOS' }
];

/**
 * 入力されたフォント名を、保存してよい形に丸める。
 *
 * カンマ区切りで複数並べられる（先頭から順に、端末で見つかったものが使われる）。
 * CSS の文法に関わる記号（引用符・セミコロン・括弧など）は落とし、文字・数字・空白・
 * `-` `_` `.` だけを残す。重複（大文字小文字違いを含む）と空の名前は捨てる。
 * サーバー側の DriveService.cleanFontFamily_ と同じ規則（テストで突き合わせている）。
 *
 * @param {*} raw
 * @return {string} 'A, B' の形。何も残らなければ ''（= 既定のフォント）
 */
export function cleanFontFamily(raw) {
  const out = [];
  const seen = {};
  for (const part of String(raw == null ? '' : raw).split(',')) {
    const name = part.replace(/[^\p{L}\p{M}\p{N} ._-]/gu, '')
      .replace(/\s+/g, ' ').trim().slice(0, FONT_MAX_NAME_LENGTH).trim();
    const key = name.toLowerCase();
    if (!name || seen[key]) continue;
    seen[key] = true;
    out.push(name);
    if (out.length >= FONT_MAX_NAMES) break;
  }
  return out.join(', ');
}

/**
 * 設定値 → CSS の font-family の値。最後に既定の並び（css.html の --font-mono-default）を付けるので、
 * 指定したフォントが端末に無くても既定の等幅フォントで表示される。
 *
 * @param {string} family cleanFontFamily 済みの値
 * @return {string}
 */
export function fontStack(family) {
  const names = cleanFontFamily(family);
  const head = names ? names.split(', ').map((n) => '"' + n + '", ').join('') : '';
  return head + 'var(--font-mono-default)';
}

/** 判定に使う文字列。欧文だけのフォントも和文だけのフォントも幅が変わるよう両方を混ぜる。 */
const PROBE_TEXT = 'mmmmmmmmmmlli10OO@#WW 日本語のあア｜';
const PROBE_GENERICS = ['monospace', 'sans-serif', 'serif'];

/**
 * そのフォントが端末で使えるか。3 つの総称フォントに落としたときの幅と比べ、
 * どれか 1 つでも違えば「指定したフォントで描かれた」とみなす。
 * 幅の測り方（canvas）は引数で受け取る。
 *
 * Safari は後からインストールしたフォントをページに見せないので、そこでは false になる
 * （実際に使えないので、それで正しい）。
 *
 * @param {string} name 1 つのフォント名
 * @param {(font: string, text: string) => number} measure CSS の font 指定と文字列 → 幅
 * @return {boolean}
 */
export function isFontInstalled(name, measure) {
  const clean = cleanFontFamily(name).split(', ')[0];
  if (!clean) return false;
  for (const generic of PROBE_GENERICS) {
    const base = measure('72px ' + generic, PROBE_TEXT);
    const test = measure('72px "' + clean + '", ' + generic, PROBE_TEXT);
    if (Math.abs(test - base) > 0.5) return true;
  }
  return false;
}
