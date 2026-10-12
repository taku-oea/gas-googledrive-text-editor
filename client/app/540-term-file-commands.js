/* ---------------------- ファイル操作のコマンド ---------------------- */

/** 移動・改名を 1 件ぶん。ツリーとタブの表示もここで合わせる。 */
async function termMoveNode(node, destFolderId, newName) {
  const isFolder = node.type === 'folder';
  if (destFolderId && destFolderId !== node.parentId) {
    const res = await (isFolder ? Api.moveFolder(node.id, destFolderId) : Api.moveFile(node.id, destFolderId));
    Tree.detach(node.id);
    Tree.attach(node.id, destFolderId);
    if (!isFolder) {
      syncTempFlag(node.id, destFolderId);
      if (node.entry && res && res.updatedAtIso) Object.assign(node.entry, res);
    }
  }
  if (newName && newName !== node.name) {
    const res = await (isFolder ? Api.renameFolder(node.id, newName) : Api.renameFile(node.id, newName));
    node.name = (res && res.name) || newName;
    if (node.entry) node.entry.name = node.name;
    if (!isFolder && res && res.updatedAtIso) syncRenamedTab(res);
    if (node.parentId) sortChildren(node.parentId);
  }
}

/**
 * 「最後の引数が移動先」という形の引数を解く。
 * 移動先が既にあるフォルダなら中へ、無ければ（元が 1 つのときだけ）その名前で置く。
 */
async function termDestination(ctx, argv, what) {
  if (argv.length < 2) throw new TermError(what + '元と' + what + '先を指定してください。');
  const destPath = argv[argv.length - 1];
  const srcPaths = argv.slice(0, -1);

  const sources = [];
  const seen = new Set();
  for (const p of srcPaths) {
    const hits = await Vfs.glob(ctx.cwd, p);
    if (!hits.length) throw new TermError('見つかりません: ' + p);
    for (const node of hits) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      sources.push(node);
    }
  }

  const dest = await Vfs.resolve(ctx.cwd, destPath, { allowMissing: true });
  if (!dest.missing && dest.node && dest.node.type === 'folder') {
    return { sources, folderId: dest.id, name: null, folderNode: dest.node };
  }
  if (!dest.missing && Vfs.isRoot(dest.id)) {
    return { sources, folderId: null, name: null, folderNode: null };
  }
  if (sources.length > 1) {
    throw new TermError('「' + destPath + '」はフォルダではありません。複数をまとめて' + what + 'せません。');
  }
  if (!dest.missing) throw new TermError('「' + destPath + '」は既にあります。');
  if (Vfs.isRoot(dest.parentId)) throw new TermError('仮想ルートの直下にはファイルを置けません。');
  return { sources, folderId: dest.parentId, name: dest.name, folderNode: Tree.get(dest.parentId) };
}

Object.assign(TERM_COMMANDS, {

  mkdir: {
    usage: 'mkdir [-p] <パス…>',
    desc: 'フォルダを作る',
    flags: { p: true },
    complete: 'dir',
    async run(ctx, argv) {
      const { flags, rest } = termArgs(argv, this.flags);
      if (!rest.length) throw new TermError('作るフォルダの名前を指定してください。');
      const made = [];
      for (const path of rest) {
        ctx.check();
        const segs = path.split('/').filter((s) => s !== '' && s !== '.');
        if (!segs.length) throw new TermError('フォルダの名前を指定してください。');
        // -p なら途中の階層も作る。そうでなければ最後の 1 段だけ。
        let cur = path.charAt(0) === '/' ? null : ctx.cwd;
        for (let i = 0; i < segs.length; i++) {
          const last = i === segs.length - 1;
          await Vfs.ensure(cur);
          const found = Vfs.find(cur, segs[i]);
          if (found) {
            if (found.type !== 'folder') throw new TermError('同じ名前のファイルがあります: ' + segs[i]);
            cur = found.id;
            if (last && !flags.p) throw new TermError('既にあります: ' + path);
            continue;
          }
          if (!last && !flags.p) throw new TermError('途中のフォルダがありません: ' + segs[i] + '（-p を付けると作ります）');
          if (Vfs.isRoot(cur)) throw new TermError('仮想ルートの直下にはフォルダを作れません（ルートフォルダは設定から追加します）。');
          const res = await Api.createFolder(cur, segs[i]);
          Tree.insertChild(cur, { id: res.id, name: res.name, type: 'folder' });
          made.push(Vfs.pathOf(res.id));
          cur = res.id;
        }
      }
      renderTree();
      Session.save();
      return made.length ? made.join('\n') : '（作るものはありませんでした）';
    }
  },

  touch: {
    usage: 'touch <パス…>',
    desc: '空のファイルを作る（既にあれば何もしない）',
    complete: 'path',
    async run(ctx, argv) {
      if (!argv.length) throw new TermError('作るファイルの名前を指定してください。');
      const made = [];
      for (const path of argv) {
        ctx.check();
        const r = await Vfs.resolve(ctx.cwd, path, { allowMissing: true });
        if (!r.missing) continue;
        if (Vfs.isRoot(r.parentId)) throw new TermError('仮想ルートの直下にはファイルを置けません。');
        const entry = await Api.createFile(r.parentId, r.name);
        Tree.insertChild(r.parentId, entry);
        made.push(Vfs.pathOf(entry.id));
      }
      renderTree();
      return made.length ? made.join('\n') : '（すべて既にあります）';
    }
  },

  cp: {
    usage: 'cp <元…> <先>',
    desc: 'ファイルを複製する（フォルダは対象外）',
    complete: 'path',
    async run(ctx, argv) {
      const plan = await termDestination(ctx, argv, 'コピー');
      const folders = plan.sources.filter((n) => n.type === 'folder');
      if (folders.length) throw new TermError('フォルダのコピーには対応していません: ' + folders[0].name);
      if (!plan.folderId) throw new TermError('コピー先のフォルダを指定してください。');

      ctx.status('コピー中… 0 / ' + plan.sources.length);
      let done = 0;
      const made = [];
      const failed = [];
      await termPool(plan.sources, 6, async (node) => {
        if (ctx.aborted()) return;
        try {
          // 別のフォルダへ入れるときは名前をそのままにする。同じフォルダなら
          // 名前を渡さず「○○ のコピー」を Drive 側に付けてもらう（複製と同じ）。
          const wanted = plan.name || (node.parentId === plan.folderId ? null : node.name);
          let entry;
          try {
            entry = await Api.copyFile(node.id, plan.folderId, wanted);
          } catch (err2) {
            if (!wanted || String(err2.message || '').indexOf('既に') < 0) throw err2;
            entry = await Api.copyFile(node.id, plan.folderId, null);
          }
          Tree.insertChild(plan.folderId, entry);
          made.push(Vfs.pathOf(entry.id));
        } catch (err) {
          failed.push(node.name + ': ' + err.message);
        }
        done++;
        ctx.status('コピー中… ' + done + ' / ' + plan.sources.length);
      });
      renderTree();
      Session.save();
      return made.join('\n') + (failed.length ? '\nコピーできなかったもの:\n  ' + failed.join('\n  ') : '');
    }
  },

  mv: {
    usage: 'mv <元…> <先>',
    desc: '移動・名前の変更をする',
    complete: 'path',
    async run(ctx, argv) {
      const plan = await termDestination(ctx, argv, '移動');

      // 別のドライブへまたぐ移動は所有者が変わる。まとめて 1 回だけ確認する。
      const destRoot = plan.folderId ? Tree.rootOf(plan.folderId) : null;
      const crossing = plan.sources.filter((n) => {
        const from = Tree.rootOf(n.id);
        return from && destRoot && from !== destRoot;
      });
      if (crossing.length) {
        const fromName = (Tree.get(Tree.rootOf(crossing[0].id)) || {}).name || '';
        const toName = (Tree.get(destRoot) || {}).name || '';
        const ok = await ctx.confirm(crossing.length + ' 件が別のルート（' + fromName + ' → ' + toName +
          '）へ移ります。移動先が共有ドライブの場合、所有者が共有ドライブに変わります。');
        if (!ok) return '（中止しました）';
      }

      ctx.status('移動中… 0 / ' + plan.sources.length);
      let done = 0;
      const moved = [];
      const failed = [];
      // 移動は Drive 側で親を付け替えるだけなので並列でよい。
      await termPool(plan.sources, 6, async (node) => {
        if (ctx.aborted()) return;
        try {
          await termMoveNode(node, plan.folderId, plan.name);
          moved.push(Vfs.pathOf(node.id));
        } catch (err) {
          failed.push(node.name + ': ' + err.message);
        }
        done++;
        ctx.status('移動中… ' + done + ' / ' + plan.sources.length);
      });
      renderTree();
      renderEditorCrumbs();
      Session.save();
      return moved.join('\n') + (failed.length ? '\n移動できなかったもの:\n  ' + failed.join('\n  ') : '');
    }
  },

  rm: {
    usage: 'rm [-r] [-f] <パス…>',
    desc: 'ゴミ箱へ移す（フォルダは -r が要る）',
    help: 'Drive のゴミ箱へ入れるだけなので、あとから元に戻せます。-f は確認を省きますが、未保存の編集があるファイルが含まれていれば中止します。',
    flags: { r: true, f: true },
    complete: 'path',
    async run(ctx, argv) {
      const { flags, rest } = termArgs(argv, this.flags);
      if (!rest.length) throw new TermError('消すものを指定してください。');
      const nodes = [];
      const seen = new Set();
      for (const p of rest) {
        const hits = await Vfs.glob(ctx.cwd, p);
        if (!hits.length) {
          if (flags.f) continue;
          throw new TermError('見つかりません: ' + p);
        }
        for (const node of hits) {
          if (seen.has(node.id)) continue;
          if (Tree.isRoot(node.id)) throw new TermError('ルートフォルダは消せません: ' + node.name + '（設定から外してください）');
          seen.add(node.id);
          nodes.push(node);
        }
      }
      if (!nodes.length) return '（消すものはありません）';

      const folders = nodes.filter((n) => n.type === 'folder');
      if (folders.length && !flags.r) {
        throw new TermError('フォルダを消すには -r が要ります: ' + folders[0].name);
      }

      // 中身が見えない（未読込の）フォルダを黙って消さない。
      const open = App.tabs.filter((t) => nodes.some((n) => n.id === t.id || isInsideFolder(t.id, n.id)));
      const dirty = open.filter((t) => t.dirty);
      // -f は確認を省くだけで、未保存の編集まで黙って捨てはしない。ファイルは
      // ゴミ箱から戻せるが、閉じたタブの未保存の編集はどこにも残らない。
      if (flags.f && dirty.length) {
        throw new TermError('未保存の編集があるため中止しました: ' + dirty.map((t) => t.name).join('、') +
          '（保存するか閉じてから実行してください。-f を外せば確認のうえで破棄できます）');
      }
      if (!flags.f) {
        const list = nodes.slice(0, 20).map((n) => '  ' + Vfs.pathOf(n.id) + (n.type === 'folder' ? '/' : '')).join('\n');
        const ok = await ctx.confirm(
          nodes.length + ' 件をゴミ箱へ移します。\n' + list +
          (nodes.length > 20 ? '\n  …ほか ' + (nodes.length - 20) + ' 件' : '') +
          (folders.length ? '\nフォルダは中身ごと移ります。' : '') +
          (dirty.length ? '\n未保存の編集があるもの: ' + dirty.map((t) => t.name).join('、') : ''));
        if (!ok) return '（中止しました）';
      }

      for (const tab of open) await closeTab(tab.id, { force: true });
      ctx.status('移動中… 0 / ' + nodes.length);
      let done = 0;
      const gone = [];
      const failed = [];
      await termPool(nodes, 6, async (node) => {
        if (ctx.aborted()) return;
        try {
          await (node.type === 'folder' ? Api.trashFolder(node.id) : Api.trashFile(node.id));
          const path = Vfs.pathOf(node.id);
          if (node.type === 'folder') Pins.removeUnder(node.id);
          else Pins.remove(node.id);
          Draft.clear(node.id);
          Tree.remove(node.id);
          gone.push(path);
        } catch (err) {
          failed.push(node.name + ': ' + err.message);
        }
        done++;
        ctx.status('移動中… ' + done + ' / ' + nodes.length);
      });
      renderTree();
      Session.save();
      return gone.length + ' 件をゴミ箱へ移しました。\n' + gone.join('\n') +
        (failed.length ? '\n移せなかったもの:\n  ' + failed.join('\n  ') : '');
    }
  },

  refresh: {
    usage: 'refresh [パス]',
    desc: 'フォルダの一覧を Drive から読み直す',
    complete: 'dir',
    async run(ctx, argv) {
      if (!argv.length && Vfs.isRoot(ctx.cwd)) { await refreshAllRoots(); return 'すべて読み直しました。'; }
      const r = await Vfs.resolve(ctx.cwd, argv[0] || '.');
      if (Vfs.isRoot(r.id)) { await refreshAllRoots(); return 'すべて読み直しました。'; }
      if (r.node && r.node.type !== 'folder') throw new TermError('フォルダを指定してください。');
      await loadFolder(r.id, true);
      return Vfs.pathOf(r.id) + ' を読み直しました。';
    }
  },

  /* ---------------------- エディタ側の機能 ---------------------- */

  open: {
    usage: 'open [-s] <パス>[:行番号]',
    desc: 'エディタで開く（-s は隣のペイン）',
    flags: { s: true },
    complete: 'path',
    async run(ctx, argv) {
      const { flags, rest } = termArgs(argv, this.flags);
      if (!rest.length) throw new TermError('開くファイルを指定してください。');
      const opened = [];
      for (const raw of rest) {
        ctx.check();
        // 末尾の :12 / :12:3 は行・列として扱う（grep の出力をそのまま貼れる）。
        const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(raw);
        const path = m ? m[1] : raw;
        const nodes = await Vfs.glob(ctx.cwd, path);
        if (!nodes.length) throw new TermError('見つかりません: ' + path);
        for (const node of nodes.slice(0, 8)) {
          if (node.type === 'folder') { ctx.setCwd(node.id); continue; }
          await Term.openNode(ctx.term, node, {
            split: !!flags.s,
            line: m ? Number(m[2]) : 0,
            column: m && m[3] ? Number(m[3]) : 1
          });
          opened.push(node.name);
        }
      }
      return opened.length ? '開きました: ' + opened.join('、') : '';
    }
  },

  diff: {
    usage: 'diff <A> <B>',
    desc: '2 つを比較ビューで開く（% は編集中のファイル）',
    complete: 'path',
    async run(ctx, argv) {
      if (argv.length !== 2) throw new TermError('比べる 2 つを指定してください（% も使えます）。');
      const side = async (p) => {
        if (p === '%' || p === '%sel') {
          const buf = termBufferRead(false);
          return diffSideFromTab(buf.tab);
        }
        const r = await Vfs.resolve(ctx.cwd, p);
        if (!r.node || r.node.type !== 'file') throw new TermError('ファイルを指定してください: ' + p);
        const tab = getTab(r.node.id);
        if (tab && tab.kind === 'text' && tab.loaded && tab.dirty) return diffSideFromTab(tab);
        return diffSideFromFile(r.node.id, r.node.name);
      };
      const a = await side(argv[0]);
      const b = await side(argv[1]);
      const pane = Term.editorPane(ctx.term);
      if (pane) Panes.focus(pane.id);
      await Diff.open(a, b);
      return '';
    }
  },

  rev: {
    usage: 'rev <パス> [番号]',
    desc: '過去の版を一覧する／番号を付けるといまの内容と比較する',
    complete: 'file',
    async run(ctx, argv) {
      if (!argv.length) throw new TermError('ファイルを指定してください。');
      const r = await Vfs.resolve(ctx.cwd, argv[0]);
      if (!r.node || r.node.type !== 'file') throw new TermError('ファイルを指定してください。');
      const list = await Api.listRevisions(r.node.id);
      const revs = (list && list.revisions) || list || [];
      if (!revs.length) return '（過去の版はありません）';

      if (argv.length < 2) {
        const rows = revs.map((rev, i) => {
          const when = new Date(rev.modifiedTime).toLocaleString('ja-JP');
          return '  ' + String(i + 1).padStart(3) + '  ' + when +
            (rev.lastModifyingUser ? '  ' + rev.lastModifyingUser : '') +
            (rev.size ? '  ' + formatBytes(rev.size) : '');
        });
        return r.node.name + ' の過去の版（新しい順・1 がいちばん新しい）:\n' + rows.join('\n') +
          '\n\nrev ' + termQuote(argv[0]) + ' <番号> でいまの内容と比べられます。';
      }

      const index = Number(argv[1]);
      if (!(index >= 1 && index <= revs.length)) throw new TermError('番号は 1〜' + revs.length + ' です。');
      const rev = revs[index - 1];
      const older = await diffSideFromRevision(r.node.id, r.node.name, rev);
      const current = await diffSideFromFile(r.node.id, r.node.name);
      const pane = Term.editorPane(ctx.term);
      if (pane) Panes.focus(pane.id);
      await Diff.open(older, current);
      return '';
    }
  },

  split: {
    usage: 'split [right|down]',
    desc: 'エディタのペインを分割する',
    complete: ['right', 'down'],
    run(ctx, argv) {
      const dir = (argv[0] === 'down' || argv[0] === 'bottom') ? 'col' : 'row';
      const pane = Term.editorPane(ctx.term);
      if (pane) Panes.focus(pane.id);
      splitActivePane(dir);
      return '';
    }
  },

  theme: {
    usage: 'theme [dark|light|system]',
    desc: '配色を切り替える',
    complete: THEME_MODES.slice(),
    run(ctx, argv) {
      if (!argv.length) return 'いま: ' + (THEME_LABELS[Theme.mode] || Theme.mode);
      if (THEME_MODES.indexOf(argv[0]) < 0) throw new TermError('dark / light / system のどれかです。');
      Theme.select(argv[0]);
      return THEME_LABELS[argv[0]] + 'にしました。';
    }
  },

  save: {
    usage: 'save',
    desc: '未保存のタブをすべて保存する',
    async run() {
      const dirty = App.tabs.filter((t) => t.dirty);
      if (!dirty.length) return '（未保存のものはありません）';
      await saveAllDirty();
      return dirty.map((t) => t.name).join('、') + ' を保存しました。';
    }
  },

  pin: {
    usage: 'pin <パス…>',
    desc: 'ピン留めを切り替える',
    complete: 'file',
    async run(ctx, argv) {
      if (!argv.length) {
        if (!Pins.items.length) return '（ピン留めはありません）';
        return Pins.items.map((p) => '  ' + (Tree.get(p.id) ? Vfs.pathOf(p.id) : p.name)).join('\n');
      }
      const out = [];
      for (const p of argv) {
        for (const node of await Vfs.glob(ctx.cwd, p, { type: 'file' })) {
          const had = Pins.has(node.id);
          Pins.toggleNode(node);
          out.push((had ? '外しました: ' : 'ピン留めしました: ') + node.name);
        }
      }
      return out.length ? out.join('\n') : '（対象がありません）';
    }
  },

  history: {
    usage: 'history [件数]',
    desc: '入力の履歴を出す',
    run(ctx, argv) {
      const n = Math.max(1, Math.min(200, Number(argv[0] || 30)));
      const list = Term.history.slice(-n);
      if (!list.length) return '（履歴はありません）';
      const base = Term.history.length - list.length + 1;
      return list.map((line, i) => String(base + i).padStart(4) + '  ' + line).join('\n');
    }
  },

  clear: {
    usage: 'clear',
    desc: '画面を消す（Ctrl+L）',
    run(ctx) { Term.clear(ctx.term); return ''; }
  }
});

