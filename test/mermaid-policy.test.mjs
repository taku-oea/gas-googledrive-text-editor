// mermaid の SVG を文書に入れる前の仕上げ（client/lib/preview-policy.js）のテスト。
// 共有された Markdown の %%{init}%% や frontmatter から、アプリ全体に効く CSS や
// 外部への読み込みを差し込ませないことを確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scopeMermaidCss, scopeMermaidStyles, holdRemote, styleLoadsRemote,
  MERMAID_SECURE, MERMAID_ID_RE, MERMAID_KEYFRAMES
} from '../client/lib/preview-policy.js';

const ID = 'mmd-3-0-12';
const norm = (s) => s.replace(/\s+/g, '').replace(/;}/g, '}');

test('mermaid CSS: mermaid 自身の出力（#id 付き）はそのまま残る', () => {
  const css = '#' + ID + '{font-family:"trebuchet ms",verdana,arial,sans-serif;font-size:16px;fill:#333;}' +
    '@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}' +
    '@keyframes dash{to{stroke-dashoffset:0;}}' +
    '#' + ID + ' .edge-animation-slow{stroke-dasharray:9,5!important;animation:dash 50s linear infinite;}' +
    '#' + ID + ' .node rect,#' + ID + ' .node circle{fill:#ECECFF;stroke:#9370DB;stroke-width:1px;}' +
    '#' + ID + ' .marker{fill:#333;}#' + ID + '>.x{fill:red}' +
    '#' + ID + '[data-look="neo"] .cluster rect{stroke:url(#' + ID + '-gradient);filter:drop-shadow(1px 2px 2px rgba(185,185,185,1));}' +
    '#' + ID + ' :root{--mermaid-font-family:"trebuchet ms";}' +
    '@media (prefers-reduced-motion:reduce){#' + ID + ' .edge-animation-slow{animation:none;}}';
  assert.equal(norm(scopeMermaidCss(css, ID)), norm(css));
});

test('mermaid CSS: #id で始まらない規則・兄弟へ出る規則は落とす', () => {
  const keep = '#' + ID + ' .a{fill:red}';
  const cases = [
    'body{display:none}',
    '.toolbar{opacity:0}',
    '*{color:red}',
    ':root{--bg-0:red}',
    '#' + ID + 'x .a{fill:red}',            // id の前方一致だけ
    '#' + ID + ' ~ div{display:none}',      // svg の兄弟
    '#' + ID + '+*{display:none}',
    '#' + ID + ':hover ~ *{display:none}',
    '#' + ID + ' .a, body{color:red}',      // 1 つでも外を指せば規則ごと落とす
    'html #' + ID + ' .a{color:red}',
    '#' + ID + ' || td{color:red}'
  ];
  for (const bad of cases) {
    assert.equal(norm(scopeMermaidCss(bad + keep, ID)), norm(keep), bad);
  }
});

test('mermaid CSS: @import・url()・expression・エスケープを落とす', () => {
  const out = scopeMermaidCss(
    '@import url(https://t.example/a.css);' +
    '@import "https://t.example/b.css";' +
    '@font-face{font-family:x;src:url(https://t.example/f.woff)}' +
    '#' + ID + ' .a{fill:red;background:url(https://t.example/p.gif);stroke:blue}' +
    '#' + ID + ' .b{background-image:image-set("https://t.example/p.png" 1x)}' +
    '#' + ID + ' .c{width:expression(alert(1))}' +
    '#' + ID + ' .d{background:\\75rl(//t.example/e)}' +
    '#' + ID + ' .e{cursor:URL( "//t.example/c" ),auto}' +
    '#' + ID + ' .f{stroke:url(' + ID + '-gradient)}' +    // # の無い相対 URL は外部
    '#' + ID + ' .g{-moz-binding:x;behavior:y;color:green}', ID);
  assert.ok(!/@import|@font-face|url\(|image-set|expression|\\|binding|behavior|t\.example/i.test(out), out);
  assert.ok(out.includes('fill:red'));
  assert.ok(out.includes('stroke:blue'));
  assert.ok(out.includes('color:green'));
});

test('mermaid CSS: @keyframes は mermaid の名前だけ、その他の @ 規則は落とす', () => {
  assert.deepEqual(MERMAID_KEYFRAMES, ['dash', 'edge-animation-frame']);
  const out = scopeMermaidCss(
    '@keyframes spin{to{opacity:0}}' +              // アプリの spin を上書きしようとする
    '@keyframes dash{to{stroke-dashoffset:0;background:url(//t.example/k)}}' +
    '@layer base, app;' +
    '@layer x{body{color:red}}' +
    '@scope (body){*{color:red}}' +
    '@media screen{body{color:red}#' + ID + ' .a{fill:red}}' +
    '@page{margin:0}', ID);
  assert.equal(norm(out), norm('@keyframes dash{to{stroke-dashoffset:0}}@media screen{#' + ID + ' .a{fill:red}}'));
});

test('mermaid CSS: コメント・文字列・入れ子で区切りをごまかせない', () => {
  // 文字列の中の } で規則を閉じたように見せる
  const s1 = scopeMermaidCss('#' + ID + ' .a{font-family:"x}body{display:none}"}', ID);
  assert.ok(!/(^|})body/.test(s1), s1);
  // コメントで #id を隠す
  assert.equal(scopeMermaidCss('/*#' + ID + '*/body{color:red}', ID), '');
  assert.equal(scopeMermaidCss('#' + ID + '/**/ ~ *{color:red}', ID), '');
  // CSS nesting（& ~ や外側のセレクタ）は使わせない
  assert.equal(scopeMermaidCss('#' + ID + ' .a{color:red;& ~ *{color:red}body &{x:y}}', ID), '');
  // 閉じていない規則は捨てる
  assert.equal(scopeMermaidCss('#' + ID + ' .a{color:red', ID), '');
  // id がおかしければ何も残さない
  assert.equal(scopeMermaidCss('#a b{color:red}', 'a b'), '');
  assert.equal(scopeMermaidCss('#x{color:red}', ''), '');
});

/** scopeMermaidStyles が使うぶんだけの DOM の代役。 */
function fakeSvgFragment(id, styles) {
  const nodes = styles.map((text) => {
    const n = { textContent: text, removed: false, remove() { n.removed = true; } };
    return n;
  });
  const svg = { getAttribute: (k) => (k === 'id' ? id : null) };
  return {
    nodes,
    root: {
      querySelector: (sel) => (sel === 'svg' && id !== undefined ? svg : null),
      querySelectorAll: (sel) => (sel === 'style' ? nodes : [])
    }
  };
}

test('mermaid SVG: <style> を一番外側の SVG の id で絞る', () => {
  const { root, nodes } = fakeSvgFragment(ID, ['body{color:red}#' + ID + ' .a{fill:red}', 'body{color:red}']);
  scopeMermaidStyles(root, MERMAID_ID_RE);
  assert.equal(norm(nodes[0].textContent), norm('#' + ID + ' .a{fill:red}'));
  assert.equal(nodes[0].removed, false);
  assert.equal(nodes[1].removed, true);   // 何も残らなければ要素ごと外す
});

test('mermaid SVG: こちらが付けた形の id でなければ <style> を全部外す', () => {
  for (const id of ['app', 'mmd-1', 'toolbar', '', undefined]) {
    const { root, nodes } = fakeSvgFragment(id, ['#' + id + ' .a{fill:red}']);
    scopeMermaidStyles(root, MERMAID_ID_RE);
    assert.equal(nodes[0].removed, true, String(id));
  }
  assert.ok(MERMAID_ID_RE.test(ID));
});

test('mermaid の secure: CSS へ入る項目を init / frontmatter から書き換えさせない', () => {
  for (const k of ['secure', 'securityLevel', 'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily',
    'actorFontFamily', 'noteFontFamily', 'messageFontFamily', 'personFontFamily', 'external_component_queueFontFamily']) {
    assert.ok(MERMAID_SECURE.includes(k), k);
  }
});

/** holdRemote が使うぶんだけの小さな DOM の代役（SVG の要素）。 */
function fakeEl(tag, attrs) {
  const a = new Map(Object.entries(attrs));
  return {
    tagName: tag.toUpperCase(),
    localName: tag,
    getAttribute: (k) => (a.has(k) ? a.get(k) : null),
    setAttribute: (k, v) => a.set(k, String(v)),
    removeAttribute: (k) => a.delete(k),
    hasAttribute: (k) => a.has(k),
    classList: { add() {}, remove() {} }
  };
}

test('mermaid SVG: 外部の <image href> は止め、図の中の参照と data: は残す', () => {
  const img = fakeEl('image', { href: 'https://t.example/i.png' });
  const ximg = fakeEl('image', { 'xlink:href': '//t.example/x.png' });
  const use = fakeEl('use', { href: '#' + ID + '-marker' });
  const data = fakeEl('image', { href: 'data:image/png;base64,AA' });
  const fe = fakeEl('feImage', { href: 'https://t.example/f.png' });
  holdRemote({ querySelectorAll: () => [img, ximg, use, data, fe] });
  assert.equal(img.getAttribute('href'), null);
  assert.equal(img.getAttribute('data-held-href'), 'https://t.example/i.png');
  assert.equal(ximg.getAttribute('xlink:href'), null);
  assert.equal(ximg.getAttribute('data-held-href'), '//t.example/x.png');
  assert.equal(fe.getAttribute('data-held-href'), 'https://t.example/f.png');
  assert.equal(use.getAttribute('href'), '#' + ID + '-marker');
  assert.equal(data.getAttribute('href'), 'data:image/png;base64,AA');
});

test('style 属性: 外部の url() とエスケープは止め、url(#id) と data: は残す', () => {
  assert.equal(styleLoadsRemote('background:url(//t.example/b)'), true);
  assert.equal(styleLoadsRemote('background:url( "https://t.example/b" )'), true);
  assert.equal(styleLoadsRemote('background:\\75rl(//t.example/b)'), true);
  assert.equal(styleLoadsRemote('background-image:image-set("x.png" 1x)'), true);
  assert.equal(styleLoadsRemote('marker-end:url(#' + ID + '-arrow)'), false);
  assert.equal(styleLoadsRemote('background:url("data:image/png;base64,AA")'), false);
  assert.equal(styleLoadsRemote('fill:#f9f;stroke:#333'), false);
  const arrow = fakeEl('path', { style: 'marker-end:url(#a)' });
  const bg = fakeEl('rect', { style: 'fill:url(https://t.example/p)' });
  holdRemote({ querySelectorAll: () => [arrow, bg] });
  assert.equal(arrow.getAttribute('style'), 'marker-end:url(#a)');
  assert.equal(bg.getAttribute('style'), null);
  assert.equal(bg.getAttribute('data-held-style'), 'fill:url(https://t.example/p)');
});
