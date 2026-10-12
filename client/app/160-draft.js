/* ------------------------------------------------------------------ *
 *  下書き（localStorage）
 *
 *  注意: HtmlService のサンドボックス iframe は
 *  https://n-<ランダム>-script.googleusercontent.com という毎回変わりうる
 *  オリジンで配信されるため、localStorage がページ再読み込みをまたいで
 *  残る保証がない。同一セッション内での保険として扱い、読み書きは必ず
 *  try/catch で包んで失敗しても動作に影響させない。
 * ------------------------------------------------------------------ */

const Draft = {
  PREFIX: 'gdte:draft:',
  key: (fileId) => Draft.PREFIX + fileId,
  /**
   * これより古い下書きは起動時に消す。開いていないファイルの下書きが共用 PC に
   * 平文で残り続けないように、また容量を食い潰して新しい下書きが書けなくならないように。
   */
  MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000,
  /** 書けなかったことを一度だけ知らせる（打鍵のたびに出さない）。 */
  warned: false,

  /** @type {Map<string, number>} fileId → タイマー ID */
  _timers: new Map(),

  /**
   * キー入力ごとに JSON 化するのは重いので 500ms スロットルをかける。
   * 書き込みは flush() 側で行い、そこで「そのタブがまだ存在するか」を検証する。
   * 検証しないと、待ち時間中にタブを閉じた場合に古い／空の内容で上書きしてしまう。
   * @param {string} fileId
   */
  schedule(fileId) {
    if (Draft._timers.has(fileId)) return;
    Draft._timers.set(fileId, setTimeout(() => { Draft.flush(fileId); }, 500));
  },

  /**
   * 保留中の下書き書き込みを即座に確定させる。タブを閉じる直前に必ず呼ぶ。
   * @param {string} fileId
   */
  flush(fileId) {
    clearTimeout(Draft._timers.get(fileId));
    Draft._timers.delete(fileId);
    const tab = getTab(fileId);
    if (!tab || !tab.loaded) return;
    // 仮 ID で呼ばれても、下書きは実 ID のキーで残す（開き直したときに復元できるように）。
    Draft.save(tab.id, tabDoc(tab), tab.baseUpdatedAtIso, tab.name);
  },

  save(fileId, content, baseUpdatedAtIso, name) {
    const value = JSON.stringify({ content, baseUpdatedAtIso, name, at: Date.now() });
    try {
      localStorage.setItem(Draft.key(fileId), value);
      return;
    } catch (e) { /* 容量超過かもしれない。空けてやり直す */ }
    try {
      // 先に消してよいのは、無くても困らない表示用の控え（LocalSnap）。
      // それでも足りなければ、開いていないファイルの下書きを古い順に 1 件ずつ空ける。
      LocalSnap.clear();
      const victims = Draft.list().filter((d) => !getTab(d.fileId)).sort((a, b) => a.at - b.at);
      for (;;) {
        try {
          localStorage.setItem(Draft.key(fileId), value);
          return;
        } catch (e) {
          const v = victims.shift();
          if (!v) throw e;
          localStorage.removeItem(v.key);
        }
      }
    } catch (e) {
      // ここで黙ると「下書きで守られている」つもりのまま編集が続くので、一度だけ知らせる。
      if (!Draft.warned) {
        Draft.warned = true;
        toast('編集中の内容をブラウザに下書き保存できません（容量不足か、ストレージが無効です）。' +
          'こまめに保存してください。', 'warn', 12000);
      }
    }
  },

  /** @return {Array<{key:string, fileId:string, at:number}>} 保存されている下書き（中身は読まない） */
  list() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || k.indexOf(Draft.PREFIX) !== 0) continue;
        let at = 0;
        try { at = Number(JSON.parse(localStorage.getItem(k)).at) || 0; } catch (e) { at = 0; }
        out.push({ key: k, fileId: k.slice(Draft.PREFIX.length), at });
      }
    } catch (e) { /* ストレージ不可 */ }
    return out;
  },

  /**
   * 開いていないファイルの下書きのうち、MAX_AGE_MS より古いものを消す（起動時）。
   * 開いているタブの下書きは古くても残す。
   * @return {number} 消した件数
   */
  sweep() {
    const now = Date.now();
    let removed = 0;
    for (const d of Draft.list()) {
      if (getTab(d.fileId) || now - d.at < Draft.MAX_AGE_MS) continue;
      try { localStorage.removeItem(d.key); removed++; } catch (e) { /* ストレージ不可 */ }
    }
    return removed;
  },

  load(fileId) {
    try {
      const raw = localStorage.getItem(Draft.key(fileId));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  },

  clear(fileId) {
    clearTimeout(Draft._timers.get(fileId));
    Draft._timers.delete(fileId);
    try { localStorage.removeItem(Draft.key(fileId)); } catch (e) { /* 無視 */ }
    // Drive に退避した分も、要らなくなったのは同じ（保存できた・捨てた・ファイルを消した）。
    DraftStash.drop(fileId);
  }
};

