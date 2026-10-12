/**
 * client/lib/cm-theme.js — CodeMirror の配色・日本語の文言（テーマを組み立てる関数と表）。
 *
 * 依存の無い純粋な部分を client/app から切り出した ES モジュール。
 * client/app 側からは tools/build-app.mjs がつなぐので、同じ名前のまま参照できる。
 */

/*
 * VS Code Dark Modern / Light Modern に合わせたエディタテーマ。
 *
 * 既製のテーマパッケージ（@fsegurai/... など）を使わず自作しているのは、
 * それらが @codemirror/view や @lezer/highlight を取り込むため、
 * import map での外部化を 1 つ間違えるとコアが二重になって
 * "Unrecognized extension value" で壊れるリスクを増やすことになるから。
 * 色の値は VS Code のテーマ定義（dark_modern / dark_plus と
 * light_modern / light_plus）から取っている。
 *
 * ライトとダークの切り替えは Editor.themeCompartment の差し替えで行う
 * （Editor.setTheme）。CSS 変数にしていないのは、CM6 のテーマが
 * StyleModule 経由で実際の色の値を要求するため。
 */
export const CM_UI = {
  dark: {
    bg: '#1f1f1f',
    fg: '#cccccc',
    caret: '#aeafad',
    selection: '#264f78',
    selectionMatch: '#3a3d41',
    // 選択範囲より下のレイヤーに描かれるので、不透明にすると選択が隠れる（下の
    // cmTheme のコメント参照）。#1f1f1f の上で #282828 になる半透明にしておく。
    lineHighlight: 'rgba(255, 255, 255, .042)',
    gutterFg: '#6e7681',
    gutterActiveFg: '#cccccc',
    panel: '#181818',
    border: '#2b2b2b',
    bracketOutline: '#888888',
    searchMatch: '#623315',
    searchMatchSelected: '#9e6a03',
    pickBg: '#04395e',
    pickFg: '#ffffff'
  },
  light: {
    bg: '#ffffff',
    fg: '#3b3b3b',
    caret: '#000000',
    selection: '#add6ff',
    selectionMatch: '#d5e8ff',
    lineHighlight: 'rgba(0, 0, 0, .035)',
    gutterFg: '#6e7681',
    gutterActiveFg: '#171184',
    panel: '#f8f8f8',
    border: '#e5e5e5',
    bracketOutline: '#b9b9b9',
    searchMatch: '#ffe9a8',
    searchMatchSelected: '#ffcc66',
    pickBg: '#cfe4f7',
    pickFg: '#17181a'
  }
};

/** トークンの色。VS Code の Dark+ / Light+ と同じ値。 */
export const CM_TOKENS = {
  dark: {
    comment: '#6a9955',
    string: '#ce9178',
    number: '#b5cea8',
    regexp: '#d16969',
    escape: '#d7ba7d',
    // 制御構文（if / for / return）だけ紫。VS Code の特徴的な部分。
    control: '#c586c0',
    keyword: '#569cd6',
    type: '#4ec9b0',
    func: '#dcdcaa',
    variable: '#9cdcfe',
    constant: '#4fc1ff',
    punct: '#cccccc',
    tag: '#569cd6',
    attr: '#9cdcfe',
    heading: '#569cd6',
    link: '#4fc1ff',
    meta: '#9d9d9d',
    invalid: '#f14c4c'
  },
  light: {
    comment: '#008000',
    string: '#a31515',
    number: '#098658',
    regexp: '#811f3f',
    escape: '#ee0000',
    control: '#af00db',
    keyword: '#0000ff',
    type: '#267f99',
    func: '#795e26',
    variable: '#001080',
    constant: '#0070c1',
    punct: '#3b3b3b',
    tag: '#800000',
    attr: '#e50000',
    heading: '#0000ff',
    link: '#0070c1',
    meta: '#616161',
    invalid: '#cd3131'
  }
};

/**
 * UI 側（背景・カーソル・選択・ガター）の見た目。
 *
 * 選択範囲は CM6 の drawSelection が z-index:-1 のレイヤー（.cm-selectionLayer）に
 * 描くので、.cm-line 側に不透明な背景を置くと選択が完全に隠れてしまう。
 * CM の既定値 (#99eeff33) に alpha が入っているのはこのため。
 * ここでも行ハイライトは半透明にし、さらに選択中は消している。
 *
 * @param {Object} EditorView
 * @param {'light'|'dark'} mode
 */
export function cmTheme(EditorView, mode) {
  const c = CM_UI[mode] || CM_UI.dark;
  return EditorView.theme({
    // フォントサイズは CSS 変数にしておき、設定から差し替えられるようにする。
    '&': { color: c.fg, backgroundColor: c.bg },
    '.cm-scroller': { fontSize: 'var(--editor-font-size, 12.5px)' },
    '.cm-content': { caretColor: c.caret },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: c.caret, borderLeftWidth: '2px' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: c.selection
    },
    '.cm-selectionMatch': { backgroundColor: c.selectionMatch },
    '.cm-activeLine': { backgroundColor: c.lineHighlight },
    // VS Code は選択中に現在行のハイライトを描かない。同じ挙動にしておくと
    // 選択色が全行で揃う（クラスは下の cmHasSelection で付けている）。
    '&.cm-hasSelection .cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-gutters': {
      backgroundColor: c.bg,
      color: c.gutterFg,
      border: 'none'
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: c.gutterActiveFg },
    '.cm-foldPlaceholder': {
      backgroundColor: 'transparent',
      border: 'none',
      color: c.gutterFg
    },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
      backgroundColor: 'transparent',
      outline: '1px solid ' + c.bracketOutline
    },
    '.cm-searchMatch': { backgroundColor: c.searchMatch },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: c.searchMatchSelected },
    '.cm-tooltip': {
      backgroundColor: c.panel,
      border: '1px solid ' + c.border,
      color: c.fg
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: c.pickBg,
      color: c.pickFg
    }
  }, { dark: mode === 'dark' });
}

/**
 * @param {Object} HighlightStyle
 * @param {Object} t @lezer/highlight の tags
 * @param {'light'|'dark'} mode
 */
export function cmHighlightStyle(HighlightStyle, t, mode) {
  const c = CM_TOKENS[mode] || CM_TOKENS.dark;
  return HighlightStyle.define([
    { tag: t.comment, color: c.comment, fontStyle: 'italic' },
    { tag: [t.string, t.special(t.string)], color: c.string },
    { tag: [t.number, t.bool, t.null], color: c.number },
    { tag: t.regexp, color: c.regexp },
    { tag: t.escape, color: c.escape },

    { tag: t.controlKeyword, color: c.control },
    { tag: [t.keyword, t.modifier, t.self, t.moduleKeyword], color: c.keyword },
    { tag: [t.operatorKeyword, t.definitionKeyword], color: c.keyword },

    { tag: [t.typeName, t.className, t.namespace], color: c.type },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: c.func },
    { tag: [t.variableName, t.propertyName, t.attributeValue], color: c.variable },
    { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: c.constant },
    { tag: t.definition(t.variableName), color: c.variable },

    { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: c.punct },
    { tag: [t.tagName, t.angleBracket], color: c.tag },
    { tag: t.attributeName, color: c.attr },

    { tag: t.heading, color: c.heading, fontWeight: 'bold' },
    { tag: t.link, color: c.link, textDecoration: 'underline' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strong, fontWeight: 'bold' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: t.quote, color: c.comment },
    { tag: [t.meta, t.processingInstruction], color: c.meta },
    { tag: t.invalid, color: c.invalid }
  ]);
}

/**
 * 検索パネル等の UI 文字列。キーは各パッケージが state.phrase(...) に渡す
 * 英語リテラルそのもの（実ソースから抽出）。キーを間違えると翻訳が当たらない。
 */
export const PHRASES = {
  'Find': '検索',
  'Replace': '置換後',
  'next': '次へ',
  'previous': '前へ',
  'all': 'すべて選択',
  'match case': '大文字小文字を区別',
  'by word': '単語単位',
  'regexp': '正規表現',
  'replace': '置換',
  'replace all': 'すべて置換',
  'close': '閉じる',
  'current match': '現在の一致',
  'replaced $ matches': '$ 件を置換しました',
  'replaced match on line $': '$ 行目を置換しました',
  'Go to line': '行へ移動',
  'go': '移動',
  'on line': '行目',
  'Completions': '入力候補',
  'folded code': '折りたたまれたコード',
  'unfold': '展開',
  'Control character': '制御文字',
  // 比較ビュー（@codemirror/merge）。$ は件数に置き換わる。
  '$ unchanged lines': '同じ行が $ 行',
  'Accept': '取り込む',
  'Reject': '戻す'
};

/**
 * 空でない選択が 1 つでもあれば .cm-hasSelection を付ける。テーマ側の
 * セレクタから参照するだけなので、state を書き換えずに済む。
 * テーマを差し替えても変わらないので compartment の外に置く。
 */
export function cmHasSelection(EditorView) {
  return EditorView.editorAttributes.compute(['selection'], (state) =>
    state.selection.ranges.some((range) => !range.empty) ? { class: 'cm-hasSelection' } : null);
}
