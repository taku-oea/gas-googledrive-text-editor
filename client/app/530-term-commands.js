/* ---------------------- コマンド ---------------------- */

/**
 * コマンドの定義。
 *   usage    … 1 行の使い方（help と補完の説明に出る）
 *   desc     … 何をするか
 *   flags    … termArgs に渡す表
 *   complete … 引数の補完。'path' | 'dir' | 'file' | 配列 | 関数
 *   run(ctx, argv, stdin) … 本体。戻り値は文字列か {text, rows}
 *
 * ctx は Term が作る。ctx.check() は Ctrl+C の確認で、長い処理の途中に挟む。
 */
const TERM_COMMANDS = {

  help: {
    usage: 'help [コマンド名]',
    desc: 'コマンドの一覧と使い方を出す',
    complete: () => Object.keys(TERM_COMMANDS),
    run(ctx, argv) {
      const name = argv[0];
      if (name) {
        const alias = TERM_ALIASES[name];
        const cmd = TERM_COMMANDS[alias ? alias[0] : name];
        if (!cmd) throw new TermError('そんなコマンドはありません: ' + name);
        return cmd.usage + '\n  ' + cmd.desc + (cmd.help ? '\n\n' + cmd.help : '') +
          (alias ? '\n\n（' + name + ' は ' + alias.join(' ') + ' の別名です）' : '');
      }
      const names = Object.keys(TERM_COMMANDS);
      const width = names.reduce((m, n) => Math.max(m, n.length), 0);
      const body = names.map((n) => '  ' + n + ' '.repeat(width - n.length) + '  ' + TERM_COMMANDS[n].desc);
      return [
        'Drive のファイルを扱うコマンドです（本物のシェルではありません）。',
        '',
        body.join('\n'),
        '',
        'パス   : / は仮想ルート（ルートフォルダが並ぶ）、~ は一時メモ、',
        '         * ? [] は 1 階層、** は階層をまたいで当たります。',
        '         名前に / を含むファイルは id:<Drive の ID> で指せます。',
        '% ：編集中のファイル、%sel ：その選択範囲。読むのにも書くのにも使えます。',
        '     例) cat %sel | sort > %sel   … 選択範囲を並べ替えて置き換える',
        '         !sort                    … 同じことの短い書き方',
        '',
        'パイプ（|）とリダイレクト（> >>）が使えます。Tab で補完、↑↓ で履歴、',
        'Ctrl+C で中断、Ctrl+L で画面を消します。'
      ].join('\n');
    }
  },

  pwd: {
    usage: 'pwd',
    desc: 'いまいるフォルダのパスを出す',
    run(ctx) { return Vfs.pathOf(ctx.cwd); }
  },

  cd: {
    usage: 'cd [パス]',
    desc: 'フォルダを移動する（- で直前の場所へ）',
    complete: 'dir',
    async run(ctx, argv) {
      const path = argv[0];
      if (!path) { ctx.setCwd(null); return ''; }
      if (path === '-') {
        if (ctx.term.prevCwd === undefined) throw new TermError('直前の場所がありません。');
        ctx.setCwd(ctx.term.prevCwd);
        return Vfs.pathOf(ctx.cwd);
      }
      const r = await Vfs.resolve(ctx.cwd, path);
      if (r.node && r.node.type !== 'folder') throw new TermError('フォルダではありません: ' + r.name);
      ctx.setCwd(r.id);
      // 次の Tab 補完を 0ms で返せるように、中身を読んでおく。
      void Vfs.ensure(r.id);
      return '';
    }
  },

  ls: {
    usage: 'ls [-l] [パス…]',
    desc: 'フォルダの中身を並べる（クリックで開く）',
    flags: { l: true },
    complete: 'path',
    async run(ctx, argv) {
      const { flags, rest } = termArgs(argv, this.flags);
      const targets = rest.length ? rest : ['.'];
      const rows = [];
      const names = [];
      let multi = false;

      const groups = [];
      for (const p of targets) {
        if (/[*?[]/.test(p)) {
          const hits = await Vfs.glob(ctx.cwd, p);
          if (!hits.length) throw new TermError('見つかりません: ' + p);
          groups.push({ label: p, nodes: hits, listing: false });
          continue;
        }
        const r = await Vfs.resolve(ctx.cwd, p);
        if (r.node && r.node.type === 'file') {
          groups.push({ label: p, nodes: [r.node], listing: false });
          continue;
        }
        await Vfs.ensure(r.id);
        const ch = Vfs.children(r.id);
        groups.push({ label: Vfs.pathOf(r.id), nodes: ch.folders.concat(ch.files), listing: true, id: r.id });
      }
      multi = groups.length > 1;

      for (const g of groups) {
        if (multi) {
          rows.push(h('div', { class: 'term__group', text: g.label + ':' }));
          names.push(g.label + ':');
        }
        if (!g.nodes.length) {
          rows.push(h('div', { class: 'term__dim', text: '（空）' }));
          names.push('');
          continue;
        }
        for (const node of g.nodes) {
          names.push(node.name + (node.type === 'folder' ? '/' : ''));
          rows.push(termEntryRow(ctx, node, !!flags.l));
        }
        const parent = g.listing && g.id ? Tree.get(g.id) : null;
        if (parent && parent.truncated) {
          rows.push(h('div', { class: 'term__dim', text: '（件数が多いため一部まで）' }));
        }
      }
      return { text: names.join('\n'), rows };
    }
  },

  tree: {
    usage: 'tree [-L 段数] [パス]',
    desc: 'フォルダを木の形で出す（既定は 2 段）',
    flags: { L: 'value' },
    complete: 'dir',
    async run(ctx, argv) {
      const { flags, rest } = termArgs(argv, this.flags);
      const depth = Math.max(1, Math.min(6, Number(flags.L || 2)));
      const r = await Vfs.resolve(ctx.cwd, rest[0] || '.');
      if (r.node && r.node.type !== 'folder') throw new TermError('フォルダではありません: ' + r.name);

      const out = [Vfs.pathOf(r.id)];
      let files = 0;
      let folders = 0;
      const walk = async (id, prefix, level) => {
        ctx.check();
        await Vfs.ensure(id);
        const ch = Vfs.children(id);
        const all = ch.folders.concat(ch.files);
        for (let i = 0; i < all.length; i++) {
          const node = all[i];
          const last = i === all.length - 1;
          out.push(prefix + (last ? '└─ ' : '├─ ') + node.name + (node.type === 'folder' ? '/' : ''));
          if (node.type === 'folder') {
            folders++;
            if (level < depth) await walk(node.id, prefix + (last ? '   ' : '│  '), level + 1);
          } else files++;
          if (out.length > 800) { out.push('…（多いのでここまで）'); return; }
        }
      };
      await walk(r.id, '', 1);
      out.push('');
      out.push('フォルダ ' + folders + ' 個 / ファイル ' + files + ' 個');
      return out.join('\n');
    }
  },

  find: {
    usage: 'find [パス] [-name パターン] [-type f|d] [-L 段数]',
    desc: 'フォルダの中を再帰的に探す（名前で）',
    flags: { name: 'value', type: 'value', L: 'value' },
    complete: 'dir',
    async run(ctx, argv) {
      const { flags, rest } = termArgs(argv, this.flags);
      const r = await Vfs.resolve(ctx.cwd, rest[0] || '.');
      const re = flags.name ? globToRegExp(flags.name) : null;
      const type = flags.type === 'd' ? 'folder' : flags.type === 'f' ? 'file' : null;

      Vfs.truncated = false;
      const folderIds = await Vfs.descend([r.id]);
      const hits = [];
      for (const id of folderIds) {
        ctx.check();
        const node = id ? Tree.get(id) : null;
        if (node && id !== r.id && (!re || re.test(node.name)) && type !== 'file') hits.push(node);
        for (const file of Vfs.children(id).files) {
          if (re && !re.test(file.name)) continue;
          if (type === 'folder') continue;
          hits.push(file);
        }
      }
      if (!hits.length) return '（一致するものはありません）';
      const rows = hits.slice(0, 500).map((node) => termEntryRow(ctx, node, false, true));
      if (Vfs.truncated) rows.push(h('div', { class: 'term__dim', text: '（範囲が広いため一部まで）' }));
      if (hits.length > 500) rows.push(h('div', { class: 'term__dim', text: '…ほか ' + (hits.length - 500) + ' 件' }));
      return { text: hits.map((n) => Vfs.pathOf(n.id)).join('\n'), rows };
    }
  },

  cat: {
    usage: 'cat <パス…>',
    desc: 'ファイルの中身を出す',
    complete: 'file',
    async run(ctx, argv, stdin) {
      if (!argv.length) {
        if (stdin === null) throw new TermError('ファイルを指定してください。');
        return stdin;
      }
      const sources = await termSources(ctx, argv);
      if (sources.length === 1) return sources[0].text;
      return sources.map((s) => '===== ' + s.label + ' =====\n' + s.text).join('\n');
    }
  },

  head: {
    usage: 'head [-n 行数] [パス…]',
    desc: '先頭の行だけ出す（既定は 10 行）',
    flags: { n: 'value' },
    complete: 'file',
    async run(ctx, argv, stdin) {
      const { flags, rest } = termArgs(argv, this.flags);
      const n = Math.max(1, Number(flags.n || 10));
      const text = rest.length ? (await termSources(ctx, rest)).map((s) => s.text).join('\n') : (stdin || '');
      return termLines(text).slice(0, n).join('\n');
    }
  },

  tail: {
    usage: 'tail [-n 行数] [パス…]',
    desc: '末尾の行だけ出す（既定は 10 行）',
    flags: { n: 'value' },
    complete: 'file',
    async run(ctx, argv, stdin) {
      const { flags, rest } = termArgs(argv, this.flags);
      const n = Math.max(1, Number(flags.n || 10));
      const text = rest.length ? (await termSources(ctx, rest)).map((s) => s.text).join('\n') : (stdin || '');
      const lines = termLines(text);
      return lines.slice(Math.max(0, lines.length - n)).join('\n');
    }
  },

  wc: {
    usage: 'wc [-l|-w|-c] [パス…]',
    desc: '行数・語数・文字数を数える',
    flags: { l: true, w: true, c: true },
    complete: 'file',
    async run(ctx, argv, stdin) {
      const { flags, rest } = termArgs(argv, this.flags);
      const items = rest.length
        ? await termSources(ctx, rest)
        : [{ label: '', text: stdin || '' }];
      const fmt = (t, label) => {
        const lines = termLines(t).length;
        const words = t.split(/\s+/).filter(Boolean).length;
        const chars = t.length;
        const only = flags.l || flags.w || flags.c;
        const parts = [];
        if (!only || flags.l) parts.push(String(lines));
        if (!only || flags.w) parts.push(String(words));
        if (!only || flags.c) parts.push(String(chars));
        return parts.join('\t') + (label ? '\t' + label : '');
      };
      return items.map((s) => fmt(s.text, s.label)).join('\n');
    }
  },

  echo: {
    usage: 'echo <文字列…>',
    desc: 'そのまま出す（> と組み合わせてファイルを作れる）',
    run(ctx, argv) { return argv.join(' '); }
  },

  sort: {
    usage: 'sort [-r] [-u] [-n] [パス…]',
    desc: '行を並べ替える',
    flags: { r: true, u: true, n: true },
    complete: 'file',
    async run(ctx, argv, stdin) {
      const { flags, rest } = termArgs(argv, this.flags);
      const text = rest.length ? (await termSources(ctx, rest)).map((s) => s.text).join('\n') : (stdin || '');
      let lines = termLines(text);
      lines = lines.slice().sort((a, b) => (flags.n
        ? (parseFloat(a) || 0) - (parseFloat(b) || 0)
        : a.localeCompare(b, 'ja')));
      if (flags.r) lines.reverse();
      if (flags.u) {
        const seen = new Set();
        lines = lines.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
      }
      return lines.join('\n');
    }
  },

  uniq: {
    usage: 'uniq [-c] [パス…]',
    desc: '続けて並ぶ同じ行をまとめる',
    flags: { c: true },
    complete: 'file',
    async run(ctx, argv, stdin) {
      const { flags, rest } = termArgs(argv, this.flags);
      const text = rest.length ? (await termSources(ctx, rest)).map((s) => s.text).join('\n') : (stdin || '');
      const out = [];
      let prev = null;
      let count = 0;
      for (const line of termLines(text)) {
        if (line === prev) { count++; continue; }
        if (prev !== null) out.push(flags.c ? String(count).padStart(4) + ' ' + prev : prev);
        prev = line;
        count = 1;
      }
      if (prev !== null) out.push(flags.c ? String(count).padStart(4) + ' ' + prev : prev);
      return out.join('\n');
    }
  },

  grep: {
    usage: 'grep [-i] [-F] [-r] [-l] [-c] <パターン> [パス…]',
    desc: '中身を検索する（正規表現・行をクリックでその場所へ）',
    help: 'パターンは正規表現です。文字どおり探すときは -F を付けます。\n' +
      'パスを省くといまのフォルダのファイル、-r なら配下すべてが対象です。',
    flags: { i: true, F: true, r: true, l: true, c: true, n: true },
    complete: 'path',
    async run(ctx, argv, stdin) {
      const { flags, rest } = termArgs(argv, this.flags);
      const pattern = rest.shift();
      if (pattern === undefined) throw new TermError('探す文字列を指定してください。');
      const re = termPattern(pattern, { i: flags.i, fixed: flags.F });

      // パイプの途中なら、渡ってきた文字列だけを見る。
      if (!rest.length && stdin !== null) {
        return termLines(stdin).filter((line) => re.test(line)).join('\n');
      }

      const targets = rest.length ? rest : [flags.r ? '**/*' : '*'];
      const nodes = [];
      const seen = new Set();
      for (const p of targets) {
        for (const node of await Vfs.glob(ctx.cwd, p, { type: 'file' })) {
          if (seen.has(node.id) || !termIsTextNode(node)) continue;
          seen.add(node.id);
          nodes.push(node);
        }
      }
      if (!nodes.length) throw new TermError('対象のファイルがありません。');

      ctx.status('検索中… ' + nodes.length + ' ファイル');
      await termPrefetch(nodes);

      const rows = [];
      const text = [];
      let total = 0;
      let files = 0;
      let unreadable = 0;
      for (const node of nodes) {
        ctx.check();
        let rec;
        try {
          rec = await termReadRecord(node);
        } catch (err) {
          unreadable++;   // バイナリ・権限など。件数だけ最後に添える
          continue;
        }
        const path = Vfs.pathOf(node.id);
        const lines = normalizeEol(rec.content).split('\n');
        let hits = 0;
        for (let i = 0; i < lines.length; i++) {
          re.lastIndex = 0;
          if (!re.test(lines[i])) continue;
          hits++;
          total++;
          if (flags.l || flags.c) continue;
          if (total > 3000) break;
          text.push(path + ':' + (i + 1) + ':' + lines[i]);
          rows.push(termHitRow(ctx, node, i + 1, lines[i]));
        }
        if (!hits) continue;
        files++;
        if (flags.l) { text.push(path); rows.push(termEntryRow(ctx, node, false, true)); }
        else if (flags.c) { text.push(path + ':' + hits); rows.push(h('div', { class: 'term__line', text: path + ':' + hits })); }
        if (total > 3000) break;
      }
      const skipped = unreadable ? '（読めなかった ' + unreadable + ' ファイルは探していません）' : '';
      if (!total) return '（一致する行はありません）' + skipped;
      rows.push(h('div', {
        class: 'term__dim',
        text: total + ' 件 / ' + files + ' ファイル' + (total > 3000 ? '（3000 件で打ち切り）' : '') + skipped
      }));
      return { text: text.join('\n'), rows };
    }
  },

  sed: {
    usage: "sed [-i] 's/探す/置き換える/g' [パス…]",
    desc: '置換する（-i でファイルを書き換える・複数ファイル可）',
    help: '探すほうは正規表現。置き換えるほうは sed と同じく & で一致した全体、\\1〜\\9 で ( ) の中身、\n' +
      '\\& \\\\ \\n で文字どおりの & ・ \\ ・改行（$ は特別扱いしません）。\n' +
      '区切りは / のほかに | # も使えます（s|a|b|g）。\n' +
      '-i を付けると Drive 上のファイルを書き換えます。実行前に件数を出して確認します。',
    flags: { i: true },
    complete: 'path',
    async run(ctx, argv, stdin) {
      const { flags, rest } = termArgs(argv, this.flags);
      const script = rest.shift();
      if (!script) throw new TermError('s/探す/置き換える/ の形で指定してください。');

      const parsed = sedSplitScript(script);
      if (!parsed) {
        const d = /^s(.)/.exec(script);
        throw new TermError(d ? 's' + d[1] + '探す' + d[1] + '置き換える' + d[1] + ' の形で指定してください。' : 's/探す/置き換える/ の形で指定してください。');
      }
      const sedFlags = parsed.flags;
      const re = termPattern(parsed.pattern, { i: sedFlags.indexOf('i') >= 0, g: sedFlags.indexOf('g') >= 0 });
      // 置き換える側は sed の書き方（& ・ \1 ・ \n）。関数で渡すので JS の $ 記法は効かない。
      const replacement = sedReplacer(parsed.replacement, sedGroupCount(re));

      if (!rest.length) {
        if (stdin === null) throw new TermError('対象のファイルを指定してください。');
        return stdin.replace(re, replacement);
      }

      const nodes = [];
      const seen = new Set();
      for (const p of rest) {
        if (p === '%' || p === '%sel') {
          const buf2 = termBufferRead(p === '%sel');
          const next = buf2.text.replace(re, replacement);
          if (!flags.i) return next;
          if (next === buf2.text) return '（変わりませんでした）';
          termBufferWrite(p === '%sel', next, false);
          return '「' + buf2.tab.name + '」を置換しました。';
        }
        for (const node of await Vfs.glob(ctx.cwd, p, { type: 'file' })) {
          if (seen.has(node.id) || !termIsTextNode(node)) continue;
          seen.add(node.id);
          nodes.push(node);
        }
      }
      if (!nodes.length) throw new TermError('対象のファイルがありません。');

      ctx.status('読み込み中… ' + nodes.length + ' ファイル');
      await termPrefetch(nodes);

      // 先に全部通してみて、何がどれだけ変わるかを出す（これが確認の材料になる）。
      const plan = [];
      const unreadable = [];
      let hits = 0;
      for (const node of nodes) {
        ctx.check();
        let rec;
        try {
          rec = await termReadRecord(node);
        } catch (err) {
          // 黙って飛ばすと「全部置換できた」ように見えるので、確認と結果に並べる。
          unreadable.push(Vfs.pathOf(node.id) + ': ' + err.message);
          continue;
        }
        const before = normalizeEol(rec.content);
        re.lastIndex = 0;
        const count = (before.match(new RegExp(re.source, re.flags.indexOf('g') >= 0 ? re.flags : re.flags + 'g')) || []).length;
        if (!count) continue;
        const after = before.replace(re, replacement);
        if (after === before) continue;
        plan.push({ node, before, after, count });
        hits += count;
      }
      const skippedNote = unreadable.length
        ? '\n読めなかったため対象外（' + unreadable.length + ' ファイル）:\n  ' + unreadable.slice(0, 20).join('\n  ') +
          (unreadable.length > 20 ? '\n  …ほか ' + (unreadable.length - 20) + ' ファイル' : '')
        : '';
      if (!plan.length) return '（一致する箇所はありません）' + skippedNote;

      if (!flags.i) {
        return plan.map((p) => '===== ' + Vfs.pathOf(p.node.id) + ' =====\n' + p.after).join('\n');
      }

      const list = plan.slice(0, 20).map((p) => '  ' + Vfs.pathOf(p.node.id) + '  (' + p.count + ' 箇所)').join('\n');
      const ok = await ctx.confirm(
        plan.length + ' ファイル・' + hits + ' 箇所を書き換えます。\n' + list +
        (plan.length > 20 ? '\n  …ほか ' + (plan.length - 20) + ' ファイル' : '') + skippedNote);
      if (!ok) return '（中止しました）';

      ctx.status('書き込み中… 0 / ' + plan.length);
      let done = 0;
      const failed = [];
      await termPool(plan, 6, async (p) => {
        if (ctx.aborted()) return;
        try {
          await termWriteFile(p.node, p.after);
        } catch (err) {
          failed.push(Vfs.pathOf(p.node.id) + ': ' + err.message);
        }
        done++;
        ctx.status('書き込み中… ' + done + ' / ' + plan.length);
      });
      renderTree();
      const okCount = plan.length - failed.length;
      return okCount + ' ファイルを書き換えました（' + hits + ' 箇所）。' +
        (failed.length ? '\n書けなかったもの:\n  ' + failed.join('\n  ') : '') + skippedNote;
    }
  }
};

