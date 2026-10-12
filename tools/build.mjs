/**
 * tools/build.mjs — CodeMirror 等のバンドルを作る。
 *
 *   npm run build            dist/vendor/ に vendor.<hash>.js と chunks/ を出す（VENDOR_BASE_URL の配信先に置く）
 *   npm run build -- --apply 上に加えて src/importmap.html の vendor:begin〜end を書き換える
 *   npm run build:inline     src/vendor.html（IIFE を <script> で包んだもの）を出す（GAS 同梱用）
 *
 * 配信先の URL は環境変数 VENDOR_BASE_URL（既定: https://assets.oea.jp/apps/editor/vendor）。
 * ファイル名に content-hash が入るので、配信先では Cache-Control: immutable で置ける。
 *
 * 出力した全ファイル（エントリ・起動用チャンク・遅延チャンク）の SHA-384 を
 * import map の "integrity" と modulepreload の integrity 属性に書き込む（SRI）。
 * ブラウザは Drive フルスコープのトークンを持つので、配信元の中身が差し替えられたら
 * 実行させずに止めるためのもの。配信先に置いたファイルと build の出力が 1 バイトでも
 * 違えば読み込みに失敗するので、--apply の後は必ず dist/vendor/ をそのまま配信先へ上げる。
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const BASE_URL = (process.env.VENDOR_BASE_URL || 'https://assets.oea.jp/apps/editor/vendor').replace(/\/$/, '');

/** src/importmap.html の import map（esm.sh 側はフォールバック用に残す）。 */
const ESM_SH = {
  '@lezer/common': 'https://esm.sh/@lezer/common@1.5.2',
  '@lezer/highlight': 'https://esm.sh/@lezer/highlight@1.2.3?external=@lezer/common',
  '@lezer/lr': 'https://esm.sh/@lezer/lr@1.4.10?external=@lezer/common',
  '@codemirror/state': 'https://esm.sh/@codemirror/state@6.7.4',
  '@codemirror/view': 'https://esm.sh/@codemirror/view@6.43.11?external=@codemirror/state',
  '@codemirror/language': 'https://esm.sh/@codemirror/language@6.12.4?external=@codemirror/state,@codemirror/view,@lezer/common,@lezer/highlight,@lezer/lr',
  '@codemirror/commands': 'https://esm.sh/@codemirror/commands@6.11.0?external=@codemirror/state,@codemirror/view,@codemirror/language,@lezer/common',
  '@codemirror/search': 'https://esm.sh/@codemirror/search@6.7.2?external=@codemirror/state,@codemirror/view',
  '@codemirror/autocomplete': 'https://esm.sh/@codemirror/autocomplete@6.20.3?external=@codemirror/state,@codemirror/view,@codemirror/language,@lezer/common',
  '@codemirror/lint': 'https://esm.sh/@codemirror/lint@6.9.7?external=@codemirror/state,@codemirror/view',
  '@codemirror/merge': 'https://esm.sh/@codemirror/merge@6.12.2?external=@codemirror/state,@codemirror/view,@codemirror/language,@lezer/common,@lezer/highlight',
  'codemirror': 'https://esm.sh/codemirror@6.0.2?external=@codemirror/state,@codemirror/view,@codemirror/language,@codemirror/commands,@codemirror/search,@codemirror/autocomplete,@codemirror/lint,@lezer/common,@lezer/highlight,@lezer/lr',
  '@codemirror/lang-javascript': 'https://esm.sh/@codemirror/lang-javascript@6.2.5?external=@codemirror/state,@codemirror/view,@codemirror/language,@codemirror/autocomplete,@lezer/common,@lezer/highlight,@lezer/lr',
  '@codemirror/lang-json': 'https://esm.sh/@codemirror/lang-json@6.0.2?external=@codemirror/state,@codemirror/view,@codemirror/language,@codemirror/autocomplete,@lezer/common,@lezer/highlight,@lezer/lr',
  '@codemirror/lang-css': 'https://esm.sh/@codemirror/lang-css@6.3.1?external=@codemirror/state,@codemirror/view,@codemirror/language,@codemirror/autocomplete,@lezer/common,@lezer/highlight,@lezer/lr',
  '@codemirror/lang-html': 'https://esm.sh/@codemirror/lang-html@6.4.12?external=@codemirror/state,@codemirror/view,@codemirror/language,@codemirror/autocomplete,@lezer/common,@lezer/highlight,@lezer/lr,@codemirror/lang-css,@codemirror/lang-javascript',
  '@codemirror/lang-markdown': 'https://esm.sh/@codemirror/lang-markdown@6.5.2?external=@codemirror/state,@codemirror/view,@codemirror/language,@codemirror/autocomplete,@lezer/common,@lezer/highlight,@lezer/lr,@codemirror/lang-css,@codemirror/lang-html,@codemirror/lang-javascript',
  '@codemirror/lang-python': 'https://esm.sh/@codemirror/lang-python@6.2.1?external=@codemirror/state,@codemirror/view,@codemirror/language,@codemirror/autocomplete,@lezer/common,@lezer/highlight,@lezer/lr',
  '@codemirror/lang-yaml': 'https://esm.sh/@codemirror/lang-yaml@6.1.3?external=@codemirror/state,@codemirror/view,@codemirror/language,@codemirror/autocomplete,@lezer/common,@lezer/highlight,@lezer/lr',
  '@codemirror/lang-sql': 'https://esm.sh/@codemirror/lang-sql@6.10.0?external=@codemirror/state,@codemirror/view,@codemirror/language,@codemirror/autocomplete,@lezer/common,@lezer/highlight,@lezer/lr',
  '@codemirror/lang-xml': 'https://esm.sh/@codemirror/lang-xml@6.1.0?external=@codemirror/state,@codemirror/view,@codemirror/language,@codemirror/autocomplete,@lezer/common,@lezer/highlight,@lezer/lr',
  '@codemirror/legacy-modes/': 'https://esm.sh/@codemirror/legacy-modes@6.5.4/',
  '@replit/codemirror-indentation-markers': 'https://esm.sh/@replit/codemirror-indentation-markers@6.5.3?external=@codemirror/state,@codemirror/view,@codemirror/language',
  'marked': 'https://esm.sh/marked@18.0.12',
  'dompurify': 'https://esm.sh/dompurify@3.4.15',
  'mermaid': 'https://esm.sh/mermaid@12.0.0',
  'fuzzysort': 'https://esm.sh/fuzzysort@4.0.2'
};

/** SRI の値（sha384-<base64>）。 */
function sri(path) {
  return 'sha384-' + createHash('sha384').update(readFileSync(path)).digest('base64');
}

function human(n) { return n >= 1024 * 1024 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB'; }

async function buildBundle() {
  const outdir = join(root, 'dist', 'vendor');
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  const result = await build({
    entryPoints: { vendor: join(root, 'client/vendor/index.js') },
    bundle: true,
    format: 'esm',
    splitting: true,
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    outdir,
    entryNames: '[name].[hash]',
    chunkNames: 'chunks/[name].[hash]',
    metafile: true,
    logLevel: 'warning'
  });
  const outputs = Object.entries(result.metafile.outputs);
  const entry = outputs.find(([, o]) => o.entryPoint && o.entryPoint.endsWith('client/vendor/index.js'));
  if (!entry) throw new Error('エントリの出力が見つかりません');
  const entryFile = entry[0].replace(/^dist\/vendor\//, '');
  // エントリが静的に import するチャンク（起動時に必ず要るもの）。modulepreload で同時に取らせる。
  const startup = (entry[1].imports || [])
    .filter((i) => i.kind === 'import-statement' && !i.external)
    .map((i) => i.path.replace(/^dist\/vendor\//, ''));
  const files = outputs.map(([f, o]) => ({
    file: f.replace(/^dist\/vendor\//, ''),
    bytes: o.bytes,
    integrity: sri(join(root, f))
  }));
  writeFileSync(join(outdir, 'manifest.json'), JSON.stringify({
    entry: entryFile, startup, baseUrl: BASE_URL, builtAt: new Date().toISOString(), files
  }, null, 2) + '\n');
  console.log(`  startup preload: ${startup.join(', ') || '(none)'}`);
  const total = files.reduce((s, f) => s + f.bytes, 0);
  console.log(`dist/vendor: ${files.length} files, ${human(total)} total`);
  console.log(`  entry: ${entryFile} (${human(entry[1].bytes)})`);
  for (const f of files.filter((x) => x.file !== entryFile).sort((a, b) => b.bytes - a.bytes)) {
    console.log(`  ${f.file} (${human(f.bytes)})`);
  }
  return { entryFile, startup, files };
}

/**
 * ESM_SH を import map に残すか。既定は残す（中身は URL の文字列だけで、
 * js.html の Vendor.load() は doGet が ESM_FALLBACK_ENABLED=true を渡したときしか
 * esm.sh を import しない）。--no-esm-fallback を付けると項目ごと外す。
 */
const WITH_ESM = !args.has('--no-esm-fallback');

/** src/importmap.html の vendor:begin〜vendor:end を書き換える。 */
function applyImportMap(entryFile, startup, files) {
  const path = join(root, 'src', 'importmap.html');
  const html = readFileSync(path, 'utf8');
  const begin = html.indexOf('<!-- vendor:begin');
  const end = html.indexOf('<!-- vendor:end -->');
  if (begin < 0 || end < 0) throw new Error('src/importmap.html に vendor:begin / vendor:end のマーカーが無い');
  const vendorUrl = `${BASE_URL}/${entryFile}`;
  const imports = Object.assign({ vendor: vendorUrl }, WITH_ESM ? ESM_SH : {});
  // 遅延チャンク（言語・merge・mermaid）も相対 import で解決された URL で照合されるので、全部載せる。
  const integrity = {};
  for (const f of files) {
    if (f.file.endsWith('.js')) integrity[`${BASE_URL}/${f.file}`] = f.integrity;
  }
  const sriOf = (file) => files.find((x) => x.file === file).integrity;
  const generated =
    `<!-- vendor:begin（tools/build.mjs が生成する。手で編集しない） -->\n` +
    `<link rel="preconnect" href="${new URL(vendorUrl).origin}" crossorigin>\n` +
    `<script type="importmap">\n${JSON.stringify({ imports, integrity }, null, 2)}\n</script>\n` +
    [entryFile].concat(startup || [])
      .map((f) => `<link rel="modulepreload" href="${BASE_URL}/${f}" integrity="${sriOf(f)}" crossorigin>`)
      .join('\n') + '\n';
  writeFileSync(path, html.slice(0, begin) + generated + html.slice(end));
  console.log(`src/importmap.html: vendor → ${vendorUrl}`);
}

/** GAS に同梱する版。IIFE を <script> で包み、window.VENDOR に置く。言語は全部入り。 */
async function buildInline() {
  const result = await build({
    entryPoints: [join(root, 'client/vendor/index.js')],
    bundle: true,
    format: 'iife',
    globalName: 'VENDOR',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    write: false,
    external: ['mermaid'],
    logLevel: 'warning'
  });
  const code = result.outputFiles[0].text;
  // 同梱版では動的 import はバンドル内に畳み込まれるので、langs のローダはそのまま動く。
  const html =
    `<!-- tools/build.mjs --inline が生成する。手で編集しない。 -->\n` +
    `<script>\n${code}\n</script>\n`;
  writeFileSync(join(root, 'src', 'vendor.html'), html);
  console.log(`src/vendor.html: ${human(Buffer.byteLength(html))}`);
}

if (args.has('--inline')) {
  await buildInline();
} else {
  const { entryFile, startup, files } = await buildBundle();
  if (args.has('--apply')) applyImportMap(entryFile, startup, files);
}
