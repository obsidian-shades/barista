// File › Open Recent. A page can't reopen a file by its path, so each recent file is kept as what the browser allows:
// a file handle where it has the File System Access API (Chromium, and WebView2 in the desktop app: the file is read
// again from disk, asking once for permission), else a copy of the file (up to COPY_LIMIT). The newest 10, by name.
const DB = 'auto-unwrap', STORE = 'recent', MAX = 10, COPY_LIMIT = 64 * 1024 * 1024;

/** `path`: a `.barista` project, which the engine reopens from disk itself. */
export interface RecentFile { name: string; time: number; size: number; handle?: FileSystemFileHandle; blob?: Blob; path?: string }
type Picker = (o: { types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle[]>;
type Permission = { queryPermission?: (o: { mode: 'read' }) => Promise<PermissionState>; requestPermission?: (o: { mode: 'read' }) => Promise<PermissionState> };

function db(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'name' });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await db();
  return new Promise((ok, fail) => {
    const t = d.transaction(STORE, mode), req = run(t.objectStore(STORE));
    t.oncomplete = () => { d.close(); ok(req ? req.result : undefined); };
    t.onerror = () => { d.close(); fail(t.error); };
  });
}

/** The recent files, newest first. */
export async function recentFiles(): Promise<RecentFile[]> {
  try { return ((await tx('readonly', (s) => s.getAll())) as RecentFile[] ?? []).sort((a, b) => b.time - a.time); } catch { return []; }
}

/** Put a file at the top of the list (keeping only the newest MAX). */
export async function remember(file: File, handle?: FileSystemFileHandle) {
  try {
    const entry: RecentFile = { name: file.name, time: Date.now(), size: file.size, ...(handle ? { handle } : file.size <= COPY_LIMIT ? { blob: file } : {}) };
    if (!entry.handle && !entry.blob) return; // too big to keep a copy of, and no handle to reopen it by
    await tx('readwrite', (s) => s.put(entry));
    for (const old of (await recentFiles()).slice(MAX)) await tx('readwrite', (s) => s.delete(old.name));
  } catch { /* private mode: no list */ }
}

/** Put a project (by its path on disk) at the top of the list. */
export async function rememberProject(path: string) {
  try {
    await tx('readwrite', (s) => s.put({ name: path.split(/[\\/]/).pop()!, time: Date.now(), size: 0, path } satisfies RecentFile));
    for (const old of (await recentFiles()).slice(MAX)) await tx('readwrite', (s) => s.delete(old.name));
  } catch { /* private mode: no list */ }
}

export const forgetRecent = (name: string) => tx('readwrite', (s) => s.delete(name)).catch(() => undefined);
export const clearRecentFiles = () => tx('readwrite', (s) => s.clear()).catch(() => undefined);

/** The file again: from disk through its handle (asking for permission if the browser wants), or the kept copy. */
export async function reopen(r: RecentFile): Promise<File> {
  if (r.handle) {
    const h = r.handle as FileSystemFileHandle & Permission;
    if ((await h.queryPermission?.({ mode: 'read' })) !== 'granted' && (await h.requestPermission?.({ mode: 'read' })) !== 'granted') throw new Error(`No permission to read ${r.name}`);
    return h.getFile();
  }
  if (r.blob) return new File([r.blob], r.name);
  throw new Error(`${r.name} can't be reopened`);
}

/** The system's open dialog with a handle to remember, where the browser has one (null: use a file input instead).
 *  Falls back only when the dialog never showed (no API, or SecurityError); an error after the pick is thrown, since
 *  falling back then asked for the file a second time. */
export async function pickWithHandle(): Promise<{ file: File; handle: FileSystemFileHandle } | null | 'cancelled'> {
  const picker = (window as unknown as { showOpenFilePicker?: Picker }).showOpenFilePicker;
  if (!picker) return null;
  let handle: FileSystemFileHandle;
  try {
    [handle] = await picker({ types: [{ description: '3D models', accept: { 'application/octet-stream': ['.fbx', '.obj', '.glb', '.gltf', '.stl'] } }] });
  } catch (e) {
    const name = (e as Error).name;
    if (name === 'AbortError') return 'cancelled';
    if (name === 'SecurityError') return null;
    throw e;
  }
  return { file: await handle.getFile(), handle };
}
