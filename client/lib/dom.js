/**
 * client/lib/dom.js — DOM の小物（要素の組み立て・アイコン・IME の判定）。
 *
 * 依存の無い純粋な部分を client/app から切り出した ES モジュール。
 * client/app 側からは tools/build-app.mjs が生成する import で同じ名前のまま参照できる。
 */

/** 要素をまとめて作る。textContent 経由なので XSS の心配がない。 */
export function h(tag, props, children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const child of [].concat(children || [])) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * SVG スプライト（src/icons.html）からアイコンを作る。
 *
 * @param {string} name シンボル名（icons.html の id から i- を外したもの）
 * @param {string} [extra] 追加クラス（icon--folder / icon--lg など）
 * @return {SVGElement}
 */
export function icon(name, extra) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon' + (extra ? ' ' + extra : ''));
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  // href が効かない環境向けに xlink:href も併記する。
  use.setAttribute('href', '#i-' + name);
  use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#i-' + name);
  svg.appendChild(use);
  return svg;
}

/**
 * IME（日本語入力など）の変換確定のためのキーかどうか。
 * Safari は確定の Enter で compositionend を先に出すので isComposing が false になる。
 * そのときも keyCode は 229 になるので、両方を見る。
 */
export function isImeKey(ev) {
  return ev.isComposing || ev.keyCode === 229;
}
