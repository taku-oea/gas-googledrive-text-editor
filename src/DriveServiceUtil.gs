/**
 * DriveServiceUtil.gs — DriveService のうち ユーティリティ（キャッシュ・BOM・バイト長など）。
 *
 * DriveService は 1 つのオブジェクトだが、長いので機能ごとのファイルに分けて足している。
 * GAS は全ファイルを 1 つのグローバルに読み込み、読み込む順は決められないので、
 * どのファイルも「無ければ作る」形にしてある（呼ばれるのは全ファイルを読み終えた後）。
 */

var DriveService = DriveService || {};

Object.assign(DriveService, {

  /* ------------------------------------------------------------------ *
   *  ユーティリティ
   * ------------------------------------------------------------------ */

  /**
   * 先頭の BOM を取り除く。付いたままだと JSON.parse 等で事故になる。
   * @param {string} text
   * @return {string}
   */
  stripBom_: function (text) {
    if (text && text.charCodeAt(0) === 0xfeff) return text.slice(1);
    return text;
  },

  /**
   * UTF-8 でのバイト長。
   * @param {string} text
   * @return {number}
   */
  byteLength_: function (text) {
    return Utilities.newBlob(text || '').getBytes().length;
  },

  /**
   * キャッシュから読む。gzip 印が付いていれば展開する。
   * @param {string} key
   * @return {string|null}
   */
  cacheGet_: function (key) {
    var raw;
    try {
      raw = CacheService.getUserCache().get(key);
    } catch (e) {
      return null;
    }
    return DriveService.decodeCached_(raw);
  },

  /**
   * 複数キーを 1 回で読む（1 キーずつ get すると往復がキー数ぶん増える）。
   * @param {Array<string>} keys
   * @return {Object<string, string>} 見つかったものだけ（展開済み）
   */
  cacheGetAll_: function (keys) {
    var out = {};
    if (!keys || !keys.length) return out;
    var raw;
    try {
      raw = CacheService.getUserCache().getAll(keys) || {};
    } catch (e) {
      return out;
    }
    for (var k in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
      var v = DriveService.decodeCached_(raw[k]);
      if (v !== null) out[k] = v;
    }
    return out;
  },

  /** キャッシュ値の文字列を展開する（gz: 印が無ければそのまま）。壊れていれば null。 */
  decodeCached_: function (raw) {
    if (raw === null || raw === undefined) return null;
    if (raw.indexOf(CACHE_GZIP_PREFIX) !== 0) return raw;   // 旧形式（非圧縮）
    try {
      var bytes = Utilities.base64Decode(raw.slice(CACHE_GZIP_PREFIX.length));
      // ungzip は Blob の content type を見るので明示する。
      return Utilities.ungzip(Utilities.newBlob(bytes, 'application/x-gzip'))
        .getDataAsString('UTF-8');
    } catch (e) {
      // 壊れていたら無かったことにして Drive から取り直させる。
      return null;
    }
  },

  /**
   * キャッシュに載せる形（gzip + Base64）に変換する。
   *
   * テキストは 4〜5 倍圧縮が効くので、生のままだと 80KB で諦めていたファイルも
   * 1 値 100KB の制限に収まる（Base64 で 4/3 に膨らむぶんを差し引いても 200〜300KB 程度まで）。
   *
   * @param {string} value
   * @return {string|null} 入りきらない・失敗したら null
   */
  encodeForCache_: function (value) {
    try {
      var text = String(value == null ? '' : value);
      if (text.length > MAX_CACHE_INPUT_CHARS) return null;
      // 小さい値は生のまま置く。Utilities.gzip はサービス呼び出しで 1 回 20〜50ms かかり、
      // 一覧を 5〜6 個書くだけで 200ms 超になっていた（getBootstrap の assemble 段）。
      // 100KB の上限に収まるものは圧縮する理由が無い。decodeCached_ は gz: 印の無い値をそのまま返す。
      if (text.length <= RAW_CACHE_MAX_CHARS) return text;
      var gz = Utilities.gzip(Utilities.newBlob(text, 'text/plain'));
      var encoded = CACHE_GZIP_PREFIX + Utilities.base64Encode(gz.getBytes());
      if (encoded.length > MAX_CACHE_VALUE_CHARS) return null;
      return encoded;
    } catch (e) {
      return null;
    }
  },

  /**
   * キャッシュへ載せる。キャッシュはあくまで高速化用途なので、失敗しても例外にせず false を返す。
   * @param {string} key
   * @param {string} value
   * @param {number} ttlSec
   * @return {boolean} 実際にキャッシュしたか
   */
  cachePut_: function (key, value, ttlSec) {
    var encoded = DriveService.encodeForCache_(value);
    if (encoded === null) return false;
    try {
      CacheService.getUserCache().put(key, encoded, ttlSec);
      return true;
    } catch (e) {
      return false;
    }
  },

  /** JSON 文字列 → オブジェクト。オブジェクトでない／壊れていれば null。 */
  parseJson_: function (text) {
    if (text === null || text === undefined) return null;
    try {
      var v = JSON.parse(text);
      return (v && typeof v === 'object') ? v : null;
    } catch (e) {
      return null;
    }
  },

  /** @return {Object|null} */
  cacheGetJson_: function (key) {
    return DriveService.parseJson_(DriveService.cacheGet_(key));
  },

  /** @return {Object<string, Object>} 見つかって解釈できたものだけ */
  cacheGetAllJson_: function (keys) {
    var raw = DriveService.cacheGetAll_(keys);
    var out = {};
    for (var k in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
      var v = DriveService.parseJson_(raw[k]);
      if (v) out[k] = v;
    }
    return out;
  },

  /** @return {boolean} */
  cachePutJson_: function (key, obj, ttlSec) {
    return DriveService.cachePut_(key, JSON.stringify(obj), ttlSec);
  },

  /**
   * 複数の値を 1 回で書く。入りきらないものは黙って省く。
   * @param {Object<string, Object>} map key → オブジェクト
   * @param {number} ttlSec
   * @return {boolean}
   */
  cachePutAllJson_: function (map, ttlSec) {
    var values = {};
    var any = false;
    for (var k in map) {
      if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
      var enc = DriveService.encodeForCache_(JSON.stringify(map[k]));
      if (enc !== null) { values[k] = enc; any = true; }
    }
    if (!any) return false;
    try {
      CacheService.getUserCache().putAll(values, ttlSec);
      return true;
    } catch (e) {
      return false;
    }
  },

  /**
   * 一覧キャッシュが「新しい」か。値は 6 時間残すが、そのまま使ってよいのは
   * 取得から LIST_CACHE_TTL_SEC（30 秒）以内のものだけ。それより古いものは
   * 起動時のインライン表示（後で本物と突き合わせる）にだけ使う。
   * @param {{fetchedAt:number}|null} listing
   * @return {boolean}
   */
  isFresh_: function (listing) {
    return !!(listing && Date.now() - (Number(listing.fetchedAt) || 0) < LIST_CACHE_TTL_SEC * 1000);
  }
});
