/**
 * tools/move-to-lib.mjs — client/app のトップレベルの宣言を client/lib の ES モジュールへ移す。
 *
 *   node tools/move-to-lib.mjs <lib ファイル名> "<ひとこと説明>" <名前> [<名前> …]
 *   例: node tools/move-to-lib.mjs search.js "全体検索の照合" searchLines
 *
 * - 宣言の直前の JSDoc / 行コメントも一緒に移す（セクション見出し `/* ---- *` は残す）
 * - 移した宣言に `export` を付け、ほかの lib の export を使っていれば import 行を足す
 * - lib ファイルが無ければ、説明つきの見出しを付けて作る
 * - 移したあと client/app の中身が空（コメントだけ）になったファイルは消す
 * 移した宣言が client/app の宣言を参照していたら止める（lib は client/app に依存できない）。
 * 生成物は build-app がつなぐので、client/app 側を書き換える必要は無い。
 */
import * as acorn from 'acorn';
import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(root, 'client', 'app');
const LIB = join(root, 'client', 'lib');
const [libName, title, ...names] = process.argv.slice(2);
if (!libName || !/^[a-z0-9-]+\.js$/.test(libName) || !names.length) {
  console.error('使い方: node tools/move-to-lib.mjs <lib.js> "<説明>" <名前>…');
  process.exit(1);
}
const parse = (s) => acorn.parse(s, { ecmaVersion: 'latest', sourceType: 'module' });
const declNames = (n) => n.type === 'VariableDeclaration' ? n.declarations.map((d) => d.id.name)
  : (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id ? [n.id.name] : [];

/** 参照している識別子（プロパティ名・キーは除く。スコープの影は気にしない＝多めに拾う）。 */
function refs(node) {
  const out = new Set();
  (function walk(x, parent, key) {
    if (!x || typeof x.type !== 'string') return;
    if (x.type === 'Identifier') {
      if (parent && parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return;
      if (parent && (parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && key === 'key' && !parent.computed) return;
      out.add(x.name);
      return;
    }
    for (const k of Object.keys(x)) {
      const v = x[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, x, k));
      else if (v && typeof v.type === 'string') walk(v, x, k);
    }
  })(node, null, null);
  return out;
}

// client/app の全宣言と、lib の export
const appDecl = new Map();   // name -> file
const appFiles = readdirSync(APP).filter((f) => f.endsWith('.js')).sort();
const texts = Object.fromEntries(appFiles.map((f) => [f, readFileSync(join(APP, f), 'utf8')]));
for (const f of appFiles) for (const n of parse(texts[f]).body) for (const nm of declNames(n)) appDecl.set(nm, f);
const libExport = new Map();  // name -> lib file
for (const f of readdirSync(LIB).filter((x) => x.endsWith('.js'))) {
  for (const n of parse(readFileSync(join(LIB, f), 'utf8')).body) {
    if (n.type === 'ExportNamedDeclaration' && n.declaration) for (const nm of declNames(n.declaration)) libExport.set(nm, f);
  }
}

const moving = new Set(names);
const pieces = [];
const cuts = {};
for (const nm of names) {
  const f = appDecl.get(nm);
  if (!f) throw new Error('client/app にトップレベルの宣言がありません: ' + nm);
  const src = texts[f];
  const node = parse(src).body.find((n) => declNames(n).includes(nm));
  if (declNames(node).length !== 1) throw new Error('1 つの文で複数を宣言しているので移せません: ' + nm);
  for (const r of refs(node)) {
    if (r !== nm && appDecl.has(r) && !moving.has(r)) throw new Error(`${nm} は client/app の ${r}（${appDecl.get(r)}）を使っているので lib に移せません`);
  }
  // 直前のコメント（見出しは除く）
  let start = node.start;
  for (;;) {
    let i = start;
    while (i > 0 && /[ \t\n]/.test(src[i - 1])) i--;
    if (src.slice(0, i).endsWith('*/')) {
      const c = src.lastIndexOf('/*', i - 2);
      if (/^\/\* -{5,}/.test(src.slice(c, c + 12))) break;   // セクション見出し
      start = c;
      continue;
    }
    const ls = src.lastIndexOf('\n', i - 1) + 1;
    if (i > 0 && /^\s*\/\//.test(src.slice(ls, i))) { start = ls; continue; }
    break;
  }
  start = src.lastIndexOf('\n', start - 1) + 1;
  let end = node.end;
  if (src[end] === '\n') end++;
  (cuts[f] ||= []).push([start, end]);
  const text = src.slice(start, end);
  const kwAt = node.start - start;
  pieces.push({ nm, text: text.slice(0, kwAt) + 'export ' + text.slice(kwAt), uses: [...refs(node)] });
}

// lib に書く
const libPath = join(LIB, libName);
let lib = existsSync(libPath) ? readFileSync(libPath, 'utf8')
  : `/**\n * client/lib/${libName} — ${title}。\n *\n * 依存の無い純粋な部分を client/app から切り出した ES モジュール。\n * client/app 側からは tools/build-app.mjs がつなぐので、同じ名前のまま参照できる。\n */\n`;
const needed = new Map();   // lib file -> Set(names)
for (const p of pieces) for (const u of p.uses) {
  const from = libExport.get(u);
  if (from && from !== libName) (needed.get(from) || needed.set(from, new Set()).get(from)).add(u);
}
// 既存の import 行に足す
for (const [from, set] of needed) {
  const re = new RegExp(`^import \\{ ([^}]*) \\} from '\\./${from.replace('.', '\\.')}';$`, 'm');
  const m = re.exec(lib);
  if (m) {
    const all = new Set(m[1].split(',').map((s) => s.trim()).concat([...set]));
    lib = lib.replace(re, `import { ${[...all].join(', ')} } from './${from}';`);
  } else {
    // 見出しコメントの直後（最初の import の前）に置く
    const headEnd = lib.indexOf('*/') + 3;
    lib = lib.slice(0, headEnd) + `import { ${[...set].join(', ')} } from './${from}';\n` + lib.slice(headEnd);
  }
}
lib = lib.replace(/\n*$/, '\n') + '\n' + pieces.map((p) => p.text.replace(/^\n+/, '')).join('\n');
writeFileSync(libPath, lib);

// client/app から外す
for (const [f, list] of Object.entries(cuts)) {
  let s = texts[f];
  for (const [a, b] of list.sort((x, y) => y[0] - x[0])) s = s.slice(0, a) + s.slice(b);
  s = s.replace(/\n{3,}/g, '\n\n');
  const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim();
  if (!code) { unlinkSync(join(APP, f)); console.log(`client/app/${f}: 空になったので消しました（見出しは要確認）`); }
  else writeFileSync(join(APP, f), s);
}
console.log(`client/lib/${libName} へ移しました: ${names.join(', ')}`);
