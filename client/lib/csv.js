/* ------------------------------------------------------------------ *
 *  CSV / TSV の解析と、表の操作を「本文への変更」に直す部分
 *
 *  表プレビュー（client/app/215-csv-grid.js）が使う。表の上での編集は、
 *  エディタの本文に対する最小の変更（CodeMirror の changes）として返し、
 *  元のタブへトランザクションで流す。本文をまるごと組み立て直さないので、
 *  触っていないセルの書き方（引用符の有無・空白）はそのまま残り、Undo も効く。
 *
 *  本文はエディタと同じく改行を \n にそろえた文字列を受け取る
 *  （CRLF は保存時に restoreEol が戻す）。
 * ------------------------------------------------------------------ */

/**
 * 区切り文字を決める。.tsv はタブ、.csv はカンマを基本にし、
 * 拡張子で決まらないときは先頭の数行で引用符の外にある候補を数えて多いものにする。
 * @param {string} name ファイル名
 * @param {string} text 本文
 * @return {string}
 */
export function csvDelimiter(name, text) {
  if (/\.tsv$/i.test(String(name || ''))) return '\t';
  if (/\.csv$/i.test(String(name || ''))) {
    // .csv でもセミコロン区切り（欧州の Excel）やタブ区切りのことがある。
    // カンマが 1 つも無く、別の候補が行ごとにそろって出るときだけ切り替える。
    const counts = countOutsideQuotes(text, [',', ';', '\t']);
    if (counts[','] === 0 && (counts[';'] > 0 || counts['\t'] > 0)) {
      return counts['\t'] >= counts[';'] ? '\t' : ';';
    }
    return ',';
  }
  const counts = countOutsideQuotes(text, [',', '\t', ';']);
  let best = ',';
  for (const d of ['\t', ';']) if (counts[d] > counts[best]) best = d;
  return best;
}

/** 先頭 20 行ぶんで、引用符の外にある各文字の数を数える。 */
function countOutsideQuotes(text, chars) {
  const counts = {};
  for (const c of chars) counts[c] = 0;
  let quoted = false;
  let lines = 0;
  for (let i = 0; i < text.length && lines < 20; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '\n') lines++;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  return counts;
}

/**
 * @typedef {{from:number, to:number, value:string, quoted:boolean}} CsvCell
 *   from / to … 本文上の範囲（引用符を含む）。value … 引用符を外した値
 * @typedef {{start:number, end:number, line:number, cells:CsvCell[]}} CsvRow
 *   start / end … 行の範囲（末尾の改行は含まない）。line … 行が始まる本文の行番号（1 始まり）
 */

/**
 * CSV を行とセルに分ける。引用符の中のカンマ・改行・"" を扱う。
 * 末尾の改行のあとは行にしない。空行は「空のセルが 1 つの行」になる。
 * 閉じていない引用符は文末までを 1 つのセルとして読む（書いている途中でも表が崩れきらない）。
 * そのセルは文末まで続く範囲を持つので、表から書き換えると後ろが全部消える。
 * 見つけたら unclosed にその行番号を入れて返し、呼び出し側は表からの編集を止める。
 * @param {string} text
 * @param {string} delim
 * @return {{rows:CsvRow[], columns:number, unclosed:(number|null)}}
 */
export function parseCsv(text, delim) {
  const rows = [];
  let columns = 0;
  let unclosed = null;
  const n = text.length;
  let i = 0;
  let line = 1;
  if (n === 0) return { rows, columns, unclosed };

  while (i < n) {
    const row = { start: i, end: i, line, cells: [] };
    for (;;) {
      const from = i;
      let value;
      let quoted = false;
      if (text[i] === '"') {
        quoted = true;
        let buf = '';
        const startLine = line;
        i++;
        for (;;) {
          if (i >= n) { if (unclosed === null) unclosed = startLine; break; }
          const ch = text[i];
          if (ch === '"') {
            if (text[i + 1] === '"') { buf += '"'; i += 2; continue; }
            i++;
            break;
          }
          if (ch === '\n') line++;
          buf += ch;
          i++;
        }
        // 閉じ引用符のあとに区切りまでの文字があれば、値の続きとして足す（Excel と同じ寛容さ）。
        while (i < n && text[i] !== delim && text[i] !== '\n') buf += text[i++];
        value = buf;
      } else {
        const start = i;
        while (i < n && text[i] !== delim && text[i] !== '\n') i++;
        value = text.slice(start, i);
      }
      row.cells.push({ from, to: i, value, quoted });
      if (i < n && text[i] === delim) { i++; continue; }
      break;
    }
    row.end = i;
    rows.push(row);
    if (row.cells.length > columns) columns = row.cells.length;
    if (i < n && text[i] === '\n') { i++; line++; }
  }
  return { rows, columns, unclosed };
}

/**
 * セルに書く文字列にする。区切り・引用符・改行を含むときと、元が引用符付きだったときは囲む。
 * @param {string} value
 * @param {string} delim
 * @param {boolean} [keepQuoted] 元のセルが引用符付きだった
 * @return {string}
 */
export function csvQuote(value, delim, keepQuoted) {
  const v = String(value == null ? '' : value);
  const need = keepQuoted || v.indexOf(delim) >= 0 || v.indexOf('"') >= 0 ||
    v.indexOf('\n') >= 0 || v.indexOf('\r') >= 0;
  return need ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/**
 * 1 つのセルを書き換える変更。行が短くて列が足りなければ、区切りを足してから書く。
 * @param {{rows:CsvRow[]}} table parseCsv の結果
 * @param {number} r 行（rows の添字）
 * @param {number} c 列
 * @param {string} value
 * @param {string} delim
 * @return {Array<{from:number, to:number, insert:string}>}
 */
export function csvSetCell(table, r, c, value, delim) {
  const row = table.rows[r];
  if (!row) return [];
  const cell = row.cells[c];
  if (cell) {
    const insert = csvQuote(value, delim, cell.quoted);
    return [{ from: cell.from, to: cell.to, insert }];
  }
  if (value === '') return [];   // 無い列を空にするだけなら何も書かない
  const missing = c - row.cells.length + 1;
  return [{ from: row.end, to: row.end, insert: delim.repeat(missing) + csvQuote(value, delim, false) }];
}

/**
 * 空の行を足す変更。at の行の前に入れる（at が行数と同じなら末尾に足す）。
 * @param {{rows:CsvRow[], columns:number}} table
 * @param {number} at
 * @param {string} delim
 * @param {number} textLength 本文の長さ（末尾に足すときに使う）
 * @return {Array<{from:number, to:number, insert:string}>}
 */
export function csvInsertRow(table, at, delim, textLength) {
  const blank = delim.repeat(Math.max(0, (table.columns || 1) - 1));
  const rows = table.rows;
  // 空のファイル。空の行は「改行 1 つ」で表す（'' のままだと行にならない）。
  if (!rows.length) return [{ from: 0, to: textLength, insert: blank + '\n' }];
  if (at < rows.length) {
    const start = rows[at].start;
    return [{ from: start, to: start, insert: blank + '\n' }];
  }
  const last = rows[rows.length - 1];
  // 1 列だけの表で末尾に改行が無いと、'\n' を足しても「末尾の改行」になるだけで行が増えない。
  // そのときは空の行のぶんの改行をもう 1 つ足す。
  const tail = blank === '' && last.end === textLength ? '\n' : '';
  return [{ from: last.end, to: last.end, insert: '\n' + blank + tail }];
}

/**
 * 行を消す変更。次の行の頭までを消し、最後の行なら前の行の改行ごと消す。
 * @param {{rows:CsvRow[]}} table
 * @param {number} r
 * @return {Array<{from:number, to:number, insert:string}>}
 */
export function csvDeleteRow(table, r) {
  const rows = table.rows;
  const row = rows[r];
  if (!row) return [];
  if (r + 1 < rows.length) return [{ from: row.start, to: rows[r + 1].start, insert: '' }];
  if (r > 0) return [{ from: rows[r - 1].end, to: row.end, insert: '' }];
  return [{ from: row.start, to: row.end, insert: '' }];
}

/**
 * 空の列を c の前に足す変更（c が列数と同じなら末尾に足す）。
 * 列が足りない短い行は、足す位置より手前で終わっているので触らない。
 * @param {{rows:CsvRow[], columns:number}} table
 * @param {number} c
 * @param {string} delim
 * @return {Array<{from:number, to:number, insert:string}>}
 */
export function csvInsertColumn(table, c, delim) {
  const out = [];
  for (const row of table.rows) {
    if (c < row.cells.length) {
      out.push({ from: row.cells[c].from, to: row.cells[c].from, insert: delim });
    } else if (c === row.cells.length && c === table.columns) {
      // 右端に足す。列がそろっている行にだけ区切りを足す。
      out.push({ from: row.end, to: row.end, insert: delim });
    }
  }
  return out;
}

/**
 * 列を消す変更。その列を持たない短い行は触らない。
 * @param {{rows:CsvRow[]}} table
 * @param {number} c
 * @return {Array<{from:number, to:number, insert:string}>}
 */
export function csvDeleteColumn(table, c) {
  const out = [];
  for (const row of table.rows) {
    const cells = row.cells;
    if (c >= cells.length) continue;
    if (cells.length === 1) out.push({ from: cells[0].from, to: cells[0].to, insert: '' });
    else if (c < cells.length - 1) out.push({ from: cells[c].from, to: cells[c + 1].from, insert: '' });
    else out.push({ from: cells[c - 1].to, to: cells[c].to, insert: '' });
  }
  return out;
}

/**
 * 並べ替え用の比較。両方が数値として読めれば数値で、そうでなければ日本語の自然順で比べる。
 * 「1,200」「¥5,000」「12%」のような書き方も数値として扱う。空は常に最後。
 * @param {string} a
 * @param {string} b
 * @return {number}
 */
export function csvCompare(a, b) {
  const ea = a === '' || a == null;
  const eb = b === '' || b == null;
  if (ea || eb) return ea === eb ? 0 : (ea ? 1 : -1);
  const na = csvNumber(a);
  const nb = csvNumber(b);
  if (na !== null && nb !== null) return na - nb;
  return CSV_COLLATOR ? CSV_COLLATOR.compare(a, b) : (a < b ? -1 : a > b ? 1 : 0);
}

const CSV_COLLATOR = (typeof Intl !== 'undefined' && Intl.Collator)
  ? new Intl.Collator('ja', { numeric: true, sensitivity: 'base' }) : null;

/**
 * 数値として読めれば数値を返す（読めなければ null）。表の右寄せにも使う。
 * @param {string} s
 * @return {number|null}
 */
export function csvNumber(s) {
  const t = String(s).trim().replace(/^[¥￥$]/, '').replace(/%$/, '').replace(/,(?=\d{3}(\D|$))/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}
