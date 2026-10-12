/**
 * hot path を Direct に差し替える。トークンが無い間（起動直後・無効化時）は GAS 経由。
 * ネットワーク層で失敗したら、この画面では以降 GAS 経由に戻して同じ呼び出しをやり直す。
 */
Api.useDirect = () => Api.backend === 'direct' && DriveApi.ready();
for (const fn of ['listEntries', 'listEntriesMulti', 'readFile', 'readFilesMulti', 'saveFile',
  'searchContents', 'listRevisions', 'readRevision',
  'renameFile', 'renameFolder', 'trashFile', 'trashFolder', 'moveFile', 'moveFolder',
  'createFile', 'createFolder', 'copyFile']) {
  const viaGas = Api[fn];
  Api[fn] = async (...args) => {
    if (!Api.useDirect()) return viaGas(...args);
    const end = Perf.start('rest.' + fn);
    try {
      const out = await Direct[fn](...args);
      end({ ok: true });
      return out;
    } catch (err) {
      end({ ok: false, code: err && err.code });
      if (err && err.network) {
        Api.backend = 'gas';
        console.warn('[direct] Drive API に直接接続できないため、サーバー経由に切り替えます: ' + err.message);
        toast('Drive に直接接続できないため、サーバー経由に切り替えました（少し遅くなります）。', 'warn', 8000);
        return viaGas(...args);
      }
      throw err;
    }
  };
}

/**
 * 保存はそのファイルを読んだときの文字コード（と BOM の有無）に戻す。呼び出し側（タブ・比較・
 * ターミナル）が文字コードを持ち回らなくて済むよう、ここで fileId から引いて足す。
 * UTF-8 としても Shift_JIS としても読めなかったファイルは、どこから保存してもここで止める
 * （壊れた所は置換文字で開いているので、保存するとその部分のバイト列が失われる）。
 */
{
  const saveWithEncoding = Api.saveFile;
  Api.saveFile = async (fileId, content, baseUpdatedAtIso, force) => {
    if (TextCodec.isBroken(fileId)) {
      throw new ApiError('NOT_TEXT', 'このファイルには UTF-8 としても Shift_JIS としても読めない部分があるため、' +
        '保存できません（保存すると読めない部分が「\ufffd」に置き換わり、元に戻せなくなります）。');
    }
    return saveWithEncoding(fileId, content, baseUpdatedAtIso, force,
      TextCodec.get(fileId), TextCodec.hasBom(fileId));
  };
  // 読んだ側でも覚える（比較ビューのように Store を通らない読み込みがあるため）。
  const readOne = Api.readFile;
  Api.readFile = async (...args) => {
    const d = await readOne(...args);
    if (d && d.encoding) TextCodec.remember(d.id, d.encoding, d.bom, d.broken);
    return d;
  };
  const readMany = Api.readFilesMulti;
  Api.readFilesMulti = async (...args) => {
    const got = await readMany(...args);
    for (const d of Object.values(got || {})) {
      if (d && d.encoding) TextCodec.remember(d.id, d.encoding, d.bom, d.broken);
    }
    return got;
  };
}

/** getBootstrap の応答からバックエンドを決める（スナップショットにはトークンが無いので GAS のまま）。 */
function applyBackend(data) {
  if (data && data.token) DriveApi.seed(data.token);
  const enabled = !!(data && data.config && data.config.directDrive);
  Api.backend = (enabled && DriveApi.ready()) ? 'direct' : 'gas';
}

/**
 * 楽観的更新。apply() でモデルと画面を即時に変え（戻し関数を返す）、裏で commit() を送る。
 * 成功・失敗のどちらもトーストで知らせ、失敗したら undo() で元に戻す。
 * 改名・移動・ゴミ箱は結果が分かりきっているので、往復（1〜3 秒）を待たせない。
 *
 * @param {{apply:function():function(), commit:function():Promise<*>, onCommit?:function(*),
 *          success:function(*):string, failure:string}} spec
 * @return {Promise<*>} commit の結果（失敗時は reject）
 */
async function optimistic(spec) {
  const undo = spec.apply();
  Session.save();
  try {
    const res = await spec.commit();
    if (spec.onCommit) spec.onCommit(res);
    toast(spec.success(res), 'info', 3500);
    Session.save();
    return res;
  } catch (err) {
    try { undo(); } catch (e) { console.error(e); }
    toast(spec.failure + ': ' + (err && err.message ? err.message : err), 'error', 10000);
    Session.save();
    throw err;
  }
}

