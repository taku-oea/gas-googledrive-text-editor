/**
 * client/lib/text-codec.js — 文字コード（UTF-8 / Shift_JIS）。
 *
 * 依存の無い純粋な部分を client/app から切り出した ES モジュール。
 * client/app 側からは tools/build-app.mjs が生成する import で同じ名前のまま参照できる。
 */
import { ApiError } from './errors.js';

/* ------------------------------------------------------------------ *
 *  文字コード（UTF-8 / Shift_JIS）
 *
 *  Excel から書き出した CSV など、日本の現場では Shift_JIS のファイルがまだ多い。
 *  読むときはまず UTF-8 として厳密に解釈し、壊れていれば Shift_JIS として
 *  解釈し直す（ブラウザの TextDecoder。中身は Windows-31J 相当）。
 *  書くときは元の文字コードに戻す。Shift_JIS の符号化はブラウザに無いので、
 *  デコーダを 2 バイトの全組み合わせに通して逆引き表を作る（初回だけ数 ms）。
 *
 *  どのファイルがどの文字コードかは fileId ごとに覚え、保存（Api.saveFile）が
 *  そこから引く。呼び出し側（タブ・比較・ターミナル）は文字コードを意識しない。
 *  UTF-8 の BOM の有無と、どちらとしても読めなかった（保存すると壊れる）ことも同じく覚える。
 * ------------------------------------------------------------------ */

export const TextCodec = {
  UTF8: 'UTF-8',
  SJIS: 'Shift_JIS',
  /** @type {Map<string, string>} fileId → 文字コード */
  byId: new Map(),
  /** @type {Set<string>} 先頭に BOM が付いていた UTF-8 のファイル（保存時に付け直す） */
  bomIds: new Set(),
  /**
   * @type {Set<string>} UTF-8 としても Shift_JIS としても読めなかったファイル。
   * 壊れた所は置換文字（U+FFFD）で開いているので、保存するとそのバイト列が失われる。保存させない。
   */
  brokenIds: new Set(),
  /** @type {Map<string, Array<number>>|null} 文字 → Shift_JIS のバイト列 */
  sjisTable: null,
  /**
   * JIS 規格どおりの字形（Mac の IME が入れる）を、Windows-31J にある同じ見た目の文字へ
   * 読み替える。「〜」(U+301C) を「～」(U+FF5E) にするなど。読み直すと Windows 側の字になる。
   */
  SJIS_ALIASES: {
    '\u301c': '\uff5e', '\u2016': '\u2225', '\u2212': '\uff0d', '\u2014': '\u2015',
    '\u00a2': '\uffe0', '\u00a3': '\uffe1', '\u00ac': '\uffe2',
    // 半角の ¥ と ‾ は Shift_JIS の 0x5C / 0x7E（日本語のフォントではそう見える）。
    // サーバーの SJIS_ALIASES と同じ表にして、どちらの経路でも同じバイト列になるようにする。
    '\u00a5': '\\', '\u203e': '~'
  },

  get(id) { return TextCodec.byId.get(String(id)) || TextCodec.UTF8; },

  /** 保存時に BOM を付けるか（UTF-8 のときだけ意味がある）。 */
  hasBom(id) { return TextCodec.bomIds.has(String(id)); },

  /** どちらの文字コードとしても読めなかったか（保存させない）。 */
  isBroken(id) { return TextCodec.brokenIds.has(String(id)); },

  /** ステータスバーに出す名前。 */
  label(id) {
    const enc = TextCodec.get(id);
    return enc + (enc === TextCodec.UTF8 && TextCodec.hasBom(id) ? ' (BOM)' : '');
  },

  /**
   * 文字コードを覚える。bom / broken は省略（undefined）なら今の値を変えない
   * （保存直後の記録やステータスバーの切り替えは、文字コードしか持っていないため）。
   * @param {string} id
   * @param {string} encoding
   * @param {boolean} [bom]
   * @param {boolean} [broken]
   */
  remember(id, encoding, bom, broken) {
    if (!id || !encoding) return;
    const key = String(id);
    TextCodec.byId.set(key, encoding === TextCodec.SJIS ? TextCodec.SJIS : TextCodec.UTF8);
    if (bom !== undefined) {
      if (bom) TextCodec.bomIds.add(key); else TextCodec.bomIds.delete(key);
    }
    if (broken !== undefined) {
      if (broken) TextCodec.brokenIds.add(key); else TextCodec.brokenIds.delete(key);
    }
  },

  /**
   * バイト列を文字列にする。UTF-8 として厳密に正しければ UTF-8（本物の U+FFFD を
   * 含んでいてもよい）、正しくなく Shift_JIS としては正しければ Shift_JIS。
   * どちらでもなければ UTF-8 として（壊れた所は置換文字で）読み、broken を立てる。
   * BOM は本文から外し、付いていたことを bom で返す（サーバーの decodeText_ と同じ規則）。
   * @param {ArrayBuffer} buf
   * @return {{text:string, encoding:string, bom:boolean, broken:boolean}}
   */
  decode(buf) {
    const head = new Uint8Array(buf, 0, Math.min(3, buf.byteLength));
    const bom = head.length === 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
    // TextDecoder は既定で先頭の BOM を読み飛ばす。
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: TextCodec.UTF8, bom, broken: false };
    } catch (e) { /* UTF-8 ではない */ }
    try {
      return { text: new TextDecoder('shift_jis', { fatal: true }).decode(buf), encoding: TextCodec.SJIS, bom: false, broken: false };
    } catch (e) { /* Shift_JIS でもない */ }
    return { text: new TextDecoder('utf-8').decode(buf), encoding: TextCodec.UTF8, bom, broken: true };
  },

  /** WHATWG の Shift_JIS エンコーダと同じ規則で逆引き表を作る。 */
  buildSjis() {
    const map = new Map();
    for (let b = 0; b < 0x80; b++) map.set(String.fromCharCode(b), [b]);
    for (let b = 0xa1; b <= 0xdf; b++) map.set(String.fromCharCode(0xff61 + b - 0xa1), [b]);
    const dec = new TextDecoder('shift_jis');
    const pair = new Uint8Array(2);
    for (let lead = 0x81; lead <= 0xfc; lead++) {
      if (lead >= 0xa0 && lead <= 0xdf) continue;
      for (let trail = 0x40; trail <= 0xfc; trail++) {
        if (trail === 0x7f) continue;
        const pointer = (lead - (lead < 0xa0 ? 0x81 : 0xc1)) * 188 + (trail - (trail < 0x7f ? 0x40 : 0x41));
        // NEC 選定 IBM 拡張文字は IBM 拡張文字と重複するので、符号化では使わない（WHATWG と同じ）。
        if (pointer >= 8272 && pointer <= 8835) continue;
        pair[0] = lead;
        pair[1] = trail;
        const ch = dec.decode(pair);
        if (ch === '\ufffd' || map.has(ch)) continue;   // 同じ文字は小さい番号を優先
        map.set(ch, [lead, trail]);
      }
    }
    TextCodec.sjisTable = map;
  },

  /**
   * 文字列をその文字コードのバイト列にする。Shift_JIS で表せない文字があれば投げる。
   * @param {string} text
   * @param {string} encoding
   * @param {boolean} [bom] UTF-8 の先頭に BOM（EF BB BF）を付ける
   * @return {Uint8Array}
   */
  encode(text, encoding, bom) {
    if (encoding !== TextCodec.SJIS) return new TextEncoder().encode((bom ? '\ufeff' : '') + text);
    if (!TextCodec.sjisTable) TextCodec.buildSjis();
    const table = TextCodec.sjisTable;
    const out = new Uint8Array(text.length * 2);
    let n = 0;
    const bad = [];
    let line = 1;
    for (const raw of text) {
      if (raw === '\n') line++;
      const bytes = table.get(raw) || table.get(TextCodec.SJIS_ALIASES[raw]);
      if (!bytes) {
        if (bad.length < 5 && !bad.some((b) => b.ch === raw)) bad.push({ ch: raw, line });
        continue;
      }
      for (const b of bytes) out[n++] = b;
    }
    if (bad.length) {
      throw new ApiError('NOT_TEXT', 'Shift_JIS で表せない文字があるため保存できません: ' +
        bad.map((b) => '「' + b.ch + '」（' + b.line + ' 行目）').join('、') +
        '。その文字を消すか、ステータスバーの文字コードから UTF-8 に切り替えてください。');
    }
    return out.slice(0, n);
  }
};
