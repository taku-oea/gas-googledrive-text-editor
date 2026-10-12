// client/lib に移した関数のテスト（第 2 弾）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, EditorSelection } from '@codemirror/state';
import { searchLines } from '../client/lib/search.js';
import { termLines, termPattern, termPool, TermError, TERM_ALIASES } from '../client/lib/term-parse.js';
import { toggleHeading, toggleLinePrefix } from '../client/lib/md-edit.js';
import { unwrapResponse, ApiError } from '../client/lib/errors.js';
import { DRAWIO_RE } from '../client/lib/preview-policy.js';
import { cleanFontFamily, fontStack, isFontInstalled, FONT_PRESETS } from '../client/lib/font.js';

/** EditorView の代わり（md-edit が使う state / dispatch / focus だけ）。 */
function fakeView(doc, ranges) {
  const view = {
    state: EditorState.create({
      doc,
      selection: EditorSelection.create(ranges.map(([a, b]) => EditorSelection.range(a, b))),
      extensions: EditorState.allowMultipleSelections.of(true)
    }),
    dispatch(spec) { view.state = view.state.update(spec).state; },
    focus() {}
  };
  return view;
}
const text = (v) => v.state.doc.toString();

test('全体検索: 一致する行と位置', () => {
  const hits = searchLines('abc\nxAbc\nzzz', 'abc', false);
  assert.deepEqual(hits.map((h) => [h.line, h.column]), [[1, 1], [2, 2]]);
  assert.equal(searchLines('abc\nxAbc', 'Abc', true).length, 1);
  assert.equal(searchLines(Array(50).fill('hit').join('\n'), 'hit', true).length, 20);   // 1 ファイル 20 行まで
});

test('ターミナル: 行分け・パターン・別名', () => {
  assert.deepEqual(termLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(termLines(''), []);
  assert.ok(termPattern('a.c', { fixed: true }).test('a.c'));
  assert.ok(!termPattern('a.c', { fixed: true }).test('abc'));
  assert.ok(termPattern('A', { i: true }).test('a'));
  assert.throws(() => termPattern('(', {}), TermError);
  assert.deepEqual(TERM_ALIASES.ll, ['ls', '-l']);
});

test('ターミナル: 並列数を守って全件を順番どおりに返す', async () => {
  let running = 0;
  let peak = 0;
  const out = await termPool([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return x * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70]);
  assert.ok(peak <= 3);
});

test('Markdown: 見出しの付け外し', () => {
  const v = fakeView('a\nb', [[0, 3]]);
  toggleHeading(v, 2);
  assert.equal(text(v), '## a\n## b');
  toggleHeading(v, 2);
  assert.equal(text(v), 'a\nb');
  const w = fakeView('# a', [[0, 0]]);
  toggleHeading(w, 3);
  assert.equal(text(w), '### a');
});

test('Markdown: 番号付きリスト・チェックリスト（空行には付けない）', () => {
  const v = fakeView('a\n\nb', [[0, 4]]);
  toggleLinePrefix(v, 'number');
  assert.equal(text(v), '1. a\n\n2. b');
  toggleLinePrefix(v, 'number');
  assert.equal(text(v), 'a\n\nb');
  const t = fakeView('- x', [[0, 0]]);
  toggleLinePrefix(t, 'task');
  assert.equal(text(t), '- [ ] x');
});

test('サーバー応答の解釈', () => {
  assert.equal(unwrapResponse({ ok: true, data: 5 }), 5);
  assert.throws(() => unwrapResponse({ ok: false, code: 'CONFLICT', error: 'x' }),
    (e) => e instanceof ApiError && e.code === 'CONFLICT');
  assert.throws(() => unwrapResponse(null), ApiError);
});

test('drawio のファイル名', () => {
  for (const n of ['a.drawio', 'b.dio', 'c.drawio.xml']) assert.ok(DRAWIO_RE.test(n), n);
  assert.ok(!DRAWIO_RE.test('d.xml'));
});

import { validFileName } from '../client/lib/format.js';
import { withScrollKeeper, holdRemote } from '../client/lib/preview-policy.js';

test('ファイル名の検証（サーバーの validateFileName_ と同じ規則）', () => {
  assert.equal(validFileName('  a.md '), 'a.md');
  for (const bad of ['', '   ', 'a/b', 'a\\b', '.', '..', 'x'.repeat(256)]) {
    assert.throws(() => validFileName(bad), ApiError, JSON.stringify(bad));
  }
});

test('HTML プレビュー: 位置を保つスクリプトは末尾に足すだけ', () => {
  const out = withScrollKeeper('<p>x</p>', 120);
  assert.ok(out.startsWith('<p>x</p>'));
  assert.ok(out.includes('var y = 120'));
  assert.equal(withScrollKeeper('', 'abc').includes('var y = 0'), true);   // 数でなければ 0
});

/** holdRemote が使うぶんだけの小さな DOM の代役。 */
function fakeEl(tag, attrs) {
  const a = new Map(Object.entries(attrs));
  const cls = new Set();
  return {
    tagName: tag.toUpperCase(),
    getAttribute: (k) => (a.has(k) ? a.get(k) : null),
    setAttribute: (k, v) => a.set(k, String(v)),
    removeAttribute: (k) => a.delete(k),
    hasAttribute: (k) => a.has(k),
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), has: (c) => cls.has(c) },
    attrs: a
  };
}

test('Markdown プレビュー: 外部の画像・背景は止め、data: は残す', () => {
  const img = fakeEl('img', { src: 'https://t.example/p.gif' });
  const inline = fakeEl('img', { src: 'data:image/png;base64,AA', alt: 'x' });
  const bg = fakeEl('span', { style: 'background:url(//t.example/b)' });
  const plain = fakeEl('span', { style: 'color:red' });
  holdRemote({ querySelectorAll: () => [img, inline, bg, plain] });
  assert.equal(img.getAttribute('src'), null);
  assert.equal(img.getAttribute('data-held-src'), 'https://t.example/p.gif');
  assert.ok(img.classList.has('mdimg--held'));
  assert.equal(img.getAttribute('alt'), '外部の画像');
  assert.equal(inline.getAttribute('src'), 'data:image/png;base64,AA');
  assert.equal(bg.getAttribute('style'), null);
  assert.equal(bg.getAttribute('data-held-style'), 'background:url(//t.example/b)');
  assert.equal(plain.getAttribute('style'), 'color:red');
});

test('フォント: 名前の丸め', () => {
  assert.equal(cleanFontFamily('  HackGen   Console NF  '), 'HackGen Console NF');
  assert.equal(cleanFontFamily('HackGen Console NF, Menlo'), 'HackGen Console NF, Menlo');
  // CSS の文法に関わる記号は落とす（値を抜け出して別の宣言を書けないように）
  assert.equal(cleanFontFamily('"Menlo"; color: red'), 'Menlo color red');
  assert.equal(cleanFontFamily('a}{b)(c\\d<e>'), 'abcde');
  assert.equal(cleanFontFamily("url('x')"), 'urlx');
  // 日本語名・ハイフン・ドットは残す
  assert.equal(cleanFontFamily('ＭＳ ゴシック, Osaka-Mono, Font.v2'), 'ＭＳ ゴシック, Osaka-Mono, Font.v2');
  // 空・重複（大文字小文字違い）は捨て、4 つまで
  assert.equal(cleanFontFamily(', menlo, Menlo, ,'), 'menlo');
  assert.equal(cleanFontFamily('a, b, c, d, e'), 'a, b, c, d');
  assert.equal(cleanFontFamily('x'.repeat(100)).length, 64);
  assert.equal(cleanFontFamily(null), '');
  assert.equal(cleanFontFamily(undefined), '');
  assert.equal(cleanFontFamily(42), '42');
  // 候補はそのまま通る名前だけにしてある
  for (const p of FONT_PRESETS) assert.equal(cleanFontFamily(p.name), p.name);
});

test('フォント: font-family の値', () => {
  assert.equal(fontStack(''), 'var(--font-mono-default)');
  assert.equal(fontStack('HackGen Console NF'), '"HackGen Console NF", var(--font-mono-default)');
  assert.equal(fontStack('A, "B"'), '"A", "B", var(--font-mono-default)');
});

test('フォント: インストール済みかの判定', () => {
  // 端末にあるフォントだけ、総称フォントと違う幅になる、という測り方の代わり
  const installed = new Set(['HackGen Console NF']);
  const measure = (font) => {
    const m = /^72px "([^"]+)", /.exec(font);
    return m && installed.has(m[1]) ? 999 : (font.endsWith('serif') ? 500 : 600);
  };
  assert.equal(isFontInstalled('HackGen Console NF', measure), true);
  assert.equal(isFontInstalled('Menlo', measure), false);
  assert.equal(isFontInstalled('', measure), false);
  // 測る側へ渡す名前も丸めてある
  const seen = [];
  isFontInstalled('Me"nlo', (font) => { seen.push(font); return 1; });
  assert.ok(seen.every((f) => !f.includes('Me"')));
});
