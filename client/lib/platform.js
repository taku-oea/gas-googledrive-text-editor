/**
 * client/lib/platform.js — 実行環境の判定（Mac かどうか・修飾キーの表記）。
 *
 * 依存の無い純粋な部分を client/app から切り出した ES モジュール。
 * client/app 側からは tools/build-app.mjs がつなぐので、同じ名前のまま参照できる。
 */

export const IS_MAC = /Mac|iPod|iPhone|iPad/.test(navigator.platform || '');

export const MOD = IS_MAC ? '⌘' : 'Ctrl';
