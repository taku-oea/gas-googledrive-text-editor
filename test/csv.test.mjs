// 表プレビューの CSV 解析と、表の操作を本文の変更に直す部分のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  csvDelimiter, parseCsv, csvQuote, csvSetCell, csvInsertRow, csvDeleteRow,
  csvInsertColumn, csvDeleteColumn, csvCompare, csvNumber
} from '../client/lib/csv.js';

/** 変更を本文に当てる（CodeMirror と同じく、全部の位置は元の本文のもの）。 */
function apply(text, changes) {
  let out = text;
  for (const c of changes.slice().sort((a, b) => b.from - a.from)) {
    out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  }
  return out;
}
const values = (t) => parseCsv(t, ',').rows.map((r) => r.cells.map((c) => c.value));

test('CSV: 引用符・カンマ・改行・"" を読む', () => {
  const t = 'a,"b,c","d ""e"""\n"改\n行",2,\n';
  const p = parseCsv(t, ',');
  assert.deepEqual(p.rows.map((r) => r.cells.map((c) => c.value)), [['a', 'b,c', 'd "e"'], ['改\n行', '2', '']]);
  assert.equal(p.columns, 3);
  assert.deepEqual(p.rows.map((r) => r.line), [1, 2]);
  // セルの範囲は引用符を含む
  assert.equal(t.slice(p.rows[0].cells[1].from, p.rows[0].cells[1].to), '"b,c"');
});

test('CSV: 末尾の改行は行にしない・空行は空のセル 1 つ・閉じない引用符は文末まで', () => {
  assert.deepEqual(values('a\n'), [['a']]);
  assert.deepEqual(values('a\n\nb'), [['a'], [''], ['b']]);
  assert.deepEqual(values(''), []);
  assert.deepEqual(values('x,"abc\ndef'), [['x', 'abc\ndef']]);
  // 閉じていない引用符は、始まった行番号を知らせる（表からの編集を止めるため）
  assert.equal(parseCsv('h\n"12 inch\nfoo\n', ',').unclosed, 2);
  assert.equal(parseCsv('a,"b"\n', ',').unclosed, null);
});

test('CSV: 区切り文字の判定', () => {
  assert.equal(csvDelimiter('a.tsv', 'a,b'), '\t');
  assert.equal(csvDelimiter('a.csv', 'a,b'), ',');
  assert.equal(csvDelimiter('a.csv', 'a;b;c\n1;2;3'), ';');
  assert.equal(csvDelimiter('a.csv', '"x,y";z'), ';');   // 引用符の中のカンマは数えない
  assert.equal(csvDelimiter('a.txt', 'a\tb\tc'), '\t');
});

test('CSV: 引用が要るときだけ囲む（元が引用符付きなら残す）', () => {
  assert.equal(csvQuote('abc', ','), 'abc');
  assert.equal(csvQuote('a,b', ','), '"a,b"');
  assert.equal(csvQuote('a"b', ','), '"a""b"');
  assert.equal(csvQuote('a\nb', ','), '"a\nb"');
  assert.equal(csvQuote('abc', ',', true), '"abc"');
  assert.equal(csvQuote('a,b', '\t'), 'a,b');
});

test('CSV: セルの書き換えは触ったセルだけを変える', () => {
  const t = 'a, b ,"c"\n1,2\n';
  const p = parseCsv(t, ',');
  assert.equal(apply(t, csvSetCell(p, 0, 2, 'x,y', ',')), 'a, b ,"x,y"\n1,2\n');
  assert.equal(apply(t, csvSetCell(p, 0, 0, 'z', ',')), 'z, b ,"c"\n1,2\n');
  // 短い行の足りない列に書くと区切りを足す
  assert.equal(apply(t, csvSetCell(p, 1, 3, 'q', ',')), 'a, b ,"c"\n1,2,,q\n');
  assert.deepEqual(csvSetCell(p, 1, 3, '', ','), []);
});

test('CSV: 行の追加と削除', () => {
  const t = 'h1,h2\na,b\nc,d\n';
  const p = parseCsv(t, ',');
  assert.equal(apply(t, csvInsertRow(p, 1, ',', t.length)), 'h1,h2\n,\na,b\nc,d\n');
  assert.equal(apply(t, csvInsertRow(p, 3, ',', t.length)), 'h1,h2\na,b\nc,d\n,\n');
  assert.equal(apply(t, csvDeleteRow(p, 1)), 'h1,h2\nc,d\n');
  assert.equal(apply(t, csvDeleteRow(p, 2)), 'h1,h2\na,b\n');
  const one = 'only';
  assert.equal(apply(one, csvDeleteRow(parseCsv(one, ','), 0)), '');
  // 空のファイルにも、1 列だけで末尾に改行が無い表にも、行が 1 つ増える
  assert.equal(parseCsv(apply('', csvInsertRow(parseCsv('', ','), 0, ',', 0)), ',').rows.length, 1);
  for (const one1 of ['a', 'a\n']) {
    const out = apply(one1, csvInsertRow(parseCsv(one1, ','), 1, ',', one1.length));
    assert.equal(parseCsv(out, ',').rows.length, 2, JSON.stringify(out));
  }
  // 改行を含むセルがあっても、行の単位で消える
  const m = 'a,"x\ny"\nb,c';
  assert.equal(apply(m, csvDeleteRow(parseCsv(m, ','), 0)), 'b,c');
});

test('CSV: 列の追加と削除（短い行は触らない）', () => {
  const t = 'a,b,c\n1,2,3\nx\n';
  const p = parseCsv(t, ',');
  assert.equal(apply(t, csvInsertColumn(p, 1, ',')), 'a,,b,c\n1,,2,3\nx\n');
  assert.equal(apply(t, csvInsertColumn(p, 3, ',')), 'a,b,c,\n1,2,3,\nx\n');
  assert.equal(apply(t, csvDeleteColumn(p, 1)), 'a,c\n1,3\nx\n');
  assert.equal(apply(t, csvDeleteColumn(p, 2)), 'a,b\n1,2\nx\n');
  assert.equal(apply(t, csvDeleteColumn(p, 0)), 'b,c\n2,3\n\n');
});

test('CSV: 並べ替えの比較（数値・自然順・空は最後）', () => {
  assert.deepEqual(['10', '9', '1,200', '¥5,000', ''].sort(csvCompare), ['9', '10', '1,200', '¥5,000', '']);
  assert.deepEqual(['item10', 'item2', 'item1'].sort(csvCompare), ['item1', 'item2', 'item10']);
  assert.equal(csvNumber('12%'), 12);
  assert.equal(csvNumber('1,2'), null);
  assert.equal(csvNumber('abc'), null);
  assert.equal(csvNumber('-3.5e2'), -350);
});
