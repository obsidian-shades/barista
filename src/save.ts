// The save's working set: which blobs the project file already holds, and the snapshot's blobs worked through a few at
// a time so a save never stalls the editor. A snapshot is captured in one tick (project.ts `docOf`); everything after
// it is asynchronous, reads the arrays the snapshot captured, and reports how much it is writing.
import { tilesOf } from './paint.ts';
import type { SaveSnapshot } from './project.ts';

/** What the open project's file already has. `keys`/`names` are per blob item (project.ts `BlobItem.id`): the same key
 *  as the last save means the same bytes, so the file's copy is kept (`names`) and nothing is made or sent. */
export interface SaveCache {
  /** The file these names came from. */
  path: string | null;
  /** That file was an autosave (its path is not the project's own, but it stays the same within a run). */
  auto: boolean;
  /** The revision those names belong to; null: unknown, so the next save writes everything. */
  rev: number | null;
  keys: Map<string, string>;
  names: Map<string, string[]>;
}

export const newCache = (): SaveCache => ({ path: null, auto: false, rev: null, keys: new Map(), names: new Map() });
export function resetCache(c: SaveCache) { c.path = null; c.auto = false; c.rev = null; c.keys.clear(); c.names.clear(); }
/** The cache describes the file this save will write: its own project, or the same autosave file as last time. */
export const cacheFits = (c: SaveCache, path: string | null) => c.rev != null && c.rev > 0 && (path !== null ? c.path === path : c.auto && c.path !== null);

/** What a save sends: the blobs whose bytes changed (and a `rev`/`keep` pair when the file can take them). */
export interface PreparedSave {
  keep: string[];
  blobs: [string, Uint8Array][];
  /** Bytes written, for the status bar. */
  bytes: number;
  changed: number;
  /** The cache for the file this save writes, once it lands. */
  next: { path: string | null; auto: boolean; keys: Map<string, string>; names: Map<string, string[]> };
}

export interface PrepareOpts {
  /** `reuse`: the cache belongs to the file being written, so unchanged blobs are only named. `full`: make every byte,
   *  as a fresh file (or a retry after the file moved on) needs. */
  reuse: boolean;
  /** The project path this save writes (null: the dialog picks one). */
  path: string | null;
  auto: boolean;
  onProgress?: (p: { bytes: number; changed: number }) => void;
}

let lastBreath = 0;
/** Let the page breathe: called between blobs, it keeps a big first save from freezing the viewport. */
async function breathe(force = false) {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (!force && now - lastBreath < 8) return;
  lastBreath = now;
  await new Promise((ok) => setTimeout(ok, 0));
}

/** Work the snapshot's blobs into what has to be sent. Unchanged blobs (same key, names in the file) are kept and their
 *  bytes never touched; everything else is made here, yielding to the page as it goes. */
export async function prepareSave(snap: SaveSnapshot, cache: SaveCache, opts: PrepareOpts): Promise<PreparedSave> {
  const keep: string[] = [], blobs: [string, Uint8Array][] = [], keys = new Map<string, string>(), names = new Map<string, string[]>();
  let bytes = 0, reported = 0, at = 0;
  const onProgress = opts.onProgress ?? (() => {});
  // the status line is redrawn at most a few times a second: a save with thousands of tiles must not re-render per blob
  const progress = () => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - at < 150 && bytes - reported < (2 << 20)) return;
    at = now;
    reported = bytes;
    onProgress({ bytes, changed: blobs.length });
  };
  for (const item of snap.items) {
    const prevKey = opts.reuse ? cache.keys.get(item.id) : undefined, prevNames = opts.reuse ? cache.names.get(item.id) : undefined;
    if (prevKey !== undefined && prevKey === item.key && prevNames) {
      for (const n of prevNames) keep.push(n);
      keys.set(item.id, item.key);
      names.set(item.id, prevNames);
    } else if (item.one) {
      const data = await item.one.data();
      if (data.length) {
        blobs.push([item.one.name, data]);
        bytes += data.length;
      }
      keys.set(item.id, item.key);
      names.set(item.id, data.length ? [item.one.name] : []);
    } else if (item.tiles) {
      const { prefix, px, size, stride } = item.tiles, held: string[] = [];
      for (const t of tilesOf(px, size, stride)) {
        const name = `${prefix}/${t.tx}_${t.ty}`;
        blobs.push([name, t.data]);
        held.push(name);
        bytes += t.data.length;
      }
      keys.set(item.id, item.key);
      names.set(item.id, held);
    }
    progress();
    await breathe();
  }
  return { keep, blobs, bytes, changed: blobs.length, next: { path: opts.path, auto: opts.auto, keys, names } };
}

/** A save landed: the cache now describes the file it wrote. */
export function commitCache(cache: SaveCache, next: PreparedSave['next'], rev: number) {
  cache.path = next.path;
  cache.auto = next.auto;
  cache.rev = rev;
  cache.keys = next.keys;
  cache.names = next.names;
}

/** A project was just opened: every blob the file has is what the state now holds, so a save right after opening writes
 *  only the edits. `tileNames` is docFrom's names map (`<part>/<layer>/<what>` → blob names); item names for single
 *  blobs are known from the snapshot itself. */
export function primeCache(cache: SaveCache, snap: SaveSnapshot, tileNames: Map<string, string[]>, rev: number | null, path: string | null) {
  resetCache(cache);
  if (rev == null || rev <= 0) return; // an older file: its blob names are not the ones this document makes
  cache.path = path;
  cache.rev = rev;
  // a composite tile (`set/…` as a single blob) the file left out was empty, as a paint buffer's missing tile is
  const inFile = new Set([...tileNames.values()].flat());
  for (const item of snap.items) {
    const held = item.one ? (!item.one.name.startsWith('set/') || inFile.has(item.one.name) ? [item.one.name] : [])
      : tileNames.get(item.tiles?.prefix.replace(/^set\//, '') ?? '');
    // a paint buffer with no tiles in the file was (and, just opened, still is) empty: remember it as such, so every
    // later save doesn't scan it to find nothing
    if (!held && !item.one) {
      cache.keys.set(item.id, item.key);
      cache.names.set(item.id, []);
      continue;
    }
    if (!held) continue;
    cache.keys.set(item.id, item.key);
    cache.names.set(item.id, held);
  }
}
