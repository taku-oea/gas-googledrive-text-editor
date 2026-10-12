import { test } from 'node:test';
import assert from 'node:assert/strict';
// client/app は 1 つのスコープを共有しているので、宣言を名前で切り出して vm で試す。
import { loadClient } from './harness.mjs';

/** Vfs が見る最小のツリー。ルート 1 つの下にファイルを並べる。 */
function fakeTree(names) {
  const nodes = new Map();
  nodes.set('R', { id: 'R', name: 'root', type: 'folder', loaded: true, childFolderIds: [], childFileIds: [] });
  names.forEach((name, i) => {
    const id = 'f' + i;
    nodes.set(id, { id, name, type: 'file', parentId: 'R' });
    nodes.get('R').childFileIds.push(id);
  });
  return {
    get: (id) => nodes.get(id) || null,
    allRootIds: () => ['R'],
    isTmpRoot: () => false,
    tmpRootId: null
  };
}

test('glob: 名前に [ ] を含むファイルは、パターンとして別のファイルに当たらない', async () => {
  const { Vfs } = loadClient(['TermError', 'globToRegExp', 'Vfs'],
    { Tree: fakeTree(['[重要]議事録.md', '要議事録.md', 'メモ.md']) });
  const hits = await Vfs.glob('R', '[重要]議事録.md');
  assert.deepEqual([...hits.map((n) => n.name)], ['[重要]議事録.md']);
  // 実在しない名前なら従来どおりパターンとして展開する。
  const pat = await Vfs.glob('R', '[要]議事録.md');
  assert.deepEqual([...pat.map((n) => n.name)], ['要議事録.md']);
  const star = await Vfs.glob('R', '*.md');
  assert.equal(star.length, 3);
});

test('下書きの復元: 下書きの基準日時に戻して、保存時の競合検出に乗せる', async () => {
  const tab = { id: 'X', name: 'a.md', baseUpdatedAtIso: '2026-10-12T02:00:00.000Z', dirty: false };
  const stubs = {
    Draft: { load: () => ({ content: '下書き', baseUpdatedAtIso: '2026-10-12T01:00:00.000Z', at: 0 }), clear() {} },
    DraftStash: { load: async () => null, drop() {} },
    getTab: (id) => (id === 'X' ? tab : null),
    modal: async () => true,
    h: () => ({}),
    replaceTabDoc: (t, text) => { t.text = text; },
    renderTabs() {}, renderTreeStates() {}, setStatusText() {}, scheduleAutoSave() {},
    App: { activeId: 'X' }
  };
  const { maybeRestoreDraft } = loadClient(['maybeRestoreDraft'], stubs);
  await maybeRestoreDraft('X', 'Drive の内容（別の人が更新済み）');
  assert.equal(tab.text, '下書き');
  assert.equal(tab.dirty, true);
  assert.equal(tab.baseUpdatedAtIso, '2026-10-12T01:00:00.000Z');
});

test('blur での一括保存は、競合中のタブを保存し直さない', async () => {
  const saved = [];
  const { saveAllDirty } = loadClient(['saveAllDirty'], {
    App: { tabs: [
      { id: 'a', dirty: true, conflicted: false },
      { id: 'b', dirty: true, conflicted: true },
      { id: 'c', dirty: false }
    ] },
    doSave: async (id) => { saved.push(id); }
  });
  await saveAllDirty();
  assert.deepEqual([...saved], ['a']);
});

test('変更履歴: 全ページを追い、新しい側から 200 件を新しい順で返す', async () => {
  const total = 1500;
  const revs = Array.from({ length: total }, (_, i) => ({ id: String(i + 1), modifiedTime: 't' + (i + 1), size: '1' }));
  const calls = [];
  const DriveApi = {
    json: async (path, params) => {
      calls.push(params.pageToken || null);
      const start = params.pageToken ? Number(params.pageToken) : 0;
      const page = revs.slice(start, start + params.pageSize);
      const next = start + params.pageSize;
      return { revisions: page, nextPageToken: next < total ? String(next) : undefined };
    }
  };
  const { Direct } = loadClient(['Direct'], { DriveApi, Intl, validFileName: () => '' });
  const res = await Direct.listRevisions('F');
  assert.equal(calls.length, 2);
  assert.equal(res.revisions.length, 200);
  assert.equal(res.revisions[0].id, '1500');
  assert.equal(res.revisions[199].id, '1301');
});

/* ---- 作成の重複・一時メモの保存漏れ・読めないファイルの閲覧専用 ---- */

/** DriveApi.http を、fetch の応答を順に返すスタブで動かす。 */
function driveApiWith(statuses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push((init && init.method) || 'GET');
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    return {
      ok: status >= 200 && status < 300, status,
      clone() { return this; },
      json: async () => ({ error: { message: 'x' } })
    };
  };
  const { DriveApi } = loadClient(['ApiError', 'DriveApi'], {
    fetch, performance: { now: () => 0 }, Perf: { record() {} },
    setTimeout: (fn) => { fn(); return 0; }, Math,
    call: async () => ({ value: 'tok', obtainedAt: Date.now() }), Date
  });
  DriveApi.seed({ value: 'tok', obtainedAt: Date.now() });
  return { DriveApi, calls };
}

test('DriveApi.http: POST（作成・コピー）は 5xx でやり直さない（成功していたら重複するため）', async () => {
  const { DriveApi, calls } = driveApiWith([503, 200]);
  await assert.rejects(DriveApi.http('https://x/files', { method: 'POST' }, 'ファイル'), /HTTP 503/);
  assert.equal(calls.length, 1);
});

test('DriveApi.http: POST でも 429 はやり直す。GET / PATCH の 5xx もやり直す', async () => {
  for (const [method, statuses] of [['POST', [429, 200]], ['GET', [503, 200]], ['PATCH', [500, 200]]]) {
    const { DriveApi, calls } = driveApiWith(statuses);
    const res = await DriveApi.http('https://x/files', { method }, 'ファイル');
    assert.equal(res.status, 200, method);
    assert.equal(calls.length, 2, method);
  }
});

test('一時メモの確定中に来た自動保存は、確定のあとで走らせる', async () => {
  const tab = { id: 'T', kind: 'text', temp: true, name: 'memo.txt', eol: 'LF', dirty: true,
    pendingSave: false, saving: false, text: 'v1' };
  const timers = [];
  const saved = [];
  const stubs = {
    getTab: (id) => (id === 'T' ? tab : null),
    tabDoc: (t) => t.text,
    restoreEol: (s) => s,
    renderTabs() {}, refreshStatus() {}, renderTree() {}, renderTreeStates() {},
    toast() {}, Session: { save() {} }, Pins: { rename() {} }, Draft: { clear() {} },
    EXT_TO_LANG: {}, extensionOf: () => 'txt', applyLanguageTo() {},
    Tree: { isTmpRoot: () => false, remove() {}, get: () => ({ id: 'D', loaded: false }) },
    App: { activeId: null },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    doSave: async (id, force) => { saved.push([id, force]); },
    Api: {
      promoteTempFile: async () => {
        // 確定の往復中に書き足され、自動保存（doSave）が pendingSave を立てて帰った。
        tab.text = 'v2';
        tab.pendingSave = true;
        return { entry: { name: 'memo.txt', mimeType: 'text/plain', size: 2, updatedAtIso: 'u1' },
          folder: { id: 'D', name: 'docs' } };
      }
    }
  };
  const { TempMemo } = loadClient(['TempMemo'], stubs);
  await TempMemo.commit('T', 'D', 'memo.txt', false);
  assert.equal(tab.saving, false);
  assert.equal(tab.dirty, true);           // v1 を保存したあと v2 が残っている
  assert.equal(tab.pendingSave, false);
  assert.equal(timers.length, 1);
  timers[0]();
  assert.deepEqual(saved, [['T', false]]);
});

test('裏で差し替えた本文が読めない／読めるようになったら、閲覧専用を付け外しする', async () => {
  const cm = await import('@codemirror/state');
  const { TextCodec } = await import('../client/lib/text-codec.js');
  const toasts = [];
  const { Editor } = loadClient(['detectEol', 'normalizeEol', 'Editor'], {
    TextCodec, Panes: { viewOf: () => null }, App: { activeId: null }, toast: (m) => toasts.push(m)
  });
  Editor.cm = cm;
  Editor.silentSwap = cm.Annotation.define();
  Editor.readOnlyCompartment = new cm.Compartment();
  const tab = { id: 'B1', name: 'a.csv', eol: 'LF' };
  tab.state = cm.EditorState.create({ doc: 'abc', extensions: [Editor.readOnlyCompartment.of(Editor.readOnlyFor(tab.id))] });
  assert.equal(tab.state.readOnly, false);

  TextCodec.remember('B1', TextCodec.UTF8, false, true);
  Editor.replaceDocKeepView(tab, { content: 'ab�', updatedAtIso: 'u2', size: 3, name: 'a.csv' });
  assert.equal(tab.state.doc.toString(), 'ab�');
  assert.equal(tab.state.readOnly, true);
  assert.equal(toasts.length, 1);

  // 本文が同じでも、読める判定に変われば閲覧専用を外す。
  TextCodec.remember('B1', TextCodec.SJIS, false, false);
  Editor.replaceDocKeepView(tab, { content: 'ab�', updatedAtIso: 'u3', size: 3, name: 'a.csv' });
  assert.equal(tab.state.readOnly, false);
  assert.equal(toasts.length, 1);
});

test('読めないファイルでは文字コードのメニューを選べず、未保存にもしない', async () => {
  const { TextCodec } = await import('../client/lib/text-codec.js');
  TextCodec.remember('B2', TextCodec.UTF8, false, true);
  let shown = null;
  const changed = [];
  const { showEncodingMenu } = loadClient(['showEncodingMenu'], {
    TextCodec, activeTab: () => ({ id: 'B2', kind: 'text' }),
    showMenuAt: (_, items) => { shown = items; }, el: {},
    onDocChanged: (id) => changed.push(id), updateStatusMeta() {}, toast() {}
  });
  showEncodingMenu();
  const choices = shown.filter((it) => !it.sep && it.label.startsWith('Shift_JIS'));
  assert.equal(choices[0].disabled, true);
  choices[0].onClick();
  assert.deepEqual(changed, []);
  assert.equal(TextCodec.get('B2'), TextCodec.UTF8);
});
