// サイドバーのツリーのデータモデル（client/lib/tree-model.js）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Tree, sortChildren, folderSig } from '../client/lib/tree-model.js';

const file = (id, name, extra = {}) => ({ id, name, updatedAtIso: '2026-09-24T00:00:00.000Z', size: 1, openable: true, ...extra });
let removed;

beforeEach(() => {
  removed = [];
  Tree.onRemoved = (id) => removed.push(id);
  Tree.reset([{ id: 'R', name: 'ルート' }]);
  Tree.ingest('R', { folders: [{ id: 'D', name: 'docs' }], files: [file('b', 'b.md'), file('a', 'A.md')] });
  Tree.ingest('D', { folders: [], files: [file('c', 'c.txt')] });
});

test('読み込んだ一覧がノードになり、パスと所属ルートが引ける', () => {
  assert.equal(Tree.pathOf('c'), 'ルート / docs / c.txt');
  assert.equal(Tree.rootOf('c'), 'R');
  assert.equal(Tree.get('D').loaded, true);
  assert.ok(Tree.get('R').sig.length > 0);
});

test('表示する行は展開したフォルダの中だけ（フォルダが先）', () => {
  const rows = () => Tree.flatten().map((r) => r.node.id + '@' + r.depth);
  assert.deepEqual(rows(), ['R@0', 'D@1', 'b@1', 'a@1']);   // docs は畳んだまま
  Tree.get('D').expanded = true;
  assert.deepEqual(rows(), ['R@0', 'D@1', 'c@2', 'b@1', 'a@1']);
});

test('並べ替え・絞り込み', () => {
  sortChildren('R');
  assert.deepEqual(Tree.get('R').childFileIds, ['a', 'b']);
  assert.deepEqual(Tree.matchingFiles('.md').map((n) => n.id), ['a', 'b']);
  assert.deepEqual(Tree.allFiles().map((n) => n.id), ['a', 'b', 'c']);
});

test('再読み込みで消えた子は Map からも消え、後始末が子から順に呼ばれる', () => {
  Tree.ingest('R', { folders: [], files: [file('a', 'A.md')] });
  assert.equal(Tree.get('D'), null);
  assert.equal(Tree.get('c'), null);
  assert.equal(Tree.get('b'), null);
  assert.deepEqual(removed, ['c', 'D', 'b']);
});

test('付け外し（detach は元に戻す関数を返す）', () => {
  const undo = Tree.detach('b');
  assert.ok(!Tree.get('R').childFileIds.includes('b'));
  undo();
  assert.deepEqual(Tree.get('R').childFileIds, ['b', 'a']);
  Tree.attach('b', 'D');
  assert.deepEqual(Tree.get('D').childFileIds, ['b', 'c']);
  assert.equal(Tree.get('b').parentId, 'D');
});

test('一時メモは固定の先頭。ほかのフォルダの子としては並べない', () => {
  Tree.ingest('R', { folders: [{ id: 'D', name: 'docs' }, { id: 'T', name: 'tmp' }], files: [] });
  Tree.setTmpRoot({ id: 'T' });
  assert.deepEqual(Tree.allRootIds(), ['T', 'R']);
  assert.equal(Tree.get('T').name, '一時メモ');
  assert.ok(!Tree.get('R').childFolderIds.includes('T'));
});

test('一覧の署名は名前や更新日時が変わると変わる', () => {
  const a = { folders: [{ id: 'D', name: 'docs' }], files: [file('a', 'A.md')] };
  const b = { folders: [{ id: 'D', name: 'docs' }], files: [file('a', 'A.md', { updatedAtIso: 'x' })] };
  assert.equal(folderSig(a), folderSig(JSON.parse(JSON.stringify(a))));
  assert.notEqual(folderSig(a), folderSig(b));
  assert.equal(folderSig(null), '');
});
