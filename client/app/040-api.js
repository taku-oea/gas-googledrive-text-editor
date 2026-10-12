/* ------------------------------------------------------------------ *
 *  サーバー呼び出し（google.script.run の Promise ラッパ）
 * ------------------------------------------------------------------ */

/**
 * サーバー関数を呼ぶ。サーバーは常に {ok, data} / {ok, error, code} を返すので、
 * withFailureHandler は通信断・タイムアウト専用になる。
 * @param {string} fnName
 * @param {...*} args
 * @return {Promise<*>}
 */
function call(fnName, ...args) {
  const end = Perf.start('rpc.' + fnName);
  return new Promise((resolve, reject) => {
    google.script.run
      .withSuccessHandler((res) => {
        end({ ok: !!(res && res.ok) });
        try { resolve(unwrapResponse(res)); } catch (err) { reject(err); }
      })
      .withFailureHandler((err) => {
        end({ ok: false, transport: true });
        const msg = (err && err.message) ? err.message : String(err);
        reject(new ApiError('TRANSPORT', 'サーバーとの通信に失敗しました: ' + msg));
      })[fnName](...args);
  });
}

/**
 * サーバー API の入口。呼び出し側は `Api.readFile(id)` のように関数名で呼ぶ。
 *
 * いまは全部 google.script.run（backend='gas'）へ流すだけだが、
 * 将来 Drive REST をブラウザから直接叩く backend='direct' を載せるときに
 * ここのメソッドを差し替えるだけで済むよう、呼び出しを 1 箇所に集めている。
 * 戻り値の形はサーバー関数の data と同じ。
 */
const Api = { backend: 'gas' };
for (const fn of [
  'getBootstrap', 'listPickerRoots', 'listFolderChildren', 'resolveFolderRef',
  'addRoot', 'removeRoot', 'listEntries', 'listEntriesMulti',
  'readFile', 'readFilesMulti', 'saveFile', 'createFile', 'renameFile', 'trashFile',
  'createFolder', 'renameFolder', 'trashFolder', 'copyFile', 'uploadFile',
  'moveFile', 'moveFolder', 'searchContents', 'listRevisions', 'readRevision',
  'saveSettings', 'saveSession', 'savePins', 'getToken',
  'createTempFile', 'listTempEntries', 'promoteTempFile', 'sweepTempFiles',
  'setTempFolder'
]) {
  Api[fn] = (...args) => call(fn, ...args);
}

