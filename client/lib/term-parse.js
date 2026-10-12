/**
 * client/lib/term-parse.js — ターミナルのコマンド行の解析（字句・パイプ・オプション・glob）。
 *
 * 依存の無い純粋な部分を client/app から切り出した ES モジュール。
 * client/app 側からは tools/build-app.mjs が生成する import で同じ名前のまま参照できる。
 */

/** 想定内のエラー（使い方の間違い）。スタックを出さずにそのまま表示する。 */
export class TermError extends Error {}

/** glob の 1 階層ぶんを正規表現にする。大文字小文字は区別しない。 */
export function globToRegExp(seg) {
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg.charAt(i);
    if (c === '*') { out += '[^/]*'; continue; }
    if (c === '?') { out += '[^/]'; continue; }
    if (c === '[') {
      const close = seg.indexOf(']', i + 1);
      if (close < 0) { out += '\\['; continue; }
      let cls = seg.slice(i + 1, close);
      if (cls.charAt(0) === '!') cls = '^' + cls.slice(1);
      out += '[' + cls + ']';
      i = close;
      continue;
    }
    out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$', 'i');
}

/**
 * コマンド行を字句に分ける。
 * 引用符（' と "）とバックスラッシュのエスケープを解き、| > >> は演算子として返す。
 * 補完のために、元の文字列での位置と引用符の種類も持たせる。
 *
 * @param {string} line
 * @return {Array<{text:string, start:number, end:number, op:boolean,
 *                 quote:string, open:boolean}>}
 */
export function termTokenize(line) {
  const tokens = [];
  const src = String(line == null ? '' : line);
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src.charAt(i))) i++;
    if (i >= src.length) break;
    const start = i;
    const c0 = src.charAt(i);

    if (c0 === '|' || c0 === '>') {
      let op = c0;
      i++;
      if (c0 === '>' && src.charAt(i) === '>') { op = '>>'; i++; }
      tokens.push({ text: op, start, end: i, op: true, quote: '', open: false });
      continue;
    }

    let text = '';
    let quote = '';
    let used = '';
    while (i < src.length) {
      const c = src.charAt(i);
      if (!quote && /\s/.test(c)) break;
      if (!quote && (c === '|' || c === '>')) break;
      if (!quote && (c === '"' || c === "'")) { quote = c; used = c; i++; continue; }
      if (quote && c === quote) { quote = ''; i++; continue; }
      if (c === '\\' && quote !== "'" && i + 1 < src.length) { text += src.charAt(i + 1); i += 2; continue; }
      text += c;
      i++;
    }
    tokens.push({ text, start, end: i, op: false, quote: used, open: !!quote });
  }
  return tokens;
}

/**
 * 字句をパイプラインに組み立てる。
 * @param {string} line
 * @return {{stages:Array<Array<string>>, redirect:({op:string, path:string}|null)}}
 */
export function termParse(line) {
  const tokens = termTokenize(line);
  const stages = [];
  let cur = [];
  let redirect = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.op && t.text === '|') {
      if (!cur.length) throw new TermError('| の前にコマンドがありません。');
      stages.push(cur);
      cur = [];
      continue;
    }
    if (t.op) {
      const target = tokens[i + 1];
      if (!target || target.op) throw new TermError(t.text + ' のあとに書き出し先を書いてください。');
      redirect = { op: t.text, path: target.text };
      i++;
      continue;
    }
    cur.push(t.text);
  }
  if (cur.length) stages.push(cur);
  if (!stages.length) throw new TermError('コマンドがありません。');
  if (redirect && stages.length === 0) throw new TermError('書き出す中身がありません。');
  return { stages, redirect };
}

/**
 * オプションを解く。spec は { l:true（真偽）, n:'value'（値をとる）} の形で、
 * 長い名前（--name）も同じキーで受ける。
 * @param {Array<string>} argv
 * @param {Object} spec
 * @return {{flags:Object, rest:Array<string>}}
 */
export function termArgs(argv, spec) {
  const flags = {};
  const rest = [];
  const table = spec || {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { for (let j = i + 1; j < argv.length; j++) rest.push(argv[j]); break; }
    if (a.length > 1 && a.charAt(0) === '-' && !/^-\d/.test(a)) {
      if (a.charAt(1) === '-') {
        const eq = a.indexOf('=');
        const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
        if (!(key in table)) throw new TermError('知らないオプションです: --' + key);
        if (table[key] === 'value') flags[key] = eq > 0 ? a.slice(eq + 1) : argv[++i];
        else flags[key] = true;
        if (table[key] === 'value' && flags[key] === undefined) {
          throw new TermError('--' + key + ' には値が要ります。');
        }
        continue;
      }
      // -name のように、ダッシュ 1 つで長い名前を書くのも受ける（find -name / sed -i）。
      const single = a.slice(1);
      const eq1 = single.indexOf('=');
      const longKey = eq1 > 0 ? single.slice(0, eq1) : single;
      if (longKey.length > 1 && (longKey in table)) {
        if (table[longKey] === 'value') {
          flags[longKey] = eq1 > 0 ? single.slice(eq1 + 1) : argv[++i];
          if (flags[longKey] === undefined) throw new TermError('-' + longKey + ' には値が要ります。');
        } else flags[longKey] = true;
        continue;
      }
      for (let j = 1; j < a.length; j++) {
        const key = a.charAt(j);
        if (!(key in table)) {
          throw new TermError('知らないオプションです: -' + key +
            '（' + Object.keys(table).map((k) => (k.length === 1 ? '-' : '--') + k).join(' ') + ' が使えます）');
        }
        if (table[key] === 'value') {
          flags[key] = a.slice(j + 1) || argv[++i];
          if (flags[key] === undefined) throw new TermError('-' + key + ' には値が要ります。');
          break;
        }
        flags[key] = true;
      }
      continue;
    }
    rest.push(a);
  }
  return { flags, rest };
}

/** 補完・表示のために、空白などを含む名前を引用符でくるむ。 */
export function termQuote(text) {
  const s = String(text == null ? '' : text);
  if (!/[\s'"|>\\]/.test(s)) return s;
  if (s.indexOf("'") < 0) return "'" + s + "'";
  return '"' + s.replace(/(["\\$`])/g, '\\$1') + '"';
}

/** 行の配列にする（末尾の空行は落とす）。 */
export function termLines(text) {
  const body = String(text == null ? '' : text);
  if (!body) return [];
  const lines = body.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** パターンを正規表現にする。-F なら文字どおり。 */
export function termPattern(pattern, opts) {
  const o = opts || {};
  const flags = (o.i ? 'i' : '') + (o.g ? 'g' : '');
  if (o.fixed) return new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    throw new TermError('正規表現として読めません: ' + pattern + '（' + err.message + '）');
  }
}

/** 並列数を絞って走らせる。Drive の PATCH は 1 本 2.5 秒前後なので、直列だと待てない。 */
export async function termPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Ctrl+C。エラーではないので、メッセージを出すためだけの型。 */
export class TermAbort extends Error {}

/** 別名。help には出さず、補完と実行だけで効かせる。 */
export const TERM_ALIASES = {
  ll: ['ls', '-l'],
  dir: ['ls'],
  md: ['mkdir'],
  del: ['rm'],
  man: ['help'],
  '?': ['help']
};
