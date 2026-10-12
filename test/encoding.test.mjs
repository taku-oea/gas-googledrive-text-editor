import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadServer, loadClient, gasUtilities as Utilities, fakeBlob } from './harness.mjs';
import { TextCodec } from '../client/lib/text-codec.js';

/* 文字コードの判定をサーバー（decodeText_）とクライアント（TextCodec.decode）で突き合わせる。
 * あわせてクライアント側の BOM の往復と、比較ビューから反映したときの基準日時。
 * サーバーだけの試験（utf8Valid_・BOM 付きの保存）は server.test.mjs。 */

const S = loadServer({ Utilities });

/** 判定に使う見本。名前 → バイト列。 */
const enc = (s) => new TextEncoder().encode(s);
const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const SAMPLES = {
  ascii: enc('abc'),
  utf8: enc('日本語'),
  // 本物の U+FFFD（EF BF BD）を含む正しい UTF-8。Shift_JIS としても置換文字なしで読めてしまう
  // 並び（「縺ゑｿｽ」）なので、置換文字の有無で決める旧判定では Shift_JIS と取り違えていた。
  utf8WithReplacement: enc('あ\ufffd'),
  utf8Bom: cat([0xef, 0xbb, 0xbf], enc('a,b\n日本,語\n')),
  sjis: TextCodec.encode('日本語①～', TextCodec.SJIS),
  // UTF-8 としても Shift_JIS としても読めない（0xFF は Shift_JIS の先頭にも 2 バイト目にも来ない）。
  broken: Uint8Array.from([0x61, 0x80, 0xff, 0x62]),
  empty: new Uint8Array(0)
};

test('文字コード判定: 本物の U+FFFD を含む UTF-8 を Shift_JIS と取り違えない', () => {
  // 見本が「Shift_JIS としても読める」ことを確かめておく（そうでないと試験にならない）。
  assert.ok(!new TextDecoder('shift_jis').decode(SAMPLES.utf8WithReplacement).includes('\ufffd'));
  const srv = S.decodeText_(fakeBlob(SAMPLES.utf8WithReplacement));
  assert.equal(srv.encoding, 'UTF-8');
  assert.equal(srv.broken, false);
  assert.equal(srv.text, 'あ\ufffd');
  const cli = TextCodec.decode(SAMPLES.utf8WithReplacement.buffer);
  assert.equal(cli.encoding, TextCodec.UTF8);
  assert.equal(cli.broken, false);
  assert.equal(cli.text, 'あ\ufffd');
});

test('文字コード判定: サーバーとクライアントで同じ結果になる', () => {
  for (const [name, u8] of Object.entries(SAMPLES)) {
    const srv = S.decodeText_(fakeBlob(u8));
    const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    const cli = TextCodec.decode(buf);
    assert.equal(srv.encoding, cli.encoding, name);
    assert.equal(srv.bom, cli.bom, name);
    assert.equal(srv.broken, cli.broken, name);
    // サーバーは BOM を本文に残して返す（呼び出し側の stripBom_ が外す）。
    assert.equal(S.DriveService.stripBom_(srv.text), cli.text, name);
  }
  assert.equal(TextCodec.decode(SAMPLES.sjis.buffer.slice(0)).encoding, TextCodec.SJIS);
  const broken = TextCodec.decode(SAMPLES.broken.buffer);
  assert.equal(broken.broken, true);
  assert.equal(broken.encoding, TextCodec.UTF8);
  assert.equal(TextCodec.decode(SAMPLES.utf8Bom.buffer).bom, true);
  assert.equal(TextCodec.decode(SAMPLES.utf8.buffer).bom, false);
});

test('クライアント: BOM と「読めない」を fileId ごとに覚え、BOM を付けて符号化する', () => {
  TextCodec.remember('B1', TextCodec.UTF8, true);
  assert.equal(TextCodec.hasBom('B1'), true);
  assert.equal(TextCodec.label('B1'), 'UTF-8 (BOM)');
  // 文字コードだけの記録（保存直後など）では BOM の値を変えない。
  TextCodec.remember('B1', TextCodec.UTF8);
  assert.equal(TextCodec.hasBom('B1'), true);
  TextCodec.remember('B1', TextCodec.UTF8, false);
  assert.equal(TextCodec.label('B1'), 'UTF-8');
  TextCodec.remember('X1', TextCodec.UTF8, false, true);
  assert.equal(TextCodec.isBroken('X1'), true);
  TextCodec.remember('X1', TextCodec.UTF8, false, false);
  assert.equal(TextCodec.isBroken('X1'), false);

  assert.deepEqual(Array.from(TextCodec.encode('a', TextCodec.UTF8, true)), [0xef, 0xbb, 0xbf, 0x61]);
  assert.deepEqual(Array.from(TextCodec.encode('a', TextCodec.UTF8)), [0x61]);
  // Shift_JIS に BOM は無い。
  assert.deepEqual(Array.from(TextCodec.encode('a', TextCodec.SJIS, true)), [0x61]);
  // 往復: BOM 付きで読んだものを BOM 付きで書くと元のバイト列に戻る。
  const d = TextCodec.decode(SAMPLES.utf8Bom.buffer);
  assert.deepEqual(Array.from(TextCodec.encode(d.text, d.encoding, d.bom)), Array.from(SAMPLES.utf8Bom));
});

test('比較ビューから反映: 比べた Drive の版まで基準日時を進める（それより新しい版は競合のまま）', () => {
  const { advanceBaseFromDiff } = loadClient(['advanceBaseFromDiff']);
  const old = '2026-10-12T00:00:00.000Z';
  const compared = '2026-10-12T01:00:00.000Z';
  const fileSide = { origin: 'file', fileId: 'F', updatedAtIso: compared };

  const tab = { id: 'F', baseUpdatedAtIso: old, conflicted: true };
  assert.equal(advanceBaseFromDiff(tab, fileSide), true);
  assert.equal(tab.baseUpdatedAtIso, compared);
  assert.equal(tab.conflicted, false);

  // 別のファイル・過去の版・貼り付けとの比較では動かさない。
  for (const other of [
    { origin: 'file', fileId: 'G', updatedAtIso: compared },
    { origin: 'revision', fileId: 'F', updatedAtIso: compared },
    { origin: 'text', fileId: null, updatedAtIso: '' }
  ]) {
    const t = { id: 'F', baseUpdatedAtIso: old, conflicted: true };
    assert.equal(advanceBaseFromDiff(t, other), false);
    assert.equal(t.baseUpdatedAtIso, old);
    assert.equal(t.conflicted, true);
  }

  // 比較を開いたあとにタブを保存して基準が新しくなっていたら、古い版へ戻さない。
  const newer = { id: 'F', baseUpdatedAtIso: '2026-10-12T02:00:00.000Z', conflicted: false };
  assert.equal(advanceBaseFromDiff(newer, fileSide), false);
  assert.equal(newer.baseUpdatedAtIso, '2026-10-12T02:00:00.000Z');
});
