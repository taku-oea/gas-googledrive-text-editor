/**
 * client/lib/errors.js — エラーの型。
 *
 * 依存の無い純粋な部分を client/app から切り出した ES モジュール。
 * client/app 側からは tools/build-app.mjs が生成する import で同じ名前のまま参照できる。
 */

/** サーバーが返した code を保持するエラー。 */
export class ApiError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail || null;
  }
}

/** サーバーの {ok, data} / {ok:false, code, error} を解いて data を返す（失敗は throw）。 */
export function unwrapResponse(res) {
  if (!res || typeof res !== 'object') {
    throw new ApiError('UNKNOWN', 'サーバーから想定外の応答が返りました。');
  }
  if (res.ok) return res.data;
  throw new ApiError(res.code || 'UNKNOWN', res.error || '不明なエラーが発生しました。', res.detail);
}
