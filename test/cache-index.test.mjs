// 本文の LRU キャッシュ（store-cache.js）とファイル名の索引（file-index.js）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../client/lib/store-cache.js';
import { FileIndex } from '../client/lib/file-index.js';
import { Tree } from '../client/lib/tree-model.js';

const rec = (id, n) => ({ id, name: id + '.md', content: 'x'.repeat(n), updatedAtIso: 't' });

beforeEach(() => {
  Store.content = new Map();
  Store.contentChars = 0;
  Store.inflight = new Map();
  Store.isOpen = () => false;
});

test('LRU: 件数の上限を超えたら古いものから追い出す', () => {
  const max = Store.MAX_ENTRIES;
  for (let i = 0; i < max + 3; i++) Store.putContent(rec('f' + i, 1));
  assert.equal(Store.content.size, max);
  assert.equal(Store.peek('f0'), null);
  assert.ok(Store.peek('f' + (max + 2)));
  assert.equal(Store.contentChars, max);
});

test('LRU: touch で末尾へ動いたものは残り、開いているタブは追い出さない', () => {
  const max = Store.MAX_ENTRIES;
  for (let i = 0; i < max; i++) Store.putContent(rec('f' + i, 1));
  Store.touch('f0');
  Store.isOpen = (id) => id === 'f1';
  Store.putContent(rec('new1', 1));
  Store.putContent(rec('new2', 1));
  assert.ok(Store.peek('f0'), 'touch したもの');
  assert.ok(Store.peek('f1'), '開いているもの');
  assert.equal(Store.peek('f2'), null);
  assert.equal(Store.peek('f3'), null);
});

test('LRU: 文字数の上限・同じ id の入れ替え・drop で合計がずれない', () => {
  Store.putContent(rec('a', 10));
  Store.putContent(rec('a', 4));
  assert.equal(Store.contentChars, 4);
  Store.drop('a');
  assert.equal(Store.contentChars, 0);
  Store.putContent(rec('big1', Store.MAX_CHARS - 1));
  Store.putContent(rec('big2', 10));
  assert.equal(Store.peek('big1'), null);
  assert.equal(Store.contentChars, 10);
  assert.equal(Store.putContent({ id: 'x' }), null);   // 本文が無いものは入れない
});

test('dedup: 同じ要求は 1 本に相乗りし、終わったら外れる', async () => {
  let calls = 0;
  const fn = () => { calls++; return new Promise((r) => setTimeout(() => r(calls), 5)); };
  const [a, b] = await Promise.all([Store.dedup('k', fn), Store.dedup('k', fn)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(Store.inflight.size, 0);
  await Store.dedup('k', fn);
  assert.equal(calls, 2);
});

test('ファイル名の索引: 保存 → 読み込みで同じ中身に戻り、ツリーに無いものだけ追加で出す', () => {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v))
  };
  Tree.onRemoved = () => {};
  Tree.reset([{ id: 'R', name: 'ルート' }]);
  Tree.ingest('R', { folders: [{ id: 'D', name: 'docs' }], files: [{ id: 'a', name: 'a.md' }] });
  FileIndex.data = {
    key: FileIndex.rootsKey(), at: Date.now(), partial: false,
    folders: new Map([['R', { name: 'ルート', parentId: null }], ['D', { name: 'docs', parentId: 'R' }], ['S', { name: 'sub', parentId: 'D' }]]),
    files: new Map([
      ['a', { name: 'a.md', parentId: 'R', kind: 'text', size: 1, updatedAtIso: 't' }],
      ['z', { name: 'deep.md', parentId: 'S', kind: 'text', size: 2, updatedAtIso: 't' }]
    ])
  };
  FileIndex.save();
  FileIndex.data = null;
  assert.equal(FileIndex.usable(), true);   // 読み込み直す
  assert.equal(FileIndex.data.files.get('z').parentId, 'S');
  assert.deepEqual(FileIndex.extraFiles().map((f) => f.id), ['z']);   // a はツリーにある
  assert.equal(FileIndex.pathOf('S', 'deep.md'), 'ルート / docs / sub / deep.md');
  assert.equal(FileIndex.entryOf('z').viewer, 'editor');
  FileIndex.drop('z');
  assert.equal(FileIndex.entryOf('z'), null);
  // ルートが変わったら古い索引は使わない
  Tree.addRoot({ id: 'R2', name: '別' });
  assert.equal(FileIndex.usable(), false);
});
