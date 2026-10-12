// ターミナルの sed（client/lib/term-sed.js）のテスト。
// 置き換える側は sed の書き方（& ・ \1 ・ \n）で、JS の $ 記法は効かないこと。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sedSplitScript, sedReplacer, sedGroupCount } from '../client/lib/term-sed.js';
import { termPattern, TermError } from '../client/lib/term-parse.js';

/** ターミナルの sed と同じ手順で 1 回置換する。 */
function sed(script, input) {
  const p = sedSplitScript(script);
  if (!p) throw new Error('形が違う: ' + script);
  const re = termPattern(p.pattern, { i: p.flags.indexOf('i') >= 0, g: p.flags.indexOf('g') >= 0 });
  return input.replace(re, sedReplacer(p.replacement, sedGroupCount(re)));
}

test('sed: スクリプトを 3 つに分ける', () => {
  assert.deepEqual(sedSplitScript('s/a/b/g'), { pattern: 'a', replacement: 'b', flags: 'g' });
  assert.deepEqual(sedSplitScript('s/a/b'), { pattern: 'a', replacement: 'b', flags: '' });
  assert.deepEqual(sedSplitScript('s|a/b|c|'), { pattern: 'a/b', replacement: 'c', flags: '' });
  assert.deepEqual(sedSplitScript('s/a\\/b/c/'), { pattern: 'a/b', replacement: 'c', flags: '' });
  // \\ の次の区切りは区切りのまま（\ 1 つと区切り）
  assert.deepEqual(sedSplitScript('s/a/\\\\/g'), { pattern: 'a', replacement: '\\\\', flags: 'g' });
  // 区切り以外の \x は 2 文字のまま残す（正規表現・置き換えの側で読む）
  assert.deepEqual(sedSplitScript('s/(\\d+)/<\\1>/'), { pattern: '(\\d+)', replacement: '<\\1>', flags: '' });
  assert.equal(sedSplitScript('x/a/b/'), null);
  assert.equal(sedSplitScript('s/a'), null);
  assert.equal(sedSplitScript(''), null);
});

test('sed: & は一致した全体、\\& は文字どおりの &', () => {
  assert.equal(sed('s/b+/[&]/g', 'abbcb'), 'a[bb]c[b]');
  assert.equal(sed('s/x/\\&/', 'axb'), 'a&b');
  assert.equal(sed('s/x/&&/', 'x'), 'xx');
});

test('sed: \\1〜\\9 は ( ) の中身、\\0 は全体', () => {
  assert.equal(sed('s/(\\w+)@(\\w+)/\\2 at \\1/', 'me@host'), 'host at me');
  assert.equal(sed('s/(a)|(b)/[\\1\\2]/g', 'ab'), '[a][b]');   // 一致しなかったグループは空
  assert.equal(sed('s/a(b)c/\\0-\\1/', 'abc'), 'abc-b');
  assert.equal(sed('s/(?<n>x)/<\\1>/', 'x'), '<x>');           // 名前付きグループも番号で
});

test('sed: $ は特別扱いしない（JS の $& $1 $$ は文字どおり）', () => {
  assert.equal(sed('s/a/$&/', 'a'), '$a');        // $ は文字、& は全体
  assert.equal(sed('s/a/$\\&/', 'a'), '$&');
  assert.equal(sed('s/(a)/$1/', 'a'), '$1');
  assert.equal(sed('s/a/$$/', 'a'), '$$');
  assert.equal(sed("s/a/$'$`/", 'xay'), "x$'$`y");
  assert.equal(sed('s/price/$100/', 'price'), '$100');
});

test('sed: \\\\ は \\、\\n は改行、\\t はタブ、ほかの \\x は x', () => {
  assert.equal(sed('s/,/\\n/g', 'a,b,c'), 'a\nb\nc');
  assert.equal(sed('s/,/\\t/', 'a,b'), 'a\tb');
  assert.equal(sed('s/x/\\\\/', 'axb'), 'a\\b');
  assert.equal(sed('s/x/a\\/b/', 'x'), 'a/b');
  assert.equal(sed('s/x/\\q/', 'x'), 'q');
  assert.equal(sedReplacer('a\\')('x', 0, 'x'), 'a\\');   // 末尾の \ は文字どおり
});

test('sed: ( ) の数を超える \\N はエラー', () => {
  assert.throws(() => sed('s/(a)/\\2/', 'a'), TermError);
  assert.throws(() => sed('s/a/\\1/', 'a'), TermError);
  assert.equal(sedGroupCount(/(a)(?:b)(?<c>d)/g), 2);
  // 数を渡さなければ、無いグループは空として扱う
  assert.equal('a'.replace(/a/, sedReplacer('[\\3]')), '[]');
});
