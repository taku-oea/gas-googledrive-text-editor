/**
 * Code.gs
 *
 * Web アプリのエントリポイントと、クライアント（google.script.run）から呼ばれる API。
 * Drive アクセスの実装は DriveService.gs に置き、ここでは薄いラッパに徹する。
 *
 * === 呼び出し回数についての方針 ===
 * google.script.run の往復は片道 0.3〜1 秒、コールドスタート時は数秒かかる。
 * そのためキー入力やカーソル移動では一切サーバーを呼ばない。
 * 読む・書く・一覧・検索はトークンを受け取ったブラウザが Drive API を直接叩き
 * （js.html の Direct）、ここの同名の関数はトークンが無い・直接アクセスが無効・
 * ネットワークで届かないときの経路になる。
 * 起動（getBootstrap）・設定やセッションの保存・ユーザーが明示的に行う操作
 * （作成・改名・移動・ゴミ箱・アップロード・一時メモ）はここを通る。
 * 一覧は docs/architecture.md の「サーバー関数一覧」を参照。
 *
 * === 戻り値の共通形 ===
 * すべての API は例外を投げず、必ず次の形を返す。
 *   成功: { ok: true,  data: <任意> }
 *   失敗: { ok: false, error: "日本語メッセージ", code: "...", detail: <任意> }
 * これにより withFailureHandler は通信断・タイムアウト専用になる。
 */

/* ==================================================================== *
 *  エントリポイント
 * ==================================================================== */

/** ブラウザタブに出すアプリ名。 */
var APP_TITLE = 'Drive テキストエディタ';

/**
 * スクリプトプロパティのキー（favicon の URL）。
 *
 * 値はコードに直書きせずプロパティから読む。設定手順は docs/icons.md を参照。
 * 未設定ならアイコンは既定のまま（実害なし）。
 *
 * 画像は assets/favicon.ico（tools/make-icons.py が assets/app-icon.png から
 * 生成する 16〜256px 同梱の ICO）。Chrome の［アプリとしてインストール］は
 * この中の大きいサイズをアプリアイコンに使うため、256px を必ず含めている。
 */
var PROP_FAVICON_URL = 'FAVICON_URL';

/**
 * 上位ページ（script.google.com 側）の <head> に入れる meta タグ。
 *
 * addMetaTag で追加できるのは次の 4 つだけで、他の name は無視される。
 *   viewport / mobile-web-app-capable / apple-mobile-web-app-capable /
 *   google-site-verification
 * index.html に直接書いた meta タグも同様に無視される（公式ドキュメント明記）。
 *
 * viewport の maximum-scale=1 は、iOS が 16px 未満の入力欄にフォーカスしたとき
 * 画面を勝手に拡大するのを止めるため（iOS は指での拡大は引き続きできる）。
 * interactive-widget=resizes-content は、Android の Chrome でソフトキーボードを
 * 出したときに画面の高さを縮めさせるため（既定では縮まず、下の行がキーボードに隠れる）。
 *
 * mobile-web-app-capable 系は、ホーム画面に追加したアイコンから開いたときに
 * ブラウザの UI を出さずアプリとして表示させるためのもの。
 * theme-color や <link rel="manifest"> は入れる API が無いため、
 * 本物の PWA（Service Worker・オフライン）にはできない。docs/icons.md の「アプリとしてインストールしたときのアイコン（PWA）」を参照。
 */
var META_TAGS = [
  ['viewport', 'width=device-width, initial-scale=1, maximum-scale=1, interactive-widget=resizes-content'],
  ['mobile-web-app-capable', 'yes'],
  ['apple-mobile-web-app-capable', 'yes']
];

/**
 * Web アプリのエントリポイント。
 * @param {GoogleAppsScript.Events.DoGet} e リクエストパラメータ（未使用）
 * @return {GoogleAppsScript.HTML.HtmlOutput}
 */
function doGet(e) {
  // 設定の確認用。?diag=favicon で FAVICON_URL の実際の値を表示する。
  // アイコンが出ないときに「値が壊れているのか、そもそも空なのか」を
  // 実行ログを見に行かずに切り分けるためのもの。
  // ContentService を使うのは、HtmlService の出力がサンドボックス iframe の
  // 中に入ってしまい、外から取得して確認できないため。
  if (e && e.parameter && e.parameter.diag === 'favicon') {
    return ContentService.createTextOutput(faviconDiagnostics_())
      .setMimeType(ContentService.MimeType.TEXT);
  }

  // 前回の状態を HTML に埋める（UserProperties + CacheService だけ。Drive は見ない）。
  // getBootstrap は doGet とは別の実行になり、別インスタンスに当たれば 2 度目の
  // コールドスタートを払う。ここで埋めておけば、クライアントはその往復を待たずに描ける。
  var t0 = Date.now();
  var boot = null;
  try {
    boot = bootSnapshot_();
  } catch (err) {
    console.warn('起動スナップショットを組み立てられませんでした: ' + (err && err.message ? err.message : err));
  }
  var t1 = Date.now();

  // テンプレート評価（include ×4 で約 900KB を結合）の所要時間も残す。
  // ここが 100ms を超えるなら、ビルド時に include を展開した単一ファイルにする。
  var tpl = HtmlService.createTemplateFromFile('index');
  tpl.bootJson = boot ? safeJson_(boot) : 'null';
  // 配色だけは bootJson（body 末尾）と別に head へ渡す。最初の描画より前に
  // <html data-theme> を確定させないと、ライト設定の人に一瞬ダークが出る。
  tpl.themeMode = themeModeFor_(boot);
  // esm.sh へのフォールバックを許すか。Vendor.load() はモジュールの評価直後に走り、
  // bootJson や getBootstrap を待たないので、これも head に渡す。
  tpl.esmFallback = esmFallbackEnabled_() ? '1' : '0';
  var out = tpl.evaluate().setTitle(APP_TITLE);
  console.log('[perf] doGet snapshot=' + (t1 - t0) + 'ms evaluate=' + (Date.now() - t1) +
    'ms inline=' + tpl.bootJson.length + 'chars');

  // 1 つでも例外が出ると以降が飛ぶので、タグごとに包む。
  for (var i = 0; i < META_TAGS.length; i++) {
    try {
      out.addMetaTag(META_TAGS[i][0], META_TAGS[i][1]);
    } catch (err) {
      console.warn('meta タグを追加できませんでした: ' + META_TAGS[i][0]
        + ' / ' + (err && err.message ? err.message : err));
    }
  }

  var iconUrl = faviconUrl_();
  if (iconUrl) {
    // setFaviconUrl は URL の形式によって例外を投げることがある。
    // ここで落ちるとページ全体が表示されなくなるので必ず包む。
    try {
      out.setFaviconUrl(iconUrl);
    } catch (err) {
      console.warn('favicon を設定できませんでした: ' + (err && err.message ? err.message : err));
    }
  }
  return out;
}

/**
 * head に埋める初期テーマ。スナップショットが作れていればそこから、
 * 作れていなければ UserProperties を直接読む（どちらも失敗したら 'system'）。
 * @param {Object|null} boot bootSnapshot_() の結果
 * @return {string} 'system' | 'light' | 'dark'
 */
function themeModeFor_(boot) {
  try {
    var mode = boot && boot.settings
      ? boot.settings.themeMode
      : DriveService.loadSettings_().themeMode;
    return (mode === 'light' || mode === 'dark') ? mode : 'system';
  } catch (e) {
    return 'system';
  }
}

/**
 * スクリプトプロパティのキー（ブラウザから Drive API を直接叩く機能の停止スイッチ）。
 * 'false' を設定すると全ユーザーが GAS 経由に戻る（再デプロイ不要）。未設定は有効。
 */
var PROP_DIRECT_DRIVE = 'DIRECT_DRIVE_ENABLED';

/** @return {boolean} */
function directDriveEnabled_() {
  try {
    return PropertiesService.getScriptProperties().getProperty(PROP_DIRECT_DRIVE) !== 'false';
  } catch (e) {
    return true;
  }
}

/**
 * スクリプトプロパティのキー（配信元のバンドルが取れないとき esm.sh から読み直すか）。
 * 'true' のときだけ有効。未設定は無効（配信元に届かなければエディタは起動しない）。
 *
 * 既定で止めているのは、ブラウザが Drive フルスコープのトークンを持つため。
 * esm.sh はリクエスト時にビルドする第三者 CDN で、中身を SRI で固定できない。
 * 配信元の障害時に一時的に逃がしたいときだけ 'true' にし、復旧したら消す。
 */
var PROP_ESM_FALLBACK = 'ESM_FALLBACK_ENABLED';

/** @return {boolean} */
function esmFallbackEnabled_() {
  try {
    return PropertiesService.getScriptProperties().getProperty(PROP_ESM_FALLBACK) === 'true';
  } catch (e) {
    return false;
  }
}

/**
 * クライアントへ配る設定。getBootstrap とスナップショット（doGet）で同じものを使う。
 * types はファイル種別の判定表で、ブラウザから直接 Drive を読むときに
 * サーバーの classifyMeta_ と同じ判定をするために配る（判定の唯一の定義は DriveService.gs）。
 * @param {boolean} directDrive
 * @return {Object}
 */
function bootConfig_(directDrive) {
  return {
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    contentCacheTtlSec: CONTENT_CACHE_TTL_SEC,
    maxSessionTabs: MAX_SESSION_TABS,
    maxRoots: MAX_ROOTS,
    defaultSettings: DriveService.defaultSettings_(),
    // 一時メモの置き場所を「○○ / アプリ名 / tmp」と描くために渡す。
    tmpAppFolderName: TMP_APP_FOLDER_NAME,
    tmpFolderName: TMP_FOLDER_NAME,
    maxTmpMoveFiles: MAX_TMP_MOVE_FILES,
    directDrive: !!directDrive,
    types: {
      textExtensions: TEXT_EXTENSIONS,
      textMimeExact: TEXT_MIME_EXACT,
      mediaExtensions: MEDIA_EXTENSIONS,
      googleViewKinds: GOOGLE_VIEW_KINDS,
      googleTypeLabels: GOOGLE_TYPE_LABELS,
      mimeByExtension: MIME_BY_EXTENSION
    }
  };
}

/**
 * アクセス中ユーザー自身の OAuth トークンを返す（ブラウザが Drive REST を直接叩くため）。
 *
 * executeAs: USER_ACCESSING なので、返るのは呼び出した本人のトークンだけで、
 * 他人の権限で動くことはない。約 1 時間で切れるのでクライアントは 45 分で取り直す。
 * スクリプトプロパティ DIRECT_DRIVE_ENABLED=false で全体を止められる。
 *
 * @return {{ok:boolean, data?:{value:string, obtainedAt:number}, error?:string, code?:string}}
 */
function getToken() {
  return guard_('getToken', function () {
    if (!directDriveEnabled_()) {
      throw appError_('FORBIDDEN', 'ブラウザからの直接アクセスは管理者により無効化されています。');
    }
    return { value: token_(), obtainedAt: Date.now() };
  });
}

/**
 * 起動スナップショットの合計サイズ上限（文字数）。HTML に埋めるので大きすぎると
 * かえって初回描画が遅れる。本文 → ルート → 展開フォルダの優先順で詰める。
 */
var MAX_SNAPSHOT_CHARS = 300 * 1024;

/**
 * doGet が HTML に埋める「前回の状態」。getBootstrap の data と同じ形に meta を足したもの。
 *
 * Drive には触らず、UserProperties を 1 回、CacheService を 1 回読むだけ（合計 100〜200ms）。
 * 一覧は getBootstrap / listEntries が 'list:<folderId>' に 6 時間残したもの、
 * 本文は getBootstrap / saveFile が 'snap:file:<fileId>' に残したもの。
 * 無いものは null になり、クライアントは getBootstrap の応答で埋める。
 *
 * @return {Object|null} ルートが未設定なら null（初回はフォルダ選択画面へ）
 */
function bootSnapshot_() {
  var props = PropertiesService.getUserProperties().getProperties() || {};
  var roots = DriveService.parseRootsRaw_(props[PROP_ROOTS]);
  if (!roots || !roots.length) return null;
  var session = DriveService.parseSessionRaw_(props[PROP_SESSION]);

  var wanted = [];
  for (var r = 0; r < roots.length; r++) if (validId_(roots[r].id)) wanted.push(roots[r].id);
  if (session && Array.isArray(session.expanded)) {
    for (var e = 0; e < session.expanded.length && wanted.length < MAX_MULTI_LIST; e++) {
      var ex = String(session.expanded[e] || '');
      if (validId_(ex) && ex !== 'root' && wanted.indexOf(ex) < 0) wanted.push(ex);
    }
  }
  var activeId = DriveService.activeTextTabId_(session);

  var keys = [];
  for (var w = 0; w < wanted.length; w++) keys.push('list:' + wanted[w]);
  if (activeId) keys.push('snap:file:' + activeId);
  var cached = DriveService.cacheGetAllJson_(keys);

  var budget = MAX_SNAPSHOT_CHARS;
  var activeFile = activeId ? (cached['snap:file:' + activeId] || null) : null;
  if (activeFile && typeof activeFile.content === 'string') budget -= activeFile.content.length;
  else activeFile = null;

  var folderEntries = {};
  var listFetchedAt = {};
  var any = false;
  for (var i = 0; i < wanted.length && budget > 0; i++) {
    var v = cached['list:' + wanted[i]];
    if (!v) continue;
    var cost = JSON.stringify(v).length;
    if (cost > budget) continue;
    budget -= cost;
    folderEntries[wanted[i]] = v;
    listFetchedAt[wanted[i]] = Number(v.fetchedAt) || 0;
    any = true;
  }

  var email = '';
  try { email = Session.getActiveUser().getEmail() || ''; } catch (e) { email = ''; }

  return {
    v: 1,
    meta: {
      at: Date.now(),
      listFetchedAt: listFetchedAt,
      fileFetchedAt: activeFile ? Date.now() : null
    },
    user: { email: email },
    roots: roots,
    rootErrors: [],
    session: session,
    folderEntries: any ? folderEntries : null,
    activeFile: activeFile,
    settings: DriveService.settingsFrom_(props[PROP_SETTINGS]),
    pins: DriveService.parsePinsRaw_(props[PROP_PINS]),
    tmpFolderId: props[PROP_TMP_FOLDER_ID] || null,
    tmpParent: DriveService.parseFolderRefRaw_(props[PROP_TMP_PARENT]),
    lastSaveFolder: DriveService.parseFolderRefRaw_(props[PROP_LAST_SAVE_FOLDER]),
    config: bootConfig_(directDriveEnabled_())
  };
}

/**
 * <script> 要素の中に置ける JSON にする。
 * '<' をバックスラッシュ + u003c に逃がせば "</script>" も "<!--" も無害になる。
 * 行区切り文字（U+2028 / U+2029）は JS の行末として解釈されうるので同様に逃がす。
 * @param {*} obj
 * @return {string}
 */
function safeJson_(obj) {
  var BS = '\\';   // バックスラッシュ 1 文字
  return JSON.stringify(obj)
    .split('<').join(BS + 'u003c')
    .split(String.fromCharCode(0x2028)).join(BS + 'u2028')
    .split(String.fromCharCode(0x2029)).join(BS + 'u2029');
}

/**
 * FAVICON_URL の状態を人が読める形で返す（?diag=favicon 用）。
 * 値そのものは秘密ではないが、目に見えない文字が混ざっている場合に
 * 気づけるよう、長さと文字コードも出す。
 *
 * @return {string}
 */
function faviconDiagnostics_() {
  var raw;
  try {
    raw = PropertiesService.getScriptProperties().getProperty(PROP_FAVICON_URL);
  } catch (e) {
    return 'プロパティを読めませんでした: ' + (e && e.message ? e.message : e);
  }

  if (raw === null || raw === undefined) {
    return 'FAVICON_URL は未設定です（プロパティが存在しません）。';
  }

  var lines = [];
  lines.push('生の値       : ' + JSON.stringify(raw));
  lines.push('長さ         : ' + raw.length);
  lines.push('先頭 10 文字 : ' + JSON.stringify(raw.slice(0, 10)));

  var codes = [];
  for (var i = 0; i < Math.min(raw.length, 10); i++) codes.push(raw.charCodeAt(i));
  lines.push('先頭の文字コード: ' + codes.join(' '));
  lines.push('（h=104 t=116 p=112 s=115 :=58 /=47 なので https:// は 104 116 116 112 115 58 47 47）');
  lines.push('');
  lines.push('検証の結果   : ' + (faviconUrl_() ? '通過 → ' + faviconUrl_() : '不合格（favicon は設定されません）'));
  return lines.join('\n');
}

/**
 * favicon の URL を返す。未設定なら null（既定のアイコンのまま）。
 *
 * === 制約（実際に配信 HTML を確認して確定させたもの）===
 *
 * 1. データ URI（data:image/...）は使えない。
 *    setFaviconUrl は例外も投げずに黙って無視し、
 *    <link rel="shortcut icon"> がまったく出力されない。
 *
 * 2. https の URL のみ有効。出力される type は image/x-icon 固定。
 *
 * 3. Drive に置いたファイルは使えない。ドメイン限定共有だと
 *    lh3.googleusercontent.com / uc?export=view / uc?export=download の
 *    いずれも画像ではなくログイン画面の HTML を返す。
 *    ブラウザが favicon を取りにいく時点では認証が効かないため。
 *
 * つまり「認証なしで取得できる https の URL」が必要になる。
 *
 * @return {string|null}
 */
function faviconUrl_() {
  var raw;
  try {
    raw = PropertiesService.getScriptProperties().getProperty(PROP_FAVICON_URL);
  } catch (e) {
    return null;
  }
  if (!raw) return null;

  var url = String(raw).trim();

  // 値が壊れていても setFaviconUrl は素通しするため、壊れた link がそのまま
  // 出力されて「設定したのにアイコンが出ない」状態になる。
  // 実際に先頭 2 文字が欠けた "tps://…" が入っていたことがあるので、
  // ここで弾いて理由をログに残す。
  if (url.indexOf('https://') !== 0) {
    console.warn('FAVICON_URL が https:// で始まっていません。設定を確認してください。値: ' + url);
    return null;
  }
  return url;
}

/**
 * HTML テンプレートの分割取り込み。index.html から <?!= include('css') ?> で呼ぶ。
 * @param {string} filename 拡張子を除いたファイル名
 * @return {string} ファイルの中身
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* ==================================================================== *
 *  共通ヘルパ
 * ==================================================================== */

/**
 * 成功レスポンスを組み立てる。
 * @param {*} data
 * @return {{ok:boolean, data:*}}
 */
function ok_(data) {
  return { ok: true, data: data === undefined ? null : data };
}

/**
 * 失敗レスポンスを組み立てる。エラーは必ず文字列としてクライアントへ返す。
 * @param {Error|*} err
 * @return {{ok:boolean, error:string, code:string, detail:*}}
 */
function fail_(err) {
  var code = (err && err.appCode) || 'UNKNOWN';
  var message = (err && err.message) ? String(err.message) : String(err);
  var detail = (err && err.appDetail) || null;

  // appCode を持たない＝想定外の例外。スタックを Stackdriver に残す。
  // 画面には中身（内部の関数名や URL などが混じりうる）を出さず、ログを引くための
  // 参照番号だけを返す。利用上限・時間切れだけは利用者が対処できるので言い分ける。
  if (!err || !err.appCode) {
    var ref = Utilities.getUuid().slice(0, 8);
    console.error('[UNHANDLED ' + ref + '] ' + message + '\n' + ((err && err.stack) || '(no stack)'));
    if (/too many times|Service invoked|quota|rate limit/i.test(message)) {
      code = 'LOCKED';
      message = 'Google のサービスの利用上限に達しました。しばらくおいて再試行してください。（参照: ' + ref + '）';
    } else if (/timed? ?out|exceeded maximum execution time/i.test(message)) {
      message = '処理に時間がかかりすぎたため中断しました。対象を絞って再試行してください。（参照: ' + ref + '）';
    } else {
      message = '予期しないエラーが発生しました。続く場合は管理者にこの参照番号を伝えてください。（参照: ' + ref + '）';
    }
  } else {
    console.warn('[' + code + '] ' + message);
  }

  return { ok: false, error: message, code: code, detail: detail };
}

/**
 * 本体処理を try/catch で包み、共通レスポンス形に変換する。
 * あわせて所要時間を実行ログに出す。
 *
 * どのサーバー処理が重いのかは推測ではなく実測で判断したいので、
 * すべての公開 API がここを通るようにしてある。
 * ログは Apps Script エディタの［実行数］か Cloud Logging で見られる。
 *
 * @param {string} label API 名
 * @param {function(): *} fn
 * @return {Object}
 */
function guard_(label, fn) {
  var t0 = Date.now();
  var T = timer_();
  try {
    return ok_(fn(T));
  } catch (err) {
    return fail_(err);
  } finally {
    console.log('[perf] ' + label + ' ' + (Date.now() - t0) + 'ms' +
      (T.marks.length ? ' stages ' + T.line() : ''));
  }
}

/**
 * 段階タイマー。fn(T) の中で T.mark('props') のように区切りを打つと、
 * guard_ が「props=52 roots=610 list=380 total=1100」の形で 1 行にまとめて出す。
 * どの段が支配的かを Cloud Logging で追うためのもの。
 * @return {{marks:string[], mark:function(string), line:function():string}}
 */
function timer_() {
  var t0 = Date.now();
  var last = t0;
  var marks = [];
  return {
    marks: marks,
    mark: function (name) {
      var now = Date.now();
      marks.push(name + '=' + (now - last));
      last = now;
    },
    line: function () { return marks.join(' ') + ' total=' + (Date.now() - t0); }
  };
}

/* ==================================================================== *
 *  クライアント公開 API
 * ==================================================================== */

/**
 * 起動時に必要な情報を 1 往復でまとめて返す。
 *
 * 保存済みの基準フォルダがあり、かつ今もアクセス可能なら、その一覧まで同梱して返す。
 * これにより「起動 → 一覧表示」が 1 往復で済む。
 *
 * @return {{ok:boolean, data?:{
 *   user: {email: string},
 *   roots: Array<{id:string, name:string}>,
 *   rootErrors: Array<{id:string, error:string}>,
 *   folderEntries: (Object|null),
 *   session: (Object|null),
 *   activeFile: (Object|null),
 *   tmpFolderId: (string|null),
 *   tmpParent: ({id:string, name:string}|null),
 *   lastSaveFolder: ({id:string, name:string}|null),
 *   settings: Object,
 *   config: Object
 * }, error?:string, code?:string}}
 */
function getBootstrap() {
  return guard_('getBootstrap', function (T) {
    var email = '';
    try {
      email = Session.getActiveUser().getEmail() || '';
    } catch (e) {
      email = '';
    }
    T.mark('email');
    var directDrive = directDriveEnabled_();

    // UserProperties は 1 回で全部読む。
    // 以前は tmp / lastSaveFolder / settings / roots / session を別々の getProperty で読んでいた。
    var props = {};
    try {
      props = PropertiesService.getUserProperties().getProperties() || {};
    } catch (e) {
      props = {};
    }

    var savedRoots = DriveService.parseRootsRaw_(props[PROP_ROOTS]);
    if (savedRoots === null) {
      savedRoots = [];
      if (props[PROP_BASE_FOLDER_ID]) {
        // 旧形式（単一の基準フォルダ）からの移行。
        savedRoots = [{ id: String(props[PROP_BASE_FOLDER_ID]), name: '' }];
        DriveService.saveRoots_(savedRoots);
        try {
          PropertiesService.getUserProperties().deleteProperty(PROP_BASE_FOLDER_ID);
        } catch (e) {
          // 消せなくても次回また移行するだけ。
        }
      }
    }
    var session = DriveService.parseSessionRaw_(props[PROP_SESSION]);

    var result = {
      user: { email: email },
      roots: [],
      rootErrors: [],
      folderEntries: null,
      session: null,
      activeFile: null,
      // tmp フォルダの実体は、実際に一時メモを使うまで作らない（null なら未作成）。
      tmpFolderId: props[PROP_TMP_FOLDER_ID] || null,
      // 一時メモを置く親フォルダ（未設定 = マイドライブ）。表示用に名前も持つ。
      tmpParent: DriveService.parseFolderRefRaw_(props[PROP_TMP_PARENT]),
      lastSaveFolder: DriveService.parseFolderRefRaw_(props[PROP_LAST_SAVE_FOLDER]),
      settings: DriveService.settingsFrom_(props[PROP_SETTINGS]),
      // ピン留めはファイル ID の記録で、ルートの有無に依存しない。
      // ルートが 1 つも無い場合の早期 return より前で入れておく。
      pins: DriveService.parsePinsRaw_(props[PROP_PINS]),
      config: bootConfig_(directDrive)
    };
    if (directDrive) {
      // アクセス中ユーザー自身のトークン。クライアントはメモリにだけ置き、Drive REST を直接叩く。
      result.token = { value: token_(), obtainedAt: Date.now() };
    }
    T.mark('props');
    if (!savedRoots.length) return result;

    if (restAvailable_()) {
      try {
        return getBootstrapRest_(result, savedRoots, session, T);
      } catch (e) {
        if (!(e && e.restFailure)) throw e;
        // UrlFetchApp が使えない環境。DriveApp 経路でやり直す。
      }
    }
    return getBootstrapLegacy_(result, savedRoots, session, T);
  });
}

/**
 * getBootstrap の本体（REST 版）。
 *
 * Drive への問い合わせを 1 回の fetchAll にまとめる:
 *   - ルートごとの files.get（アクセス可否と名前。以前は DriveApp で 1 件ずつ直列）
 *   - ルート + 展開中フォルダの files.list（15 親ずつに分けて並列）
 *   - アクティブなタブの files.get と alt=media（以前は一覧の後に直列）
 *   - 共有ドライブ名の対応表が cold なら drives.list
 * CacheService も getAll / putAll で 1 回ずつ。
 * 取った一覧と本文はスナップショットとして 6 時間残し、doGet がインライン描画に使う。
 *
 * @param {Object} result 組み立て途中の応答
 * @param {Array<{id:string,name:string}>} savedRoots
 * @param {Object|null} session
 * @param {{mark:function(string)}} T 段階タイマー
 * @return {Object}
 */
function getBootstrapRest_(result, savedRoots, session, T) {
  var wanted = [];
  var rootSet = {};
  for (var r = 0; r < savedRoots.length; r++) {
    if (!validId_(savedRoots[r].id)) continue;
    wanted.push(savedRoots[r].id);
    rootSet[savedRoots[r].id] = true;
  }
  if (session && Array.isArray(session.expanded)) {
    for (var e = 0; e < session.expanded.length && wanted.length < MAX_MULTI_LIST; e++) {
      var ex = String(session.expanded[e] || '');
      if (validId_(ex) && ex !== 'root' && wanted.indexOf(ex) < 0) wanted.push(ex);
    }
  }
  var activeId = DriveService.activeTextTabId_(session);

  // ---- CacheService を 1 回で ----
  var keys = ['sharedDriveNames', 'sharedDriveNamesFailed'];
  for (var w = 0; w < wanted.length; w++) keys.push('list:' + wanted[w]);
  var cached = DriveService.cacheGetAll_(keys);
  var names = DriveService.parseJson_(cached['sharedDriveNames']);
  if (names) memo_.driveNames = names;
  var freshLists = {};
  for (var w2 = 0; w2 < wanted.length; w2++) {
    var v = DriveService.parseJson_(cached['list:' + wanted[w2]]);
    if (v && DriveService.isFresh_(v)) { v.fromCache = true; freshLists[wanted[w2]] = v; }
  }
  T.mark('cache');

  // ---- Drive を fetchAll 1 回で ----
  var reqs = [];
  var tags = [];
  for (var i = 0; i < savedRoots.length; i++) {
    if (!rootSet[savedRoots[i].id]) continue;
    reqs.push(metaReq_(savedRoots[i].id, 'id,name,mimeType,driveId,trashed'));
    tags.push({ t: 'root', root: savedRoots[i] });
  }
  var toList = [];
  for (var l = 0; l < wanted.length; l++) if (!freshLists[wanted[l]]) toList.push(wanted[l]);
  var chunks = chunk_(toList, MAX_PARENTS_PER_LIST_REQ);
  for (var c = 0; c < chunks.length; c++) {
    reqs.push(listReq_(chunks[c], null));
    tags.push({ t: 'list', ids: chunks[c] });
  }
  if (activeId) {
    reqs.push(metaReq_(activeId, 'id,name,mimeType,size,modifiedTime'));
    tags.push({ t: 'meta' });
    reqs.push(mediaReq_(activeId));
    tags.push({ t: 'media' });
  }
  var needDrives = (names === null && !cached['sharedDriveNamesFailed']);
  if (needDrives) {
    reqs.push(req_('drives', { pageSize: 100, fields: 'nextPageToken,drives(id,name)' }));
    tags.push({ t: 'drives' });
  }

  var resps = fetchAll_(reqs);
  T.mark('fetch');

  // ---- 組み立て ----
  var buckets = {};
  var pending = [];
  var meta = null;
  var media = null;
  var rootResps = [];
  for (var k = 0; k < resps.length; k++) {
    var tag = tags[k];
    var rs = resps[k];
    if (tag.t === 'drives') {
      if (rs.ok) {
        names = {};
        var dj = rs.json();
        var ds = dj.drives || [];
        for (var d = 0; d < ds.length; d++) names[ds[d].id] = ds[d].name;
        memo_.driveNames = names;
        // 1 ページ（100 件）で読み切れたときだけ覚える。途中までの表を 30 分残すと、
        // フォルダ選択画面（listPickerRoots_）に 101 件目以降の共有ドライブが出なくなる。
        // 読み切れなかったら、次に sharedDriveNames_ が全ページを取り直す。
        if (!dj.nextPageToken) {
          DriveService.cachePut_('sharedDriveNames', JSON.stringify(names), SHARED_DRIVE_NAME_TTL_SEC);
        }
      } else {
        DriveService.cachePut_('sharedDriveNamesFailed', '1', SHARED_DRIVE_FAIL_TTL_SEC);
      }
    } else if (tag.t === 'root') {
      rootResps.push({ root: tag.root, rs: rs });
    } else if (tag.t === 'list') {
      if (!rs.ok) continue;   // 失敗チャンクは黙って落とす（旧 listEntriesMany_ と同じ方針）
      var body = rs.json();
      DriveService.bucketize_(body.files || [], tag.ids, buckets);
      if (body.nextPageToken) pending.push({ ids: tag.ids, token: body.nextPageToken });
    } else if (tag.t === 'meta') {
      meta = rs;
    } else if (tag.t === 'media') {
      media = rs;
    }
  }

  // ルート。共有ドライブのルートは files.get の名前が汎用名のことがあるので対応表で上書きする。
  // files.get が通らない共有ドライブでも、対応表に載っていればアクセス可として扱う。
  var nameChanged = false;
  for (var q = 0; q < rootResps.length; q++) {
    var root = rootResps[q].root;
    var rr = rootResps[q].rs;
    if (rr.ok) {
      var m = rr.json();
      if (m.trashed) {
        result.rootErrors.push({ id: root.id, name: root.name, error: 'フォルダがゴミ箱に入っています。' });
        continue;
      }
      if (m.mimeType !== FOLDER_MIME) {
        result.rootErrors.push({ id: root.id, name: root.name, error: 'フォルダではありません。' });
        continue;
      }
      var nm = (names && names[m.id]) || m.name || root.name;
      if (nm !== root.name) nameChanged = true;
      result.roots.push({ id: m.id, name: nm });
    } else if (names && names[root.id]) {
      if (names[root.id] !== root.name) nameChanged = true;
      result.roots.push({ id: root.id, name: names[root.id] });
    } else {
      result.rootErrors.push({ id: root.id, name: root.name, error: driveErr_(rr, 'フォルダ').message });
    }
  }
  // 開けなかったルートは rootErrors に出すだけで、保存済みの一覧からは外さない。
  if (nameChanged && result.roots.length) {
    DriveService.saveRoots_(DriveService.renameRoots_(savedRoots, result.roots));
  }
  if (!result.roots.length) return result;
  result.session = session;

  // 一覧のページ継続（稀）。並列で最大 4 回まで追う。
  for (var round = 0; round < 4 && pending.length; round++) {
    var more = fetchAll_(pending.map(function (p) { return listReq_(p.ids, p.token); }));
    var next = [];
    for (var mi = 0; mi < more.length; mi++) {
      if (!more[mi].ok) continue;
      var b2 = more[mi].json();
      DriveService.bucketize_(b2.files || [], pending[mi].ids, buckets);
      if (b2.nextPageToken) next.push({ ids: pending[mi].ids, token: b2.nextPageToken });
    }
    pending = next;
  }
  var truncatedIds = {};
  for (var pi = 0; pi < pending.length; pi++) {
    for (var ti = 0; ti < pending[pi].ids.length; ti++) truncatedIds[pending[pi].ids[ti]] = true;
  }

  var okRoots = {};
  for (var o = 0; o < result.roots.length; o++) okRoots[result.roots[o].id] = true;
  result.folderEntries = {};
  var toPut = {};
  for (var f = 0; f < wanted.length; f++) {
    var id = wanted[f];
    if (rootSet[id] && !okRoots[id]) continue;   // 開けなかったルートの中身は返さない
    var entry = freshLists[id] ||
      (buckets[id] ? DriveService.finishBucket_(id, buckets[id], !!truncatedIds[id]) : null);
    if (!entry) continue;
    result.folderEntries[id] = entry;
    if (!freshLists[id]) toPut['list:' + id] = entry;
  }

  // アクティブだったタブの本文。開けない・消えた場合はクライアントが readFile で改めて取りに行く。
  if (activeId && meta && media && meta.ok) {
    try {
      var payload = DriveService.assembleRead_(activeId, meta.json(), media);
      if (payload.content.length <= MAX_INLINE_CONTENT_CHARS) {
        result.activeFile = payload;
        toPut['snap:file:' + activeId] = payload;
      }
    } catch (e2) {
      // 開けない種別・サイズ超過など。
    }
  }
  // 取ったものをスナップショットとして 1 回で書く（doGet がインライン描画に使う）。
  DriveService.cachePutAllJson_(toPut, SNAPSHOT_TTL_SEC);
  T.mark('assemble');
  return result;
}

/**
 * getBootstrap の本体（DriveApp 経路）。UrlFetchApp が使えない環境のフォールバック。
 * ルートを 1 件ずつ検証してから一覧と本文を直列に取る旧実装。
 */
function getBootstrapLegacy_(result, saved, session, T) {
  result.roots = [];
  result.rootErrors = [];
  result.folderEntries = null;
  result.session = null;
  result.activeFile = null;

  // 開けなくなったルートがあっても起動自体は成功させ、
  // 理由を添えて残りのルートで続行する（全滅なら選択画面へ誘導される）。
  var nameChanged = false;
  for (var i = 0; i < saved.length; i++) {
    try {
      var access = DriveService.assertFolderAccess_(saved[i].id);
      if (access.name !== saved[i].name) nameChanged = true;
      result.roots.push({ id: access.id, name: access.name });
    } catch (err) {
      result.rootErrors.push({
        id: saved[i].id,
        name: saved[i].name,
        error: (err && err.message) ? String(err.message) : String(err)
      });
    }
  }
  // Drive 側で名前が変わっていたら覚え直す。
  if (nameChanged && result.roots.length) DriveService.saveRoots_(DriveService.renameRoots_(saved, result.roots));
  T.mark('roots');

  if (!result.roots.length) return result;
  result.session = session;

  // 前回の状態の復元に必要なものを、ここで全部積んでしまう。
  // 分けて呼ぶと getBootstrap → listEntriesMulti → readFile の
  // 直列 3 往復になり、コールドスタート時に往復ぶんそのまま待たされる。
  var wanted = [];
  for (var r = 0; r < result.roots.length; r++) wanted.push(result.roots[r].id);
  if (session && Array.isArray(session.expanded)) {
    for (var e = 0; e < session.expanded.length; e++) {
      if (wanted.indexOf(session.expanded[e]) < 0) wanted.push(session.expanded[e]);
    }
  }
  result.folderEntries = DriveService.listEntriesMany_(wanted);
  T.mark('list');

  // アクティブだったタブの本文。ビューアで開く種別（PDF・画像・Google ドキュメント類）は持たない。
  var activeId = DriveService.activeTextTabId_(session);
  if (activeId) {
    try {
      var payload = DriveService.readText_(activeId);
      if (payload.content.length <= MAX_INLINE_CONTENT_CHARS) {
        result.activeFile = payload;
      }
    } catch (e2) {
      // 消えた／権限が外れた／大きすぎる。
      // クライアントが readFile で改めて取りに行き、失敗ならタブを閉じる。
    }
    T.mark('read');
  }
  return result;
}

/**
 * フォルダ選択画面のルート一覧を返す。
 *
 * マイドライブと、ユーザーが参加している共有ドライブ。
 * 共有ドライブの列挙は DriveApp ではできないため Drive API を使う。
 * 取得できなかった場合は sharedDrivesAvailable:false を返し、
 * クライアントは URL 貼り付けでの指定を案内する。
 *
 * @return {{ok:boolean, data?:{roots:Array<{id:string,name:string,kind:string}>,
 *           sharedDrivesAvailable:boolean}, error?:string, code?:string}}
 */
function listPickerRoots() {
  return guard_('listPickerRoots', function () {
    return DriveService.listPickerRoots_();
  });
}

/**
 * フォルダツリーを 1 階層だけ展開する（遅延ロード）。
 * 全階層を一括取得すると重いので、必ずこの API を階層ごとに呼ぶ。
 *
 * @param {string|null} parentFolderId null / 未指定ならマイドライブのルート
 * @return {{ok:boolean, data?:{
 *   parent: {id:string, name:string},
 *   folders: Array<{id:string, name:string}>,
 *   truncated: boolean
 * }, error?:string, code?:string}}
 */
function listFolderChildren(parentFolderId) {
  return guard_('listFolderChildren', function () {
    return DriveService.listSubFolders_(parentFolderId || null);
  });
}

/**
 * フォルダの URL または ID を解決し、現在のユーザーからアクセスできるか検証する。
 * 共有ドライブ内のフォルダを指定する用途を想定。
 *
 * @param {string} refText フォルダ URL または生の ID
 * @return {{ok:boolean, data?:{
 *   id: string, name: string, breadcrumb: Array<{id:string, name:string}>
 * }, error?:string, code?:string}}
 */
function resolveFolderRef(refText) {
  return guard_('resolveFolderRef', function () {
    var id = DriveService.extractFolderId_(refText);
    // 共有ドライブのルートは DriveApp から開けないことがあるので、
    // 基準フォルダの検証は読み取り用の assertFolderAccess_ を使う。
    var access = DriveService.assertFolderAccess_(id);
    return {
      id: access.id,
      name: access.name,
      breadcrumb: access.folder
        ? DriveService.breadcrumb_(access.folder, null)
        : [{ id: access.id, name: access.name }]
    };
  });
}

/**
 * ツリーに並べるルートフォルダを 1 つ追加し、そのフォルダの一覧も返す。
 * 「検証 → 保存 → 一覧取得」を 1 往復にまとめている。
 *
 * 既に入っている場合は added:false を返す（名前だけ更新する）。
 * 開いているタブは閉じない。別のフォルダが増えるだけで、
 * 今開いているファイルはそのまま編集を続けられる。
 *
 * @param {string} folderId
 * @return {{ok:boolean, data?:{
 *   root: {id:string, name:string},
 *   roots: Array<{id:string, name:string}>,
 *   added: boolean,
 *   entries: Object
 * }, error?:string, code?:string}}
 */
function addRoot(folderId) {
  return guard_('addRoot', function () {
    var res = DriveService.addRoot_(folderId);
    return {
      root: res.root,
      roots: res.roots,
      added: res.added,
      entries: DriveService.listEntries_(res.root.id, true)
    };
  });
}

/**
 * ルートフォルダを 1 つ外す。Drive 上のフォルダには触らない。
 *
 * そのフォルダ配下のファイルを開いていた場合、タブを閉じるかどうかは
 * クライアント側の判断に任せる（編集中のものを勝手に閉じないため）。
 *
 * @param {string} folderId
 * @return {{ok:boolean, data?:{roots:Array<{id:string, name:string}>},
 *           error?:string, code?:string}}
 */
function removeRoot(folderId) {
  return guard_('removeRoot', function () {
    return DriveService.removeRoot_(folderId);
  });
}

/**
 * 指定フォルダ直下のサブフォルダとファイルを返す。
 * サイドバーの表示・更新ボタン・パンくずでの階層移動すべてがこの API を使う。
 *
 * 開けないファイル（Google 独自形式・バイナリ・5MB 超）も openable:false と
 * reason 付きで返すので、UI 側でグレー表示＋ツールチップにできる。
 *
 * @param {string} folderId 表示するフォルダ
 * @param {boolean} [forceRefresh] true で一覧キャッシュ（30 秒）をバイパス
 * @return {{ok:boolean, data?:{
 *   folder: {id:string, name:string},
 *   folders: Array<{id:string, name:string}>,
 *   files: Array<{id:string, name:string, mimeType:string, size:number,
 *                 updatedAtIso:string,
 *                 kind:('text'|'pdf'|'doc'|'sheet'|'slide'|'drawing'|'media'|'google'|'binary'),
 *                 viewer:('editor'|'embed'|null), openable:boolean, reason:(string|null)}>,
 *   truncated: boolean,
 *   fromCache: boolean
 * }, error?:string, code?:string}}
 */
function listEntries(folderId, forceRefresh) {
  return guard_('listEntries', function () {
    return DriveService.listEntries_(folderId, !!forceRefresh);
  });
}

/**
 * ファイル本文を取得する。
 * 返す updatedAtIso はクライアントが保持し、保存時に競合検出の基準として送り返す。
 *
 * knownUpdatedAtIso を渡すと、Drive 側の更新日時がそれと同じなら本文を送らず
 * {unchanged:true, content:null} を返す（クライアントが本文を持っている場合の再検証用）。
 *
 * @param {string} fileId
 * @param {string} [knownUpdatedAtIso]
 * @return {{ok:boolean, data?:{
 *   id:string, name:string, mimeType:string, size:number,
 *   content:(string|null), updatedAtIso:string, unchanged:boolean, fromCache:boolean
 * }, error?:string, code?:string}}
 */
function readFile(fileId, knownUpdatedAtIso) {
  return guard_('readFile', function () {
    return DriveService.readText_(fileId, knownUpdatedAtIso || null);
  });
}

/**
 * 複数ファイルの本文を 1 往復でまとめて取得する（開いているタブの先読み用）。
 * 読めなかったファイルは結果に含めない（全体をエラーにはしない）。
 *
 * @param {Array<string>} fileIds 最大 20 件
 * @return {{ok:boolean, data?:Object<string, Object>, error?:string, code?:string}}
 */
function readFilesMulti(fileIds) {
  return guard_('readFilesMulti', function () {
    return DriveService.readMany_(fileIds || []);
  });
}

/**
 * 空のテキストファイルを新規作成する。
 *
 * 開けない拡張子（ホワイトリスト外）や同名ファイルがある場合は作成せずエラーを返す。
 * 作成しても一覧でグレー表示になるだけなので、事前に止めたほうが親切なため。
 *
 * @param {string} folderId 作成先フォルダ
 * @param {string} name ファイル名（拡張子込み）
 * @return {{ok:boolean, data?:Object, error?:string, code?:string}}
 */
function createFile(folderId, name) {
  return guard_('createFile', function () {
    return DriveService.createTextFile_(folderId, name);
  });
}

/**
 * ファイル名を変更する。
 *
 * setName は Drive の更新日時も変えるため、戻り値の updatedAtIso で
 * クライアント側の競合検出の基準値を必ず差し替えること。
 *
 * @param {string} fileId
 * @param {string} newName
 * @return {{ok:boolean, data?:Object, error?:string, code?:string}}
 */
function renameFile(fileId, newName) {
  return guard_('renameFile', function () {
    return DriveService.renameFile_(fileId, newName);
  });
}

/**
 * ファイルをゴミ箱へ移動する。完全削除はしない（Drive のゴミ箱から復元できる）。
 *
 * @param {string} fileId
 * @return {{ok:boolean, data?:{id:string, name:string}, error?:string, code?:string}}
 */
function trashFile(fileId) {
  return guard_('trashFile', function () {
    return DriveService.trashFile_(fileId);
  });
}

/**
 * 複数フォルダの中身を 1 往復でまとめて取得する。
 *
 * ツリーの展開状態を復元するとき、展開されていたフォルダの数だけ listEntries を
 * 呼ぶと往復がその回数ぶん発生してしまう。それを 1 回にまとめるための API。
 * 通常の展開操作（1 フォルダ）では listEntries を使う。
 *
 * アクセスできないフォルダは結果から黙って落とす（消えている可能性があるため、
 * 全体をエラーにはしない）。
 *
 * @param {Array<string>} folderIds 最大 30 件まで
 * @return {{ok:boolean, data?:Object<string, {folders:Array, files:Array, truncated:boolean}>,
 *           error?:string, code?:string}}
 */
function listEntriesMulti(folderIds) {
  return guard_('listEntriesMulti', function () {
    return DriveService.listEntriesMany_(folderIds);
  });
}

/**
 * フォルダの名前を変更する。
 *
 * @param {string} folderId
 * @param {string} newName
 * @return {{ok:boolean, data?:{id:string,name:string}, error?:string, code?:string}}
 */
function renameFolder(folderId, newName) {
  return guard_('renameFolder', function () {
    return DriveService.renameFolder_(folderId, newName);
  });
}

/**
 * フォルダをゴミ箱へ移動する。中身ごと移動するが、Drive のゴミ箱から復元できる。
 *
 * @param {string} folderId
 * @return {{ok:boolean, data?:{id:string,name:string}, error?:string, code?:string}}
 */
function trashFolder(folderId) {
  return guard_('trashFolder', function () {
    return DriveService.trashFolder_(folderId);
  });
}

/**
 * ファイルを複製する。コピー／貼り付けと「複製」の両方から使う。
 *
 * @param {string} fileId
 * @param {string} destFolderId 複製先フォルダ
 * @param {string} [newName] 省略時は「元の名前 のコピー」を自動で採番する
 * @return {{ok:boolean, data?:Object, error?:string, code?:string}}
 */
function copyFile(fileId, destFolderId, newName) {
  return guard_('copyFile', function () {
    return DriveService.copyFile_(fileId, destFolderId, newName || null);
  });
}

/**
 * ファイルを別のフォルダへ移動する（ツリーのドラッグ＆ドロップ用）。
 *
 * @param {string} fileId
 * @param {string} destFolderId
 * @return {{ok:boolean, data?:Object, error?:string, code?:string}}
 */
function moveFile(fileId, destFolderId) {
  return guard_('moveFile', function () {
    return DriveService.moveFile_(fileId, destFolderId);
  });
}

/**
 * フォルダを別のフォルダへ移動する。
 * 自分自身や自分の子孫が移動先の場合は拒否する（循環参照になるため）。
 *
 * @param {string} folderId
 * @param {string} destFolderId
 * @return {{ok:boolean, data?:{id:string,name:string}, error?:string, code?:string}}
 */
function moveFolder(folderId, destFolderId) {
  return guard_('moveFolder', function () {
    return DriveService.moveFolder_(folderId, destFolderId);
  });
}

/**
 * サブフォルダを作成する。
 *
 * @param {string} parentFolderId
 * @param {string} name
 * @return {{ok:boolean, data?:{id:string,name:string}, error?:string, code?:string}}
 */
function createFolder(parentFolderId, name) {
  return guard_('createFolder', function () {
    return DriveService.createFolder_(parentFolderId, name);
  });
}

/* -------------------------------------------------------------------- *
 *  一時メモ（とっさのメモ）
 *
 *  マイドライブ（設定で変えられる）の「Googleドライブテキストエディタ / tmp」に
 *  実ファイルとして作る。実ファイルなので、以降の自動保存・競合検出・セッション復元は
 *  通常のファイルとまったく同じ経路（saveFile / readFile）を通る。
 *  ここに置く API は「作る」「一覧」「保存先を確定する」「掃除する」の 4 つだけ。
 * -------------------------------------------------------------------- */

/**
 * 一時メモを 1 つ作る。
 *
 * 溜まった古いメモの掃除もここで一緒に走らせる（12 時間に 1 回まで）。
 * ユーザーは既に Drive への書き込みを待っているので、体感が変わらない。
 *
 * @return {{ok:boolean, data?:{
 *   entry: Object, folder: {id:string, name:string}, swept: number
 * }, error?:string, code?:string}}
 */
function createTempFile() {
  return guard_('createTempFile', function () {
    var settings = DriveService.loadSettings_();
    var created = DriveService.createTempFile_(settings.tmpExtension);
    return {
      entry: created.entry,
      folder: created.folder,
      swept: DriveService.maybeSweepTemp_(settings.tmpRetentionDays)
    };
  });
}

/**
 * 一時メモの一覧を返す（サイドバーの「一時メモ」セクション用）。
 * まだ一度も使っていなければフォルダをここで作る。
 *
 * @param {boolean} [forceRefresh] 一覧キャッシュを無視する
 * @return {{ok:boolean, data?:{
 *   folder: {id:string, name:string}, entries: Object, swept: number
 * }, error?:string, code?:string}}
 */
function listTempEntries(forceRefresh) {
  return guard_('listTempEntries', function () {
    var settings = DriveService.loadSettings_();
    return DriveService.withTmpFolder_(function (folder) {
      var swept = DriveService.maybeSweepTemp_(settings.tmpRetentionDays);
      return {
        folder: folder,
        entries: DriveService.listEntries_(folder.id, !!forceRefresh || swept > 0),
        swept: swept
      };
    });
  });
}

/**
 * 一時メモの保存先を確定する（保存 → 改名 → 移動を 1 往復で行う）。
 *
 * @param {string} fileId
 * @param {string} destFolderId
 * @param {string} newName
 * @param {string} content 本文（null なら触らない）
 * @param {string} baseUpdatedAtIso 競合検出の基準
 * @param {boolean} [force] 競合を無視して上書きするか
 * @return {{ok:boolean, data?:{
 *   entry: Object, folder: {id:string, name:string}, timestampVerified: boolean
 * }, error?:string, code?:string, detail?:Object}}
 */
function promoteTempFile(fileId, destFolderId, newName, content, baseUpdatedAtIso, force) {
  return guard_('promoteTempFile', function () {
    return DriveService.promoteTempFile_(
      fileId, destFolderId, newName, content, baseUpdatedAtIso, !!force);
  });
}

/**
 * 一時メモの置き場所（親フォルダ）を変える。
 *
 * 選ぶのは親フォルダで、実体はその下の「<アプリ名> / tmp」。掃除が
 * ユーザーの既存ファイルを巻き込まないよう、自動でゴミ箱へ移す対象を
 * 必ずアプリが作ったフォルダの中に閉じるため。
 *
 * まだ一度も一時メモを使っていなければ記録だけして実体は作らない
 * （初回起動時に選ばれても、Drive にフォルダを作らずに済ませる）。
 * 実体があれば新しい場所に作り直し、中のファイルをそこへ移す。
 *
 * @param {string|null} parentId 親フォルダの ID。null / '' で既定（マイドライブ）へ戻す
 * @return {{ok:boolean, data?:{
 *   parent: ({id:string, name:string}|null),
 *   folder: ({id:string, name:string}|null),
 *   previousFolderId: (string|null),
 *   moved: number, failed: number, hasMore: boolean, unchanged: boolean
 * }, error?:string, code?:string}}
 */
function setTempFolder(parentId) {
  return guard_('setTempFolder', function () {
    return DriveService.setTempFolder_(parentId || null);
  });
}

/**
 * 古い一時メモをゴミ箱へ移す。設定画面から明示的に呼ぶ用。
 * 期間の判定は設定（tmpRetentionDays）に従う。
 *
 * @return {{ok:boolean, data?:{trashed:number, scanned:number},
 *           error?:string, code?:string}}
 */
function sweepTempFiles() {
  return guard_('sweepTempFiles', function () {
    var settings = DriveService.loadSettings_();
    return DriveService.sweepTempFiles_(settings.tmpRetentionDays);
  });
}

/**
 * ルート配下のテキストファイルの中身を検索する。
 *
 * Drive の全文索引（fullText contains）で候補を絞り、
 * そのうち上位だけ本文を取って一致行を組み立てる二段構え。
 * 全ファイルを読んで検索すると往復もダウンロード量も跳ねるため。
 *
 * 制約:
 *  - 索引の反映が遅れるので、保存直後の内容は見つからないことがある
 *  - 正規表現は使えない（索引は語単位の一致）
 *
 * @param {string} query 2 文字以上
 * @param {Array<string>} rootIds 検索対象のルートフォルダ
 * @param {{caseSensitive:boolean}} [opts]
 * @return {{ok:boolean, data?:Object, error?:string, code?:string}}
 */
function searchContents(query, rootIds, opts) {
  return guard_('searchContents', function () {
    return DriveService.searchContents_(query, rootIds || [], opts || {});
  });
}

/**
 * ファイルの過去のリビジョンを一覧する（VS Code のタイムライン相当）。
 *
 * @param {string} fileId
 * @return {{ok:boolean, data?:{revisions:Array}, error?:string, code?:string}}
 */
function listRevisions(fileId) {
  return guard_('listRevisions', function () {
    return DriveService.listRevisions_(fileId);
  });
}

/**
 * 指定リビジョンの本文を取得する。
 *
 * Drive 上のファイルは書き換えない。中身を返してエディタに載せるだけなので、
 * 復元したい場合はその状態で保存する（競合検出も通常どおり働く）。
 *
 * @param {string} fileId
 * @param {string} revisionId
 * @return {{ok:boolean, data?:{content:string}, error?:string, code?:string}}
 */
function readRevision(fileId, revisionId) {
  return guard_('readRevision', function () {
    return DriveService.readRevision_(fileId, revisionId);
  });
}

/**
 * ユーザー設定を保存する。値はサーバー側で型と範囲へ丸める。
 *
 * @param {Object} settings
 * @return {{ok:boolean, data?:Object, error?:string, code?:string}}
 */
function saveSettings(settings) {
  return guard_('saveSettings', function () {
    return DriveService.saveSettings_(settings);
  });
}

/**
 * ブラウザからドラッグ＆ドロップされたファイルを Drive に作る。
 *
 * テキストもバイナリも Base64 で受け取る。文字コードの解釈を
 * クライアント側でやらずに済み、PDF や画像も同じ経路で扱える。
 * 上限は 2MB（Base64 で 4/3 に膨らんだものが google.script.run の
 * リクエストとして飛ぶため、編集の上限 5MB より小さく取っている）。
 *
 * 同名のファイルがある場合は上書きせず「… のコピー」に退避する。
 *
 * @param {string} folderId
 * @param {string} name
 * @param {string} base64
 * @param {string} mimeType
 * @return {{ok:boolean, data?:Object, error?:string, code?:string}}
 */
function uploadFile(folderId, name, base64, mimeType) {
  return guard_('uploadFile', function () {
    return DriveService.uploadFile_(folderId, name, base64, mimeType || '');
  });
}

/**
 * 開いていたタブなどのセッションを保存する。
 *
 * 画面をリロードしても開き直さずに済むようにするための保存で、
 * ファイル ID と表示名しか持たない（本文は常に Drive が真実の保存先）。
 * クライアント側でデバウンスしてから呼ぶこと。失敗しても致命的ではないので、
 * クライアントはエラーを握りつぶしてよい。
 *
 * @param {{activeId:(string|null), tabs:Array<{id:string, name:string, kind:string}>,
 *          expanded:Array<string>, sidebarWidth:(number|undefined),
 *          sidebarHidden:(boolean|undefined)}} session
 * @return {{ok:boolean, data?:{tabs:number}, error?:string, code?:string}}
 */
function saveSession(session) {
  return guard_('saveSession', function () {
    return DriveService.saveSession_(session);
  });
}

/**
 * ピン留めしたファイルの一覧を保存する。
 *
 * セッションと違って「前回の画面」ではなく「よく使うファイル」の記録なので、
 * 別の値（UserProperties の 'pins'）に分けてある。持つのはファイル ID と
 * 表示名・種別だけで、並び順はクライアントが渡したものをそのまま正とする。
 *
 * @param {{items:Array<{id:string, name:string, kind:string}>,
 *          collapsed:(boolean|undefined)}} pins
 * @return {{ok:boolean, data?:{count:number}, error?:string, code?:string}}
 */
function savePins(pins) {
  return guard_('savePins', function () {
    return DriveService.savePins_(pins);
  });
}

/**
 * ファイルを保存する。
 *
 * baseUpdatedAtIso が Drive 側の現在の更新日時と食い違う場合、
 * force が false なら保存せず code:'CONFLICT' を返す。
 * detail.serverUpdatedAtIso にサーバー側の更新日時を入れるので、
 * クライアントは上書き確認ダイアログを出して force:true で再送できる。
 *
 * 保存に成功したら必ず新しい updatedAtIso を返す。
 * クライアントはこれで基準値を差し替えること（差し替えないと次回が必ず競合になる）。
 *
 * @param {string} fileId
 * @param {string} content 保存する全文
 * @param {string} baseUpdatedAtIso 開いた／最後に保存した時点の更新日時（ISO 8601）
 * @param {boolean} [force] true なら競合を無視して上書き
 * @param {string} [encoding] 'Shift_JIS' ならその文字コードで書く（既定は UTF-8）
 * @param {boolean} [bom] UTF-8 の先頭に BOM を付ける（開いたときに付いていたファイル）
 * @return {{ok:boolean, data?:{
 *   updatedAtIso:string, size:number, name:string, timestampVerified:boolean
 * }, error?:string, code?:string, detail?:{serverUpdatedAtIso:string, name:string}}}
 */
function saveFile(fileId, content, baseUpdatedAtIso, force, encoding, bom) {
  return guard_('saveFile', function () {
    // 一覧キャッシュ（30 秒）はここで消さない。一覧の updatedAtIso は表示専用で、
    // readFile は常に実ファイルのメタデータを見るため、多少古くても不整合にならない。
    // 画面上の更新日時はクライアントが戻り値で書き換える。
    return DriveService.writeText_(fileId, content, baseUpdatedAtIso, !!force,
      encoding === 'Shift_JIS' ? 'Shift_JIS' : 'UTF-8', bom === true);
  });
}
