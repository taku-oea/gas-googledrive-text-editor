/**
 * client/lib/search.js — 全体検索の照合（一致する行の抜き出し）。
 *
 * 依存の無い純粋な部分を client/app から切り出した ES モジュール。
 * client/app 側からは tools/build-app.mjs がつなぐので、同じ名前のまま参照できる。
 */

/**
 * 本文から一致する行を拾う（全体検索の結果 1 ファイルぶん）。
 * @param {string} content
 * @param {string} needle caseSensitive でなければ小文字にしてから渡す
 * @param {boolean} caseSensitive
 * @return {Array<{line:number, column:number, text:string}>} 最大 20 行
 */
export function searchLines(content, needle, caseSensitive) {
  const lines = content.split('\n');
  const hits = [];
  for (let L = 0; L < lines.length && hits.length < 20; L++) {
    const line = lines[L];
    const hay = caseSensitive ? line : line.toLowerCase();
    const at = hay.indexOf(needle);
    if (at < 0) continue;
    hits.push({ line: L + 1, column: at + 1,
      text: line.length > 200 ? line.slice(Math.max(0, at - 60), at + 140) : line });
  }
  return hits;
}
