/**
 * client/lib/term-sed.js — ターミナルの sed の「s/探す/置き換える/フラグ」を読む部分。
 *
 * 置き換える側は sed の書き方に合わせる（JS の String.replace の $ 記法ではない）。
 *   &        一致した全体
 *   \1〜\9   ( ) で囲んだ部分（\0 は & と同じ）
 *   \&  \\   文字どおりの & と \
 *   \n  \t   改行・タブ
 *   $        ただの文字（$1 や $& も特別扱いしない）
 * replace には文字列ではなく関数を渡すので、$ が解釈される余地が無い。
 */
import { TermError } from './term-parse.js';

/**
 * s/探す/置き換える/フラグ を 3 つに分ける。区切りは s の直後の 1 文字。
 * 区切り文字は \ を前に付ければ中に書ける（s|a\|b|c|）。それ以外の \x は
 * そのまま残し、正規表現・置き換えの側で解釈させる（\\ の次の区切りは区切りのまま）。
 * @param {string} script
 * @return {{pattern:string, replacement:string, flags:string}|null} 形が違えば null
 */
export function sedSplitScript(script) {
  const m = /^s(.)([\s\S]*)$/.exec(String(script || ''));
  if (!m) return null;
  const delim = m[1];
  const body = m[2];
  const parts = [];
  let buf = '';
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i);
    if (c === '\\' && i + 1 < body.length) {
      const next = body.charAt(i + 1);
      // 区切りの \ は外す。それ以外（\\ や \1）は 2 文字のまま残す。
      buf += next === delim ? delim : c + next;
      i++;
      continue;
    }
    if (c === delim) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  parts.push(buf);
  if (parts.length < 2) return null;
  return { pattern: parts[0], replacement: parts[1], flags: parts[2] || '' };
}

/**
 * 置き換える側を解釈して、String.replace に渡す関数にする。
 * @param {string} replacement
 * @param {number} [groups] 正規表現の ( ) の数。渡すと、それを超える \N をエラーにする
 * @return {function(string, ...*):string}
 */
export function sedReplacer(replacement, groups) {
  const src = String(replacement);
  // 文字列（そのまま出す）と数（その番号のグループ。0 は全体）を順に並べる。
  const pieces = [];
  let lit = '';
  const flush = () => { if (lit) { pieces.push(lit); lit = ''; } };
  for (let i = 0; i < src.length; i++) {
    const c = src.charAt(i);
    if (c === '&') { flush(); pieces.push(0); continue; }
    if (c !== '\\') { lit += c; continue; }
    if (i + 1 >= src.length) { lit += '\\'; break; }   // 末尾の \ は文字どおり
    const next = src.charAt(++i);
    if (next >= '0' && next <= '9') {
      const n = Number(next);
      if (typeof groups === 'number' && n > groups) {
        throw new TermError('\\' + n + ' に対応する ( ) がありません。');
      }
      flush();
      pieces.push(n);
    } else if (next === 'n') lit += '\n';
    else if (next === 't') lit += '\t';
    else lit += next;   // \& \\ \/ など。知らない \x も x にする（sed と同じ）
  }
  flush();
  return function (match) {
    // 引数は (全体, グループ…, 位置, 元の文字列[, 名前付きグループ])。
    // グループは文字列か undefined なので、最初の数（位置）の手前までがグループ。
    const caps = [match];
    for (let k = 1; k < arguments.length && typeof arguments[k] !== 'number'; k++) caps.push(arguments[k]);
    let out = '';
    for (const p of pieces) out += typeof p === 'number' ? (caps[p] === undefined ? '' : caps[p]) : p;
    return out;
  };
}

/** 正規表現の ( ) の数（名前付きも含む）。空文字に「または空」を足して照合すると数が分かる。 */
export function sedGroupCount(re) {
  return new RegExp(re.source + '|', re.flags.replace(/[gy]/g, '')).exec('').length - 1;
}
