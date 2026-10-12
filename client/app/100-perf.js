/* ------------------------------------------------------------------ *
 *  計測
 *
 *  推測で最適化しないための土台。起動は performance.mark、操作は
 *  Perf.start(name)() の所要時間を溜めて、コマンドパレットの
 *  「パフォーマンス計測を表示」で p50 / p95 を出す。
 *  記録は配列 push だけなので、常時有効にしておいて問題ない。
 * ------------------------------------------------------------------ */

const Perf = {
  samples: [],
  MAX: 2000,
  pendingOpen: null,
  longTasks: 0,
  longTaskMax: 0,
  prevOrigin: null,
  earlyRpc: null,
  _bootDone: false,

  mark(name) { try { performance.mark(name); } catch (e) { /* 無視 */ } },

  /** @return {function(Object=)} 終了時に呼ぶ。meta は任意の付加情報。 */
  start(name) {
    const t0 = performance.now();
    return (meta) => Perf.record(name, performance.now() - t0, meta);
  },

  record(name, ms, meta) {
    Perf.samples.push({ name, ms, meta: meta || null, at: Date.now() });
    if (Perf.samples.length > Perf.MAX) Perf.samples.splice(0, 500);
  },

  /** ツリー行のクリック → 本文が見えるまで。 */
  markOpen(id) { Perf.pendingOpen = { id, t0: performance.now() }; },
  paintOpen(id) {
    const p = Perf.pendingOpen;
    if (!p || p.id !== id) return;
    Perf.pendingOpen = null;
    requestAnimationFrame(() => Perf.record('open.click→visible', performance.now() - p.t0, { id }));
  },

  /** 起動完了。1 回だけ editor-interactive を打って要約をコンソールに出す。 */
  finishBoot() {
    if (Perf._bootDone) return;
    Perf._bootDone = true;
    Perf.mark('editor-interactive');
    setTimeout(() => Perf.report(), 0);
  },

  /** name ごとの n / p50 / p95 / max / last。p95 の大きい順。 */
  summary() {
    const by = new Map();
    for (const s of Perf.samples) {
      if (!by.has(s.name)) by.set(s.name, []);
      by.get(s.name).push(s.ms);
    }
    const q = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
    return Array.from(by, ([name, a]) => {
      const sorted = a.slice().sort((x, y) => x - y);
      return {
        name, n: a.length,
        p50: +q(sorted, 0.5).toFixed(1), p95: +q(sorted, 0.95).toFixed(1),
        max: +sorted[sorted.length - 1].toFixed(1), last: +a[a.length - 1].toFixed(1)
      };
    }).sort((x, y) => y.p95 - x.p95);
  },

  /** 起動のタイムライン（マーク）と HTML / CDN の取得状況をコンソールへ。 */
  report() {
    try {
      const marks = performance.getEntriesByType('mark').filter((m) => !m.name.startsWith('rpc:'));
      console.table(marks.map((m) => ({ mark: m.name, ms: Math.round(m.startTime) })));
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav) {
        console.log('[perf] html: ttfb=' + Math.round(nav.responseStart) + 'ms responseEnd=' +
          Math.round(nav.responseEnd) + 'ms encoded=' + nav.encodedBodySize + 'B decoded=' +
          nav.decodedBodySize + 'B（encoded < decoded なら圧縮配信）');
      }
      const res = performance.getEntriesByType('resource')
        .filter((r) => /esm\.sh|\/vendor\//.test(r.name));
      const cached = res.filter((r) => r.deliveryType === 'cache' || (r.transferSize === 0 && r.duration < 15)).length;
      console.log('[perf] vendor: files=' + res.length + ' cached≈' + cached + ' lastEnd=' +
        Math.round(Math.max(0, ...res.map((r) => r.responseEnd))) + 'ms');
      console.log('[perf] origin=' + location.origin + ' prevOrigin=' + Perf.prevOrigin +
        ' earlyRpc=' + Perf.earlyRpc);
    } catch (e) { /* 計測は任意 */ }
  },

  /** コマンドパレットから。要約を表にして出す。 */
  show() {
    const rows = Perf.summary();
    console.table(rows);
    Perf.report();
    const head = 'name'.padEnd(26) + 'n'.padStart(5) + 'p50'.padStart(9) + 'p95'.padStart(9) + 'max'.padStart(9);
    const lines = rows.map((r) =>
      r.name.padEnd(26) + String(r.n).padStart(5) + String(r.p50).padStart(9) +
      String(r.p95).padStart(9) + String(r.max).padStart(9));
    const text = rows.length
      ? head + '\n' + lines.join('\n') + '\n\nlong tasks: ' + Perf.longTasks + '（最大 ' + Math.round(Perf.longTaskMax) + 'ms）' +
        '\n起動のタイムラインはコンソールに出力しました。'
      : 'まだ計測データがありません。';
    void modal({
      title: 'パフォーマンス計測（ms）',
      body: h('pre', { class: 'perf', text }),
      wide: true,
      actions: [
        { label: 'クリア', value: 'clear' },
        { label: '閉じる', value: null, variant: 'primary' }
      ]
    }).then((v) => { if (v === 'clear') Perf.samples.length = 0; });
  }
};

// localStorage のオリジンが再読み込みをまたいで同じかを記録する（docs/limitations.md「localStorage の永続性」の検証）。
try {
  Perf.prevOrigin = localStorage.getItem('gdte:originProbe');
  localStorage.setItem('gdte:originProbe', location.origin + ' @ ' + new Date().toISOString());
} catch (e) {
  Perf.prevOrigin = '(localStorage 不可)';
}
if (window.PerformanceObserver) {
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        Perf.longTasks++;
        Perf.longTaskMax = Math.max(Perf.longTaskMax, e.duration);
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) { /* 未対応ブラウザ */ }
}

/**
 * getBootstrap の Promise を得る。
 * index.html の <head> で先に発火してあれば（window.__bootP）それを使い、
 * 無ければここから呼ぶ。再試行（boot() の 2 回目以降）は常にここから。
 */
function takeBootstrapPromise() {
  const early = window.__bootP;
  window.__bootP = null;
  Perf.earlyRpc = early ? 'head' : 'module';
  if (!early) return Api.getBootstrap();
  const startMark = performance.getEntriesByName('rpc:getBootstrap:start')[0];
  const t0 = startMark ? startMark.startTime : performance.now();
  return early.then(
    (res) => { Perf.record('rpc.getBootstrap', performance.now() - t0, { ok: true, early: true }); return unwrapResponse(res); },
    (err) => {
      Perf.record('rpc.getBootstrap', performance.now() - t0, { ok: false, early: true });
      throw new ApiError('TRANSPORT', 'サーバーとの通信に失敗しました: ' + (err && err.message ? err.message : String(err)));
    }
  );
}

