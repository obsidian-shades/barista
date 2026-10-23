// The Rust engine's HTTP API (engine/src/main.rs), or its Tauri commands (src-tauri/src/main.rs) in the desktop app.
// Field names mirror engine/src/lib.rs: change both together.
import { invoke, isTauri } from '@tauri-apps/api/core';
export interface Params { sharp: number; tol: number; seam_weight: number; join: boolean; one_atlas: boolean }
export interface Stats { islands: number; tris: number; flips: number; mean_stretch: number; max_stretch: number; good_area: number; overlap: number; efficiency: number; ms: number }
/** Per corner: positions (xyz), uvs (uv). Per triangle: stretch (−1 = flipped), island (numbered across all parts),
 *  source (its triangle in the part's input soup). */
export interface PartOut { positions: number[]; uvs: number[]; stretch: number[]; island: number[]; source: number[] }
export interface Output { parts: PartOut[]; stats: Stats }
/** An island as the editor holds it, for the hand-edit solvers (engine/src/edit.rs): xyz and uv per corner. */
export interface IslandIn { positions: number[]; uvs: number[] }
/** Seams: two xyz endpoints (6 numbers) per edge. `poly`: per soup triangle its polygon (no seam runs inside one). */
export interface PartIn { name: string; soup: Float32Array; seams: number[]; poly?: Int32Array }
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
  let r: Response;
  try {
    r = await fetch(`/api/${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new ServerDown('Engine not reachable: run `pnpm server`');
  }
  // the Vite proxy answers 5xx with an empty body when the engine isn't running
  if (r.status >= 502 && r.status <= 504) throw new ServerDown('Engine not reachable: run `pnpm server`');
  if (!r.ok) throw new Error((await r.text()) || `${r.status} ${r.statusText}`);
  return r.json();
}

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
