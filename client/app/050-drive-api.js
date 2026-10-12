/* ------------------------------------------------------------------ *
 *  Direct — ブラウザから Drive API v3 を直接叩くバックエンド
 *
 *  google.script.run は、サーバーの処理が 100ms でも往復に 1〜2 秒かかる
 *  （GAS インスタンスの起動 + 転送）。読む・書く・一覧・検索は Drive REST を
 *  ブラウザから直接呼び、GAS はシェル・トークン・セッションだけにする。
 *
 *  トークンはサーバーの getBootstrap / getToken が返す「アクセス中ユーザー自身の」
 *  OAuth トークン（ScriptApp.getOAuthToken）。この IIFE のクロージャにだけ置き、
 *  window にも localStorage にも出さない。約 1 時間で切れるので 45 分で先回りして
 *  取り直し、401 が返ったときも 1 回だけ取り直す。
 *
 *  ネットワーク層で失敗したとき（CORS・オフライン・組織のネットワークで遮断）は Api.backend を
 *  'gas' に戻して同じ呼び出しをサーバー経由でやり直す。HTTP エラー（404 / 403 …）は
 *  そのままエラーとして返す（サーバー経由でも同じ結果になるため）。
 * ------------------------------------------------------------------ */

const DriveApi = (() => {
  const BASE = 'https://www.googleapis.com/drive/v3/';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/';
  const TOKEN_MAX_AGE_MS = 45 * 60 * 1000;
  let token = null;
  let tokenAt = 0;
  let refreshing = null;

  function seed(t) {
    if (t && t.value) { token = t.value; tokenAt = t.obtainedAt || Date.now(); }
  }
  function ready() { return !!token; }
  function forget() { token = null; tokenAt = 0; }

  async function ensureToken(force) {
    if (!force && token && Date.now() - tokenAt < TOKEN_MAX_AGE_MS) return token;
    if (!refreshing) {
      refreshing = call('getToken')
        .then((t) => { seed(t); return token; })
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function reasonOf(res) {
    try {
      const j = await res.json();
      const e = j && j.error;
      return {
        reason: (e && e.errors && e.errors[0] && e.errors[0].reason) || (e && e.status) || '',
        message: (e && e.message) || ''
      };
    } catch (e) {
      return { reason: '', message: '' };
    }
  }

  /** HTTP エラーをサーバーと同じ code に写す（クライアントの分岐が変わらないように）。 */
  function toApiError(status, info, what) {
    const label = what || 'ファイル';
    if (status === 404) {
      return new ApiError('NOT_FOUND', label + 'が見つかりません。削除されたか、あなたに共有されていない可能性があります。');
    }
    if (status === 429 || (status === 403 && /rateLimit|quotaExceeded/i.test(info.reason))) {
      return new ApiError('LOCKED', '短時間に操作が集中しています。数秒おいて再試行してください。');
    }
    if (status === 403 && /fileNotDownloadable/i.test(info.reason)) {
      return new ApiError('NOT_TEXT', 'この' + label + 'は raw テキストとして取得できません。');
    }
    if (status === 401 || status === 403) {
      return new ApiError('FORBIDDEN', 'この' + label + 'にアクセスできません。削除されたか、あなたに共有されていない、' +
        'または編集権限が無い可能性があります。' + (info.message ? '（' + info.message + '）' : ''));
    }
    return new ApiError('UNKNOWN', label + 'の操作に失敗しました（HTTP ' + status + (info.message ? ' ' + info.message : '') + '）。');
  }

  /**
   * fetch の薄い包み。401 は 1 回だけトークンを取り直し、
   * 429 / 5xx / rateLimit は指数バックオフで最大 4 回やり直す（POST の 5xx だけはやり直さない）。
   * ネットワーク層の失敗は err.network = true を付けて投げる（呼び出し側が GAS 経路へ落とす）。
   */
  async function http(url, init, what, attempt) {
    attempt = attempt || 0;
    const tok = await ensureToken(false);
    const headers = Object.assign({}, (init && init.headers) || {}, { Authorization: 'Bearer ' + tok });
    const method = (init && init.method) || 'GET';
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(url, Object.assign({}, init || {}, { headers }));
    } catch (err) {
      Perf.record('rest.http.' + method, performance.now() - t0, { error: true, attempt });
      const e = new ApiError('TRANSPORT', 'Drive API に接続できません: ' + (err && err.message ? err.message : err));
      e.network = true;
      throw e;
    }
    // ヘッダが届くまで（CORS のプリフライト込み）。本文の転送時間は含まない。
    Perf.record('rest.http.' + method, performance.now() - t0, { status: res.status, attempt });
    if (res.ok) return res;
    // Range 付きの取得で 416 なのは空のファイル。呼び出し側（decoded）が空の本文にする。
    if (res.status === 416 && headers.Range) return res;
    if (res.status === 401 && attempt === 0) {
      await ensureToken(true);
      return http(url, init, what, 1);
    }
    const info = await reasonOf(res.clone());
    // POST（作成・コピー・新規アップロード）の 5xx は、Drive 側では作れていることがある。
    // やり直すと同じファイルが 2 つできるので、POST は 5xx ではやり直さずにエラーで返す。
    // 429 / rateLimit は受け付ける前に断られているので POST でもやり直してよい。
    const retriable = res.status === 429 || (res.status >= 500 && method !== 'POST') ||
      (res.status === 403 && /rateLimit/i.test(info.reason));
    if (retriable && attempt < 4) {
      await sleep(400 * Math.pow(2, attempt) + Math.random() * 300);
      return http(url, init, what, attempt + 1);
    }
    throw toApiError(res.status, info, what);
  }

  const qs = (o) => Object.entries(o)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
    .join('&');
  const json = (path, params, init, what) =>
    http(BASE + path + '?' + qs(params), init, what).then((r) => r.json());
  const text = (path, params, what) =>
    http(BASE + path + '?' + qs(params), null, what).then((r) => r.text());
  /**
   * 本文を文字コードを判定して読む（{text, encoding}）。
   * 上限（5MB）+ 1 バイトまでしか取らない。メタデータと並列に取るのでサイズの判定は
   * あとになるが、巨大なファイルを丸ごと落としてから弾くことはなくなる。
   * 上限を超えていたら（サイズを先に確かめない版の履歴など）ここで TOO_LARGE にする。
   */
  const decoded = (path, params, what) => {
    const max = (App.config && App.config.maxFileSizeBytes) || 5 * 1024 * 1024;
    return http(BASE + path + '?' + qs(params), { headers: { Range: 'bytes=0-' + max } }, what)
      // 空のファイルに Range を付けると 416 が返る（http が通す）。本文は空として扱う。
      .then((r) => (r.status === 416 ? new ArrayBuffer(0) : r.arrayBuffer()))
      .then((buf) => {
        if (buf.byteLength > max) {
          throw new ApiError('TOO_LARGE', (what || 'ファイル') + 'が上限（5MB）を超えているため読み込めません。');
        }
        return TextCodec.decode(buf);
      });
  };
  const upload = (path, params, init, what) =>
    http(UPLOAD + path + '?' + qs(params), init, what).then((r) => r.json());
  const escQ = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const iso = (v) => { const d = new Date(v); return isNaN(d.getTime()) ? String(v || '') : d.toISOString(); };

  return {
    seed, ready, forget, ensureToken, http, json, text, decoded, upload, qs, escQ, iso,
    FIELDS: 'id,name,mimeType,size,modifiedTime,parents',
    FOLDER: 'application/vnd.google-apps.folder'
  };
})();

