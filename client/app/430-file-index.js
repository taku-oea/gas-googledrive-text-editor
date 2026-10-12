/* ------------------------------------------------------------------ *
 *  ファイル名の索引（クイックオープン用）
 *
 *  ツリーは開いたフォルダの中身しか持たないので、Mod+P は展開した階層の
 *  ファイルしか出せなかった。ルート配下を裏で 1 段ずつ辿ってファイル名だけを
 *  集め、localStorage に残しておく。往復は listEntriesMulti（30 フォルダずつ）で、
 *  回数はフォルダ数ではなく「フォルダ数 / 30 × 深さ」程度に収まる。
 *
 *  ツリーに載っているものはツリーの情報（改名・移動が即時に反映される）を優先し、
 *  索引はツリーに無いものを補うだけに使う。消えたファイルは Tree.remove が
 *  索引からも落とし、それ以外の食い違いは次の作り直し（TTL）で直る。
 * ------------------------------------------------------------------ */

// FileIndex の芯（KEY / TTL_MS / MAX_DEPTH / MAX_FOLDERS / MAX_FILES / CONCURRENCY / data / building / onUpdate / rootsKey / usable / stale / save / load / drop / pathOf / entryOf / extraFiles など）は client/lib/file-index.js。ここでは残りを足す。
Object.assign(FileIndex, {
  /** 起動が落ち着いてから、古ければ裏で作る。遅い回線では Mod+P を押すまで待つ。 */
  warmUp() {
    if (Prefetch.slowNet() || !Tree.rootIds.length) return;
    const run = () => { if (FileIndex.stale()) void FileIndex.ensure(); };
    setTimeout(() => {
      if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 5000 });
      else run();
    }, 4000);
  },

  /** 古ければ作り直す。作り直し中なら同じ Promise を返す。 */
  ensure() {
    if (!FileIndex.stale()) return Promise.resolve(FileIndex.data);
    if (!FileIndex.building) {
      const end = Perf.start('fileIndex.build');
      FileIndex.building = FileIndex.build()
        .then((data) => {
          end({ folders: data.folders.size, files: data.files.size, partial: data.partial });
          // 作っている間にルートが変わっていたら捨てる（次の ensure で作り直す）。
          if (data.key !== FileIndex.rootsKey()) return FileIndex.data;
          FileIndex.data = data;
          FileIndex.save();
          if (FileIndex.onUpdate) FileIndex.onUpdate();
          return data;
        })
        .catch((err) => {
          end({ error: true });
          console.warn('ファイル名の索引を作れませんでした: ' + (err && err.message ? err.message : err));
          return FileIndex.data;
        })
        .finally(() => { FileIndex.building = null; });
    }
    return FileIndex.building;
  },

  /** ルートから 1 段ずつ広げて、フォルダとファイルを集める。 */
  async build() {
    const key = FileIndex.rootsKey();
    const folders = new Map();
    const files = new Map();
    for (const id of Tree.rootIds) {
      const node = Tree.get(id);
      folders.set(id, { name: node ? node.name : '', parentId: null });
    }
    let frontier = Tree.rootIds.slice();
    let partial = false;

    for (let depth = 0; frontier.length && depth < FileIndex.MAX_DEPTH; depth++) {
      const chunks = [];
      for (let i = 0; i < frontier.length; i += 30) chunks.push(frontier.slice(i, i + 30));
      const next = [];
      const queue = chunks.slice();
      const worker = async () => {
        while (queue.length) {
          const chunk = queue.shift();
          let got;
          try {
            got = await Api.listEntriesMulti(chunk);
          } catch (err) {
            continue;   // 読めない枝は飛ばして続ける
          }
          for (const [parentId, listing] of Object.entries(got || {})) {
            if (listing.truncated) partial = true;
            for (const f of listing.folders || []) {
              if (folders.has(f.id) || Tree.isTmpRoot(f.id)) continue;
              if (folders.size >= FileIndex.MAX_FOLDERS) { partial = true; break; }
              folders.set(f.id, { name: f.name, parentId });
              next.push(f.id);
            }
            for (const e of listing.files || []) {
              if (!e.openable) continue;
              if (files.size >= FileIndex.MAX_FILES) { partial = true; break; }
              files.set(e.id, {
                name: e.name, parentId,
                kind: e.viewer === 'embed' ? e.kind : 'text',
                size: e.size || 0, updatedAtIso: e.updatedAtIso || ''
              });
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(FileIndex.CONCURRENCY, chunks.length) }, worker));
      frontier = next;
    }
    if (frontier.length) partial = true;
    return { key, at: Date.now(), partial, folders, files };
  }
});

const Palette = {
  /** @type {'file'|'command'|null} */
  mode: null,
  items: [],
  filtered: [],
  index: 0,
  fuzzy: null,

  /** fuzzysort を遅延読み込みする。失敗しても部分一致で動かす。 */
  async loadFuzzy() {
    if (Palette.fuzzy !== null) return;
    try {
      const mod = await (await Vendor.load()).loadFuzzysort();
      Palette.fuzzy = mod.default || mod;
    } catch (e) {
      console.warn('fuzzysort を読み込めませんでした。部分一致で検索します。', e);
      Palette.fuzzy = false;
    }
  },

  /**
   * @param {'file'|'command'} mode
   */
  open(mode) {
    Ctx.hide();
    Palette.mode = mode;
    Palette.index = 0;

    if (mode === 'file') {
      Palette.fileItems();
      el.paletteInput.placeholder = 'ファイル名を入力（サブフォルダの中も対象）';
      // 索引が無い・古いときは裏で作り、できたら候補を差し替える。
      if (FileIndex.stale()) {
        FileIndex.onUpdate = () => {
          if (Palette.mode !== 'file') return;
          Palette.fileItems();
          Palette.render();
        };
        void FileIndex.ensure();
        Palette.fileFoot();
      }
    } else {
      Palette.items = commandRegistry().map((c) => ({
        id: c.id, label: c.label, hint: c.hint || '', icon: c.icon || 'chevron', key: c.key, run: c.run
      }));
      el.paletteInput.placeholder = 'コマンド名を入力';
      el.paletteFoot.textContent = Palette.items.length + ' 件のコマンド';
    }

    el.paletteInput.value = '';
    el.paletteOverlay.hidden = false;
    Palette.render();
    el.paletteInput.focus();
    void Palette.loadFuzzy().then(() => { if (Palette.mode) Palette.render(); });
  },

  /** ツリーのファイルと、ツリーに無い索引のファイルを合わせて候補にする。 */
  fileItems() {
    const items = Tree.allFiles().map((node) => ({
      id: node.id,
      label: node.name,
      hint: Tree.pathOf(node.id),
      icon: node.entry && VIEWERS[node.entry.kind]
        ? VIEWERS[node.entry.kind].icon : 'file-text',
      node
    }));
    const extra = FileIndex.extraFiles();
    extra.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    for (const f of extra) {
      items.push({
        id: f.id,
        label: f.name,
        hint: FileIndex.pathOf(f.parentId, f.name),
        icon: VIEWERS[f.kind] ? VIEWERS[f.kind].icon : 'file-text',
        indexed: true
      });
    }
    Palette.items = items;
    Palette.fileFoot();
  },

  fileFoot() {
    const n = Palette.items.length + ' 件';
    const tail = '（中身の検索は ' + MOD + '+Shift+F）';
    if (FileIndex.building) {
      el.paletteFoot.textContent = n + ' · サブフォルダの中を読み込んでいます…';
    } else if (FileIndex.usable()) {
      el.paletteFoot.textContent = n + ' · サブフォルダも含む' +
        (FileIndex.data.partial ? '（範囲が広いため一部まで）' : '') +
        ' · 更新 ' + formatRelative(new Date(FileIndex.data.at).toISOString()) + tail;
    } else {
      el.paletteFoot.textContent = n + ' · 未展開のフォルダの中は対象外です' + tail;
    }
  },

  close() {
    Palette.mode = null;
    FileIndex.onUpdate = null;
    el.paletteOverlay.hidden = true;
    if (Editor.view && activeTab()) Editor.view.focus();
  },

  /** 入力に合わせて候補を絞る。 */
  render() {
    const query = el.paletteInput.value.trim();
    let list;

    if (!query) {
      // 索引込みだと数千件になる。全部を DOM にすると開くのが遅れるので先頭だけ出す。
      list = Palette.items.slice(0, 300).map((item) => ({ item, hit: null }));
    } else if (Palette.fuzzy) {
      list = Palette.fuzzy
        .go(query, Palette.items, { key: 'label', limit: 60, threshold: -10000 })
        .map((r) => ({ item: r.obj, hit: r }));
    } else {
      const needle = query.toLowerCase();
      list = Palette.items
        .filter((item) => item.label.toLowerCase().includes(needle))
        .slice(0, 60)
        .map((item) => ({ item, hit: null }));
    }

    Palette.filtered = list;
    if (Palette.index >= list.length) Palette.index = Math.max(0, list.length - 1);

    el.paletteList.textContent = '';
    if (!list.length) {
      el.paletteList.appendChild(h('div', { class: 'palette__empty', text: '一致するものがありません' }));
      return;
    }

    list.forEach(({ item, hit }, i) => {
      el.paletteList.appendChild(h('button', {
        type: 'button',
        class: 'pitem' + (i === Palette.index ? ' pitem--on' : ''),
        'data-index': String(i),
        onmousemove: () => { if (Palette.index !== i) { Palette.index = i; Palette.paint(); } },
        onclick: () => { Palette.run(i); }
      }, [
        h('span', { class: 'pitem__icon' }, item.icon ? [icon(item.icon)] : []),
        Palette.highlight(item.label, hit),
        h('span', { class: 'pitem__hint', text: item.hint || '' }),
        item.key ? h('span', { class: 'pitem__key', text: item.key }) : null
      ]));
    });
    Palette.scrollIntoView();
  },

  /** あいまい検索で一致した文字を強調する。 */
  highlight(label, hit) {
    const wrap = h('span', { class: 'pitem__label' });
    const indexes = hit && typeof hit.indexes !== 'undefined'
      ? Array.from(hit.indexes)
      : null;
    if (!indexes || !indexes.length) {
      wrap.textContent = label;
      return wrap;
    }
    const set = new Set(indexes);
    let buffer = '';
    let bufferHit = false;
    const flush = () => {
      if (!buffer) return;
      wrap.appendChild(bufferHit
        ? h('span', { class: 'pitem__hit', text: buffer })
        : document.createTextNode(buffer));
      buffer = '';
    };
    for (let i = 0; i < label.length; i++) {
      const isHit = set.has(i);
      if (isHit !== bufferHit) { flush(); bufferHit = isHit; }
      buffer += label[i];
    }
    flush();
    return wrap;
  },

  /** 選択位置だけを塗り替える（再構築しない）。 */
  paint() {
    for (const node of el.paletteList.querySelectorAll('.pitem')) {
      node.classList.toggle('pitem--on', Number(node.dataset.index) === Palette.index);
    }
    Palette.scrollIntoView();
  },

  scrollIntoView() {
    const node = el.paletteList.querySelector('.pitem--on');
    if (node) node.scrollIntoView({ block: 'nearest' });
  },

  move(delta) {
    if (!Palette.filtered.length) return;
    const n = Palette.filtered.length;
    Palette.index = (Palette.index + delta + n) % n;
    Palette.paint();
  },

  /** @param {number} i */
  run(i) {
    const hit = Palette.filtered[i];
    if (!hit) return;
    const mode = Palette.mode;
    Palette.close();

    if (mode === 'file') {
      const entry = hit.item.node ? hit.item.node.entry : FileIndex.entryOf(hit.item.id);
      if (entry) void openEntry(entry, { ephemeral: false });
    } else if (hit.item.run) {
      hit.item.run();
    }
  }
};

