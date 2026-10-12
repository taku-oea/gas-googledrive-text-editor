/**
 * client/lib/file-index.js — クイックオープン用のファイル名の索引（保存・読み込み・パス）。
 *
 * client/app の FileIndex のうち、依存の無い芯を切り出した ES モジュール。
 * 残り（通信・画面に触るもの）は client/app 側で Object.assign(FileIndex, { … }) して足している。
 */
import { Tree } from './tree-model.js';

export const FileIndex = {
  KEY: 'gdte:fileindex',

  /** これより古ければ、次に使う機会に裏で作り直す。 */
  TTL_MS: 10 * 60 * 1000,

  MAX_DEPTH: 8,

  MAX_FOLDERS: 1000,

  MAX_FILES: 10000,

  /** listEntriesMulti を同時に何本まで投げるか。 */
  CONCURRENCY: 4,

  /**
   * @type {{key:string, at:number, partial:boolean,
   *   folders:Map<string,{name:string,parentId:(string|null)}>,
   *   files:Map<string,{name:string,parentId:string,kind:string,size:number,updatedAtIso:string}>}|null}
   */
  data: null,

  /** @type {Promise|null} */
  building: null,

  /** 作り直しが済んだら呼ぶ（開いているパレットの描き直し）。 */
  onUpdate: null,

  rootsKey() { return Tree.rootIds.join(','); },

  /** 今のルート構成で使える索引があるか（古くてもよい）。 */
  usable() {
    if (!FileIndex.data) FileIndex.load();
    return !!(FileIndex.data && FileIndex.data.key === FileIndex.rootsKey());
  },

  stale() {
    return !FileIndex.usable() || Date.now() - FileIndex.data.at > FileIndex.TTL_MS;
  },

  /** 詰めた形で localStorage に置く（id の重複を避け、親は番号で持つ）。 */
  save() {
    const d = FileIndex.data;
    if (!d) return;
    const folderIds = Array.from(d.folders.keys());
    const at = new Map(folderIds.map((id, i) => [id, i]));
    const packed = {
      v: 1, key: d.key, at: d.at, partial: d.partial,
      folders: folderIds.map((id) => {
        const f = d.folders.get(id);
        return [id, f.name, f.parentId ? at.get(f.parentId) : -1];
      }),
      files: Array.from(d.files, ([id, f]) => [id, f.name, at.get(f.parentId), f.kind, f.size, f.updatedAtIso])
    };
    try {
      localStorage.setItem(FileIndex.KEY, JSON.stringify(packed));
    } catch (err) {
      // 容量超過など。メモリ上の索引は使えるので黙る。
    }
  },

  load() {
    let packed;
    try {
      packed = JSON.parse(localStorage.getItem(FileIndex.KEY) || 'null');
    } catch (err) {
      return;
    }
    if (!packed || packed.v !== 1 || !Array.isArray(packed.folders)) return;
    const folders = new Map();
    for (const [id, name, p] of packed.folders) {
      folders.set(id, { name, parentId: p >= 0 ? packed.folders[p][0] : null });
    }
    const files = new Map();
    for (const [id, name, p, kind, size, updatedAtIso] of packed.files || []) {
      const parent = packed.folders[p];
      if (!parent) continue;
      files.set(id, { name, parentId: parent[0], kind, size, updatedAtIso });
    }
    FileIndex.data = { key: packed.key, at: packed.at, partial: !!packed.partial, folders, files };
  },

  /** Drive から消えた（とツリーが知った）ものを索引からも落とす。 */
  drop(id) {
    const d = FileIndex.data;
    if (!d) return;
    d.files.delete(id);
    d.folders.delete(id);
  },

  pathOf(folderId, name) {
    const parts = [name];
    const d = FileIndex.data;
    let id = folderId;
    for (let i = 0; id && i < 20; i++) {
      const tn = Tree.get(id);
      const f = d.folders.get(id);
      if (!f && !tn) break;
      parts.unshift(tn ? tn.name : f.name);
      id = f ? f.parentId : (tn ? tn.parentId : null);
    }
    return parts.join(' / ');
  },

  /** openEntry に渡せる形。 */
  entryOf(id) {
    const f = FileIndex.data && FileIndex.data.files.get(id);
    if (!f) return null;
    return {
      id, name: f.name, mimeType: '', size: f.size, updatedAtIso: f.updatedAtIso,
      kind: f.kind, viewer: f.kind === 'text' ? 'editor' : 'embed', openable: true, reason: null
    };
  },

  /** ツリーに載っていないファイル（クイックオープンの補い）。 */
  extraFiles() {
    if (!FileIndex.usable()) return [];
    const out = [];
    for (const [id, f] of FileIndex.data.files) {
      if (Tree.get(id)) continue;
      out.push({ id, name: f.name, parentId: f.parentId, kind: f.kind });
    }
    return out;
  }
};
