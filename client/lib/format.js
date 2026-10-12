/**
 * client/lib/format.js — 表示用の書式（バイト数・相対時刻・時刻・拡張子）。
 *
 * 依存の無い純粋な部分を client/app から切り出した ES モジュール。
 * client/app 側からは tools/build-app.mjs が生成する import で同じ名前のまま参照できる。
 */
import { ApiError } from './errors.js';

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

export function formatRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return 'たった今';
  if (diffSec < 3600) return Math.floor(diffSec / 60) + '分前';
  if (diffSec < 86400) return Math.floor(diffSec / 3600) + '時間前';
  if (diffSec < 86400 * 7) return Math.floor(diffSec / 86400) + '日前';
  const d = new Date(then);
  return (d.getMonth() + 1) + '/' + d.getDate();
}

export function formatClock(date) {
  const d = date || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

export function extensionOf(name) {
  const base = String(name || '');
  const idx = base.lastIndexOf('.');
  return (idx < 0 ? base : base.slice(idx + 1)).toLowerCase();
}

export function validFileName(name) {
  const trimmed = String(name == null ? '' : name).trim();
  if (!trimmed) throw new ApiError('NOT_FOUND', 'ファイル名を入力してください。');
  if (trimmed.length > 255) throw new ApiError('UNKNOWN', 'ファイル名が長すぎます（255 文字以内にしてください）。');
  if (trimmed.indexOf('/') >= 0 || trimmed.indexOf('\\') >= 0) {
    throw new ApiError('UNKNOWN', 'ファイル名に / や \\ は使えません。');
  }
  if (trimmed === '.' || trimmed === '..') throw new ApiError('UNKNOWN', 'そのファイル名は使えません。');
  return trimmed;
}
