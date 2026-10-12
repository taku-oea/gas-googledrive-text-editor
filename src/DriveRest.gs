/**
 * DriveRest.gs
 *
 * Drive API v3 を UrlFetchApp で直接叩くための薄いヘルパ。
 *
 * なぜ Advanced Service（Drive.*）や DriveApp ではなくこれを使うのか:
 * どちらも 1 呼び出し = 1 HTTP 往復で、必ず直列に走る。ルートの検証・一覧・
 * 本文のように互いに独立な取得は UrlFetchApp.fetchAll で同時に投げれば
 * 「いちばん遅い 1 本ぶん」の待ち時間で済む。GAS で HTTP を並列に出せる手段は
 * fetchAll だけなので、その入口をここに閉じ込める。
 *
 * 使い方:
 *   var rs = fetchAll_([ req_('files/' + id, { fields: 'id,name' }), listReq_([id], null) ]);
 *   if (!rs[0].ok) throw driveErr_(rs[0], 'ファイル');
 *   var meta = rs[0].json();
 *
 * 失敗は 2 層に分けて扱う:
 *   - 個々の HTTP エラー（404 / 403 …）は例外にせず {ok:false, code, reason} で返す
 *     → 呼び出し側が driveErr_ でアプリのエラーコードに写す
 *   - UrlFetchApp 自体の例外（スコープ未承認・ネットワーク断）は restFailure=true を
 *     付けて throw し、この実行の残りは REST を使わない
 *     → 呼び出し側は DriveApp 経路（*Legacy_）へフォールバックする
 *
 * 前提: appsscript.json の oauthScopes に
 *   https://www.googleapis.com/auth/script.external_request
 * が必要（UrlFetchApp を使うため）。
 */

var DRIVE_V3 = 'https://www.googleapis.com/drive/v3/';
var DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/';
var FOLDER_MIME = 'application/vnd.google-apps.folder';

/** 一覧・作成・改名で共通に取るメタデータ。entryFromMeta_ が読む項目に揃える。 */
var ENTRY_FIELDS = 'id,name,mimeType,size,modifiedTime,parents';

/**
 * 1 本の files.list に載せる親フォルダの数。
 * "'<33文字>' in parents or " は URL エンコード後 65 文字ほどで、
 * UrlFetchApp の URL 長上限（2,082 文字）に fields などを足しても収まる数。
 */
var MAX_PARENTS_PER_LIST_REQ = 15;

/**
 * 1 本の全体検索リクエストに載せる親フォルダの数。listReq_ より控えめなのは
 * `fullText contains '<検索語>'` のぶん URL に余裕を持たせるため。
 */
var MAX_PARENTS_PER_SEARCH_REQ = 12;

/** fetchAll に一度に渡す上限。超えるぶんはチャンクに分けて順に投げる。 */
var MAX_FETCH_ALL = 40;

/**
 * 起動時スナップショット（一覧・アクティブ本文）の TTL（秒）。CacheService の上限 6 時間。
 * 一覧の「新しさ」は値の中の fetchedAt で別に判定する（LIST_CACHE_TTL_SEC）。
 */
var SNAPSHOT_TTL_SEC = 21600;

/**
 * 実行内メモ。GAS はリクエストごとにグローバルを作り直すので、寿命は 1 実行。
 *  token        … ScriptApp.getOAuthToken() の結果
 *  driveNames   … 共有ドライブ id → name（undefined = 未取得、null = 取得不能）
 *  restDisabled … UrlFetchApp が例外を出した後 true。以降は DriveApp 経路
 */
var memo_ = { token: null, driveNames: undefined, restDisabled: false };

/** この実行で REST 経路を使えるか。 */
function restAvailable_() {
  if (memo_.restDisabled) return false;
  try {
    return typeof UrlFetchApp !== 'undefined' && typeof UrlFetchApp.fetchAll === 'function';
  } catch (e) {
    return false;
  }
}

/** アクセス中ユーザーのトークン（executeAs: USER_ACCESSING なので本人のもの）。 */
function token_() {
  if (!memo_.token) memo_.token = ScriptApp.getOAuthToken();
  return memo_.token;
}

/**
 * クエリ文字列を組む。null / undefined の値は省く。
 * @param {Object} params
 * @return {string} 先頭に ? を含む。空なら ''
 */
function qs_(params) {
  var parts = [];
  for (var k in params) {
    if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
    var v = params[k];
    if (v === undefined || v === null) continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

/**
 * fetchAll_ に渡す 1 リクエストを作る。
 * @param {string} path 'files/<id>' や 'files'。先頭にスラッシュは付けない
 * @param {Object} params クエリパラメータ
 * @param {{method?:string, payload?:*, contentType?:string, upload?:boolean}} [opt]
 * @return {Object} UrlFetchApp.fetchAll の要素
 */
function req_(path, params, opt) {
  opt = opt || {};
  var r = {
    url: (opt.upload ? DRIVE_UPLOAD : DRIVE_V3) + path + qs_(params || {}),
    method: opt.method || 'get',
    headers: { Authorization: 'Bearer ' + token_() },
    muteHttpExceptions: true   // 4xx / 5xx を例外にせず、個別に判定する
  };
  if (opt.payload !== undefined) r.payload = opt.payload;
  if (opt.contentType) r.contentType = opt.contentType;
  return r;
}

/**
 * 全件を並列に投げ、応答を正規化して同じ順序で返す。
 *
 * UrlFetchApp 自体の例外（ネットワーク断・スコープ未承認）は restFailure=true を
 * 付けて throw する。個々の HTTP エラーは throw せず {ok:false} で返す。
 *
 * @param {Array<Object>} reqs req_ の戻り値の配列
 * @return {Array<{ok:boolean, code:number, text?:function():string, json?:function():Object,
 *                 reason?:string, message?:string}>}
 */
function fetchAll_(reqs) {
  if (!reqs || !reqs.length) return [];
  var out = [];
  try {
    for (var i = 0; i < reqs.length; i += MAX_FETCH_ALL) {
      var chunk = reqs.slice(i, i + MAX_FETCH_ALL);
      var resps = UrlFetchApp.fetchAll(chunk);
      for (var j = 0; j < resps.length; j++) out.push(parseResp_(resps[j], chunk[j]));
    }
  } catch (e) {
    memo_.restDisabled = true;
    console.warn('UrlFetchApp での Drive 呼び出しに失敗したため、この実行は DriveApp 経路に切り替えます: ' +
      (e && e.message ? e.message : e));
    var err = new Error('Drive API への接続に失敗しました。');
    err.restFailure = true;
    err.cause = e;
    throw err;
  }
  return out;
}

/**
 * HTTPResponse を {ok, code, text(), json()} / {ok:false, code, reason, message} に正規化する。
 * text() / json() は遅延評価（alt=media の大きな本文を不要に文字列化しないため）。
 * @param {GoogleAppsScript.URL_Fetch.HTTPResponse} resp
 * @param {Object} [req] 投げたリクエスト（Range 付きかを見る）
 * @return {Object}
 */
function parseResp_(resp, req) {
  var code = resp.getResponseCode();
  // 空のファイルに Range を付けると 416（Range Not Satisfiable）が返る。本文は空として扱う。
  if (code === 416 && req && req.headers && req.headers.Range) {
    return {
      ok: true,
      code: code,
      text: function () { return ''; },
      decoded: function () { return { text: '', encoding: 'UTF-8', bom: false, broken: false }; },
      json: function () { return {}; }
    };
  }
  if (code >= 200 && code < 300) {
    return {
      ok: true,
      code: code,
      // alt=media の応答には charset が付かないので UTF-8 を明示する。
      text: function () { return resp.getContentText('UTF-8'); },
      // 本文用。UTF-8 として壊れていれば Shift_JIS として読み直す（decodeText_）。
      decoded: function () { return decodeText_(resp.getBlob()); },
      json: function () {
        var t = resp.getContentText('UTF-8');
        return t ? JSON.parse(t) : {};
      }
    };
  }
  var reason = '';
  var message = '';
  try {
    var body = JSON.parse(resp.getContentText());
    var e = body && body.error;
    if (e) {
      message = e.message || '';
      reason = (e.errors && e.errors[0] && e.errors[0].reason) || e.status || '';
    }
  } catch (_) {
    // 非 JSON 応答（HTML のエラーページなど）
  }
  return { ok: false, code: code, reason: String(reason), message: String(message) };
}

/**
 * Shift_JIS として扱うときの Java の文字セット名の候補（先頭から試す）。
 * ブラウザの TextDecoder('shift_jis')（WHATWG）と同じく Windows の拡張文字
 * （① や ～ など）を含む Windows-31J が本命で、MS932 はその別名。
 * 最後の Shift_JIS は JIS X 0208 だけなので拡張文字を扱えないが、保存時の
 * 往復確認（encodeSjis_）で止まるので、黙って ? に化けることはない。
 */
var SJIS_CHARSETS = ['Windows-31J', 'MS932', 'Shift_JIS'];

/** 実行中に使える文字セット名（sjisCharset_ が決める）。undefined = まだ試していない。 */
var sjisCharsetCache_;

/**
 * この実行環境で使える Shift_JIS の文字セット名を返す。どれも使えなければ null。
 * 「あ」（0x82 0xA0）を読ませて、正しく読めた最初の名前を使う。
 * @return {string|null}
 */
function sjisCharset_() {
  if (sjisCharsetCache_ !== undefined) return sjisCharsetCache_;
  sjisCharsetCache_ = null;
  for (var i = 0; i < SJIS_CHARSETS.length; i++) {
    try {
      // Apps Script のバイト列は符号付き（0x82 = -126, 0xA0 = -96）。
      if (Utilities.newBlob([-126, -96]).getDataAsString(SJIS_CHARSETS[i]) === '\u3042') {
        sjisCharsetCache_ = SJIS_CHARSETS[i];
        break;
      }
    } catch (e) {
      // この名前は使えない。次を試す。
    }
  }
  if (!sjisCharsetCache_) console.warn('Shift_JIS の文字セットが使えません: ' + SJIS_CHARSETS.join(', '));
  return sjisCharsetCache_;
}

/**
 * JIS 規格どおりの字形を、Windows-31J にある同じ見た目の文字へ読み替える
 * （クライアントの TextCodec.SJIS_ALIASES と同じ表）。
 */
var SJIS_ALIASES = {
  '\u301c': '\uff5e', '\u2016': '\u2225', '\u2212': '\uff0d', '\u2014': '\u2015',
  '\u00a2': '\uffe0', '\u00a3': '\uffe1', '\u00ac': '\uffe2',
  // 半角の ¥ と ‾ は Shift_JIS の 0x5C / 0x7E（日本語のフォントではそう見える）。
  '\u00a5': '\\', '\u203e': '~'
};

/**
 * 本文の Blob を文字列にする。規則はクライアントの TextCodec.decode と同じ。
 *
 * - バイト列が UTF-8 として厳密に正しければ UTF-8。本物の U+FFFD（EF BF BD）を
 *   含んでいてもよい（置換文字が出たかどうかでは決めない）
 * - 正しくなく、Shift_JIS としては置換文字なしで読めれば Shift_JIS
 * - どちらでもなければ UTF-8 として（壊れた所は置換文字で）読み、broken を立てる。
 *   クライアントはこのファイルを閲覧専用にし、保存させない
 *
 * 先頭の BOM（UTF-8 のときだけ）は bom で返す。本文から外すのは呼び出し側（stripBom_）。
 * @param {GoogleAppsScript.Base.Blob} blob
 * @return {{text:string, encoding:string, bom:boolean, broken:boolean}} encoding は 'UTF-8' か 'Shift_JIS'
 */
function decodeText_(blob) {
  var text = blob.getDataAsString('UTF-8');
  // getDataAsString が先頭の BOM を残すかに頼らず、バイト列で見る（EF BB BF は符号付きで -17 -69 -65）。
  var head = text.charCodeAt(0) === 0xfeff ? null : blob.getBytes();
  var bom = head ? (head.length >= 3 && head[0] === -17 && head[1] === -69 && head[2] === -65) : true;
  // 置換文字が無ければ正しい UTF-8（全バイトを調べるのは置換文字が出たときだけ）。
  if (text.indexOf('\ufffd') < 0 || utf8Valid_(blob.getBytes())) {
    return { text: text, encoding: 'UTF-8', bom: bom, broken: false };
  }
  var charset = sjisCharset_();
  if (charset) {
    var sjis = blob.getDataAsString(charset);
    if (sjis.indexOf('\ufffd') < 0) return { text: sjis, encoding: 'Shift_JIS', bom: false, broken: false };
  }
  return { text: text, encoding: 'UTF-8', bom: bom, broken: true };
}

/**
 * バイト列が UTF-8 として正しいか。ブラウザの TextDecoder('utf-8', {fatal:true})
 * （WHATWG の UTF-8 デコーダ）と同じ規則で、冗長な表現・サロゲート・U+10FFFF 超・
 * 途中で切れた並びを不正とする。
 * @param {Array<number>} bytes Apps Script のバイト列（-128〜127 の符号付き）
 * @return {boolean}
 */
function utf8Valid_(bytes) {
  var n = bytes.length;
  var i = 0;
  while (i < n) {
    var b = bytes[i] & 0xff;
    if (b < 0x80) { i++; continue; }
    var need;
    var lo = 0x80;
    var hi = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) {
      need = 1;
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      if (b === 0xe0) lo = 0xa0;        // 冗長な 3 バイト表現
      else if (b === 0xed) hi = 0x9f;   // サロゲート（U+D800〜U+DFFF）
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      if (b === 0xf0) lo = 0x90;        // 冗長な 4 バイト表現
      else if (b === 0xf4) hi = 0x8f;   // U+10FFFF を超える
    } else {
      return false;                     // 0x80〜0xC1・0xF5〜0xFF は先頭に来ない
    }
    if (i + need >= n) return false;    // 途中で切れている
    for (var k = 1; k <= need; k++) {
      var c = bytes[i + k] & 0xff;
      if (k === 1 ? (c < lo || c > hi) : (c < 0x80 || c > 0xbf)) return false;
    }
    i += need + 1;
  }
  return true;
}

/**
 * 文字列を Shift_JIS のバイト列にする。表せない文字があれば throw（黙って ? にしない）。
 * @param {string} text
 * @return {Array<number>}
 */
function encodeSjis_(text) {
  var src = String(text).replace(/[\u301c\u2016\u2212\u2014\u00a2\u00a3\u00ac\u00a5\u203e]/g, function (c) {
    return SJIS_ALIASES[c];
  });
  var charset = sjisCharset_();
  if (!charset) {
    throw appError_('UNKNOWN', 'サーバー側で Shift_JIS を扱えないため保存できませんでした。' +
      'ページを再読み込みしてから保存し直してください（ブラウザから直接保存します）。');
  }
  var bytes = Utilities.newBlob('').setDataFromString(src, charset).getBytes();
  var back = Utilities.newBlob(bytes).getDataAsString(charset);
  if (back !== src) {
    var line = 1;
    for (var i = 0; i < src.length && i < back.length; i++) {
      if (src.charAt(i) !== back.charAt(i)) {
        throw appError_('NOT_TEXT', 'Shift_JIS で表せない文字があるため保存できません: 「' +
          src.charAt(i) + '」（' + line + ' 行目）。その文字を消すか、ステータスバーの文字コードから UTF-8 に切り替えてください。');
      }
      if (src.charAt(i) === '\n') line++;
    }
    throw appError_('NOT_TEXT', 'Shift_JIS で表せない文字があるため保存できません。');
  }
  return bytes;
}

/**
 * HTTP エラーを既存の appError_ のコードへ写す。
 * @param {{code:number, reason:string, message:string}} r parseResp_ の失敗応答
 * @param {string} what 'ファイル' / 'フォルダ' などメッセージ用
 * @return {Error}
 */
function driveErr_(r, what) {
  var label = what || 'ファイル';
  if (r.code === 404) {
    return appError_('NOT_FOUND',
      label + 'が見つかりません。削除されたか、あなたに共有されていない可能性があります。');
  }
  if (r.code === 429 || (r.code === 403 && /rateLimit|quotaExceeded/i.test(r.reason))) {
    return appError_('LOCKED', '短時間に操作が集中しています。数秒おいて再試行してください。');
  }
  if (r.code === 403 && /fileNotDownloadable/i.test(r.reason)) {
    return appError_('NOT_TEXT', 'この' + label + 'は raw テキストとして取得できません。');
  }
  if (r.code === 401 || r.code === 403) {
    return appError_('FORBIDDEN',
      'この' + label + 'にアクセスできません。削除されたか、あなたに共有されていない、' +
      'または編集権限が無い可能性があります。' + (r.message ? '（' + r.message + '）' : ''));
  }
  return appError_('UNKNOWN',
    label + 'の操作に失敗しました（HTTP ' + r.code + (r.message ? ' ' + r.message : '') + '）。');
}

/**
 * Drive の RFC3339 を DriveApp の getLastUpdated().toISOString() と同じ表記に揃える。
 * 競合検出は文字列比較なので、書式が揺れると誤検出になる。
 * @param {string} rfc3339
 * @return {string}
 */
function iso_(rfc3339) {
  var d = new Date(rfc3339);
  return isNaN(d.getTime()) ? String(rfc3339 || '') : d.toISOString();
}

/** files.list の q に埋める文字列のエスケープ（\ と ' を潰す）。 */
function escQ_(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** ID としてクエリに埋めてよい文字列か。 */
function validId_(id) {
  return /^[A-Za-z0-9_-]+$/.test(String(id == null ? '' : id)) || id === 'root';
}

/**
 * 複数フォルダ直下の一覧を 1 本で取るリクエスト。
 * @param {Array<string>} parentIds
 * @param {string|null} pageToken
 * @param {boolean} [foldersOnly] サブフォルダだけ（フォルダ選択画面用）
 * @return {Object}
 */
function listReq_(parentIds, pageToken, foldersOnly) {
  var clauses = [];
  for (var i = 0; i < parentIds.length; i++) clauses.push("'" + parentIds[i] + "' in parents");
  var q = '(' + clauses.join(' or ') + ') and trashed = false';
  if (foldersOnly) q += " and mimeType = '" + FOLDER_MIME + "'";
  return req_('files', {
    q: q,
    fields: 'nextPageToken,files(' + ENTRY_FIELDS + ')',
    pageSize: 1000,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageToken: pageToken || null
  });
}

/**
 * 同名チェック用のリクエスト。該当があれば files に id が入って返る。
 * @param {string} parentId
 * @param {string} name
 * @param {boolean} foldersOnly
 * @return {Object}
 */
function nameQueryReq_(parentId, name, foldersOnly) {
  var q = "'" + parentId + "' in parents and name = '" + escQ_(name) + "' and trashed = false";
  if (foldersOnly) q += " and mimeType = '" + FOLDER_MIME + "'";
  return req_('files', {
    q: q,
    fields: 'files(id,name)',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
}

/** ファイル 1 件のメタデータを取るリクエスト。 */
function metaReq_(fileId, fields) {
  return req_('files/' + fileId, { supportsAllDrives: true, fields: fields || ENTRY_FIELDS });
}

/**
 * ファイル本文（alt=media）を取るリクエスト。
 *
 * メタデータと並列に投げるので、サイズの判定（assertReadable_）は取得のあとになる。
 * 巨大なファイルを丸ごと落としてから弾かないよう、Range で上限 + 1 バイトまでに切る
 * （上限を超えるファイルはメタデータの size で TOO_LARGE になり、本文は使われない）。
 */
function mediaReq_(fileId) {
  var r = req_('files/' + fileId, { supportsAllDrives: true, alt: 'media' });
  r.headers.Range = 'bytes=0-' + MAX_FILE_SIZE_BYTES;
  return r;
}

/**
 * 全文索引で候補ファイルを絞るリクエスト（全体検索）。
 *
 * 親は listReq_ より少なくまとめる。`fullText contains '<検索語>'` のぶんだけ
 * URL が伸びるので、上限 2,082 文字に対して検索語の余地を残しておきたい。
 *
 * @param {string} escaped fullText contains に渡す、クォートを潰した検索語
 * @param {Array<string>} parentIds この親の直下を対象にする
 * @param {string|null} pageToken
 * @return {Object}
 */
function searchReq_(escaped, parentIds, pageToken) {
  var clauses = [];
  for (var i = 0; i < parentIds.length; i++) clauses.push("'" + parentIds[i] + "' in parents");
  return req_('files', {
    q: "fullText contains '" + escaped + "' and trashed = false and (" + clauses.join(' or ') + ')',
    fields: 'nextPageToken,files(' + ENTRY_FIELDS + ')',
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageToken: pageToken || null
  });
}

/**
 * メタデータだけを PATCH するリクエスト（改名・移動・ゴミ箱）。
 * @param {string} fileId
 * @param {Object} body {name} / {trashed:true} など
 * @param {Object} [extraParams] addParents / removeParents など
 * @return {Object}
 */
function patchMetaReq_(fileId, body, extraParams) {
  var params = { supportsAllDrives: true, fields: ENTRY_FIELDS };
  for (var k in (extraParams || {})) params[k] = extraParams[k];
  return req_('files/' + fileId, params, {
    method: 'patch',
    payload: JSON.stringify(body || {}),
    contentType: 'application/json'
  });
}

/**
 * 本文を書き込む PATCH（uploadType=multipart）。
 *
 * media 単体（uploadType=media）だと、リクエストの Content-Type が
 * ファイルの mimeType として採用されて .md が text/plain に変わる、
 * charset が混ざる、といった揺れが起きうる。metadata 側で mimeType を
 * 明示すればそれが優先されるので、multipart にして既存の型を保つ。
 *
 * @param {string} fileId
 * @param {string|Array<number>} content 文字列（UTF-8 で送る）か、符号化済みのバイト列
 * @param {string} mimeType 既存の mimeType（維持する）
 * @param {Object} [metadata] name など追加のメタデータ
 * @param {Object} [extraParams] addParents / removeParents など
 * @return {Object}
 */
function uploadReq_(fileId, content, mimeType, metadata, extraParams) {
  var boundary = 'gdte_' + Utilities.getUuid().replace(/-/g, '');
  var meta = metadata || {};
  meta.mimeType = mimeType || 'text/plain';
  var head =
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(meta) + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: ' + meta.mimeType + '\r\n\r\n';
  var tail = '\r\n--' + boundary + '--';
  // content がバイト列（Shift_JIS で符号化済み）なら、文字列にせずバイト列のまま挟む。
  var body = Array.isArray(content)
    ? Utilities.newBlob(head).getBytes().concat(content, Utilities.newBlob(tail).getBytes())
    : head + content + tail;
  var params = { uploadType: 'multipart', supportsAllDrives: true, fields: ENTRY_FIELDS };
  for (var k in (extraParams || {})) params[k] = extraParams[k];
  return req_('files/' + fileId, params, {
    upload: true,
    method: 'patch',
    payload: body,
    contentType: 'multipart/related; boundary=' + boundary
  });
}

/**
 * 配列を n 個ずつに分ける。
 * @param {Array} arr
 * @param {number} n
 * @return {Array<Array>}
 */
function chunk_(arr, n) {
  var out = [];
  for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
