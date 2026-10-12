/**
 * tools/check-esm.mjs — esm.sh のフォールバック URL が生きているかを確かめる。
 *
 *   npm run check:esm
 *
 * ライブラリの本命は VENDOR_BASE_URL から配るバンドル（tools/build.mjs）で、esm.sh はそこへ到達できない
 * ときの退路。使われないまま腐りやすいので、版を上げたあとやデプロイ前にここで確かめる。
 *
 * 見ているのは 2 つ。
 *   1. import map の各 URL が 200 を返すか（版の打ち間違い・公開停止の検出）
 *   2. スタブが再エクスポートしている深い URL（x-esm-path ヘッダ）
 *      → 版を固定していれば immutable で配信される。ここが変わると取得が 1 段増える
 *
 * 終了コードは、1 つでも 200 以外があれば 1。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'src', 'importmap.html'), 'utf8');

const m = html.match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/);
if (!m) {
  console.error('src/importmap.html に import map が見つかりません。');
  process.exit(1);
}
const imports = JSON.parse(m[1]).imports || {};

/** 末尾が / のもの（@codemirror/legacy-modes/ など）は URL の断片なので確かめられない。 */
const targets = Object.entries(imports)
  .filter(([name, url]) => !url.endsWith('/') && name !== 'vendor');

let failed = 0;
const rows = [];
await Promise.all(targets.map(async ([name, url]) => {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (!res.ok) failed++;
    rows.push({
      name,
      status: res.status,
      cache: /immutable/.test(res.headers.get('cache-control') || '') ? 'immutable' : (res.headers.get('cache-control') || ''),
      deep: res.headers.get('x-esm-path') || ''
    });
  } catch (err) {
    failed++;
    rows.push({ name, status: 'ERR', cache: '', deep: String(err && err.message ? err.message : err) });
  }
}));

rows.sort((a, b) => a.name.localeCompare(b.name));
for (const r of rows) {
  console.log(String(r.status).padEnd(5), r.name.padEnd(44), r.cache.padEnd(10), r.deep);
}
console.log(`\n${rows.length} 件を確認、${failed} 件が失敗。`);
if (failed) {
  console.error('取得できない URL があります。package.json の版と tools/build.mjs の ESM_SH を確かめてください。');
  process.exit(1);
}
