/**
 * tools/split-core.mjs — client/app のオブジェクトのうち、依存の無いプロパティ（芯）を
 * client/lib へ移す。残りは client/app の元の場所で Object.assign して足す。
 *
 *   node tools/split-core.mjs <client/app のファイル> <オブジェクト名> <lib.js> "<説明>" <プロパティ名> [...]
 *   例: node tools/split-core.mjs client/app/110-store.js Store store-cache.js "本文の LRU キャッシュ" inflight content dedup
 *
 * - 移すプロパティは直前のコメントごと移し、元の並び順を保つ
 * - lib 側は `export const <名前> = { … };`、app 側は `Object.assign(<名前>, { … });` になる
 *   （lib が先に評価されるので、app 側の Object.assign の時点でオブジェクトはできている）
 * - 移すプロパティが client/app の宣言を参照していたら止める（差し込み口に置き換えてから移す）
 * - ゲッター / セッターは Object.assign で写せないので止める
 */
import * as acorn from 'acorn';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';

const [appFile, obj, libName, title, ...names] = process.argv.slice(2);
if (!appFile || !obj || !libName || !names.length) {
  console.error('使い方: node tools/split-core.mjs <app ファイル> <オブジェクト名> <lib.js> "<説明>" <プロパティ名>…');
  process.exit(1);
}
const parse = (s) => acorn.parse(s, { ecmaVersion: 'latest', sourceType: 'module' });
const declNames = (n) => n.type === 'VariableDeclaration' ? n.declarations.map((d) => d.id.name)
  : (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id ? [n.id.name] : [];
function refs(node) {
  const out = new Set();
  (function walk(x, parent, key) {
    if (!x || typeof x.type !== 'string') return;
    if (x.type === 'Identifier') {
      if (parent && parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return;
      if (parent && parent.type === 'Property' && key === 'key' && !parent.computed) return;
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

const appDecl = new Map();
for (const f of readdirSync('client/app').filter((x) => x.endsWith('.js'))) {
  for (const n of parse(readFileSync('client/app/' + f, 'utf8')).body) for (const nm of declNames(n)) appDecl.set(nm, f);
}
const libExport = new Map();
for (const f of readdirSync('client/lib').filter((x) => x.endsWith('.js'))) {
  for (const n of parse(readFileSync('client/lib/' + f, 'utf8')).body) {
    if (n.type === 'ExportNamedDeclaration' && n.declaration) for (const nm of declNames(n.declaration)) libExport.set(nm, f);
  }
}

const src = readFileSync(appFile, 'utf8');
const decl = parse(src).body.find((n) => n.type === 'VariableDeclaration' && n.declarations[0].id.name === obj);
if (!decl || decl.declarations[0].init.type !== 'ObjectExpression') throw new Error(`${appFile} に const ${obj} = { … } がありません`);
const lit = decl.declarations[0].init;
const props = lit.properties;
const keyOf = (p) => p.key.name || p.key.value;
for (const nm of names) if (!props.some((p) => keyOf(p) === nm)) throw new Error(`${obj} に ${nm} がありません`);

// 各プロパティの範囲（直前のコメント・空行を含む）: 前のプロパティのカンマの次の行から、自分の末尾まで
const ranges = props.map((p, i) => {
  const from = i === 0 ? src.indexOf('\n', lit.start) + 1 : src.indexOf('\n', src.indexOf(',', props[i - 1].end)) + 1;
  return { p, key: keyOf(p), text: src.slice(from, p.end).replace(/^\n+/, '') };
});
const moving = ranges.filter((r) => names.includes(r.key));
const staying = ranges.filter((r) => !names.includes(r.key));
const uses = new Set();
for (const r of moving) {
  if (r.p.kind !== 'init') throw new Error(`${obj}.${r.key} はゲッター / セッターなので移せません`);
  for (const u of refs(r.p.value)) {
    if (u === obj) continue;
    if (appDecl.has(u)) throw new Error(`${obj}.${r.key} は client/app の ${u}（${appDecl.get(u)}）を使っているので移せません`);
    uses.add(u);
  }
}
const body = (list) => list.map((r) => r.text).join(',\n\n') + '\n';

// lib
const libPath = 'client/lib/' + libName;
let lib = existsSync(libPath) ? readFileSync(libPath, 'utf8')
  : `/**\n * client/lib/${libName} — ${title}。\n *\n * client/app の ${obj} のうち、依存の無い芯を切り出した ES モジュール。\n * 残り（通信・画面に触るもの）は client/app 側で Object.assign(${obj}, { … }) して足している。\n */\n`;
const needed = new Map();
for (const u of uses) {
  const from = libExport.get(u);
  if (from && from !== libName) (needed.get(from) || needed.set(from, new Set()).get(from)).add(u);
}
for (const [from, set] of needed) {
  const head = lib.indexOf('*/') + 3;
  lib = lib.slice(0, head) + `import { ${[...set].join(', ')} } from './${from}';\n` + lib.slice(head);
}
lib = lib.replace(/\n*$/, '\n') + `\nexport const ${obj} = {\n` + body(moving) + '};\n';
writeFileSync(libPath, lib);

// app: 宣言を Object.assign に置き換える（宣言の直前の JSDoc はそのまま残す）
const assign = `// ${obj} の芯（${moving.map((r) => r.key).join(' / ')} など）は client/lib/${libName}。ここでは残りを足す。\n` +
  `Object.assign(${obj}, {\n` + body(staying) + '});';
writeFileSync(appFile, src.slice(0, decl.start) + assign + src.slice(decl.end));
console.log(`${obj}: ${moving.length} 個を client/lib/${libName} へ、${staying.length} 個を ${appFile} に残しました`);
