/* ---------------------- OS からのアップロード ---------------------- */

/** アップロードできる 1 ファイルの上限。サーバー側と同じ値。 */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/**
 * File を Base64 に変換する。
 * テキストもバイナリも同じ経路で扱えるようにするため、文字コードの
 * 解釈はここではしない（サーバー側で Blob として作る）。
 *
 * @param {File} file
 * @return {Promise<string>}
 */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : '');
    };
    reader.onerror = () => reject(new Error('ファイルを読み取れませんでした'));
    reader.readAsDataURL(file);
  });
}

/**
 * OS からドロップされたファイルを Drive にアップロードする。
 *
 * @param {FileList|File[]} files
 * @param {string} folderId 保存先
 */
async function uploadFiles(files, folderId) {
  const list = Array.from(files);
  if (!list.length) return;

  const folder = Tree.get(folderId);
  const folderName = folder ? folder.name : '';

  const tooBig = list.filter((f) => f.size > MAX_UPLOAD_BYTES);
  const ok = list.filter((f) => f.size <= MAX_UPLOAD_BYTES);

  if (tooBig.length) {
    toast(tooBig.map((f) => f.name).join('、') + ' は ' +
      formatBytes(MAX_UPLOAD_BYTES) + ' を超えるためスキップします（Drive に直接アップロードしてください）',
      'warn', 12000);
  }
  if (!ok.length) return;

  const go = await modal({
    title: ok.length + ' 件をアップロード',
    body: h('div', {}, [
      h('p', { text: '「' + folderName + '」に次のファイルを作成します。' }),
      h('p', { text: ok.map((f) => f.name + '（' + formatBytes(f.size) + '）').join('、') }),
      h('p', { text: '同名のファイルがある場合は上書きせず「… のコピー」になります。' })
    ]),
    actions: [
      { label: 'アップロード', value: true, variant: 'primary' },
      { label: 'キャンセル', value: false }
    ]
  });
  if (!go) return;

  setStatusText('saving', 'アップロード中…');
  const failed = [];
  let last = null;

  for (const file of ok) {
    try {
      const base64 = await fileToBase64(file);
      last = await Api.uploadFile(folderId, file.name, base64, file.type || '');
    } catch (err) {
      failed.push(file.name + '（' + err.message + '）');
    }
  }

  if (folder) folder.expanded = true;
  await loadFolder(folderId, true);
  refreshStatus();

  if (failed.length) toast('失敗: ' + failed.join('、'), 'error', 12000);
  const done = ok.length - failed.length;
  if (done > 0) {
    toast(done + ' 件をアップロードしました', 'info', 4000);
    // 1 件だけならそのまま開く。
    if (done === 1 && last && last.openable) await openEntry(last, { ephemeral: false });
  }
}

/** ドラッグされているのが OS のファイルかどうか。 */
function isFileDrag(ev) {
  const dt = ev.dataTransfer;
  if (!dt) return false;
  return Array.from(dt.types || []).indexOf('Files') >= 0;
}

/** アプリの中のドラッグ（タブ・ツリーの行・ピン留め）が進行中か。 */
function isAppDrag() {
  return !!(App.dragTabId || App.dragId || App.dragPinId);
}

