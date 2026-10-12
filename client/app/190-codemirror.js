/* ------------------------------------------------------------------ *
 *  CodeMirror 6
 * ------------------------------------------------------------------ */

/** 拡張子 → 言語キー。ここに無い拡張子はプレーンテキストで開く。 */
const EXT_TO_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', gs: 'javascript',
  jsx: 'jsx', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  json: 'json', jsonc: 'json', json5: 'json', geojson: 'json',
  html: 'html', htm: 'html', xhtml: 'html', vue: 'html', svelte: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  py: 'python', pyi: 'python',
  yml: 'yaml', yaml: 'yaml',
  sql: 'sql',
  xml: 'xml', svg: 'xml', rss: 'xml', atom: 'xml', plist: 'xml',
  drawio: 'xml', dio: 'xml',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell'
};

/** 言語キー → 表示名と遅延ローダ。開いたときに初めて import する。 */
const LANGUAGES = {
  javascript: { label: 'JavaScript', load: () => Vendor.lang('javascript') },
  jsx:        { label: 'JavaScript (JSX)', load: () => Vendor.lang('javascript', { jsx: true }) },
  typescript: { label: 'TypeScript', load: () => Vendor.lang('javascript', { typescript: true }) },
  tsx:        { label: 'TypeScript (TSX)', load: () => Vendor.lang('javascript', { typescript: true, jsx: true }) },
  json:       { label: 'JSON', load: () => Vendor.lang('json') },
  html:       { label: 'HTML', load: () => Vendor.lang('html') },
  css:        { label: 'CSS', load: () => Vendor.lang('css') },
  markdown:   { label: 'Markdown', load: () => Vendor.lang('markdown') },
  python:     { label: 'Python', load: () => Vendor.lang('python') },
  yaml:       { label: 'YAML', load: () => Vendor.lang('yaml') },
  sql:        { label: 'SQL', load: () => Vendor.lang('sql') },
  xml:        { label: 'XML', load: () => Vendor.lang('xml') },
  shell:      { label: 'Shell', load: () => Vendor.lang('shell') }
};

