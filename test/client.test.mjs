import { test } from 'node:test';
import assert from 'node:assert/strict';
// client/lib は本物の ES モジュールなので、そのまま import して試す。
import * as eol from '../client/lib/eol.js';
import * as term from '../client/lib/term-parse.js';
import * as policy from '../client/lib/preview-policy.js';
import * as format from '../client/lib/format.js';
import { TextCodec } from '../client/lib/text-codec.js';

const C = { ...eol, ...term, ...policy };

test('改行コードの判定と往復', () => {
  assert.equal(C.detectEol('a'), null);
  assert.equal(C.detectEol('a\nb\n'), 'LF');
  assert.equal(C.detectEol('a\r\nb\r\n'), 'CRLF');
  assert.equal(C.detectEol('a\r\nb\nc\r\n'), 'CRLF');
  assert.equal(C.normalizeEol('a\r\nb\rc\n'), 'a\nb\nc\n');
  const crlf = 'x\r\ny\r\n';
  assert.equal(C.restoreEol(C.normalizeEol(crlf), 'CRLF'), crlf);
  assert.equal(C.restoreEol('x\n', 'LF'), 'x\n');
});

test('glob を正規表現にする', () => {
  assert.ok(C.globToRegExp('*.md').test('README.MD'));
  assert.ok(!C.globToRegExp('*.md').test('a/b.md'));
  assert.ok(C.globToRegExp('file?.txt').test('file1.txt'));
  assert.ok(C.globToRegExp('[!a]x').test('bx'));
  assert.ok(!C.globToRegExp('[!a]x').test('ax'));
  assert.ok(C.globToRegExp('a.b').test('a.b'));
  assert.ok(!C.globToRegExp('a.b').test('axb'));
});

test('コマンド行の字句と引用符', () => {
  const t = C.termTokenize(`grep -i "a b" 'c\\d' e\\ f|wc>>out`);
  assert.deepEqual([...t.map((x) => x.text)], ['grep', '-i', 'a b', 'c\\d', 'e f', '|', 'wc', '>>', 'out']);
  assert.equal(C.termTokenize('"open').pop().open, true);
});

test('パイプとリダイレクト', () => {
  const p = C.termParse('cat a | grep x > out.txt');
  assert.deepEqual(JSON.parse(JSON.stringify(p.stages)), [['cat', 'a'], ['grep', 'x']]);
  assert.deepEqual({ ...p.redirect }, { op: '>', path: 'out.txt' });
  assert.throws(() => C.termParse('| x'), C.TermError);
  assert.throws(() => C.termParse('ls >'), C.TermError);
  assert.throws(() => C.termParse('   '), C.TermError);
});

test('オプションの解釈', () => {
  const spec = { r: true, f: true, n: 'value', name: 'value' };
  const a = C.termArgs(['-rf', 'x', '--', '-y'], spec);
  assert.deepEqual({ ...a.flags }, { r: true, f: true });
  assert.deepEqual([...a.rest], ['x', '-y']);
  assert.equal(C.termArgs(['-n', '5'], spec).flags.n, '5');
  assert.equal(C.termArgs(['-n5'], spec).flags.n, '5');
  assert.equal(C.termArgs(['--name=a*'], spec).flags.name, 'a*');
  assert.equal(C.termArgs(['-name', 'b'], spec).flags.name, 'b');
  assert.deepEqual([...C.termArgs(['-3'], spec).rest], ['-3']);
  assert.throws(() => C.termArgs(['-z'], spec), C.TermError);
  assert.throws(() => C.termArgs(['--name'], spec), C.TermError);
});

test('外部 URL の判定（Markdown の画像を止める対象）', () => {
  for (const u of ['https://x/a.png', '//x/a.png', 'http://x', 'a.png', '/a.png', 'javascript:x']) {
    assert.equal(C.isRemoteUrl(u), true, u);
  }
  for (const u of ['data:image/png;base64,AA', ' DATA:x', 'blob:https://x/1', '#frag']) {
    assert.equal(C.isRemoteUrl(u), false, u);
  }
});

test('バイト数・拡張子の書式', () => {
  assert.equal(format.formatBytes(512), '512 B');
  assert.equal(format.formatBytes(2048), '2.0 KB');
  assert.equal(format.formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(format.extensionOf('a/b/README.MD'), 'md');
  // 拡張子の無い名前は名前全体（小文字）を返す（Makefile / Dockerfile を判定表で引くため）。
  assert.equal(format.extensionOf('Makefile'), 'makefile');
});

test('インデントの推定', () => {
  assert.deepEqual({ ...eol.detectIndent('x\n    y\n        z\n    w\n') }, { useTabs: false, size: 4 });
  assert.deepEqual({ ...eol.detectIndent('x\n  y\n    z\n') }, { useTabs: false, size: 2 });
  assert.deepEqual({ ...eol.detectIndent('x\n\ty\n\t\tz\n') }, { useTabs: true, size: 0 });
  // 字下げが 1 行も無ければ判定しない（設定の既定に任せる）。
  assert.equal(eol.detectIndent('a\nb\n'), null);
});

test('文字コード: UTF-8 と Shift_JIS の往復', () => {
  const utf8 = new TextEncoder().encode('日本語 abc');
  const d1 = TextCodec.decode(utf8.buffer);
  assert.equal(d1.text, '日本語 abc');
  assert.equal(d1.encoding, 'UTF-8');
  const sjis = TextCodec.encode('日本語①～', TextCodec.SJIS);
  const d2 = TextCodec.decode(sjis.buffer.slice(sjis.byteOffset, sjis.byteOffset + sjis.byteLength));
  assert.equal(d2.encoding, TextCodec.SJIS);
  assert.equal(d2.text, '日本語①～');
});
