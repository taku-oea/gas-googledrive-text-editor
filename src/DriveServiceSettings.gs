/**
 * DriveServiceSettings.gs — DriveService のうち ユーザー設定。
 *
 * DriveService は 1 つのオブジェクトだが、長いので機能ごとのファイルに分けて足している。
 * GAS は全ファイルを 1 つのグローバルに読み込み、読み込む順は決められないので、
 * どのファイルも「無ければ作る」形にしてある（呼ばれるのは全ファイルを読み終えた後）。
 */

var DriveService = DriveService || {};

Object.assign(DriveService, {

  /* ------------------------------------------------------------------ *
   *  ユーザー設定
   * ------------------------------------------------------------------ */

  /** 既定の設定。クライアントと共有する唯一の定義。 */
  defaultSettings_: function () {
    return {
      autosaveDelayMs: AUTOSAVE_DELAY_MS,
      autosaveEnabled: true,
      fontSize: 12.5,
      // エディタのフォント名（カンマ区切り・端末にインストール済みのものを名前で指す）。'' は既定の等幅フォント。
      fontFamily: '',
      lineWrap: true,
      // 画面の配色。'system' は OS の設定（prefers-color-scheme）に従う。
      themeMode: 'system',
      // Markdown プレビューのスクロールを左右で合わせるか。
      previewScrollSync: true,
      // Markdown のタブで入力バー（見出し・太字・表など）を出すか。
      mdToolbar: true,
      tmpRetentionDays: DEFAULT_TMP_RETENTION_DAYS,
      tmpExtension: DEFAULT_TMP_EXTENSION,
      // インデントと改行コードは本来ファイルの内容そのものなので、
      // 既定値は「本文から判定できなかったときに何にするか」を決めるもの。
      // detectIndentation を切ると、判定せず常に既定値を使う。
      detectIndentation: true,
      defaultIndentWithTabs: false,
      defaultIndentUnit: 2,
      defaultEol: 'LF'
    };
  },

  /** @return {Object} */
  loadSettings_: function () {
    try {
      return DriveService.settingsFrom_(
        PropertiesService.getUserProperties().getProperty(PROP_SETTINGS));
    } catch (e) {
      return DriveService.defaultSettings_();
    }
  },

  /** 設定の生 JSON → 既定値で埋めて丸めた設定。無い／壊れていれば既定値。 */
  settingsFrom_: function (raw) {
    var defaults = DriveService.defaultSettings_();
    try {
      if (!raw) return defaults;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return defaults;
      var out = {};
      for (var key in defaults) {
        if (Object.prototype.hasOwnProperty.call(defaults, key)) {
          out[key] = Object.prototype.hasOwnProperty.call(parsed, key) ? parsed[key] : defaults[key];
        }
      }
      return DriveService.sanitizeSettings_(out);
    } catch (e) {
      return defaults;
    }
  },

  /**
   * 受け取った設定を既定値の型・範囲へ丸める。
   * クライアントから来た値をそのまま保存しないため。
   */
  sanitizeSettings_: function (src) {
    var d = DriveService.defaultSettings_();
    var delay = Number(src.autosaveDelayMs);
    var font = Number(src.fontSize);
    var keep = Number(src.tmpRetentionDays);
    var ext = String(src.tmpExtension || '').toLowerCase();
    var unit = Number(src.defaultIndentUnit);
    return {
      autosaveDelayMs: isFinite(delay) ? Math.max(500, Math.min(30000, Math.round(delay))) : d.autosaveDelayMs,
      autosaveEnabled: src.autosaveEnabled !== false,
      fontSize: isFinite(font) ? Math.max(9, Math.min(24, font)) : d.fontSize,
      fontFamily: DriveService.cleanFontFamily_(src.fontFamily),
      lineWrap: src.lineWrap !== false,
      // 'system' / 'light' / 'dark' の 3 つだけ。知らない値は 'system' に丸める。
      themeMode: (src.themeMode === 'light' || src.themeMode === 'dark') ? src.themeMode : 'system',
      previewScrollSync: src.previewScrollSync !== false,
      mdToolbar: src.mdToolbar !== false,
      // 0 は無期限。上限は 1 年。
      tmpRetentionDays: isFinite(keep) ? Math.max(0, Math.min(365, Math.round(keep))) : d.tmpRetentionDays,
      tmpExtension: TMP_EXTENSIONS[ext] ? ext : d.tmpExtension,
      detectIndentation: src.detectIndentation !== false,
      defaultIndentWithTabs: src.defaultIndentWithTabs === true,
      // ステータスバーのメニューと同じ 2 / 4 / 8 に限る。
      defaultIndentUnit: (unit === 2 || unit === 4 || unit === 8) ? unit : d.defaultIndentUnit,
      defaultEol: src.defaultEol === 'CRLF' ? 'CRLF' : 'LF'
    };
  },

  /**
   * フォント名を保存してよい形に丸める。CSS に差し込む値なので、文字・数字・空白・`-` `_` `.` だけを残す。
   * カンマ区切りで最大 4 つ・1 つ 64 文字まで。重複（大文字小文字違いを含む）と空は捨てる。
   * クライアントの cleanFontFamily（client/lib/font.js）と同じ規則（テストで突き合わせている）。
   *
   * @param {*} raw
   * @return {string} 'A, B' の形。何も残らなければ ''
   */
  cleanFontFamily_: function (raw) {
    var out = [];
    var seen = {};
    var parts = String(raw == null ? '' : raw).split(',');
    for (var i = 0; i < parts.length && out.length < 4; i++) {
      var name = parts[i].replace(/[^\p{L}\p{M}\p{N} ._-]/gu, '')
        .replace(/\s+/g, ' ').trim().slice(0, 64).trim();
      var key = name.toLowerCase();
      if (!name || seen[key]) continue;
      seen[key] = true;
      out.push(name);
    }
    return out.join(', ');
  },

  /** @param {Object} settings @return {Object} 丸めたあとの値 */
  saveSettings_: function (settings) {
    var clean = DriveService.sanitizeSettings_(settings || {});
    PropertiesService.getUserProperties().setProperty(PROP_SETTINGS, JSON.stringify(clean));
    return clean;
  }
});
