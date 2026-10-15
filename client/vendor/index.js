/**
 * client/vendor/index.js — バンドルのエントリ。
 *
 * CodeMirror 6 一式と marked / DOMPurify / fuzzysort を 1 つの ESM に束ね、
 * tools/build.mjs が content-hash 付きで dist/vendor/ に出力する。
 * client/app/200-vendor.js の Vendor.load() はこれを import('vendor') で読む。読めなければ
 * ESM_FALLBACK_ENABLED=true のときだけ esm.sh に落ちる。
 *
 * ここに並べる名前は Vendor.fromEsm() が作るオブジェクトと同じにすること
 * （どちらの経路でも Editor.cm の組み立てが同じコードで済むように）。
 *
 * 言語パッケージは動的 import のまま残す。esbuild の --splitting がチャンクとして
 * 切り出し、必要になった言語だけが読み込まれる（CM6 のコアは同じバンドル内で共有される）。
 * mermaid も同じバンドルに入れるが、数 MB あるので import() で別チャンクに切り出し、
 * ```mermaid のブロックが現れるまで取得しない（起動時間は変わらない）。
 * 以前は esm.sh から読んでいたが、ブラウザは Drive フルスコープのトークンを持つので、
 * 第三者 CDN のコードを実行経路に入れないために自前の配信元へ寄せた（SRI も付けられる）。
 */

export { basicSetup } from 'codemirror';
export { EditorState, EditorSelection, Compartment, Annotation, Transaction, Prec } from '@codemirror/state';
export { EditorView, keymap } from '@codemirror/view';
export { indentWithTab, undo, redo } from '@codemirror/commands';
export { search, gotoLine, openSearchPanel } from '@codemirror/search';
export { indentUnit, syntaxHighlighting, HighlightStyle, StreamLanguage } from '@codemirror/language';
export { tags } from '@lezer/highlight';
export { indentationMarkers } from '@replit/codemirror-indentation-markers';

import { StreamLanguage } from '@codemirror/language';

/** 言語サポートのローダ。キーは client/app/190-codemirror.js の LANGUAGES と対応する。 */
export const langs = {
  javascript: (o) => import('@codemirror/lang-javascript').then((m) => m.javascript(o || {})),
  json:       () => import('@codemirror/lang-json').then((m) => m.json()),
  html:       () => import('@codemirror/lang-html').then((m) => m.html()),
  css:        () => import('@codemirror/lang-css').then((m) => m.css()),
  markdown:   () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  python:     () => import('@codemirror/lang-python').then((m) => m.python()),
  yaml:       () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  sql:        () => import('@codemirror/lang-sql').then((m) => m.sql()),
  xml:        () => import('@codemirror/lang-xml').then((m) => m.xml()),
  shell:      () => import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell))
};

/**
 * 比較ビュー（@codemirror/merge）。比較を開いたときに初めて読み込む。
 * 依存（state / view / language / @lezer/highlight）はこのバンドルに入っているので、
 * 切り出されるチャンクは merge 自身のぶん（約 30KB）だけになる。
 */
export const loadMerge = () => import('@codemirror/merge');

/** プレビュー・パレット用。使う場面になって初めて読み込む。 */
export const loadMarked = () => import('marked');
export const loadDompurify = () => import('dompurify');
export const loadFuzzysort = () => import('fuzzysort');
export const loadMermaid = () => import('mermaid');
