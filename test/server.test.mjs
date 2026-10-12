import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadServer, gasUtilities, fakeBlob, signed, unsigned } from './harness.mjs';
import { cleanFontFamily } from '../client/lib/font.js';

const S = loadServer();
const { DriveService } = S;

/** appError_ の投げたコードを取り出す。 */
function codeOf(fn) {
  try { fn(); } catch (e) { return e.appCode; }
  return null;
}

test('ID の検証とクエリのエスケープ', () => {
  assert.equal(S.validId_('1AbC_-9'), true);
  assert.equal(S.validId_('root'), true);
  assert.equal(S.validId_("a' or 'b"), false);
  assert.equal(S.validId_(''), false);
  assert.equal(S.validId_(null), false);
  assert.equal(S.escQ_("it's \\ ok"), "it\\'s \\\\ ok");
});

test('script に埋める JSON', () => {
  const s = S.safeJson_({ a: '</script><!--', b: '  ' });
  assert.ok(!s.includes('<'));
  assert.ok(!s.includes(' ') && !s.includes(' '));
  assert.deepEqual(JSON.parse(s), { a: '</script><!--', b: '  ' });
});

test('競合検出: 基準が空なら上書きしない', () => {
  const now = '2026-09-24T00:00:00.000Z';
  assert.equal(codeOf(() => DriveService.assertNoConflict_(now, now, false, 'a')), null);
  assert.equal(codeOf(() => DriveService.assertNoConflict_(now, '2026-01-01T00:00:00.000Z', false, 'a')), 'CONFLICT');
  assert.equal(codeOf(() => DriveService.assertNoConflict_(now, '', false, 'a')), 'CONFLICT');
  assert.equal(codeOf(() => DriveService.assertNoConflict_(now, null, false, 'a')), 'CONFLICT');
  assert.equal(codeOf(() => DriveService.assertNoConflict_(now, '', true, 'a')), null);
});

test('保存サイズの上限', () => {
  const max = S.MAX_FILE_SIZE_BYTES;
  assert.equal(DriveService.assertUtf8Size_('abc', false), null);
  assert.equal(codeOf(() => DriveService.assertUtf8Size_('a'.repeat(max + 1), false)), 'TOO_LARGE');
});

test('アップロードの MIME タイプ', () => {
  assert.equal(DriveService.safeUploadMime_('text/plain'), 'text/plain');
  assert.equal(DriveService.safeUploadMime_('Image/PNG'), 'image/png');
  assert.equal(DriveService.safeUploadMime_('application/vnd.google-apps.script'), '');
  assert.equal(DriveService.safeUploadMime_('text/html; charset=utf-8'), '');
  assert.equal(DriveService.safeUploadMime_('../../x'), '');
  assert.equal(DriveService.safeUploadMime_(''), '');
  assert.equal(DriveService.safeUploadMime_(null), '');
});

test('一時メモの掃除は自分のものだけ', () => {
  assert.equal(DriveService.isMyTempFile_({ ownedByMe: true }), true);
  assert.equal(DriveService.isMyTempFile_({ ownedByMe: false, lastModifyingUser: { me: true } }), true);
  assert.equal(DriveService.isMyTempFile_({ ownedByMe: false, lastModifyingUser: { me: false } }), false);
  assert.equal(DriveService.isMyTempFile_({}), false);
  assert.equal(DriveService.isMyTempFile_(null), false);
});

test('Range 付きの取得で 416 は空の本文（空のファイル）', () => {
  const resp = (code) => ({ getResponseCode: () => code, getContentText: () => '{"error":{"message":"x"}}' });
  const ranged = { headers: { Range: 'bytes=0-1' } };
  const r = S.parseResp_(resp(416), ranged);
  assert.equal(r.ok, true);
  assert.equal(r.decoded().text, '');
  assert.equal(S.parseResp_(resp(416), { headers: {} }).ok, false);
  assert.equal(S.parseResp_(resp(404), ranged).ok, false);
});

test('.gs を読み込む順に依存しない（DriveService を分けたファイルが揃う）', () => {
  const R = loadServer({}, { reverse: true });
  const a = Object.keys(S.DriveService).sort();
  const b = Object.keys(R.DriveService).sort();
  assert.ok(a.length > 100);
  assert.deepEqual([...b], [...a]);
});

test('設定: フォント名はクライアントと同じ規則で丸める', () => {
  const inputs = [
    '', null, undefined, 42, 'HackGen Console NF', '  a  b ,, A B, c',
    '"Menlo"; } body { color: red', 'ＭＳ ゴシック, Osaka-Mono', 'a, b, c, d, e, f',
    'x'.repeat(100) + ', y', 'tab\there', 'emoji😀font'
  ];
  for (const raw of inputs) {
    assert.equal(DriveService.cleanFontFamily_(raw), cleanFontFamily(raw), JSON.stringify(raw));
  }
  assert.equal(DriveService.defaultSettings_().fontFamily, '');
  assert.equal(DriveService.sanitizeSettings_({ fontFamily: 'HackGen Console NF; x' }).fontFamily, 'HackGen Console NF x');
  assert.equal(DriveService.sanitizeSettings_({}).fontFamily, '');
  // 以前の保存値（fontFamily が無い）を読んでも既定で埋まる
  assert.equal(DriveService.settingsFrom_(JSON.stringify({ fontSize: 14 })).fontFamily, '');
});

/** UrlFetchApp.fetchAll の応答のスタブ。 */
function httpResp(code, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return { getResponseCode: () => code, getContentText: () => text };
}

test('起動: 開けなかったルートは名前の更新のついでに消さない', () => {
  let savedRoots = null;
  const puts = {};
  const ctx = loadServer({
    ScriptApp: { getOAuthToken: () => 't' },
    PropertiesService: {
      getUserProperties: () => ({ setProperty: (k, v) => { if (k === 'roots') savedRoots = JSON.parse(v); } })
    },
    CacheService: {
      getUserCache: () => ({
        getAll: () => ({}),
        put: (k, v) => { puts[k] = v; },
        putAll: () => {}
      })
    },
    UrlFetchApp: {
      fetchAll: (reqs) => reqs.map((r) => {
        if (/\/files\/AAAAAAAAAA\?/.test(r.url)) {
          return httpResp(200, { id: 'AAAAAAAAAA', name: '新しい名前', mimeType: 'application/vnd.google-apps.folder' });
        }
        if (/\/files\/BBBBBBBBBB\?/.test(r.url)) return httpResp(500, { error: { message: 'backend' } });
        if (/\/drives\?/.test(r.url)) return httpResp(200, { drives: [{ id: 'D1', name: 'x' }], nextPageToken: 'p2' });
        return httpResp(200, { files: [] });
      })
    }
  });
  const result = { roots: [], rootErrors: [], folderEntries: null, session: null, activeFile: null };
  const T = { mark() {} };
  ctx.getBootstrapRest_(result, [{ id: 'AAAAAAAAAA', name: '古い名前' }, { id: 'BBBBBBBBBB', name: 'B' }], null, T);
  assert.equal(result.rootErrors.length, 1);
  assert.deepEqual(savedRoots, [{ id: 'AAAAAAAAAA', name: '新しい名前' }, { id: 'BBBBBBBBBB', name: 'B' }]);
  // 共有ドライブ名は 1 ページで読み切れていないので覚えない（選択画面で 101 件目以降が消えるため）
  assert.equal(puts.sharedDriveNames, undefined);
});

test('変更履歴: 1 ページで読み切れなくても新しい版を返す', () => {
  const pages = {
    '': { revisions: [{ id: '1' }, { id: '2' }], nextPageToken: 'n' },
    n: { revisions: [{ id: '3' }] }
  };
  const ctx = loadServer({
    DriveApp: { getFileById: () => ({ getName: () => 'a.txt' }) },
    Drive: { Files: {}, Revisions: { list: (id, o) => pages[o.pageToken || ''] } }
  });
  const ids = ctx.DriveService.listRevisions_('F').revisions.map((r) => r.id);
  assert.deepEqual([...ids], ['3', '2', '1']);
});

test('一時メモ: 既存フォルダを探せなかったら作らない（二重に作らない）', () => {
  const methods = [];
  const ctx = loadServer({
    ScriptApp: { getOAuthToken: () => 't' },
    UrlFetchApp: {
      fetchAll: (reqs) => reqs.map((r) => { methods.push(r.method); return httpResp(503, { error: { message: 'x' } }); })
    }
  });
  assert.throws(() => ctx.DriveService.ensureChildFolderRest_('root', 'tmp'));
  assert.deepEqual(methods, ['get']);
});

/* ---- 文字コード（UTF-8 の厳密な判定・BOM の保持）。クライアントとの突き合わせは encoding.test.mjs ---- */

const E = loadServer({ Utilities: gasUtilities });
const UTF8_BOM = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a,b\n日本,語\n')]);
/** UTF-8 としても Shift_JIS としても読めない（0xFF は Shift_JIS のどこにも来ない）。 */
const BROKEN = Uint8Array.from([0x61, 0x80, 0xff, 0x62]);

test('サーバー: utf8Valid_ はブラウザの TextDecoder(fatal) と同じ判定をする', () => {
  const fatal = (u8) => { try { new TextDecoder('utf-8', { fatal: true }).decode(u8); return true; } catch (e) { return false; } };
  const edge = [
    [0xef, 0xbf, 0xbd], [0xc0, 0x80], [0xc1, 0xbf], [0xc2, 0x80], [0xe0, 0x9f, 0x80], [0xe0, 0xa0, 0x80],
    [0xed, 0x9f, 0xbf], [0xed, 0xa0, 0x80], [0xf0, 0x8f, 0x80, 0x80], [0xf0, 0x90, 0x80, 0x80],
    [0xf4, 0x8f, 0xbf, 0xbf], [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xe3, 0x81], [0xe3, 0x81, 0x41],
    [0x80], [0xff], [0xef, 0xbb, 0xbf], []
  ];
  for (const b of edge) assert.equal(E.utf8Valid_(signed(Uint8Array.from(b))), fatal(Uint8Array.from(b)), JSON.stringify(b));
  // 乱数のバイト列でも一致する（UTF-8 に寄せた並びも混ぜる）。
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  const pool = [0x00, 0x41, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc2, 0xdf, 0xe0, 0xe3, 0xed, 0xef, 0xf0, 0xf4, 0xf5, 0xff];
  for (let i = 0; i < 5000; i++) {
    const len = rnd() % 8;
    const u8 = Uint8Array.from({ length: len }, () => (rnd() % 3 ? pool[rnd() % pool.length] : rnd() % 256));
    assert.equal(E.utf8Valid_(signed(u8)), fatal(u8), JSON.stringify(Array.from(u8)));
  }
});

/** writeText_ を REST 経路で走らせ、アップロードした本文のバイト列を返す。 */
function serverSave(encoding, bom) {
  let uploaded = null;
  const ctx = loadServer({
    Utilities: gasUtilities,
    ScriptApp: { getOAuthToken: () => 't' },
    LockService: { getUserLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    CacheService: { getUserCache: () => ({ put() {}, remove() {}, putAll() {}, get: () => null }) },
    UrlFetchApp: {
      fetchAll: (reqs) => reqs.map((r) => {
        const ok = (body) => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(body), getBlob: () => null });
        if (r.method === 'patch') {
          uploaded = r.payload;
          return ok({ id: 'F', name: 'a.csv', modifiedTime: '2026-10-12T01:00:00.000Z', size: '9', mimeType: 'text/csv' });
        }
        return ok({ id: 'F', name: 'a.csv', mimeType: 'text/csv', modifiedTime: '2026-10-12T00:00:00.000Z', size: '5' });
      })
    }
  });
  const res = ctx.DriveService.writeText_('FFFFFFFFFF', 'a,b', '2026-10-12T00:00:00.000Z', false, encoding, bom);
  assert.equal(res.updatedAtIso, '2026-10-12T01:00:00.000Z');
  return uploaded;
}

test('サーバー: BOM 付きで開いた UTF-8 は BOM を付けて保存する', () => {
  const withBom = serverSave('UTF-8', true);
  assert.equal(typeof withBom, 'string');
  assert.ok(withBom.includes('\r\n\r\n\ufeffa,b\r\n--'), '本文の直前に BOM がある');
  const without = serverSave('UTF-8', false);
  assert.ok(without.includes('\r\n\r\na,b\r\n--'));
  assert.ok(!without.includes('\ufeff'));
  // Shift_JIS には付けない（バイト列で送る）。
  const sjis = serverSave('Shift_JIS', true);
  assert.ok(Array.isArray(sjis));
  assert.ok(!new TextDecoder().decode(unsigned(sjis)).includes('\ufeff'));
});

test('サーバー: 読み込みの戻り値に bom / broken が入り、本文から BOM は外す', () => {
  const media = (u8) => ({
    ok: true,
    decoded: () => E.decodeText_(fakeBlob(u8))
  });
  const meta = { name: 'a.csv', mimeType: 'text/csv', size: '20', modifiedTime: '2026-10-12T00:00:00.000Z' };
  const r1 = E.DriveService.assembleRead_('F', meta, media(UTF8_BOM));
  assert.equal(r1.bom, true);
  assert.equal(r1.broken, false);
  assert.equal(r1.content.charCodeAt(0), 'a'.charCodeAt(0));
  const r2 = E.DriveService.assembleRead_('F', meta, media(BROKEN));
  assert.equal(r2.broken, true);
});

/* ---- UserProperties の 9KB 制限・改名・コピー名・一時メモの引っ越し ---- */

/** UserProperties のスタブ。9KB（バイト数）を超える値は GAS と同じく例外にする。 */
function fakeProps(init = {}) {
  const store = new Map(Object.entries(init));
  return {
    store,
    getProperty: (k) => (store.has(k) ? store.get(k) : null),
    setProperty: (k, v) => {
      if (new TextEncoder().encode(v).length > 9216) throw new Error('Argument too large: value');
      store.set(k, v);
    },
    deleteProperty: (k) => { store.delete(k); }
  };
}

test('セッション・ピン留め: 日本語の名前でも 9KB（バイト数）に収めて保存する', () => {
  const props = fakeProps();
  const ctx = loadServer({ Utilities: gasUtilities, PropertiesService: { getUserProperties: () => props } });
  const name = 'あ'.repeat(120) + '.txt';
  const tabs = Array.from({ length: 20 }, (_, i) => ({ id: 'F' + i, name, kind: 'text' }));
  const expanded = Array.from({ length: 40 }, (_, i) => 'D' + i);
  const r = ctx.DriveService.saveSession_({ activeId: 'F0', tabs, expanded });
  const saved = props.getProperty('session');
  assert.ok(new TextEncoder().encode(saved).length <= ctx.MAX_SESSION_BYTES);
  assert.equal(r.expanded, 0, '展開状態から先に落とす');
  assert.ok(r.tabs > 0 && r.tabs < 20);

  const p = ctx.DriveService.savePins_({ items: Array.from({ length: 40 }, (_, i) => ({ id: 'P' + i, name, kind: 'text' })) });
  assert.ok(p.count > 0 && p.count < 40);
  for (const v of props.store.values()) assert.ok(new TextEncoder().encode(v).length <= 8000);
});

test('改名: REST の PATCH 応答の modifiedTime を返す（setName は使わない）', () => {
  const reqs = [];
  let setName = false;
  const file = { getName: () => '古い.txt', getParents: () => ({ hasNext: () => false }), setName: () => { setName = true; } };
  const ctx = loadServer({
    ScriptApp: { getOAuthToken: () => 't' },
    CacheService: { getUserCache: () => ({ remove() {} }) },
    UrlFetchApp: {
      fetchAll: (rs) => rs.map((r) => {
        reqs.push(r);
        return httpResp(200, { id: 'FFFFFFFFFF', name: '新しい.txt', mimeType: 'text/plain', size: '3', modifiedTime: '2026-10-12T02:00:00Z' });
      })
    }
  });
  ctx.DriveService.assertFile_ = () => file;
  const e = ctx.DriveService.renameFile_('FFFFFFFFFF', '新しい.txt');
  assert.equal(e.updatedAtIso, '2026-10-12T02:00:00.000Z');
  assert.equal(e.name, '新しい.txt');
  assert.equal(setName, false);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].method, 'patch');
  assert.deepEqual(JSON.parse(reqs[0].payload), { name: '新しい.txt' });
  assert.ok(/fields=[^&]*modifiedTime/.test(reqs[0].url));
});

test('コピー名: フォルダの一覧ではなく候補の名前で問い合わせる', () => {
  const asked = [];
  const taken = new Set(['a のコピー.txt', 'a のコピー 2.txt', 'a のコピー 3.txt', 'a のコピー 4.txt', 'a のコピー 5.txt', 'a のコピー 6.txt']);
  const ctx = loadServer({
    ScriptApp: { getOAuthToken: () => 't' },
    UrlFetchApp: {
      fetchAll: (rs) => rs.map((r) => {
        const q = new URL(r.url).searchParams.get('q');
        asked.push(q);
        const m = /name = '(.*)' and trashed/.exec(q);
        assert.ok(m, q);
        return httpResp(200, { files: taken.has(m[1]) ? [{ id: 'X', name: m[1] }] : [] });
      })
    }
  });
  assert.equal(ctx.DriveService.uniqueCopyNameById_('DDDDDDDDDD', 'a.txt'), 'a のコピー 7.txt');
  assert.ok(asked.every((q) => q.startsWith("'DDDDDDDDDD' in parents and name = ")));
  // エスケープされる
  ctx.DriveService.uniqueCopyNameById_('DDDDDDDDDD', "it's.txt");
  assert.ok(asked.some((q) => q.includes("it\\'s のコピー.txt")));
});

test('一時メモの引っ越し: 移し残しを複数覚え、まとめて移す（旧形式も読む）', () => {
  // 旧形式（ID 1 つ）と配列の両方を読める
  const R = loadServer();
  assert.deepEqual([...R.DriveService.tmpMoveFromList_('AAAAAAAAAA')], ['AAAAAAAAAA']);
  assert.deepEqual([...R.DriveService.tmpMoveFromList_('["B","A","B","x\'y"]')], ['B', 'A']);
  assert.deepEqual([...R.DriveService.tmpMoveFromList_('[1,2,3,4,5,6,7]')], ['1', '2', '3', '4', '5']);
  assert.deepEqual([...R.DriveService.tmpMoveFromList_('[broken')], []);
  assert.deepEqual([...R.DriveService.tmpMoveFromList_(null)], []);

  const props = fakeProps({ tmpFolderId: 'TA', tmpParent: JSON.stringify({ id: 'PA', name: 'a' }) });
  const ctx = loadServer({ PropertiesService: { getUserProperties: () => props } });
  const remain = { TA: 400, TB: 0, TC: 0 };
  const calls = [];
  Object.assign(ctx.DriveService, {
    folderRef_: (id) => ({ id, name: id }),
    ensureTmpFolder_: (ref) => ({ id: 'T' + ref.id.slice(1), name: 'tmp' }),
    moveTempFiles_: (from, to) => {
      calls.push(from + '>' + to);
      const n = Math.min(remain[from], 300);
      remain[from] -= n;
      remain[to] = (remain[to] || 0) + n;
      return { moved: n, failed: 0, hasMore: remain[from] > 0 };
    }
  });
  // A → B: 300 件だけ移り、A を覚える
  let r = ctx.DriveService.setTempFolder_('PB');
  assert.equal(r.hasMore, true);
  assert.deepEqual(JSON.parse(props.getProperty('tmpMoveFrom')), ['TA']);
  // B → C: A を忘れない（以前は B で上書きしていた）。1 回の上限に達したら A は次回に回す
  r = ctx.DriveService.setTempFolder_('PC');
  assert.deepEqual(calls, ['TA>TB', 'TB>TC']);
  assert.equal(r.hasMore, true);
  assert.deepEqual(JSON.parse(props.getProperty('tmpMoveFrom')), ['TA']);
  // C を選び直すと A の残りも C へ
  r = ctx.DriveService.setTempFolder_('PC');
  assert.deepEqual(calls, ['TA>TB', 'TB>TC', 'TA>TC']);
  assert.equal(remain.TA, 0);
  assert.equal(remain.TC, 400);
  assert.equal(r.hasMore, false);
  assert.equal(props.getProperty('tmpMoveFrom'), null);
  // 旧形式の値が残っていても、同じ場所を選び直せば続きから移す
  remain.TA = 5;
  props.setProperty('tmpMoveFrom', 'TA');
  r = ctx.DriveService.setTempFolder_('PC');
  assert.equal(r.moved, 5);
  assert.equal(r.previousFolderId, 'TA');
  assert.equal(props.getProperty('tmpMoveFrom'), null);
});
