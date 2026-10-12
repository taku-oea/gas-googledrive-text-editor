/**
 * tools/build-app.mjs — client/app/*.js と client/lib/*.js から src/js.html を作る。
 *
 *   npm run build:app             src/js.html を書き出す
 *   npm run build:app -- --check  書き出さず、src/js.html が今のソースと一致するかだけ見る
 *
 * クライアントは GAS の HtmlService が配る <script type="module"> 1 枚で動く。
 * もとは 1.7 万行の 1 ファイルだったものを、次の 2 種類に分けて持っている。
 *
 *   client/lib/*.js  本物の ES モジュール（import / export）。依存の無い純粋な部分から順に移している。
 *                    テストからも直接 import できる
 *   client/app/*.js  まだモジュールにしていない部分。ファイル名の番号順に「そのまま」つなぎ、
 *                    全ファイルが 1 つのスコープを共有する（分割前と同じ動き）
 *
 * 生成物では lib を依存の順に並べ、`import` 行と `export` の語だけを外して client/app の前に置く。
 * コードそのものは 1 文字も書き換えない（esbuild でまとめるとトップレベルの const / class が
 * var に変わるため、あえて使っていない）。client/app からは lib の関数を今までと同じ名前で呼べる。
 * 全体が 1 つのスコープになるので、トップレベルの名前が重なったらここで止める。
 *
 * そのため lib で使える書き方は次だけに絞っている（それ以外はビルドが止める）。
 *   import { a, b } from './x.js';            lib 同士の import
 *   export function / class / const / let      宣言にじかに付ける export
 * （default export・export { a as b }・import * as・外部パッケージの import は使えない。
 *   vendor や mermaid は今までどおり client/app から import() で読む）
 *
 * client/app の番号は 10 刻みにしてあるので、あいだにファイルを足すときは 015 のように挟む。
 * 並び順は評価順でもある。トップレベルで実行される文（イベント配線など）は、
 * 使う宣言より後ろのファイルに置くこと。
 *
 * src/js.html は生成物で git には入れない（.gitignore）。clasp push の前に必ず作る
 * （npm run push がこれ → check → test → clasp push を順に行う）。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = join(root, 'client', 'app');
const LIB_DIR = join(root, 'client', 'lib');
const OUT = join(root, 'src', 'js.html');

/** 連結する順のファイル名。 */
export function appFiles() {
  return readdirSync(APP_DIR).filter((f) => /^\d{3}-[a-z0-9-]+\.js$/.test(f)).sort();
}

/** client/lib のファイル名。 */
export function libFiles() {
  return existsSync(LIB_DIR) ? readdirSync(LIB_DIR).filter((f) => f.endsWith('.js')).sort() : [];
}

/**
 * lib 1 本を読み、import 先・export 名と、import / export を外した本文を返す。
 * @param {string} file
 * @return {{file:string, deps:string[], names:string[], body:string}}
 */
function readLib(file) {
  const src = readFileSync(join(LIB_DIR, file), 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
  const deps = [];
  const names = [];
  const cuts = [];   // [start, end, 置き換え]
  const bad = (n, why) => new Error(`client/lib/${file}: ${why}（${src.slice(n.start, Math.min(n.end, n.start + 60))}）`);
  for (const n of ast.body) {
    if (n.type === 'ImportDeclaration') {
      const from = n.source.value;
      if (!/^\.\/[a-z0-9-]+\.js$/.test(from)) throw bad(n, 'lib からは同じフォルダの lib しか import できません');
      if (n.specifiers.some((sp) => sp.type !== 'ImportSpecifier' || sp.imported.name !== sp.local.name)) {
        throw bad(n, 'import { a } の形だけ使えます（as・default・* は不可）');
      }
      deps.push(from.slice(2));
      let end = n.end;
      if (src[end] === '\n') end++;
      cuts.push([n.start, end, '']);
    } else if (n.type === 'ExportNamedDeclaration') {
      if (!n.declaration) throw bad(n, 'export は宣言にじかに付けてください');
      const d = n.declaration;
      if (d.type === 'VariableDeclaration') for (const v of d.declarations) names.push(v.id.name);
      else names.push(d.id.name);
      cuts.push([n.start, d.start, '']);
    } else if (n.type === 'ExportDefaultDeclaration' || n.type === 'ExportAllDeclaration') {
      throw bad(n, 'default export / export * は使えません');
    }
  }
  let body = src;
  for (const [a, b, rep] of cuts.sort((x, y) => y[0] - x[0])) body = body.slice(0, a) + rep + body.slice(b);
  return { file, deps, names, body };
}

/** lib を依存の順に（import 先が先）。循環していたら止める。 */
function orderedLibs() {
  const libs = new Map(libFiles().map((f) => [f, readLib(f)]));
  const out = [];
  const state = new Map();   // 1 = 訪問中, 2 = 済み
  const visit = (f, trail) => {
    if (!libs.has(f)) throw new Error(`client/lib/${trail[trail.length - 1]}: import 先がありません: ${f}`);
    if (state.get(f) === 2) return;
    if (state.get(f) === 1) throw new Error('client/lib の import が循環しています: ' + trail.concat(f).join(' → '));
    state.set(f, 1);
    for (const d of libs.get(f).deps) visit(d, trail.concat(f));
    state.set(f, 2);
    out.push(libs.get(f));
  };
  for (const f of libs.keys()) visit(f, []);
  return out;
}

/** 生成物のモジュールスクリプトの中身（lib → app の順）。 */
export function assembleSource() {
  const lib = orderedLibs().map((l) => `/* ==== client/lib/${l.file} ==== */\n` + l.body.replace(/\n*$/, '\n\n')).join('');
  return lib + appFiles().map((f) => readFileSync(join(APP_DIR, f), 'utf8')).join('');
}

/**
 * assembleSource() の行番号 → 元のファイルと行。構文エラーの位置を元のファイルで示すため。
 * （lib の部分は import 行を外しているので、行番号は数行ずれることがある）
 * @param {number} line 1 始まり
 * @return {{file:string, line:number}}
 */
export function locate(line) {
  let base = 0;
  for (const l of orderedLibs()) {
    const n = (`/* ==== client/lib/${l.file} ==== */\n` + l.body.replace(/\n*$/, '\n\n')).split('\n').length - 1;
    if (line <= base + n) return { file: 'client/lib/' + l.file, line: line - base - 1 };
    base += n;
  }
  for (const f of appFiles()) {
    const n = readFileSync(join(APP_DIR, f), 'utf8').split('\n').length - 1;
    if (line <= base + n) return { file: 'client/app/' + f, line: line - base };
    base += n;
  }
  return { file: '(末尾)', line };
}

/** トップレベルの名前が重なっていないか（1 つのスコープに並べるので）。 */
function assertUniqueNames(code) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  } catch (e) {
    // 構文エラー（名前の重なりもここで出る）を元のファイルの位置で示す。
    if (!e.loc) throw e;
    const at = locate(e.loc.line);
    throw new Error(`${at.file}:${at.line}:${e.loc.column + 1}: ${e.message.replace(/\s*\(\d+:\d+\)$/, '')}`);
  }
  const seen = new Map();
  for (const n of ast.body) {
    const names = n.type === 'VariableDeclaration' ? n.declarations.map((d) => d.id.name)
      : (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id ? [n.id.name] : [];
    for (const nm of names) {
      if (seen.has(nm)) {
        const a = locate(seen.get(nm));
        const b = locate(n.loc.start.line);
        throw new Error(`トップレベルの名前が重なっています: ${nm}（${a.file}:${a.line} と ${b.file}:${b.line}）`);
      }
      seen.set(nm, n.loc.start.line);
    }
  }
}

/** src/js.html の全体。 */
export function buildHtml() {
  const code = assembleSource();
  assertUniqueNames(code);
  // HtmlService のテンプレートとして評価されるので、"<?" が紛れていたら止める。
  if (code.indexOf('<?') >= 0) throw new Error('生成物に "<?" が含まれています（HtmlService のスクリプトレットとして解釈される）');
  if (/<\/script/i.test(code)) throw new Error('生成物に "</script" が含まれています');
  return '<!-- tools/build-app.mjs が client/lib と client/app から生成する。手で編集しない。 -->\n' +
    '<script type="module">\n' + code + '</script>\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let html;
  try {
    html = buildHtml();
  } catch (e) {
    console.error('✖ ' + e.message);
    process.exit(1);
  }
  if (process.argv.includes('--check')) {
    const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
    if (cur !== html) {
      console.error('✖ src/js.html が今のソースと一致しません（npm run build:app で作り直す）');
      process.exit(1);
    }
    console.log('✔ src/js.html は今のソースと一致');
  } else {
    writeFileSync(OUT, html);
    console.log(`src/js.html: lib ${libFiles().length} 本 + app ${appFiles().length} ファイル（${Buffer.byteLength(html)} バイト）`);
  }
}
