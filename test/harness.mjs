/**
 * test/harness.mjs — ファイルを分けずに、src の中の純粋な関数を取り出して試すための足場。
 *
 * クライアント（client/app/*.js を連結した src/js.html）は <script type="module"> 1 枚で、
 * ファイル同士が 1 つのスコープを共有しているので、1 ファイルだけを import できる形になっていない。そこで acorn で構文木を作り、名前で指定した
 * トップレベルの宣言（function / class / const）だけを切り出して vm で評価する。
 * 文字列の検索ではなく構文木で切るので、関数の中身が変わっても壊れない。
 *
 * サーバー（src/*.gs）は GAS と同じく全ファイルを 1 つのグローバルに流し込む。
 * トップレベルでは宣言しかしていないので、GAS のサービスはスタブ無しでも読み込める
 * （関数を呼んだときに必要なものだけ context で渡す）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as acorn from 'acorn';
import { assembleSource } from '../tools/build-app.mjs';
import { TextCodec } from '../client/lib/text-codec.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** クライアントのモジュールスクリプトの中身（client/app/*.js を連結したもの）。 */
export function clientSource() {
  return assembleSource();
}

/** トップレベルの宣言名 → ソース。 */
function topLevelDecls(src) {
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
  const out = new Map();
  for (const node of ast.body) {
    if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) {
      out.set(node.id.name, src.slice(node.start, node.end));
    } else if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        if (d.id.type === 'Identifier') out.set(d.id.name, node.kind + ' ' + src.slice(d.start, d.end) + ';');
      }
    }
  }
  return out;
}

/**
 * クライアントの宣言を名前で取り出し、1 つの vm で評価して返す。
 * @param {string[]} names 依存するもの（TermError など）も並べる
 * @param {Object} [globals] window などのスタブ
 * @return {Object} name → 値
 */
export function loadClient(names, globals = {}) {
  const decls = topLevelDecls(clientSource());
  const parts = names.map((n) => {
    if (!decls.has(n)) throw new Error('client/app にトップレベルの宣言がありません: ' + n);
    return decls.get(n);
  });
  const ctx = vm.createContext(Object.assign({}, globals));
  vm.runInContext(parts.join('\n') + '\n;globalThis.__out = {' + names.join(',') + '};', ctx);
  return ctx.__out;
}

/**
 * サーバーの .gs を GAS と同じく 1 つのグローバルに読み込む。
 * @param {Object} [globals] Utilities / PropertiesService などのスタブ
 * @return {Object} vm の context（DriveService などがそのまま見える）
 */
export function loadServer(globals = {}, opts = {}) {
  const ctx = vm.createContext(Object.assign({ console }, globals));
  const dir = join(root, 'src');
  const files = readdirSync(dir).filter((x) => x.endsWith('.gs')).sort();
  // GAS は読み込む順を決められないので、テストでは逆順でも試せるようにしておく。
  if (opts.reverse) files.reverse();
  for (const f of files) {
    vm.runInContext(readFileSync(join(dir, f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

/* ---- GAS の Blob / Utilities のスタブ（文字コードの試験用） ---- */

/** Apps Script のバイト列（符号付き）にする。 */
export const signed = (u8) => Array.from(u8, (b) => (b > 127 ? b - 256 : b));
export const unsigned = (arr) => Uint8Array.from(arr, (b) => b & 0xff);

/**
 * Blob のスタブ。getDataAsString は Java と同じく BOM を残し、壊れた所は U+FFFD にする。
 * Windows-31J は WHATWG の shift_jis（中身は Windows-31J 相当）で代用する。
 */
export function fakeBlob(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : unsigned(bytes);
  return {
    getBytes: () => signed(u8),
    getDataAsString: (cs) => {
      if (!cs || /^utf-?8$/i.test(cs)) return new TextDecoder('utf-8', { ignoreBOM: true }).decode(u8);
      if (cs === 'Windows-31J') return new TextDecoder('shift_jis').decode(u8);
      throw new Error('unsupported charset ' + cs);
    },
    setDataFromString(text, cs) {
      if (cs !== 'Windows-31J') throw new Error('unsupported charset ' + cs);
      return fakeBlob(TextCodec.encode(text, TextCodec.SJIS));
    }
  };
}
export const gasUtilities = {
  newBlob: (data) => fakeBlob(typeof data === 'string' ? new TextEncoder().encode(data) : unsigned(data)),
  getUuid: () => '00000000-0000-0000-0000-000000000000'
};
