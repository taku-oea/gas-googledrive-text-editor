/**
 * client/lib/store-cache.js — 本文の LRU キャッシュ（同じ要求の相乗り・追い出し）。
 *
 * client/app の Store のうち、依存の無い芯を切り出した ES モジュール。
 * 残り（通信・画面に触るもの）は client/app 側で Object.assign(Store, { … }) して足している。
 */
import { TextCodec } from './text-codec.js';

export const Store = {
  /** @type {Map<string, Promise>} 同じ要求が同時に走らないようにする */
  inflight: new Map(),

  /** @type {Map<string, {id:string,name:string,mimeType:string,size:number,content:string,updatedAtIso:string,at:number}>} 挿入順 = LRU */
  content: new Map(),

  contentChars: 0,

  MAX_ENTRIES: 20,

  MAX_CHARS: 8 * 1024 * 1024,

  /** 先読みする本文の上限（文字数）。大きいものはクリックされてから読む。 */
  PREFETCH_MAX: 500 * 1024,

  /** この時間内に取ったものは再検証しない（先読み直後のクリックで往復しない）。 */
  FRESH_MS: 5000,

  /** @type {Map<string, number>} 先読みで読めなかった id → 再試行してよい時刻 */
  negative: new Map(),

  dedup(key, fn) {
    let p = Store.inflight.get(key);
    if (!p) {
      p = fn().finally(() => { Store.inflight.delete(key); });
      Store.inflight.set(key, p);
    }
    return p;
  },

  /** readFile の data（または同じ形）を LRU に入れる。 */
  putContent(d) {
    if (!d || !d.id || typeof d.content !== 'string') return null;
    if (d.encoding) TextCodec.remember(d.id, d.encoding, d.bom, d.broken);
    const prev = Store.content.get(d.id);
    if (prev) { Store.contentChars -= prev.content.length; Store.content.delete(d.id); }
    const rec = {
      id: d.id, name: d.name, mimeType: d.mimeType || '', size: d.size || d.content.length,
      content: d.content, updatedAtIso: d.updatedAtIso, at: Date.now(),
      // この本文が Drive 上でどの文字コードか。保存直後の記録（encoding を持たない）は
      // いま保存に使った文字コードになる。開き直したとき hydrateTab がこれで覚え直すので、
      // ステータスバーで切り替えて保存せずに閉じた、という変更は残らない。
      encoding: d.encoding || TextCodec.get(d.id),
      // BOM の有無と「読めなかった」も同じく、無ければいま覚えている値。
      bom: d.bom !== undefined ? !!d.bom : TextCodec.hasBom(d.id),
      broken: d.broken !== undefined ? !!d.broken : TextCodec.isBroken(d.id)
    };
    Store.content.set(d.id, rec);
    Store.contentChars += rec.content.length;
    Store.evict();
    return rec;
  },

  peek(id) { return Store.content.get(id) || null; },

  /** 参照して LRU の末尾へ動かす。 */
  touch(id) {
    const r = Store.content.get(id);
    if (r) { Store.content.delete(id); Store.content.set(id, r); }
    return r || null;
  },

  drop(id) {
    const r = Store.content.get(id);
    if (r) { Store.contentChars -= r.content.length; Store.content.delete(id); }
  },

  /**
   * タブで開いているか（開いているものは追い出さない）。タブはキャッシュの外にあるので、
   * client/app がここを差し替える。
   * @param {string} id
   * @return {boolean}
   */
  isOpen(id) { return false; },

  evict() {
    for (const [id, rec] of Store.content) {
      if (Store.content.size <= Store.MAX_ENTRIES && Store.contentChars <= Store.MAX_CHARS) break;
      if (Store.isOpen(id)) continue;   // 開いているものは追い出さない
      Store.content.delete(id);
      Store.contentChars -= rec.content.length;
    }
  }
};
