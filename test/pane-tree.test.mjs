// ペインの木の形の操作（client/lib/pane-tree.js）。DOM は使わない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  paneLeaves, paneLeafOf, paneAddTab, paneRemoveTab, paneInsertBeside, paneInsertOutside,
  paneDetach, paneSerialize, paneRestore
} from '../client/lib/pane-tree.js';

let seq = 0;
const leaf = (tabs = []) => ({ id: 'p' + (++seq), type: 'leaf', parent: null, tabIds: tabs.slice(), activeId: tabs[0] || null, size: 1 });
const split = (dir, parent, size) => ({ id: 'p' + (++seq), type: 'split', parent: parent || null, dir, children: [], size: size > 0 ? size : 1 });
/** 形を文字にする（例: row(L,col(L,L))）。親の参照も確かめる。 */
function shape(n, parent = null) {
  assert.equal(n.parent, parent, '親の参照が壊れている: ' + n.id);
  return n.type === 'leaf' ? 'L' : n.dir + '(' + n.children.map((c) => shape(c, n)).join(',') + ')';
}

test('同じ向きの分割は枝を深くせず並べ、取り分を配り直す', () => {
  const a = leaf();
  let root = a;
  const b = leaf();
  root = paneInsertBeside(root, a, b, 'row', true, split);
  const c = leaf();
  b.size = 3;
  root = paneInsertBeside(root, b, c, 'row', true, split);
  assert.equal(shape(root), 'row(L,L,L)');
  assert.deepEqual(root.children.map((x) => x.size), [1, 1, 1]);
  assert.deepEqual(paneLeaves(root), [a, b, c]);
});

test('向きが変わる分割は枝を 1 つ挟み、元の取り分を引き継ぐ', () => {
  const a = leaf(), b = leaf();
  let root = paneInsertBeside(a, a, b, 'row', true, split);
  a.size = 2;
  const c = leaf();
  root = paneInsertBeside(root, a, c, 'col', false, split);   // a の上に c
  assert.equal(shape(root), 'row(col(L,L),L)');
  assert.equal(root.children[0].size, 2);
  assert.deepEqual(paneLeaves(root), [c, a, b]);
});

test('外側に足す: 根が同じ向きなら端に並べ、違えば根を包む', () => {
  const a = leaf(), b = leaf();
  let root = paneInsertBeside(a, a, b, 'row', true, split);
  const c = leaf();
  root = paneInsertOutside(root, c, 'col', true, split);      // 下に全幅の段
  assert.equal(shape(root), 'col(row(L,L),L)');
  const d = leaf();
  root = paneInsertOutside(root, d, 'col', false, split);     // 上にも
  assert.equal(shape(root), 'col(L,row(L,L),L)');
});

test('畳む: 子が 1 つになった枝はその子を繰り上げ、最後の 1 枚は外さない', () => {
  const a = leaf(), b = leaf(), c = leaf();
  let root = paneInsertBeside(a, a, b, 'row', true, split);
  root = paneInsertBeside(root, b, c, 'col', true, split);    // row(L,col(L,L))
  const inner = c.parent;
  inner.size = 5;
  let r = paneDetach(root, c);
  assert.equal(r.removed, true);
  assert.equal(r.collapsed, inner);
  assert.equal(shape(r.root), 'row(L,L)');
  assert.equal(b.size, 5);                                      // 枝の取り分を引き継ぐ
  r = paneDetach(r.root, b);
  assert.equal(r.root, a);                                      // 根まで繰り上がる
  assert.equal(shape(r.root), 'L');
  assert.deepEqual(paneDetach(a, a), { root: a, removed: false, collapsed: null });
});

test('タブの付け外し: 表示中を外したら隣へ送る', () => {
  const a = leaf(['x', 'y', 'z']);
  a.activeId = 'z';
  paneAddTab(a, 'w', 1);
  paneAddTab(a, 'x');                                            // 重複は足さない
  assert.deepEqual(a.tabIds, ['x', 'w', 'y', 'z']);
  assert.equal(paneLeafOf(a, 'y'), a);
  assert.equal(paneLeafOf(a, 'nope'), null);
  paneRemoveTab(a, 'z');
  assert.equal(a.activeId, 'y');
  paneRemoveTab(a, 'x');
  assert.equal(a.activeId, 'y');
  assert.equal(paneRemoveTab(a, 'nope'), null);
});

test('保存と復元: 形・取り分・表示中タブが戻り、復元できないタブは落とす', () => {
  const a = leaf(['t1', 't2']), b = leaf(['t3']);
  a.activeId = 't2';
  let root = paneInsertBeside(a, a, b, 'row', true, split);
  a.size = 1.23456;
  const data = JSON.parse(JSON.stringify(paneSerialize(root)));
  assert.equal(data.ch[0].size, 1.23);
  const forgotten = [];
  const back = paneRestore(data, (id) => id !== 't2', { max: 6, makeLeaf: () => leaf(), makeSplit: split, forget: (n) => forgotten.push(n) });
  assert.equal(shape(back), 'row(L,L)');
  assert.deepEqual(back.children[0].tabIds, ['t1']);
  assert.equal(back.children[0].activeId, 't1');                 // 表示中が落ちたら先頭
  assert.deepEqual(forgotten, []);
  // 保存するときに残すタブを選べる
  assert.deepEqual(paneSerialize(root, (id) => id === 't3').ch[0].tabs, []);
});

test('復元: 上限を超えた葉は作らず、1 枚だけになった枝は繰り上げ、壊れたデータは null', () => {
  const nine = { t: 's', dir: 'row', size: 1, ch: Array.from({ length: 9 }, (_, i) => ({ t: 'l', size: 1, tabs: ['x' + i] })) };
  const f = { max: 6, makeLeaf: () => leaf(), makeSplit: split, forget() {} };
  assert.equal(paneLeaves(paneRestore(nine, () => true, f)).length, 6);
  const forgotten = [];
  // 子の片方が読めない（null）と枝の子は 1 つになる。子が 2 つ未満の枝（ch: []）は葉として読む。
  assert.equal(shape(paneRestore({ t: 's', dir: 'row', ch: [] }, () => true, f)), 'L');
  const one = paneRestore({ t: 's', dir: 'col', size: 2, ch: [{ t: 'l', tabs: ['a'] }, null] }, () => true,
    { ...f, forget: (n) => forgotten.push(n.type) });
  assert.equal(shape(one), 'L');
  assert.equal(one.size, 2);
  assert.deepEqual(forgotten, ['split']);
  for (const bad of [null, {}, { t: 'x' }]) assert.equal(paneRestore(bad, () => true, f), null);
});
