/* ---------------------- 読み書きの土台 ---------------------- */

/** テキストとして扱えるファイルか。 */
function termIsTextNode(node) {
  if (!node || node.type !== 'file') return false;
  const entry = node.entry;
  return !entry || entry.viewer === 'editor';
}

/**
 * 本文を 1 件読む。開いているタブがあれば編集中の内容を正とする
 * （画面に見えているものと、コマンドが見るものを一致させる）。
 * @return {Promise<{id, name, content, updatedAtIso, size, mimeType}>}
 */
async function termReadRecord(node) {
  if (node.type === 'folder') throw new TermError('「' + node.name + '」はフォルダです。');
  if (!termIsTextNode(node)) {
    const entry = node.entry || {};
    const reason = entry.reason ||
      (entry.viewer === 'embed' ? 'このエディタでは閲覧専用です（' + entry.kind + '）' : 'テキストではありません');
    throw new TermError('「' + node.name + '」は読めません（' + reason + '）。');
  }
  const tab = getTab(node.id);
  if (tab && tab.kind === 'text' && tab.loaded) {
    return {
      id: node.id, name: tab.name, mimeType: tab.mimeType || '',
      content: restoreEol(tabDoc(tab), tab.eol),
      updatedAtIso: tab.baseUpdatedAtIso, size: tab.size
    };
  }
  const { data, revalidate } = Store.readFile(node.id);
  if (data) return data;
  const fresh = await revalidate;
  if (!fresh) throw new TermError('「' + node.name + '」を読めませんでした。');
  return fresh;
}

/**
 * まとめて読むものを先に 1 往復で取っておく。
 * grep や sed -i のように何十件も開くコマンドで、1 件ずつの往復を避ける。
 */
async function termPrefetch(nodes) {
  const ids = nodes
    .filter((n) => termIsTextNode(n) && !Store.peek(n.id) && !getTab(n.id))
    .map((n) => n.id);
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    try {
      const got = await Api.readFilesMulti(chunk);
      for (const d of Object.values(got || {})) {
        if (d && typeof d.content === 'string') Store.putContent(d);
      }
    } catch (err) {
      // まとめ読みに失敗しても、あとで 1 件ずつ読めば済む。
      console.warn('まとめ読みに失敗しました: ' + err.message);
    }
  }
}

/** 編集の対象になる「いまのバッファ」（% が指すタブ）。 */
function termBufferTab() {
  const last = App.lastTextTabId ? getTab(App.lastTextTabId) : null;
  if (last && last.kind === 'text') return last;
  return App.tabs.find((t) => t.kind === 'text') || null;
}

/**
 * % / %sel を読む。
 * @param {boolean} sel 選択範囲だけか（選択が無ければ全体）
 * @return {{tab:Tab, text:string, from:number, to:number}}
 */
function termBufferRead(sel) {
  const tab = termBufferTab();
  if (!tab) throw new TermError('テキストのタブが開いていません（% は編集中のファイルを指します）。');
  if (!tab.loaded) throw new TermError('「' + tab.name + '」はまだ読み込まれていません。一度タブを開いてください。');
  const doc = tabDoc(tab);
  if (!sel) return { tab, text: doc, from: 0, to: doc.length };
  const view = Panes.viewOf(tab.id);
  const main = view ? view.state.selection.main : null;
  if (!main || main.empty) return { tab, text: doc, from: 0, to: doc.length };
  return { tab, text: doc.slice(main.from, main.to), from: main.from, to: main.to };
}

/**
 * % / %sel へ書き戻す。置き換えは 1 つのトランザクションにするので、
 * 気に入らなければ Mod+Z で元に戻せる。
 */
function termBufferWrite(sel, text, append) {
  const target = termBufferRead(sel);
  const tab = target.tab;
  let insert = append ? target.text + text : text;
  // 全体を置き換えるときは、元が改行で終わっていたらそれを残す
  // （行単位のコマンドは表示のために末尾の改行を落としている）。
  const whole = target.from === 0 && target.to === (tab.state ? tab.state.doc.length : 0);
  if (whole && insert && /\n$/.test(target.text) && !/\n$/.test(insert)) insert += '\n';
  const spec = {
    changes: { from: target.from, to: target.to, insert },
    selection: { anchor: target.from, head: target.from + insert.length }
  };
  const view = Panes.viewOf(tab.id);
  if (view) {
    view.dispatch(spec);          // updateListener が dirty と自動保存を面倒みる
  } else {
    tab.state = tab.state.update(spec).state;
    onDocChanged(tab.id);
  }
  return tab;
}

/**
 * ファイルへ書き出す。
 * 開いているタブがあるときはタブ越しに書く（Undo が効き、画面と中身がずれない）。
 * 未保存の編集があるファイルは触らない。
 */
async function termWriteFile(node, text) {
  const tab = getTab(node.id);
  if (tab && tab.kind === 'text') {
    if (tab.dirty) {
      throw new TermError('「' + node.name + '」には未保存の編集があります。保存するか閉じてから実行してください。');
    }
    if (!tab.loaded) {
      const ok = await loadTabContent(tab);
      if (!ok) throw new TermError('「' + node.name + '」を読み込めませんでした。');
    }
    const view = Panes.viewOf(tab.id);
    const spec = { changes: { from: 0, to: tab.state.doc.length, insert: text } };
    if (view) view.dispatch(spec);
    else { tab.state = tab.state.update(spec).state; onDocChanged(tab.id); }
    await doSave(tab.id, false);
    const after = getTab(node.id);
    if (after && after.dirty) throw new TermError('「' + node.name + '」を保存できませんでした。');
    return;
  }

  const rec = await termReadRecord(node);
  const eol = detectEol(rec.content) || Settings.get('defaultEol');
  const body = restoreEol(text, eol);
  const res = await Api.saveFile(node.id, body, rec.updatedAtIso, false);
  Store.putContent({
    id: node.id, name: res.name || node.name, mimeType: rec.mimeType || '',
    size: res.size, content: body, updatedAtIso: res.updatedAtIso
  });
  patchEntry(node.id, { updatedAtIso: res.updatedAtIso, size: res.size });
}

/**
 * 読み込み対象を解決する。'%' は編集中のバッファ、'%sel' はその選択範囲。
 * @return {Promise<Array<{label:string, node:(Object|null), text:string}>>}
 */
async function termSources(ctx, paths) {
  const out = [];
  for (const p of paths) {
    if (p === '%' || p === '%sel') {
      const buf = termBufferRead(p === '%sel');
      out.push({ label: buf.tab.name + (p === '%sel' ? '（選択範囲）' : ''), node: null, text: buf.text });
      continue;
    }
    const nodes = await Vfs.glob(ctx.cwd, p, { type: 'file' });
    if (!nodes.length) throw new TermError('見つかりません: ' + p);
    await termPrefetch(nodes);
    for (const node of nodes) {
      ctx.check();
      const rec = await termReadRecord(node);
      out.push({ label: Vfs.pathOf(node.id), node, text: normalizeEol(rec.content) });
    }
  }
  return out;
}

