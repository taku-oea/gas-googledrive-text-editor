/**
 * tools/check.mjs — clasp push の前に通す静的な確認。
 *
 *   npm run check
 *
 * 1. src/*.gs を GAS と同じく 1 本につなげて構文を確かめる
 * 2. client/lib と client/app から作るクライアントを構文解析する（ES モジュールとして）。
 *    トップレベルの名前の重なりも見る。src/js.html があれば、作り直したものと一致するか
 *    （生成し忘れ）も見る
 * 3. src/importmap.html の自前配信（BASE_URL 配下）のモジュールすべてに SRI が付いているか、
 *    dist/vendor/ があればその中身のハッシュと一致するかを確かめる
 *    （配信先に上げる前に import map だけ手で直す、といった食い違いを push 前に止める）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as acorn from 'acorn';
import { assembleSource, buildHtml, locate } from './build-app.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = (process.env.VENDOR_BASE_URL || 'https://assets.oea.jp/apps/editor/vendor').replace(/\/$/, '');
const errors = [];

// 1. .gs（V8 ランタイムはスクリプト扱い）
const gsDir = join(root, 'src');
const gs = readdirSync(gsDir).filter((f) => f.endsWith('.gs')).sort();
for (const f of gs) {
  try {
    acorn.parse(readFileSync(join(gsDir, f), 'utf8'), { ecmaVersion: 2020, sourceType: 'script' });
  } catch (e) {
    errors.push(`src/${f}: ${e.message}`);
  }
}

// 2. クライアント
let clientHtml = null;
try {
  acorn.parse(assembleSource(), { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  clientHtml = buildHtml();
} catch (e) {
  // 連結後の行番号を、元のファイルの行に直す。
  const at = e.loc ? locate(e.loc.line) : null;
  errors.push(at ? `${at.file}:${at.line}:${e.loc.column + 1}: ${e.message.replace(/\s*\(\d+:\d+\)$/, '')}` : String(e.message));
}
const jsOut = join(root, 'src', 'js.html');
if (clientHtml && existsSync(jsOut) && readFileSync(jsOut, 'utf8') !== clientHtml) {
  errors.push('src/js.html が今のソースと一致しません（npm run build:app で作り直す）');
}

// 3. import map の SRI
const im = readFileSync(join(root, 'src', 'importmap.html'), 'utf8');
const mapText = /<script type="importmap">([\s\S]*?)<\/script>/.exec(im);
if (!mapText) errors.push('src/importmap.html: import map が見つかりません');
else {
  const map = JSON.parse(mapText[1]);
  const integrity = map.integrity || {};
  const ours = Object.values(map.imports || {}).filter((u) => u.startsWith(BASE_URL + '/'));
  if (!ours.length) errors.push('src/importmap.html: 自前配信の "vendor" がありません（npm run build -- --apply）');
  for (const u of ours) if (!integrity[u]) errors.push(`src/importmap.html: SRI がありません: ${u}`);
  for (const pre of im.matchAll(/<link rel="modulepreload" href="([^"]+)"([^>]*)>/g)) {
    const want = integrity[pre[1]];
    const got = /integrity="([^"]+)"/.exec(pre[2]);
    if (!got) errors.push(`src/importmap.html: modulepreload に integrity がありません: ${pre[1]}`);
    else if (want && got[1] !== want) errors.push(`src/importmap.html: modulepreload と import map の SRI が違います: ${pre[1]}`);
  }
  const dist = join(root, 'dist', 'vendor');
  if (existsSync(dist)) {
    for (const [url, sri] of Object.entries(integrity)) {
      if (!url.startsWith(BASE_URL + '/')) continue;
      const file = join(dist, url.slice(BASE_URL.length + 1));
      if (!existsSync(file)) { errors.push(`dist/vendor に無いファイルが import map にあります: ${url}（build をやり直す）`); continue; }
      const actual = 'sha384-' + createHash('sha384').update(readFileSync(file)).digest('base64');
      if (actual !== sri) errors.push(`dist/vendor の中身と SRI が違います: ${url}`);
    }
  }
  console.log(`importmap: 自前配信 ${Object.keys(integrity).length} ファイルに SRI`);
}

console.log(`構文: .gs ${gs.length} 本 / client/lib + client/app`);
if (errors.length) {
  console.error('\n' + errors.map((e) => '✖ ' + e).join('\n'));
  process.exit(1);
}
console.log('✔ check OK');
