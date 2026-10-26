// The Rust engine's HTTP API (engine/src/main.rs), or its Tauri commands (src-tauri/src/main.rs) in the desktop app.
// Field names mirror engine/src/lib.rs: change both together.
import { invoke, isTauri } from '@tauri-apps/api/core';
export interface Params { sharp: number; tol: number; seam_weight: number; join: boolean; atlas: number; one_atlas: boolean }
/** The seams themselves (engine/src/judge.rs), measured on the cuts before nets are joined. Scale-free: `length` is
 *  Σ seam length / √(Σ area); the others are shares of that length. */
export interface Seams {
  length: number;
  /** Share of the seam length on surface hidden inside the model. */
  hidden: number;
  /** Dead-end runs shorter than 6% of √area: they open nothing. */
  spurs: number;
  spur_length: number;
  /** Share of the seam length in staircase turns. */
  steps: number;
  /** Share inside one polygon (should be 0: the export would split the face). */
  inside: number;
}
export interface Stats { islands: number; tris: number; flips: number; mean_stretch: number; max_stretch: number; good_area: number; overlap: number; efficiency: number; seams: Seams; ms: number }
/** Per corner: positions (xyz), uvs (uv). Per triangle: stretch (−1 = flipped), island (numbered across all parts),
 *  source (its triangle in the part's input soup). */
export interface PartOut { positions: number[]; uvs: number[]; stretch: number[]; island: number[]; source: number[] }
export interface Output { parts: PartOut[]; stats: Stats }
/** An island as the editor holds it, for the hand-edit solvers (engine/src/edit.rs): xyz and uv per corner. */
export interface IslandIn { positions: number[]; uvs: number[] }
/** Seams: two xyz endpoints (6 numbers) per edge. `poly`: per soup triangle its polygon (no seam runs inside one).
 *  `symmetry`: a point on a mirror plane and its normal (6 numbers, world units), drawn by hand; empty = auto-detect. */
export interface PartIn { name: string; soup: Float32Array; seams: number[]; poly?: Int32Array; symmetry?: number[] }
/** A part after a seam change (engine/src/edit.rs): its output as the editor holds it, every seam now, the edges
 *  toggled since its UVs were made, and the pinned corners. */
export interface ReseamIn {
  positions: number[]; uvs: number[]; stretch: number[]; island: number[]; seams: number[]; changed: number[]; pins: number[];
  /** Triangles to unwrap again (U); with `live`, just laid out again around their pins (a pin drag). */
  faces?: number[]; live?: boolean;
  /** By hand: islands made by the seams alone, each flattened as it is, never cut further. */
  manual?: boolean;
}

export class ServerDown extends Error {}

async function call<T>(path: string, body?: unknown): Promise<T> {
  // in the desktop app the engine is in-process (src-tauri): same body, command named after the route
  if (isTauri()) {
    const [cmd, arg] = path.split('/');
    try {
      return await invoke<T>(cmd.replace('-', '_'), { body: body ?? arg });
    } catch (e) {
      throw new Error(String(e));
    }
  }
  return (await post(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
}

async function post(path: string, init?: RequestInit): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(`/api/${path}`, init);
  } catch (e) {
    // a request the browser itself couldn't send (out of memory for a big body) is not the engine being down
    const up = await fetch('/api/shapes').then((x) => x.ok, () => false);
    if (up) throw new Error(`The editor couldn't send ${path} to the engine (${e instanceof Error ? e.message : String(e)}); reload the page to free memory and try again.`);
    throw new ServerDown('Engine not reachable: run `pnpm server`');
  }
  // the Vite proxy answers 5xx with an empty body when the engine isn't running
  if (r.status >= 502 && r.status <= 504) throw new ServerDown('Engine not reachable: run `pnpm server`');
  if (!r.ok) throw new Error((await r.text()) || `${r.status} ${r.statusText}`);
  return r;
}

/** `.barista` projects (engine/src/project.rs): the engine shows the Open / Save dialogs and reads / writes the file. */
const tauriCall = async <T>(cmd: string, args: Record<string, unknown> | Uint8Array): Promise<T> => {
  try { return await invoke<T>(cmd, args); } catch (e) { throw new Error(String(e)); }
};
export interface OpenProject { path?: string; recover?: boolean }
/** Full-resolution texture export (engine/src/texture): a Pack in; the folder and files out, null when cancelled. */
export const textureApi = {
  export: (pack: Uint8Array<ArrayBuffer>): Promise<{ dir: string; files: string[] } | null> => isTauri() ? tauriCall('texture_export', pack)
    : post('texture-export', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pack }).then((r) => r.json()),
  /** What the running export is on ('' when idle). */
  status: (): Promise<string> => isTauri() ? tauriCall('texture_status', {}) : post('texture-status').then((r) => r.text()),
};
export const projectApi = {
  /** Writes a Pack (project.ts); the path written, or null when the dialog was cancelled. */
  save: (pack: Uint8Array<ArrayBuffer>): Promise<string | null> => isTauri() ? tauriCall('project_save', pack)
    : post('project-save', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pack }).then((r) => r.json()),
  /** The project as a Pack whose JSON is { path, doc } (or { cancelled }). */
  open: async (req: OpenProject): Promise<Uint8Array> => new Uint8Array(isTauri() ? await tauriCall<ArrayBuffer>('project_open', { body: req })
    : await (await post('project-open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) })).arrayBuffer()),
};

export const api = {
  shapes: () => call<string[]>('shapes'),
  shape: (name: string) => call<number[]>(`shape/${name}`),
  unwrap: (parts: PartIn[], params: Params) =>
    call<Output>('unwrap', { parts: parts.map((p) => ({ name: p.name, positions: Array.from(p.soup), seams: p.seams, polys: p.poly ? Array.from(p.poly) : [] })), params }),
  /** Only the islands the changed edges touch solved again, laid back where they were; the rest as sent. */
  reseam: (part: ReseamIn, params: Params) => call<Pick<PartOut, 'uvs' | 'stretch' | 'island'>>('reseam', { part, params }),
  /** u,v per corner per island, as edited; returns them packed into 0..1. */
  pack: (islands: number[][], rotate = false) => call<number[][]>('pack', { islands, rotate }),
  /** Each island re-flattened (ARAP) from where it lies, put back in place: uv per corner per island. */
  relax: (islands: IslandIn[]) => call<number[][]>('relax', { islands }),
  /** Continue a picked edge through welded mesh topology using the straightest connected edge at each vertex. */
  edgeLoop: (soup: Float32Array, edge: number[]) => call<number[]>('edge-loop', { positions: Array.from(soup), edge }),
};
