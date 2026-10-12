/**
 * client/lib/eol.js — 改行コードとインデントの判定。
 *
 * 依存の無い純粋な部分を client/app から切り出した ES モジュール。
 * client/app 側からは tools/build-app.mjs が生成する import で同じ名前のまま参照できる。
 */

/**
 * 改行コードを判定する。
 *
 * CodeMirror は読み込んだ文字列を /\r\n?|\n/ で分割し、内部では常に \n で扱う。
 * そのため何もしないと CRLF のファイルを開いて保存した時点で LF に変わってしまう。
 * 元の形式を覚えておき、保存時に戻す。
 *
 * @param {string} text
 * @return {'LF'|'CRLF'|null} 判定材料が無ければ null（呼び出し側が既定値を当てる）
 */
export function detectEol(text) {
  const all = (text.match(/\n/g) || []).length;
  // 改行が 1 つも無いファイル（新規・1 行だけ）は判定材料が無い。
  // ここで LF と決め打ちすると、設定した既定の改行コードが効かなくなる。
  if (!all) return null;
  const crlf = (text.match(/\r\n/g) || []).length;
  return crlf > (all - crlf) ? 'CRLF' : 'LF';
}

/** すべての改行を \n にそろえる。エディタへ渡す前に必ず通す。 */
export function normalizeEol(text) {
  return text.replace(/\r\n?/g, '\n');
}

/** 保存する直前に元の改行コードへ戻す。 */
export function restoreEol(text, eol) {
  return eol === 'CRLF' ? text.replace(/\n/g, '\r\n') : text;
}

/**
 * インデントの流儀を推定する。
 * 先頭 400 行までを見て、タブが優勢ならタブ、そうでなければ
 * 一番多く出てくる字下げ幅（2/4/8）を採用する。
 *
 * @param {string} text
 * @return {{useTabs:boolean, size:number}|null}
 *         字下げが 1 行も無ければ null。size が 0 なら幅は判定できていない。
 *         どちらも呼び出し側が既定値を当てる。
 */
export function detectIndent(text) {
  const lines = text.split('\n', 400);
  let tabs = 0;
  const widths = new Map();
  let prev = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    if (line[0] === '\t') { tabs++; prev = 0; continue; }
    const spaces = line.length - line.replace(/^ +/, '').length;
    if (spaces > 0) {
      const step = prev > 0 && spaces > prev ? spaces - prev : spaces;
      if (step >= 2 && step <= 8) widths.set(step, (widths.get(step) || 0) + 1);
    }
    prev = spaces;
  }

  // タブ優勢。タブ 1 つを何文字ぶんに見せるかは本文からは決められない
  // （表示上の好みでしかない）ので、幅は呼び出し側の既定に委ねる。
  if (tabs > 0 && tabs >= widths.size) return { useTabs: true, size: 0 };

  let best = 0;
  let bestCount = 0;
  for (const [w, c] of widths) {
    if (c > bestCount) { best = w; bestCount = c; }
  }
  // 字下げが 1 行も無い（新規ファイル・べた書きのメモなど）。
  // ここで 2 と決め打ちすると、設定した既定のインデントが効かなくなる。
  return best ? { useTabs: false, size: best } : null;
}
