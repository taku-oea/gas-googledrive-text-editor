/**
 * 保存した本文をこのブラウザにも残す（origin は再読み込みをまたいで安定している）。
 * サーバーのスナップショット（snap:file）は getBootstrap 時にしか更新されないので、
 * 直接 API で保存 → 再読み込み、のときに古い本文が一瞬出るのを防ぐ。アクティブなファイル 1 件だけ持つ。
 */
const LocalSnap = {
  prefix: 'gdte:snapfile:',
  MAX: 200 * 1024,
  put(d) {
    if (!d || !d.id || typeof d.content !== 'string' || d.content.length > LocalSnap.MAX) return;
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.indexOf(LocalSnap.prefix) === 0 && k !== LocalSnap.prefix + d.id) localStorage.removeItem(k);
      }
      localStorage.setItem(LocalSnap.prefix + d.id, JSON.stringify({
        id: d.id, name: d.name, mimeType: d.mimeType || '', size: d.size,
        content: d.content, updatedAtIso: d.updatedAtIso, at: Date.now(),
        encoding: d.encoding || TextCodec.get(d.id),
        bom: d.bom !== undefined ? !!d.bom : TextCodec.hasBom(d.id)
      }));
    } catch (e) { /* 容量・無効化。無くても動く */ }
  },
  /** 控えを全部消す。下書きを書く場所が足りないときに先に空ける。 */
  clear() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.indexOf(LocalSnap.prefix) === 0) localStorage.removeItem(k);
      }
    } catch (e) { /* ストレージ不可 */ }
  },
  get(id) {
    try {
      const raw = localStorage.getItem(LocalSnap.prefix + id);
      const v = raw ? JSON.parse(raw) : null;
      return (v && typeof v.content === 'string' && v.updatedAtIso) ? v : null;
    } catch (e) {
      return null;
    }
  }
};

