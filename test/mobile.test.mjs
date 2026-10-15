import { test } from 'node:test';
import assert from 'node:assert/strict';
// client/app は 1 つのスコープを共有しているので、宣言を名前で切り出して vm で試す。
import { loadClient } from './harness.mjs';

/** classList と hidden / setAttribute だけを持つ、要素の代わり。 */
function fakeEl() {
  const cls = new Set();
  return {
    hidden: false,
    attrs: {},
    classList: {
      toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); },
      contains: (c) => cls.has(c)
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    has: (c) => cls.has(c)
  };
}

function loadMobile(extra) {
  const el = { app: fakeEl(), drawerScrim: fakeEl(), btnToggleSidebar: fakeEl() };
  const calls = { layout: 0, tabs: 0, tree: 0 };
  const globals = Object.assign({
    el,
    Layout: { sidebarHidden: false, apply: () => { calls.layout++; } },
    renderTabs: () => { calls.tabs++; },
    renderTreeStates: () => { calls.tree++; },
    Ctx: { hide() {} },
    Date
  }, extra || {});
  const { Mobile } = loadClient(['Mobile'], globals);
  return { Mobile, el, calls, globals };
}

test('スマホ表示: ドロワーの開閉は PC のサイドバーの開閉（Layout.sidebarHidden）と別に持つ', () => {
  const { Mobile, el, globals } = loadMobile();
  Mobile.apply(true);
  assert.equal(el.app.has('app--mobile'), true);
  assert.equal(Mobile.sidebarShown(), false);        // スマホは閉じた状態から始まる

  Mobile.toggleDrawer();
  assert.equal(Mobile.drawerOpen, true);
  assert.equal(el.app.has('app--drawerOpen'), true);
  assert.equal(el.drawerScrim.hidden, false);
  assert.equal(globals.Layout.sidebarHidden, false);  // PC 側の値は触らない

  // PC 表示へ戻ると、ドロワーは閉じて PC のサイドバーの状態で判断する。
  Mobile.apply(false);
  assert.equal(Mobile.drawerOpen, false);
  assert.equal(el.app.has('app--mobile'), false);
  assert.equal(Mobile.sidebarShown(), true);
  // PC 表示ではドロワーを開けない。
  Mobile.setDrawer(true);
  assert.equal(Mobile.drawerOpen, false);
});

test('スマホ表示の切り替えで、サイドバーとタブバー（ペインの切り替えボタン）を描き直す', () => {
  const { Mobile, calls } = loadMobile();
  Mobile.apply(true);
  assert.deepEqual([calls.layout, calls.tabs], [1, 1]);
  Mobile.apply(true);                                 // 変わらなければ描き直さない
  assert.deepEqual([calls.layout, calls.tabs], [1, 1]);
  Mobile.apply(false);
  assert.deepEqual([calls.layout, calls.tabs], [2, 2]);
});

test('ドロワーから開いたファイルならドロワーを閉じ、触っていないなら閉じない', () => {
  let now = 1000000;
  const FakeDate = { now: () => now };
  const { Mobile } = loadMobile({ Date: FakeDate });
  Mobile.apply(true);
  Mobile.setDrawer(true);                             // 開いた時刻が「触った時刻」になる
  now += 2000;
  Mobile.onTabShown();
  assert.equal(Mobile.drawerOpen, false);

  // ドロワーを開いたまま長く放置したあとに、裏でタブが出た（起動時の復元など）なら閉じない。
  Mobile.setDrawer(true);
  now += 60000;
  Mobile.onTabShown();
  assert.equal(Mobile.drawerOpen, true);
});
