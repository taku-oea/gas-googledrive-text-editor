/**
 * client/lib/preview-policy.js — プレビューの安全設定（sandbox・DOMPurify・外部 URL の判定）。
 *
 * 依存の無い純粋な部分を client/app から切り出した ES モジュール。
 * client/app 側からは tools/build-app.mjs が生成する import で同じ名前のまま参照できる。
 */

/**
 * HTML プレビューの sandbox。どちらも allow-same-origin は付けない（opaque origin のまま）。
 * STATIC は何も許さない既定。SCRIPTS はバーから明示的に選んだときだけ使う。
 */
export const PREVIEW_SANDBOX_STATIC = '';

export const PREVIEW_SANDBOX_SCRIPTS = 'allow-scripts allow-modals allow-forms allow-popups';

/**
 * Markdown の DOMPurify 設定。描く先はアプリ本体の DOM なので、HTML プロファイルから
 * さらに、画面全体に効く <style> と、送信先を持てる入力部品（form など）を外す。
 * チェックリストの <input type="checkbox"> は form が無ければ送れないので残す。
 */
export const MD_PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'textarea', 'select', 'button']
};

/**
 * mermaid の SVG の DOMPurify 設定。図の色は svg 内の <style>、ラベルは
 * foreignObject 内の HTML で描かれるので、その 2 つは残す（script や javascript: は落ちる）。
 */
export const MERMAID_PURIFY = {
  USE_PROFILES: { svg: true, svgFilters: true, html: true },
  ADD_TAGS: ['foreignObject', 'style'],
  HTML_INTEGRATION_POINTS: { foreignobject: true }
};

/**
 * mermaid の initialize に渡す secure（%%{init: ...}%% や frontmatter の config: で
 * 書き換えられない項目）。mermaid の既定の一覧に、CSS へそのまま入る項目を足している。
 *   themeCSS        図の <style> に入る任意の CSS
 *   themeVariables  色やフォントの値。<style> の各所に埋め込まれる
 *   *FontFamily     font-family の値として <style> や style 属性に入る（C4・sequence などの図ごとの設定も）
 * mermaid はこの一覧を設定の入れ子の中まで見て消すので、図ごとの項目も名前だけ並べれば効く。
 * 共有されたファイルの図から、アプリの画面全体に効く CSS を差し込ませないため。
 */
export const MERMAID_SECURE = [
  'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges',
  'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily',
  'actorFontFamily', 'messageFontFamily', 'noteFontFamily', 'boundaryFontFamily', 'taskFontFamily',
  'titleFontFamily', 'usecaseFontFamily',
  'personFontFamily', 'external_personFontFamily',
  'systemFontFamily', 'system_dbFontFamily', 'system_queueFontFamily',
  'external_systemFontFamily', 'external_system_dbFontFamily', 'external_system_queueFontFamily',
  'containerFontFamily', 'container_dbFontFamily', 'container_queueFontFamily',
  'external_containerFontFamily', 'external_container_dbFontFamily', 'external_container_queueFontFamily',
  'componentFontFamily', 'component_dbFontFamily', 'component_queueFontFamily',
  'external_componentFontFamily', 'external_component_dbFontFamily', 'external_component_queueFontFamily'
];

/** mermaid.render に渡す SVG の id の形（Preview.renderDiagrams の 'mmd-世代-番号-長さ'）。 */
export const MERMAID_ID_RE = /^mmd-\d+-\d+-\d+$/;

/** 外部から取ってくる属性。開いただけで「読んだこと」が外へ伝わるので、既定では止める。 */
export const MD_REMOTE_ATTRS = ['src', 'srcset', 'poster'];

/** data: / blob: / ページ内（#）以外は外部とみなす。 */
export function isRemoteUrl(v) {
  return !/^\s*(?:data:|blob:|#)/i.test(String(v || ''));
}

/** drawio のファイル。中身は XML なのでテキストとして開き、図はプレビューで見る。 */
export const DRAWIO_RE = /\.(?:drawio|dio)(?:\.xml)?$/i;

/**
 * 埋め込みの URL。chrome=0 で編集 UI を出さない（＝読み取り専用）。
 * dark は URL でしか渡せないので、テーマを変えたら読み込み直す（Drawio.reload）。
 */
/** drawio の埋め込み元。送るときの宛先と、受け取るときの送り主の照合に使う。 */
export const DRAWIO_ORIGIN = 'https://embed.diagrams.net';

/**
 * srcdoc を入れ替えると iframe は毎回読み込み直しになり、表示が先頭へ戻る。
 * 中身は sandbox で opaque origin になっていて親から scrollY を読めないので、
 * 末尾に小さなスクリプトを足して
 *   ・読み込み直後に前回の位置へ戻す
 *   ・スクロールしたら親へ位置を知らせる
 * ようにしている。足すのはプレビューへ渡す文字列だけで、保存される本文は変わらない。
 *
 * @param {string} html
 * @param {number} top
 * @return {string}
 */
export function withScrollKeeper(html, top) {
  const keeper = [
    '\n<script>(function () {',
    'var y = ' + (Number(top) || 0) + ', pending = false;',
    // 画像の読み込みで高さが決まるので、戻すのは load のあと。
    'addEventListener("load", function () { scrollTo(0, y); });',
    'addEventListener("scroll", function () {',
    '  if (pending) return;',
    '  pending = true;',
    '  requestAnimationFrame(function () {',
    '    pending = false;',
    '    parent.postMessage({ __preview: "scroll", top: scrollY }, "*");',
    '  });',
    '}, { passive: true });',
    '})();<\/script>\n'
  ].join('');
  return html + keeper;
}

/** SVG で外部を読みに行く要素と属性（mermaid の図の画像・アイコンなど）。 */
export const SVG_REMOTE_TAGS = ['image', 'feImage', 'use'];
export const SVG_REMOTE_ATTRS = ['href', 'xlink:href'];

/**
 * style 属性が外部を読みに行くか。url() の中身が data: / # 以外なら外部とみなす。
 * \ エスケープ（\75rl( で url( と同じになる）と image-set( は中身を見ずに外部扱いにする。
 * @param {string} style
 */
export function styleLoadsRemote(style) {
  const s = String(style || '');
  if (/\\|image-set\s*\(|image\s*\(|src\s*\(/i.test(s)) return true;
  const re = /url\s*\(\s*(['"]?)([^'")]*)/gi;
  for (let m; (m = re.exec(s));) {
    if (isRemoteUrl(m[2])) return true;
  }
  return false;
}

/**
 * 外部の画像・動画・音声の URL と、外部の url() を含む style 属性を data-held-* に退避する。
 * 開いただけで外部へ「読んだこと」が伝わる（トラッキング画像）のを防ぐため。
 * mermaid の SVG の <image> / <use> などの href も同じく止める（戻すときは href に入れる）。
 * @param {ParentNode} root まだ文書に入っていない断片
 */
export function holdRemote(root) {
  for (const node of root.querySelectorAll('img, video, audio, source, [style], ' + SVG_REMOTE_TAGS.join(', '))) {
    for (const attr of MD_REMOTE_ATTRS) {
      const v = node.getAttribute(attr);
      if (v === null || !isRemoteUrl(v)) continue;
      node.setAttribute('data-held-' + attr, v);
      node.removeAttribute(attr);
    }
    if (SVG_REMOTE_TAGS.indexOf(node.localName || '') >= 0) {
      for (const attr of SVG_REMOTE_ATTRS) {
        const v = node.getAttribute(attr);
        if (v === null || !isRemoteUrl(v)) continue;
        node.setAttribute('data-held-href', v);
        node.removeAttribute(attr);
      }
    }
    const style = node.getAttribute('style');
    if (style && styleLoadsRemote(style)) {
      node.setAttribute('data-held-style', style);
      node.removeAttribute('style');
    }
    if (node.tagName === 'IMG' && node.hasAttribute('data-held-src')) {
      node.classList.add('mdimg--held');
      if (!node.getAttribute('alt')) node.setAttribute('alt', '外部の画像');
    }
  }
}

/**
 * mermaid が SVG の <style> に入れる @keyframes の名前。@keyframes は文書全体に効くので、
 * これ以外の名前（アプリ側の spin・toastIn など）を図から上書きさせない。
 */
export const MERMAID_KEYFRAMES = ['dash', 'edge-animation-frame'];

/** 宣言に入っていたら落とすもの。外部の読み込み（url・image-set 等）と、古い IE の式。 */
const MERMAID_CSS_DANGER = /url\s*\(|image(?:-set)?\s*\(|cross-fade\s*\(|element\s*\(|src\s*\(|expression\s*\(|-moz-binding|behavior\s*:|javascript:|@import/i;

/**
 * CSS の文字列・コメントを飛ばしながら 1 文字ずつ読む小さな字句器。
 * 文字列の中の { } ; , ( ) を区切りと取り違えないためだけのもの。
 * @param {string} s
 * @param {number} i 開き引用符の位置
 * @return {number} 閉じ引用符の次の位置（閉じていなければ末尾）
 */
function mermaidCssSkipString(s, i) {
  const q = s.charAt(i);
  for (let j = i + 1; j < s.length; j++) {
    const c = s.charAt(j);
    if (c === '\\') { j++; continue; }
    if (c === q || c === '\n') return j + 1;
  }
  return s.length;
}

/** コメントを空白に置き換える（文字列の中の /* はそのまま）。 */
function mermaidCssStripComments(s) {
  let out = '';
  for (let i = 0; i < s.length;) {
    const c = s.charAt(i);
    if (c === '"' || c === "'") {
      const j = mermaidCssSkipString(s, i);
      out += s.slice(i, j);
      i = j;
    } else if (c === '/' && s.charAt(i + 1) === '*') {
      const end = s.indexOf('*/', i + 2);
      out += ' ';
      i = end < 0 ? s.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * ( ) と文字列の外にある区切り文字で分ける。
 * @param {string} s
 * @param {string} sep 1 文字
 * @return {string[]}
 */
function mermaidCssSplitTop(s, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '"' || c === "'") { i = mermaidCssSkipString(s, i) - 1; continue; }
    if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
    else if (c === sep && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}

/**
 * 1 段ぶんの規則を { head, body } に分ける。body が null なのは ; で終わる文（@import など）。
 * 閉じていないブロックは捨てる（途中で切れた CSS を推測で補わない）。
 * @param {string} s
 * @return {Array<{head:string, body:(string|null)}>}
 */
function mermaidCssItems(s) {
  const items = [];
  let head = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '"' || c === "'") {
      const j = mermaidCssSkipString(s, i);
      head += s.slice(i, j);
      i = j - 1;
    } else if (c === ';') {
      if (head.trim()) items.push({ head: head.trim(), body: null });
      head = '';
    } else if (c === '}') {
      head = '';   // 対応の無い閉じ括弧。そこまでを捨てて読み直す
    } else if (c === '{') {
      let depth = 1;
      let j = i + 1;
      for (; j < s.length && depth; j++) {
        const d = s.charAt(j);
        if (d === '"' || d === "'") { j = mermaidCssSkipString(s, j) - 1; continue; }
        if (d === '{') depth++;
        else if (d === '}') depth--;
      }
      if (depth) return items;
      items.push({ head: head.trim(), body: s.slice(i + 1, j - 1) });
      head = '';
      i = j - 1;
    } else {
      head += c;
    }
  }
  return items;
}

/**
 * セレクタが、その SVG 自身か中の要素だけを指しているか。
 * 「#id」で始まり、id がそこで終わり、最初の結合子が ~ + || でない（＝兄弟や外へ出ない）こと。
 * @param {string} sel カンマで分けたあとの 1 つ
 * @param {string} id
 */
function mermaidSelectorInScope(sel, id) {
  const s = sel.trim();
  const head = '#' + id;
  if (!s.startsWith(head)) return false;
  if (/^[\w-]/.test(s.slice(head.length)) || /[^\x00-\x7f]/.test(s.charAt(head.length))) return false;
  // #id に続く複合セレクタ（.cls や :hover、[attr]、(...)）を飛ばし、最初の結合子を見る。
  let depth = 0;
  let i = head.length;
  for (; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '"' || c === "'") { i = mermaidCssSkipString(s, i) - 1; continue; }
    if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
    else if (depth === 0 && /[\s>~+|]/.test(c)) break;
  }
  const rest = s.slice(i).trimStart();
  return !/^[~+|]/.test(rest);
}

/** 図の中の要素を指す url(#id)（グラデーション・マーカーなど）。読み込みは起きないので残す。 */
const MERMAID_CSS_LOCAL_URL = /url\(\s*(['"]?)#[\w-]*\1\s*\)/gi;

/** 宣言の並びから、外部を読みに行くもの・エスケープを含むものを落とす。 */
function mermaidCssDecls(body) {
  return mermaidCssSplitTop(body, ';')
    .map((d) => d.trim())
    .filter((d) => d && d.indexOf(':') > 0 && !/[\\{}]/.test(d) &&
      !MERMAID_CSS_DANGER.test(d.replace(MERMAID_CSS_LOCAL_URL, '')))
    .join(';');
}

/**
 * mermaid の SVG 内の <style> を、その SVG の中にしか効かない形に絞る（DOMPurify の後に通す）。
 *
 * mermaid は規則に #id を前置するが、%%{init}%% や frontmatter の themeCSS・fontFamily などを
 * 通った CSS が文書全体（タブバー・ダイアログ）を書き換えたり、url() で外へ「読んだこと」を
 * 伝えたりしないよう、ここで改めて確かめる。残すのは次だけ。
 *   ・セレクタがすべて #id で始まり、兄弟（~ +）へ出ない規則
 *   ・@media / @supports の中の、同じ条件を満たす規則
 *   ・mermaid 自身の @keyframes（MERMAID_KEYFRAMES）
 * 宣言からは url( ・ image-set( ・ expression( ・ \ エスケープなどを含むものを落とす。
 * 入れ子の規則（CSS nesting）・@import・@font-face などのそれ以外の @ 規則も落とす。
 *
 * @param {string} css
 * @param {string} id SVG の id
 * @return {string}
 */
export function scopeMermaidCss(css, id) {
  // id は mermaid.render に渡した値（英数とハイフン）。それ以外なら何も残さない。
  if (!/^[A-Za-z][\w-]*$/.test(String(id || ''))) return '';
  const rules = (src, depth) => {
    const out = [];
    for (const it of mermaidCssItems(src)) {
      if (it.body === null) continue;   // ; で終わる @ 規則（@import・@charset・@layer a, b;）
      if (/[\\]/.test(it.head) || MERMAID_CSS_DANGER.test(it.head)) continue;
      const at = /^@([-\w]+)/.exec(it.head);
      if (at) {
        const name = at[1].toLowerCase();
        if ((name === 'media' || name === 'supports') && depth < 2) {
          const inner = rules(it.body, depth + 1);
          if (inner) out.push(it.head + '{' + inner + '}');
        } else if (name === 'keyframes' || name === '-webkit-keyframes') {
          const kname = it.head.slice(at[0].length).trim();
          if (MERMAID_KEYFRAMES.indexOf(kname) < 0) continue;
          const frames = mermaidCssItems(it.body)
            .filter((f) => f.body !== null && /^[\s\w.%,]+$/.test(f.head) && f.body.indexOf('{') < 0)
            .map((f) => f.head + '{' + mermaidCssDecls(f.body) + '}');
          out.push(it.head + '{' + frames.join('') + '}');
        }
        continue;   // それ以外の @ 規則（@font-face・@layer・@scope など）は落とす
      }
      if (it.body.indexOf('{') >= 0) continue;   // 入れ子の規則は使わない（mermaid の出力は平ら）
      const sels = mermaidCssSplitTop(it.head, ',');
      if (!sels.every((s) => mermaidSelectorInScope(s, id))) continue;
      out.push(it.head + '{' + mermaidCssDecls(it.body) + '}');
    }
    return out.join('');
  };
  return rules(mermaidCssStripComments(String(css || '')), 0);
}

/**
 * DOMPurify を通した mermaid の SVG を仕上げる。<style> を scopeMermaidCss で絞る。
 * 基準にする id は一番外側の SVG のもので、こちらが mermaid.render に渡した形（idRe）に
 * 合うときだけ使う。図の中に別の id を持つ SVG を作られても、その id は基準にしない。
 * 合わなければ <style> を全部外す（色は付かないが、文書全体に効く CSS は残らない）。
 * @param {ParentNode} root まだ文書に入っていない断片
 * @param {RegExp} idRe mermaid.render に渡す id の形
 */
export function scopeMermaidStyles(root, idRe) {
  const svg = root.querySelector('svg');
  const id = svg ? svg.getAttribute('id') || '' : '';
  const ok = !!id && idRe.test(id);
  for (const style of Array.from(root.querySelectorAll('style'))) {
    const css = ok ? scopeMermaidCss(style.textContent, id) : '';
    if (css) style.textContent = css;
    else style.remove();
  }
}
