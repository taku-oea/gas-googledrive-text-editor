/**
 * DriveService.gs
 *
 * Drive へのアクセスとキャッシュを引き受ける内部モジュール。
 * ここの関数はクライアントから直接呼ばれない（名前末尾の _ は GAS の非公開規約）。
 * クライアント公開 API は Code.gs 側にのみ置く。
 *
 * DriveService は 1 つのオブジェクトだが、長いので機能ごとのファイルに分けている。
 *   DriveService.gs           定数・検証・フォルダ参照の解決・ファイル種別の判定（このファイル）
 *   DriveServiceList.gs       一覧
 *   DriveServiceFiles.gs      作成・改名・移動・複製・アップロード・ゴミ箱
 *   DriveServiceReadWrite.gs  本文の読み込みと保存
 *   DriveServiceUserState.gs  ルートフォルダ・セッション・ピン留め
 *   DriveServiceSearch.gs     全体検索・リビジョン履歴
 *   DriveServiceTemp.gs       一時メモ
 *   DriveServiceSettings.gs   ユーザー設定
 *   DriveServiceUtil.gs       ユーティリティ
 * GAS は全ファイルを 1 つのグローバルに読み込むが、読み込む順は決められない。そこで
 * どのファイルも `var DriveService = DriveService || {};` のあと Object.assign で足す
 * （中の関数が呼ばれるのは全ファイルを読み終えた後なので、順番に依存しない）。
 * 定数（MAX_* など）はこのファイルに置き、ほかのファイルはトップレベルで参照しない。
 */

/** 開ける最大サイズ（バイト）。これを超えるファイルは一覧でグレー表示にし、開かせない。 */
var MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * CacheService に載せる 1 値の上限（文字数）。
 * GAS の制限は 1 値 100KB。gzip + Base64 済みの文字列に対して測るので、
 * ここは ASCII 換算でよい。少し余裕を持たせる。
 */
var MAX_CACHE_VALUE_CHARS = 95 * 1024;

/**
 * gzip にかける入力の上限（文字数）。
 * これを超えるものは圧縮の CPU 時間が惜しいのでキャッシュしない。
 */
var MAX_CACHE_INPUT_CHARS = 1024 * 1024;

/** キャッシュ値の先頭に付ける印。付いていない値は非圧縮として読む。 */
var CACHE_GZIP_PREFIX = 'gz:';

/**
 * この文字数までは gzip せず生で置く（1 値 100KB の制限は ASCII 換算。日本語は
 * 1 文字 3 バイトになりうるので、余裕を見て 30K 文字）。
 */
var RAW_CACHE_MAX_CHARS = 30 * 1024;

/** 本文キャッシュの TTL（秒）。 */
var CONTENT_CACHE_TTL_SEC = 600;

/** 一覧キャッシュの TTL（秒）。短め。更新ボタンで明示的にバイパスできる。 */
var LIST_CACHE_TTL_SEC = 30;

/**
 * 共有ドライブ名の対応表をキャッシュしておく秒数。
 * ドライブ名はめったに変わらないので長めでよい。変えた場合はこの時間だけ
 * 古い名前が残るが、次の取得で追いつく。
 */
var SHARED_DRIVE_NAME_TTL_SEC = 1800;

/**
 * 共有ドライブ名の取得に失敗したあと、再試行を控える秒数。
 * 失敗をキャッシュしないと、フォルダを開くたびに失敗する API 呼び出しを
 * 繰り返してアプリ全体が遅くなる。
 */
var SHARED_DRIVE_FAIL_TTL_SEC = 300;

/** 自動保存のデバウンス（ミリ秒）。クライアントへ配布する。 */
var AUTOSAVE_DELAY_MS = 2000;

/**
 * UserProperties のキー（ツリーに並べるルートフォルダの一覧）。
 * JSON 配列 [{id, name}, ...] を入れる。
 */
var PROP_ROOTS = 'roots';

/**
 * 旧キー（単一の基準フォルダ ID）。
 * 複数ルート対応より前の設定を引き継ぐためだけに読む。
 */
var PROP_BASE_FOLDER_ID = 'baseFolderId';

/** 同時に開けるルートフォルダの最大数。 */
var MAX_ROOTS = 8;

/**
 * アップロードできる 1 ファイルの上限（バイト）。
 * Base64 にすると 4/3 に膨らみ、それが google.script.run の
 * リクエストとして飛ぶので、編集の上限（5MB）より小さく取る。
 */
var MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/**
 * 一時メモ（とっさのメモ）を置くフォルダ。既定ではマイドライブ直下に作る（置き場所は設定で変えられる）。
 *
 * localStorage ではなく Drive の実ファイルにするのは、書きかけのメモを
 * 他の端末からも同じように開けるようにするため。App Data 領域を使わないのは、
 * Drive の画面や Drive for desktop から人の目で探せなくなるため。
 */
var TMP_APP_FOLDER_NAME = 'Googleドライブテキストエディタ';
var TMP_FOLDER_NAME = 'tmp';

/**
 * UserProperties のキー（tmp フォルダの ID）。
 * 名前で毎回探すとフォルダの列挙が毎回走るうえ、ユーザーが改名・移動した瞬間に
 * 二重に作ってしまう。ID なら改名・移動されても同じフォルダを指し続ける。
 */
var PROP_TMP_FOLDER_ID = 'tmpFolderId';

/**
 * UserProperties のキー（一時メモを置く親フォルダ。未設定ならマイドライブ）。
 *
 * 覚えるのは <アプリ名> / tmp を作る「親」であって、tmp そのものではない。
 * 掃除（保存期間を過ぎたら Drive のゴミ箱へ）の対象を、必ずアプリが作った
 * フォルダの中に閉じるため。ユーザーが選んだフォルダを直接 tmp として使うと、
 * そこに元からあったファイルまで巻き込むことになる。
 *
 * 値は {id, name} の JSON。name は表示用（「○○ / アプリ名 / tmp」と出すため）で、
 * Drive を触らずにパスを描けるよう控えている。
 */
var PROP_TMP_PARENT = 'tmpParent';

/**
 * UserProperties のキー（置き場所を変えたとき、移しきれずに残った古い tmp の ID）。
 *
 * 1 回で移せる件数には上限があるので、超えたぶんは古いフォルダに残る。そこを
 * 覚えておかないと、残りはアプリから見えないまま Drive に取り残される
 * （掃除の対象にもならない）。同じ場所をもう一度選べば続きから移す。
 *
 * 中身は ID の JSON 配列（新しいものが先頭）。移しきる前に置き場所を何度も変えると
 * 移し残しのフォルダが複数になるため。以前の形式（ID 1 つの文字列）も読める。
 */
var PROP_TMP_MOVE_FROM = 'tmpMoveFrom';

/** 移し残しとして覚えておく古い tmp の数の上限（溢れたら古いものから忘れる）。 */
var MAX_TMP_MOVE_FROM = 5;

/** UserProperties のキー（一時メモの保存先として最後に選んだフォルダ）。 */
var PROP_LAST_SAVE_FOLDER = 'lastSaveFolder';

/** UserProperties のキー（tmp の掃除を最後に走らせた時刻）。 */
var PROP_TMP_SWEPT_AT = 'tmpSweptAt';

/** tmp の掃除を走らせる間隔（ミリ秒）。操作のたびに走らせると無駄に遅くなる。 */
var TMP_SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * 中身が空のまま放置された一時メモを片付けるまでの時間（ミリ秒）。
 * タブを閉じたときは空なら即ゴミ箱へ入れるが、その前にブラウザが落ちると
 * 0 バイトのファイルが残る。それを後から回収するための保険。
 */
var TMP_EMPTY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 1 回の掃除で見るファイル数の上限。実行時間の上限に当たらないように切る。 */
var MAX_TMP_SWEEP_FILES = 300;

/**
 * 置き場所を変えるときに 1 回で移せる一時メモの上限。
 * 掃除と同じく、実行時間の上限（6 分）に当たらないところで切る。
 * 超えたぶんは「まだ残っている」と返し、もう一度実行してもらう。
 */
var MAX_TMP_MOVE_FILES = 300;

/** 一時メモを残しておく日数の既定。0 は無期限。 */
var DEFAULT_TMP_RETENTION_DAYS = 30;

/** 一時メモの既定の拡張子。言語モードは拡張子から決まるので無拡張にはしない。 */
var DEFAULT_TMP_EXTENSION = 'txt';

/** 一時メモの拡張子として選べるもの。 */
var TMP_EXTENSIONS = { txt: 1, md: 1 };

/** UserProperties のキー（開いていたタブなどのセッション）。 */
var PROP_SESSION = 'session';

/** UserProperties のキー（ユーザー設定）。 */
var PROP_SETTINGS = 'settings';

/** UserProperties のキー（ピン留めしたファイル）。 */
var PROP_PINS = 'pins';

/** 全体検索で本文を読む最大ファイル数。これを超えたぶんは候補だけ返す。 */
var MAX_SEARCH_FILES = 30;

/** 1 ファイルあたりに返す一致行の最大数。 */
var MAX_SEARCH_HITS_PER_FILE = 20;

/**
 * 全体検索でルートから何段まで潜るか。
 * Drive の `in parents` は直下しか見ないので、検索の前にフォルダを段ごとに列挙する。
 */
var MAX_SEARCH_DEPTH = 8;

/** 全体検索の対象にするフォルダ数の上限（ルート自身を含む）。 */
var MAX_SEARCH_FOLDERS = 300;

/**
 * 検索語の長さの上限。索引は語単位なので長い文字列を投げても当たらないうえ、
 * 検索語が長いほど 1 本の q に載せられる親フォルダが減る
 * （日本語は 1 文字が URL エンコードで 9 文字になるので、100 文字で約 900 文字）。
 */
var MAX_SEARCH_QUERY = 100;

/** 全体検索でフォルダを列挙するのに使ってよい時間（ms）。超えたら scopePartial で返す。 */
var SEARCH_FOLDER_BUDGET_MS = 60 * 1000;

/** 変更履歴に返す版の数（新しい順）。 */
var MAX_REVISIONS = 200;

/** 変更履歴の一覧で追うページ数の上限（1 ページ 1,000 版）。 */
var MAX_REVISION_PAGES = 10;

/** セッションに記録するタブの最大数。 */
var MAX_SESSION_TABS = 20;

/** セッションに記録する「展開中フォルダ」の最大数。 */
var MAX_SESSION_EXPANDED = 40;

/** 同時に開けるペインの数。クライアント側の Panes.MAX と合わせる。 */
var MAX_PANES = 6;

/**
 * ペインの木の深さの上限。6 枚を入れ子にしても 5 段あれば足りるが、
 * 壊れた（あるいは細工された）JSON で再帰が深くなるのを止めるための蓋。
 */
var MAX_PANE_DEPTH = 8;

/** listEntriesMulti で 1 回に取得できるフォルダ数の上限。 */
var MAX_MULTI_LIST = 30;

/** readFilesMulti で 1 回に読める本文の数（タブの先読み用）。 */
var MAX_MULTI_READ = 20;

/**
 * getBootstrap の応答に本文を同梱する上限（文字数）。
 * これを超えるファイルは同梱せず、クライアントに readFile で取りに行かせる。
 * 起動の往復を減らす目的なので、応答が肥大して逆に遅くなる手前で切る。
 */
var MAX_INLINE_CONTENT_CHARS = 200 * 1024;

/**
 * セッション JSON の最大長（UTF-8 のバイト数）。UserProperties は 1 値 9KB までなので余裕を持たせる。
 * 文字数で数えると日本語の名前（1 文字 3 バイト）で 9KB を超え、保存そのものが失敗する。
 * 超える場合は古いタブから落とす。
 */
var MAX_SESSION_BYTES = 8000;

/**
 * ピン留めできるファイル数の上限。
 * 「よく使うものを最上段に置く」ための枠なので、探さずに目で拾える数で止める。
 */
var MAX_PINS = 40;

/** ピン留め JSON の最大長（UTF-8 のバイト数）。セッションとは別の値なので 9KB 制限は独立している。 */
var MAX_PINS_BYTES = 8000;

/**
 * Drive の画面名。/drive/<これ> は ID ではないので URL 解析で弾く。
 * 例: https://drive.google.com/drive/u/0/shared-drives
 */
var DRIVE_RESERVED_PATHS = {
  'shared-drives': 1, 'shared-with-me': 1, 'my-drive': 1, 'sharedwithme': 1,
  'computers': 1, 'recent': 1, 'starred': 1, 'trash': 1, 'priority': 1,
  'search': 1, 'quota': 1, 'spam': 1
};

/** パンくず生成で親を遡る最大段数。循環参照や深すぎる階層での暴走を防ぐ。 */
var MAX_PATH_DEPTH = 12;

/**
 * 名前のソートに使う照合器。localeCompare(b, 'ja') は比較のたびに照合器を作り直すので、
 * 500 件のソート（約 4,500 比較）で目に見える時間になる。1 個作って使い回す。
 */
var COLLATOR_JA = null;
try {
  if (typeof Intl !== 'undefined' && Intl.Collator) COLLATOR_JA = new Intl.Collator('ja');
} catch (e) {
  COLLATOR_JA = null;
}

/** 1 フォルダあたりに列挙する上限。これを超えたら truncated フラグを立てて打ち切る。 */
var MAX_FOLDERS_PER_LISTING = 300;
var MAX_FILES_PER_LISTING = 500;

/**
 * テキストとして開いてよい拡張子のホワイトリスト。
 * Drive は .md や .ts に application/octet-stream を付けることがあるので、
 * MIME より拡張子を優先して判定する。
 */
var TEXT_EXTENSIONS = {
  txt: 1, text: 1, md: 1, markdown: 1, mdx: 1, rst: 1, adoc: 1,
  js: 1, mjs: 1, cjs: 1, jsx: 1, ts: 1, mts: 1, cts: 1, tsx: 1, gs: 1,
  json: 1, jsonc: 1, json5: 1, geojson: 1,
  html: 1, htm: 1, xhtml: 1, vue: 1, svelte: 1, ejs: 1, hbs: 1,
  css: 1, scss: 1, sass: 1, less: 1, styl: 1,
  csv: 1, tsv: 1,
  py: 1, pyi: 1, rb: 1, php: 1, pl: 1, lua: 1, r: 1,
  sh: 1, bash: 1, zsh: 1, fish: 1, bat: 1, cmd: 1, ps1: 1,
  yml: 1, yaml: 1, toml: 1, ini: 1, cfg: 1, conf: 1, properties: 1, env: 1,
  sql: 1, graphql: 1, gql: 1, prisma: 1,
  xml: 1, svg: 1, plist: 1, rss: 1, atom: 1,
  // drawio は中身が XML。図としての表示はクライアント側のプレビューで行う。
  drawio: 1, dio: 1,
  log: 1, diff: 1, patch: 1,
  java: 1, kt: 1, kts: 1, scala: 1, groovy: 1, go: 1, rs: 1, swift: 1,
  c: 1, h: 1, cc: 1, cpp: 1, hpp: 1, cxx: 1, cs: 1, m: 1, mm: 1,
  tf: 1, tfvars: 1, hcl: 1, dockerfile: 1, makefile: 1, gitignore: 1,
  gitattributes: 1, editorconfig: 1, npmrc: 1, nvmrc: 1, prettierrc: 1, eslintrc: 1
};

/** 拡張子が無い／ホワイトリスト外でも、この MIME ならテキストとして扱う。 */
var TEXT_MIME_EXACT = {
  'application/json': 1,
  'application/ld+json': 1,
  'application/javascript': 1,
  'application/x-javascript': 1,
  'application/ecmascript': 1,
  'application/typescript': 1,
  'application/xml': 1,
  'application/xhtml+xml': 1,
  'application/x-sh': 1,
  'application/x-shellscript': 1,
  'application/yaml': 1,
  'application/x-yaml': 1,
  'application/sql': 1,
  'application/x-sql': 1,
  'application/toml': 1,
  'image/svg+xml': 1,
  // drawio が Drive 上のファイルに付ける MIME。中身は XML。
  'application/vnd.jgraph.mxfile': 1
};

/**
 * 新規作成時に付与する MIME。未知の拡張子は text/plain にする。
 * 読み込み側は拡張子ホワイトリストで判定するので、ここは「Drive 上での見え方」だけの問題。
 */
var MIME_BY_EXTENSION = {
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', jsx: 'text/javascript',
  ts: 'text/plain', tsx: 'text/plain', gs: 'text/javascript',
  json: 'application/json', html: 'text/html', htm: 'text/html',
  css: 'text/css', scss: 'text/plain', less: 'text/plain',
  csv: 'text/csv', tsv: 'text/tab-separated-values',
  py: 'text/x-python', rb: 'text/plain', php: 'text/plain',
  sh: 'text/x-sh', bash: 'text/x-sh', zsh: 'text/x-sh',
  yml: 'text/yaml', yaml: 'text/yaml', toml: 'text/plain', ini: 'text/plain',
  sql: 'application/sql', xml: 'text/xml', svg: 'image/svg+xml'
};

/**
 * 埋め込みビューアで閲覧できる種別。値はクライアントの VIEWERS のキーと対応する。
 * 本文は取得せず、Drive / Docs が出しているプレビュー URL を iframe に入れるだけなので、
 * どれも閲覧専用・サイズ上限の対象外になる。
 */
var VIEW_KINDS = { pdf: 1, doc: 1, sheet: 1, slide: 1, drawing: 1, media: 1 };

/**
 * セッションに記録してよいタブの種別。ビューアで開くものに加えて、
 * プレビュー（Markdown / HTML / drawio を映すだけのタブ）とターミナルを含む。
 * 比較タブは材料が Drive 上に無く復元できないので入れない。
 */
var SESSION_KINDS = { pdf: 1, doc: 1, sheet: 1, slide: 1, drawing: 1, media: 1, preview: 1, term: 1 };

/** Google 独自形式のうち、プレビュー URL を持っているもの。 */
var GOOGLE_VIEW_KINDS = {
  'application/vnd.google-apps.document': 'doc',
  'application/vnd.google-apps.spreadsheet': 'sheet',
  'application/vnd.google-apps.presentation': 'slide',
  'application/vnd.google-apps.drawing': 'drawing'
};

/**
 * Drive のプレビューで閲覧できる拡張子（画像・音声・動画・Office）。
 * テキストとして開ける拡張子より後ろで判定するので、.svg や .csv はここに入れない
 * （編集できたほうが役に立つため）。
 */
var MEDIA_EXTENSIONS = {
  png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1, ico: 1, heic: 1, heif: 1,
  tif: 1, tiff: 1, avif: 1, psd: 1, ai: 1, eps: 1,
  mp4: 1, mov: 1, m4v: 1, webm: 1, avi: 1, mpg: 1, mpeg: 1, wmv: 1,
  mp3: 1, wav: 1, m4a: 1, aac: 1, ogg: 1, flac: 1,
  doc: 1, docx: 1, xls: 1, xlsx: 1, ppt: 1, pptx: 1, rtf: 1, odt: 1, ods: 1, odp: 1
};

/** Google ネイティブ形式の日本語ラベル（グレー表示のツールチップに使う）。 */
var GOOGLE_TYPE_LABELS = {
  'application/vnd.google-apps.document': 'Google ドキュメント',
  'application/vnd.google-apps.spreadsheet': 'Google スプレッドシート',
  'application/vnd.google-apps.presentation': 'Google スライド',
  'application/vnd.google-apps.form': 'Google フォーム',
  'application/vnd.google-apps.drawing': 'Google 図形描画',
  'application/vnd.google-apps.script': 'Apps Script プロジェクト',
  'application/vnd.google-apps.site': 'Google サイト',
  'application/vnd.google-apps.jam': 'Jamboard',
  'application/vnd.google-apps.map': 'マイマップ',
  'application/vnd.google-apps.shortcut': 'ショートカット'
};

/**
 * ペインに載せてよいタブ ID か。
 * プレビュータブだけは合成 ID（preview:<ファイル ID>）を持つので、
 * 接頭辞を外してから中身を確かめる。
 * @param {*} id
 * @return {boolean}
 */
function validTabId_(id) {
  var s = String(id == null ? '' : id);
  if (s.indexOf('preview:') === 0) return validId_(s.slice(8));
  // ターミナルは Drive 上に実体が無い合成 ID（term:<通し番号>）。
  if (s.indexOf('term:') === 0) return /^[0-9]{1,6}$/.test(s.slice(5));
  return validId_(s);
}

/**
 * ペインの取り分（flex-grow）として受け入れてよい数に直す。
 * 0 以下・無限・数でないものは 1 に倒し、小数 2 桁で足りるので丸める。
 * @param {*} value
 * @return {number}
 */
function sanitizePaneSize_(value) {
  var n = Number(value);
  if (!isFinite(n) || n <= 0) return 1;
  return Math.round(Math.min(n, 100) * 100) / 100;
}

/**
 * アプリ独自のエラーを生成する。code はクライアント側の分岐に使う。
 * @param {string} code 'FORBIDDEN'|'NOT_FOUND'|'CONFLICT'|'TOO_LARGE'|'NOT_TEXT'|'LOCKED'|'UNKNOWN'
 * @param {string} message ユーザーにそのまま見せる日本語メッセージ
 * @param {Object} [detail] クライアントへ渡す追加情報（競合時のサーバー更新日時など）
 * @return {Error}
 */
function appError_(code, message, detail) {
  var err = new Error(message);
  err.appCode = code;
  err.appDetail = detail || null;
  return err;
}

// 読み込む順は決められないので、ほかの DriveService*.gs と同じく「無ければ作って足す」。
var DriveService = DriveService || {};

Object.assign(DriveService, {

  /* ------------------------------------------------------------------ *
   *  検証（すべての公開 API はここを最初に必ず通す）
   * ------------------------------------------------------------------ */

  /**
   * フォルダ ID が現在のユーザーからアクセス可能かを検証する。
   * @param {string} folderId
   * @return {GoogleAppsScript.Drive.Folder}
   */
  assertFolder_: function (folderId) {
    if (!folderId) {
      throw appError_('NOT_FOUND', 'フォルダが指定されていません。');
    }
    var folder;
    try {
      folder = DriveApp.getFolderById(String(folderId));
      // DriveApp は遅延評価するため、ここで実アクセスさせて権限エラーを確定させる。
      folder.getName();
    } catch (e) {
      // Drive API からは見えているなら、共有ドライブのルートに対する
      // 書き込み操作である可能性が高い。原因が分かるように言い分ける。
      var meta = DriveService.folderMetaViaApi_(String(folderId));
      if (meta) {
        throw appError_(
          'FORBIDDEN',
          '「' + meta.name + '」に対してこの操作はできませんでした。' +
            '共有ドライブの最上位では作成や移動が制限されている場合があります。' +
            '中のフォルダを対象にしてお試しください。'
        );
      }
      throw appError_(
        'FORBIDDEN',
        'このフォルダにアクセスできません。削除されたか、あなたに共有されていない可能性があります。（ID: ' +
          folderId + '）'
      );
    }
    return folder;
  },

  /**
   * フォルダを Drive API 側から見て、存在とアクセス可否を確かめる。
   * 共有ドライブのルート（folderId が driveId と同じ ID）は
   * DriveApp から開けないことがあるため、読み取り系はこちらを使う。
   *
   * @param {string} folderId
   * @return {{id:string, name:string, driveId:(string|null)}|null} 見えなければ null
   */
  folderMetaViaApi_: function (folderId) {
    if (!DriveService.hasAdvancedDrive_()) return null;

    try {
      var meta = Drive.Files.get(folderId, {
        supportsAllDrives: true,
        fields: 'id,name,mimeType,driveId'
      });
      if (meta && meta.mimeType === 'application/vnd.google-apps.folder') {
        return { id: meta.id, name: meta.name, driveId: meta.driveId || null };
      }
    } catch (e) {
      // Files.get が通らない場合、共有ドライブそのものの ID かもしれない。
      try {
        var drive = Drive.Drives.get(folderId, { fields: 'id,name' });
        if (drive && drive.id) return { id: drive.id, name: drive.name, driveId: drive.id };
      } catch (e2) {
        return null;
      }
    }
    return null;
  },

  /**
   * 読み取り目的でフォルダのアクセス可否を確かめる（REST 版）。
   * files.get 1 本で存在・種別・名前が分かる。REST が使えなければ DriveApp 版へ。
   *
   * @param {string} folderId
   * @return {{id:string, name:string, folder:(GoogleAppsScript.Drive.Folder|null)}}
   */
  folderAccess_: function (folderId) {
    if (!folderId) {
      throw appError_('NOT_FOUND', 'フォルダが指定されていません。');
    }
    var id = String(folderId);
    if (restAvailable_() && validId_(id)) {
      try {
        var r = fetchAll_([metaReq_(id, 'id,name,mimeType,driveId,trashed')])[0];
        var f = DriveService.folderFromMetaResp_(id, r);
        return { id: f.id, name: f.name, folder: null };
      } catch (e) {
        if (!(e && e.restFailure)) throw e;
      }
    }
    return DriveService.assertFolderAccess_(id);
  },

  /**
   * files.get の応答からフォルダの {id, name} を確定する。
   * 共有ドライブのルートは files.get が通らないことがあるので、
   * その ID がドライブ一覧に載っていればアクセス可として扱う。
   *
   * @param {string} id 問い合わせた ID（'root' のこともある）
   * @param {Object} resp parseResp_ の戻り値
   * @return {{id:string, name:string}}
   */
  folderFromMetaResp_: function (id, resp) {
    if (resp.ok) {
      var m = resp.json();
      if (m.trashed) {
        throw appError_('NOT_FOUND', 'このフォルダはゴミ箱に入っています。');
      }
      if (m.mimeType !== FOLDER_MIME) {
        throw appError_('NOT_FOUND', '指定された ID はフォルダではありません。');
      }
      return { id: m.id, name: DriveService.displayFolderName_(m.id, m.name) };
    }
    var names = DriveService.sharedDriveNames_();
    if (names && names[id]) return { id: id, name: names[id] };
    throw driveErr_(resp, 'フォルダ');
  },

  /**
   * 読み取り目的でフォルダのアクセス可否を検証する（DriveApp 版）。
   *
   * DriveApp で開ければそれを返し、開けなくても Drive API から見えていれば
   * ID と名前だけで先に進む（共有ドライブのルート対策）。
   * 一覧の取得自体は Drive API が担当するので、Folder オブジェクトは無くてもよい。
   *
   * @param {string} folderId
   * @return {{id:string, name:string, folder:(GoogleAppsScript.Drive.Folder|null)}}
   */
  assertFolderAccess_: function (folderId) {
    if (!folderId) {
      throw appError_('NOT_FOUND', 'フォルダが指定されていません。');
    }
    var id = String(folderId);

    try {
      var folder = DriveApp.getFolderById(id);
      var name = folder.getName();   // 遅延評価対策。ここで権限エラーを確定させる
      // 共有ドライブのルートはここで「ドライブ」が返るので、実名に直す。
      // ルート名はここを必ず通るため、差し替えもここ 1 箇所で足りる。
      return {
        id: folder.getId(),
        name: DriveService.displayFolderName_(folder.getId(), name),
        folder: folder
      };
    } catch (e) {
      // DriveApp で開けない = 共有ドライブのルートである可能性があるので、
      // Drive API 側から見えるかを確かめる。
      var meta = DriveService.folderMetaViaApi_(id);
      if (meta) {
        return {
          id: meta.id,
          name: DriveService.displayFolderName_(meta.id, meta.name),
          folder: null
        };
      }

      throw appError_(
        'FORBIDDEN',
        'このフォルダにアクセスできません。削除されたか、あなたに共有されていない可能性があります。（ID: ' +
          id + '）'
      );
    }
  },

  /**
   * ファイル ID が現在のユーザーからアクセス可能かを検証する。
   * @param {string} fileId
   * @return {GoogleAppsScript.Drive.File}
   */
  assertFile_: function (fileId) {
    if (!fileId) {
      throw appError_('NOT_FOUND', 'ファイルが指定されていません。');
    }
    var file;
    try {
      file = DriveApp.getFileById(String(fileId));
      file.getName();
    } catch (e) {
      throw appError_(
        'FORBIDDEN',
        'このファイルにアクセスできません。削除されたか、あなたに共有されていない可能性があります。（ID: ' +
          fileId + '）'
      );
    }
    return file;
  },

  /* ------------------------------------------------------------------ *
   *  フォルダ参照の解決
   * ------------------------------------------------------------------ */

  /**
   * フォルダの URL または生の ID からフォルダ ID を取り出す。
   * 共有ドライブのフォルダ URL、旧形式の ?id=、マイドライブ URL に対応する。
   * @param {string} refText
   * @return {string} フォルダ ID
   */
  extractFolderId_: function (refText) {
    var text = String(refText == null ? '' : refText).trim();
    if (!text) {
      throw appError_('NOT_FOUND', 'フォルダの URL または ID を入力してください。');
    }

    // https://drive.google.com/drive/u/0/my-drive → マイドライブのルート
    if (/\/my-drive(\b|\/|$)/.test(text)) {
      return DriveApp.getRootFolder().getId();
    }

    // 共有ドライブの一覧ページには ID が含まれないので、先に案内する。
    if (/\/shared-drives(\b|\/|$)/.test(text) || /\/shared-with-me(\b|\/|$)/.test(text)) {
      throw appError_(
        'NOT_FOUND',
        'そのページには特定のフォルダの ID が含まれていません。' +
          '目的の共有ドライブ（またはその中のフォルダ）を開いてから、' +
          'アドレスバーの URL を貼り付けてください。'
      );
    }

    var patterns = [
      /\/folders\/([a-zA-Z0-9_-]{10,})/,   // .../drive/folders/XXX, .../drive/u/0/folders/XXX
      /[?&]id=([a-zA-Z0-9_-]{10,})/,       // .../open?id=XXX
      /\/drive\/([a-zA-Z0-9_-]{10,})/      // 共有ドライブのトップ .../drive/0AB...
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = text.match(patterns[i]);
      // 3 番目のパターンは /drive/<何か> に広く当たるので、
      // Drive 自身の画面名（shared-drives, my-drive 等）を ID と誤認しないよう弾く。
      if (m && !DRIVE_RESERVED_PATHS[m[1].toLowerCase()]) return m[1];
    }

    // 生の ID がそのまま貼られた場合
    if (/^[a-zA-Z0-9_-]{10,}$/.test(text) && !DRIVE_RESERVED_PATHS[text.toLowerCase()]) {
      return text;
    }

    throw appError_(
      'NOT_FOUND',
      'フォルダの URL または ID として認識できませんでした。' +
        'ブラウザのアドレスバーに出る https://drive.google.com/drive/folders/… をそのまま貼り付けてください。'
    );
  },

  /**
   * フォルダのパンくずを生成する。stopAtId に到達したらそこで打ち切る。
   * 全階層を無条件に遡らないよう MAX_PATH_DEPTH で上限を設ける。
   * @param {GoogleAppsScript.Drive.Folder} folder
   * @param {string|null} stopAtId ここより上には遡らない基準フォルダ ID
   * @return {Array<{id:string, name:string}>} ルート側から順に並んだ配列
   */
  breadcrumb_: function (folder, stopAtId) {
    var chain = [{
      id: folder.getId(),
      name: DriveService.displayFolderName_(folder.getId(), folder.getName())
    }];
    if (stopAtId && folder.getId() === stopAtId) return chain;

    var current = folder;
    for (var depth = 0; depth < MAX_PATH_DEPTH; depth++) {
      var parent = null;
      try {
        var parents = current.getParents();
        if (!parents.hasNext()) break;
        parent = parents.next();
      } catch (e) {
        // 共有ドライブのルートなど、親を辿れないケースは黙って打ち切る。
        break;
      }
      chain.unshift({
        id: parent.getId(),
        name: DriveService.displayFolderName_(parent.getId(), parent.getName())
      });
      if (stopAtId && parent.getId() === stopAtId) break;
      current = parent;
    }
    return chain;
  },

  /* ------------------------------------------------------------------ *
   *  ファイル種別の判定
   * ------------------------------------------------------------------ */

  /**
   * ファイル名から拡張子を取り出す。ドットが無い場合はファイル名全体を返す
   * （Dockerfile / Makefile のような拡張子なしファイルを拾うため）。
   * @param {string} name
   * @return {string} 小文字の拡張子
   */
  extensionOf_: function (name) {
    var base = String(name || '');
    var idx = base.lastIndexOf('.');
    if (idx < 0) return base.toLowerCase();
    return base.slice(idx + 1).toLowerCase();
  },

  /**
   * @param {string} mimeType
   * @return {boolean}
   */
  isTextMime_: function (mimeType) {
    var mime = String(mimeType || '').toLowerCase();
    if (mime.indexOf('text/') === 0) return true;
    return !!TEXT_MIME_EXACT[mime];
  },

  /**
   * ファイルを分類し、開けるかどうかと理由を返す。
   *
   * kind:
   *   'text'   … エディタで編集できる
   *   'pdf' / 'doc' / 'sheet' / 'slide' / 'drawing' / 'media'
   *            … 編集はできないが埋め込みビューアで閲覧できる（VIEW_KINDS）
   *   'google' … Google 独自形式のうちプレビューを持たないもの。開けない
   *   'binary' … それ以外。開けない
   *
   * viewer は開き方を示す。'editor' か 'embed'。開けない場合は null。
   *
   * @param {GoogleAppsScript.Drive.File} file
   * @return {{kind:string, viewer:(string|null), openable:boolean, size:number,
   *           reason:(string|null), code:(string|null)}}
   */
  classify_: function (file, knownName, knownMime) {
    var mime = (knownMime !== undefined && knownMime !== null)
      ? String(knownMime)
      : String(file.getMimeType() || '');
    var name = (knownName !== undefined && knownName !== null)
      ? knownName
      : file.getName();

    // Google 独自形式は getSize() を呼んでも意味がないので先に返す。
    if (mime.indexOf('application/vnd.google-apps.') === 0) {
      return DriveService.classifyMeta_(name, mime, 0);
    }

    var size = 0;
    try {
      size = file.getSize() || 0;
    } catch (e) {
      size = 0;
    }
    return DriveService.classifyMeta_(name, mime, size);
  },

  /**
   * 名前・MIME・サイズだけで分類する。DriveApp の File でも
   * Drive API v3 のメタデータでも同じ判定になるよう、ルールをここ 1 箇所に集める。
   *
   * @param {string} name
   * @param {string} mimeType
   * @param {number} size
   * @return {{kind:string, viewer:(string|null), openable:boolean, size:number,
   *           reason:(string|null), code:(string|null)}}
   */
  classifyMeta_: function (name, mimeType, size) {
    var mime = String(mimeType || '');
    size = Number(size) || 0;

    if (mime.indexOf('application/vnd.google-apps.') === 0) {
      // ドキュメント・スプレッドシート・スライド・図形描画は
      // docs.google.com のプレビューを埋め込んで閲覧できる（編集は本家で行う）。
      var googleKind = GOOGLE_VIEW_KINDS[mime];
      if (googleKind) {
        return {
          kind: googleKind,
          viewer: 'embed',
          openable: true,
          size: 0,
          reason: null,
          code: null
        };
      }

      var label = GOOGLE_TYPE_LABELS[mime] || 'Google 独自形式のファイル';
      return {
        kind: 'google',
        viewer: null,
        openable: false,
        size: 0,
        reason: label + ' は raw テキストとして取得できないため、このエディタでは開けません。',
        code: 'NOT_TEXT'
      };
    }

    var ext = DriveService.extensionOf_(name);

    // PDF は Drive のプレビューを埋め込んで閲覧する。本文は取得しないので
    // 5MB 上限の対象外にする（読み込むのはブラウザ側の iframe）。
    if (mime === 'application/pdf' || ext === 'pdf') {
      return {
        kind: 'pdf',
        viewer: 'embed',
        openable: true,
        size: size,
        reason: null,
        code: null
      };
    }

    // drawio が書き出す .drawio.png / .drawio.svg は中身に XML を埋めた画像。
    // テキストとして開くより、画像として見せたほうが役に立つ。
    if (/\.drawio\.(png|svg)$/i.test(String(name || ''))) {
      return { kind: 'media', viewer: 'embed', openable: true, size: size, reason: null, code: null };
    }

    var isText = !!TEXT_EXTENSIONS[ext] || DriveService.isTextMime_(mime);

    // 画像・音声・動画・Office は Drive のプレビューで閲覧できる。
    // 本文は取得しないので 5MB 上限の対象外（読み込むのはブラウザ側の iframe）。
    if (!isText && (MEDIA_EXTENSIONS[ext] || mime.indexOf('image/') === 0
        || mime.indexOf('video/') === 0 || mime.indexOf('audio/') === 0)) {
      return { kind: 'media', viewer: 'embed', openable: true, size: size, reason: null, code: null };
    }

    if (!isText) {
      return {
        kind: 'binary',
        viewer: null,
        openable: false,
        size: size,
        reason: 'テキストファイルとして扱えない形式です（' + (mime || '種類不明') + '）。',
        code: 'NOT_TEXT'
      };
    }

    if (size > MAX_FILE_SIZE_BYTES) {
      return {
        kind: 'text',
        viewer: null,
        openable: false,
        size: size,
        reason: 'サイズが上限（5MB）を超えているため開けません（' +
          DriveService.formatBytes_(size) + '）。',
        code: 'TOO_LARGE'
      };
    }

    return { kind: 'text', viewer: 'editor', openable: true, size: size, reason: null, code: null };
  },

  /**
   * @param {number} bytes
   * @return {string}
   */
  formatBytes_: function (bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }
});
