// After a seam edit: the islands it changed fitted in round the others, which stay where they are (Ctrl+P still packs
// everything again). The engine packer's grid and padding. Each changed island, biggest first, stays where the edit
// laid it (where the old island lay) if its triangles are clear of everything there; else nudged off that spot (the two
// halves of a cut island come back touching), nearest first; else by its real shape to the lowest free spot, upright or
// a quarter turn (a box that's all free takes it at once; one with fewer free cells
// than the island covers is skipped unlooked).

const R = 512, PAD = 3, BUDGET_MS = 60, NUDGE = 48;
/** An island: its part's UV array and its corners, three per triangle. */
export interface Isl { a: Float32Array; corners: number[] }

/** Fit `moving` round `fixed` inside the 0..1 square, keeping their size; false (nothing moved) if one doesn't fit or
 *  the search runs past its budget (then the caller packs everything). */
export function placeChanged(fixed: Isl[], moving: Isl[]): boolean {
  const t0 = performance.now(), occ = new Uint8Array(R * R);
  for (const s of fixed) fill(occ, s);
  const saved = moving.map((s) => s.corners.map((c) => [s.a[c * 2], s.a[c * 2 + 1]]));
  const undo = () => { moving.forEach((m, j) => m.corners.forEach((c, k) => { m.a[c * 2] = saved[j][k][0]; m.a[c * 2 + 1] = saved[j][k][1]; })); return false; };
  const order = moving.map((_, i) => i).sort((i, j) => area(box(moving[j])) - area(box(moving[i])));
  for (const i of order) {
    // staying put needs a cell's gap (the engine packed it that close); a new spot gets the full padding
    const s = moving[i], close = grow(occ, 1), own = new Uint8Array(R * R);
    if (!fill(own, s) || own.some((x, k) => x && close[k])) {
      const near = grow(occ, PAD), sum = prefix(near), b = box(s);
      const fits = (m: { cells: [number, number][]; w: number; h: number }, x: number, y: number) => {
        if (x < 0 || y < 0 || x + m.w > R || y + m.h > R) return false;
        const taken = sum[(y + m.h) * (R + 1) + x + m.w] - sum[y * (R + 1) + x + m.w] - sum[(y + m.h) * (R + 1) + x] + sum[y * (R + 1) + x];
        return taken <= m.w * m.h - m.cells.length && (taken === 0 || !m.cells.some(([dx, dy]) => near[(y + dy) * R + x + dx]));
      };
      let best: { top: number; x: number; y: number; turn: boolean } | null = null;
      // first nudged off where it lies (the two halves of a cut island come back touching), nearest ring first
      const m0 = shape(s, b, false), x0 = Math.floor(b.u0 * R), y0 = Math.floor(b.v0 * R);
      near: for (let r = 1; m0 && r <= NUDGE; r++) {
        for (let k = -r; k <= r; k++) {
          for (const [dx, dy] of [[k, -r], [k, r], [-r, k], [r, k]]) if (fits(m0, x0 + dx, y0 + dy)) { best = { top: 0, x: x0 + dx, y: y0 + dy, turn: false }; break near; }
        }
      }
      for (const turn of best ? [] : [false, true]) {
        const m = shape(s, b, turn);
        if (!m) continue;
        scan: for (let y = 0; y + m.h <= R && (!best || y + m.h < best.top); y++) {
          if (performance.now() - t0 > BUDGET_MS) return undo();
          for (let x = 0; x + m.w <= R; x++) if (fits(m, x, y)) { best = { top: y + m.h, x, y, turn }; break scan; }
        }
      }
      if (!best) return undo();
      // a nudge keeps the island's own offset within its cell; a new spot puts its box's corner on the cell
      const u0 = best.top ? best.x / R : b.u0 + (best.x - x0) / R, v0 = best.top ? best.y / R : b.v0 + (best.y - y0) / R;
      for (const c of s.corners) {
        const du = s.a[c * 2] - b.u0, dv = s.a[c * 2 + 1] - b.v0;
        // a quarter turn: (du, dv) → (height − dv, du) keeps the box's corner at the origin
        s.a[c * 2] = u0 + (best.turn ? b.v1 - b.v0 - dv : du);
        s.a[c * 2 + 1] = v0 + (best.turn ? du : dv);
      }
    }
    fill(occ, s);
  }
  return true;
}

/** The island's cells with its box's corner at the origin (a quarter turn first if `turn`), and their extent. */
function shape(s: Isl, b: Box, turn: boolean): { cells: [number, number][]; w: number; h: number } | null {
  const a = new Float32Array(s.a.length);
  for (const c of s.corners) {
    const du = s.a[c * 2] - b.u0, dv = s.a[c * 2 + 1] - b.v0;
    a[c * 2] = turn ? b.v1 - b.v0 - dv : du;
    a[c * 2 + 1] = turn ? du : dv;
  }
  const g = new Uint8Array(R * R);
  if (!fill(g, { a, corners: s.corners })) return null;
  const cells: [number, number][] = [];
  let w = 0, h = 0;
  for (let k = 0; k < g.length; k++) if (g[k]) { const x = k % R, y = (k / R) | 0; cells.push([x, y]); w = Math.max(w, x + 1); h = Math.max(h, y + 1); }
  return { cells, w, h };
}

type Box = { u0: number; v0: number; u1: number; v1: number };
function box(s: Isl): Box {
  const b = { u0: Infinity, v0: Infinity, u1: -Infinity, v1: -Infinity };
  for (const c of s.corners) {
    b.u0 = Math.min(b.u0, s.a[c * 2]); b.u1 = Math.max(b.u1, s.a[c * 2]);
    b.v0 = Math.min(b.v0, s.a[c * 2 + 1]); b.v1 = Math.max(b.v1, s.a[c * 2 + 1]);
  }
  return b;
}
const area = (b: Box) => (b.u1 - b.u0) * (b.v1 - b.v0);

/** Each triangle's cells (centre inside, or a corner in it); false if any part lies outside the square. */
function fill(occ: Uint8Array, s: Isl): boolean {
  let inside = true;
  const cell = (q: number) => { const c = Math.floor(q); if (c < 0 || c >= R) inside = false; return Math.min(R - 1, Math.max(0, c)); };
  for (let k = 0; k < s.corners.length; k += 3) {
    const p = [0, 1, 2].map((i) => [s.a[s.corners[k + i] * 2] * R, s.a[s.corners[k + i] * 2 + 1] * R]);
    for (const [u, v] of p) occ[cell(v) * R + cell(u)] = 1;
    const d = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]);
    if (d === 0) continue;
    const x0 = cell(Math.min(p[0][0], p[1][0], p[2][0])), x1 = cell(Math.max(p[0][0], p[1][0], p[2][0]));
    const y0 = cell(Math.min(p[0][1], p[1][1], p[2][1])), y1 = cell(Math.max(p[0][1], p[1][1], p[2][1]));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      let ok = true;
      for (let i = 0; i < 3 && ok; i++) { const a = p[i], b = p[(i + 1) % 3]; ok = ((b[0] - a[0]) * (cy - a[1]) - (b[1] - a[1]) * (cx - a[0])) * d >= 0; }
      if (ok) occ[y * R + x] = 1;
    }
  }
  return inside;
}

/** The grid grown by `r` cells each way (two running-window passes). */
function grow(occ: Uint8Array, r: number): Uint8Array {
  const h = new Uint8Array(R * R), out = new Uint8Array(R * R);
  for (let y = 0; y < R; y++) {
    let last = -1e9;
    for (let x = 0; x < R + r; x++) { if (x < R && occ[y * R + x]) last = x; const t = x - r; if (t >= 0 && t < R && x - last <= 2 * r) h[y * R + t] = 1; }
  }
  for (let x = 0; x < R; x++) {
    let last = -1e9;
    for (let y = 0; y < R + r; y++) { if (y < R && h[y * R + x]) last = y; const t = y - r; if (t >= 0 && t < R && y - last <= 2 * r) out[t * R + x] = 1; }
  }
  return out;
}

function prefix(occ: Uint8Array): Int32Array {
  const s = new Int32Array((R + 1) * (R + 1));
  for (let y = 0; y < R; y++) for (let x = 0, row = 0; x < R; x++) { row += occ[y * R + x]; s[(y + 1) * (R + 1) + x + 1] = s[y * (R + 1) + x + 1] + row; }
  return s;
}
