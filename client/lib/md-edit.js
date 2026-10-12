/**
 * client/lib/md-edit.js — Markdown の入力バーの編集（行の選択・行頭記号・ひな形）。
 *
 * 依存の無い純粋な部分を client/app から切り出した ES モジュール。
 * client/app 側からは tools/build-app.mjs がつなぐので、同じ名前のまま参照できる。
 */

/** 一覧・番号・チェックボックスの行頭記号。付け替えのときにまとめて外す。 */
export const MD_LIST_RE = /^\s*(?:[-*+]\s+\[[ xX]\]\s*|[-*+]\s+|\d+[.)]\s+)/;

/** 選択している行の中身を配列で返す。 */
export function selectedLines(view) {
  const doc = view.state.doc;
  const out = [];
  const seen = new Set();
  for (const range of view.state.selection.ranges) {
    const from = doc.lineAt(range.from).number;
    const to = doc.lineAt(range.to).number;
    for (let n = from; n <= to; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(doc.line(n).text);
    }
  }
  return out;
}

/**
 * 選択している行を書き換える。
 * @param {Object} view EditorView
 * @param {function(string, number): string} fn 行の中身と通し番号から新しい行を作る
 */
export function mapSelectedLines(view, fn) {
  const doc = view.state.doc;
  const changes = [];
  const seen = new Set();
  let index = 0;
  for (const range of view.state.selection.ranges) {
    const from = doc.lineAt(range.from).number;
    const to = doc.lineAt(range.to).number;
    for (let n = from; n <= to; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = doc.line(n);
      const next = fn(line.text, index++);
      if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
    }
  }
  if (changes.length) view.dispatch({ changes });
  view.focus();
}

export const TABLE_TEMPLATE = [
  '|  |  |',
  '| --- | --- |',
  '|  |  |'
].join('\n');

export const MERMAID_TEMPLATE = [
  '```mermaid',
  'flowchart TD',
  '  A[はじめ] --> B{分岐}',
  '  B -->|はい| C[おわり]',
  '  B -->|いいえ| A',
  '```'
].join('\n');

/** 見出しレベルを付け外しする。同じレベルなら外す。 */
export function toggleHeading(view, level) {
  const mark = '#'.repeat(level) + ' ';
  const lines = selectedLines(view).filter((t) => t.trim());
  const on = lines.length > 0 && lines.every((t) => t.startsWith(mark));
  mapSelectedLines(view, (text) => {
    const bare = text.replace(/^#{1,6}\s+/, '');
    return on ? bare : mark + bare;
  });
}

/** 行頭の記号（引用・箇条書き・番号・チェック）を付け外しする。 */
export function toggleLinePrefix(view, kind) {
  const rules = {
    quote:  { re: /^\s*>\s?/, strip: /^\s*>\s?/, make: () => '> ' },
    bullet: { re: /^\s*[-*+]\s+/, strip: MD_LIST_RE, make: () => '- ' },
    number: { re: /^\s*\d+[.)]\s+/, strip: MD_LIST_RE, make: (i) => (i + 1) + '. ' },
    task:   { re: /^\s*[-*+]\s+\[[ xX]\]\s*/, strip: MD_LIST_RE, make: () => '- [ ] ' }
  };
  const rule = rules[kind];
  const lines = selectedLines(view);
  const body = lines.filter((t) => t.trim());
  const on = body.length > 0 && body.every((t) => rule.re.test(t));
  // 複数行を選んでいるときは、あいだの空行に記号を付けない。
  const multi = lines.length > 1;

  let seq = 0;
  mapSelectedLines(view, (text) => {
    if (multi && !text.trim()) return text;
    return on ? text.replace(rule.re, '') : rule.make(seq++) + text.replace(rule.strip, '');
  });
}
