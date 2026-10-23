// The unfold animation: as-rigid-as-possible shape interpolation (Alexa, Cohen-Or & Levin 2000).
// A straight line from each point on the model to its spot in the layout sends a ring through its own middle;
// instead each triangle turns (slerp) and stretches toward its flat self, and one Poisson solve per frame
// stitches the triangles back together, so the surface rolls out like paper.

type M3 = number[]; // row-major 3×3

const mul3 = (a: M3, b: M3): M3 => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]));
const tr3 = (a: M3): M3 => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];

// Orthonormal frame of a triangle: columns e1 (along a→b), e2, normal.
function frame(p: number[]): M3 {
  const e1 = [p[3] - p[0], p[4] - p[1], p[5] - p[2]], f = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
  const n = [e1[1] * f[2] - e1[2] * f[1], e1[2] * f[0] - e1[0] * f[2], e1[0] * f[1] - e1[1] * f[0]];
  const unit = (v: number[]) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
  const a = unit(e1), c = unit(n), b = [c[1] * a[2] - c[2] * a[1], c[2] * a[0] - c[0] * a[2], c[0] * a[1] - c[1] * a[0]];
  return [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
}

function toQuat(m: M3): number[] {
  const t = m[0] + m[4] + m[8];
  let q: number[];
  if (t > 0) { const s = Math.sqrt(t + 1) * 2; q = [0.25 * s, (m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s]; }
  else if (m[0] > m[4] && m[0] > m[8]) { const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2; q = [(m[7] - m[5]) / s, 0.25 * s, (m[1] + m[3]) / s, (m[2] + m[6]) / s]; }
  else if (m[4] > m[8]) { const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2; q = [(m[2] - m[6]) / s, (m[1] + m[3]) / s, 0.25 * s, (m[5] + m[7]) / s]; }
  else { const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2; q = [(m[3] - m[1]) / s, (m[2] + m[6]) / s, (m[5] + m[7]) / s, 0.25 * s]; }
  return q[0] < 0 ? q.map((x) => -x) : q; // the short way round
}
function quatMat([w, x, y, z]: number[]): M3 {
  return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
}
// slerp from identity to q
function slerpId(q: number[], t: number): number[] {
  const th = Math.acos(Math.min(1, q[0]));
  if (th < 1e-6) return [1, 0, 0, 0];
  const a = Math.sin((1 - t) * th) / Math.sin(th), b = Math.sin(t * th) / Math.sin(th);
  return [a + b * q[0], b * q[1], b * q[2], b * q[3]];
}

export class Morph {
  private n: number;
  private corner: Int32Array; // corner → welded vertex
  private tris: Int32Array;
  private src: Float64Array; // vertex positions on the model
  private dst: Float64Array; // vertex positions laid flat
  private rot: number[][] = []; // per triangle: quaternion, model frame → flat frame
  private fs: M3[] = []; // per triangle: model frame
  private st: number[][] = []; // per triangle: in-plane 2×2 stretch, model local → flat local
  private rows: Int32Array[] = [];
  private wts: Float64Array[] = [];
  private pin: Int32Array; // one vertex per island, moved in a straight line
  private x: Float64Array;

  /** Corners (3 per triangle): xyz on the model, xyz laid flat, and UVs (corners sharing position and UV are one vertex). */
  constructor(p3: ArrayLike<number>, p2: ArrayLike<number>, uvs: ArrayLike<number>) {
    const ids = new Map<string, number>(), nc = p3.length / 3;
    this.corner = new Int32Array(nc);
    const src: number[] = [], dst: number[] = [];
    for (let c = 0; c < nc; c++) {
      const k = `${p3[c * 3]},${p3[c * 3 + 1]},${p3[c * 3 + 2]}|${uvs[c * 2]},${uvs[c * 2 + 1]}`;
      let id = ids.get(k);
      if (id === undefined) { id = ids.size; ids.set(k, id); for (let q = 0; q < 3; q++) { src.push(p3[c * 3 + q]); dst.push(p2[c * 3 + q]); } }
      this.corner[c] = id;
    }
    this.n = ids.size;
    this.src = Float64Array.from(src);
    this.dst = Float64Array.from(dst);
    this.tris = this.corner;
    this.x = this.src.slice();

    const nb = Array.from({ length: this.n }, () => new Map<number, number>());
    for (let t = 0; t < nc / 3; t++) {
      const v = [this.tris[t * 3], this.tris[t * 3 + 1], this.tris[t * 3 + 2]];
      const P = v.flatMap((i) => [src[i * 3], src[i * 3 + 1], src[i * 3 + 2]]), Q = v.flatMap((i) => [dst[i * 3], dst[i * 3 + 1], dst[i * 3 + 2]]);
      const Fs = frame(P), Fq = frame(Q);
      this.fs.push(Fs);
      this.rot.push(toQuat(mul3(Fq, tr3(Fs))));
      // corners in each triangle's own frame → the 2×2 map between them
      const loc = (F: M3, X: number[], k: number) => [0, 1].map((r) => F[r] * (X[k * 3] - X[0]) + F[3 + r] * (X[k * 3 + 1] - X[1]) + F[6 + r] * (X[k * 3 + 2] - X[2]));
      const [p1, p2_] = [loc(Fs, P, 1), loc(Fs, P, 2)], [q1, q2] = [loc(Fq, Q, 1), loc(Fq, Q, 2)];
      const det = p1[0] * p2_[1] - p2_[0] * p1[1] || 1e-12;
      const inv = [p2_[1] / det, -p2_[0] / det, -p1[1] / det, p1[0] / det];
      this.st.push([q1[0] * inv[0] + q2[0] * inv[2], q1[0] * inv[1] + q2[0] * inv[3], q1[1] * inv[0] + q2[1] * inv[2], q1[1] * inv[1] + q2[1] * inv[3]]);
      for (let k = 0; k < 3; k++) {
        const a = v[k], b = v[(k + 1) % 3];
        nb[a].set(b, (nb[a].get(b) ?? 0) + 1);
        nb[b].set(a, (nb[b].get(a) ?? 0) + 1);
      }
    }
    this.rows = nb.map((m) => Int32Array.from(m.keys()));
    this.wts = nb.map((m) => Float64Array.from(m.values()));

    // one pin per island (connected piece), or the piece could drift
    const seen = new Uint8Array(this.n), pins: number[] = [];
    for (let s = 0; s < this.n; s++) {
      if (seen[s]) continue;
      pins.push(s);
      seen[s] = 1;
      for (const q = [s]; q.length;) for (const j of this.rows[q.pop()!]) if (!seen[j]) { seen[j] = 1; q.push(j); }
    }
    this.pin = Int32Array.from(pins);
  }

  /** Write the shape at time t (0 = model, 1 = flat) into `out`, xyz per corner. */
  at(t: number, out: Float32Array) {
    const n = this.n, b = new Float64Array(n * 3), x = this.x;
    for (let tri = 0; tri < this.tris.length / 3; tri++) {
      const R = quatMat(slerpId(this.rot[tri], t)), F = this.fs[tri], s = this.st[tri];
      const S2 = [1 - t + t * s[0], t * s[1], t * s[2], 1 - t + t * s[3]];
      // stretch acts in the triangle's plane (model frame), then the interpolated turn
      const T = mul3(R, mul3(F, mul3([S2[0], S2[1], 0, S2[2], S2[3], 0, 0, 0, 1], tr3(F))));
      for (let k = 0; k < 3; k++) {
        const i = this.tris[tri * 3 + k], j = this.tris[tri * 3 + (k + 1) % 3];
        const d = [0, 1, 2].map((q) => this.src[j * 3 + q] - this.src[i * 3 + q]);
        for (let r = 0; r < 3; r++) {
          const g = T[r * 3] * d[0] + T[r * 3 + 1] * d[1] + T[r * 3 + 2] * d[2];
          b[i * 3 + r] -= g;
          b[j * 3 + r] += g;
        }
      }
    }
    const fixed = new Uint8Array(n);
    for (const p of this.pin) {
      fixed[p] = 1;
      for (let q = 0; q < 3; q++) x[p * 3 + q] = this.src[p * 3 + q] + (this.dst[p * 3 + q] - this.src[p * 3 + q]) * t;
    }
    for (let q = 0; q < 3; q++) this.solve(b, x, fixed, q);
    for (let c = 0; c < this.corner.length; c++) { const v = this.corner[c]; out[c * 3] = x[v * 3]; out[c * 3 + 1] = x[v * 3 + 1]; out[c * 3 + 2] = x[v * 3 + 2]; }
  }

  // Conjugate gradients on one coordinate of L x = b (graph Laplacian, edge counts as weights), warm-started.
  private solve(b: Float64Array, x: Float64Array, fixed: Uint8Array, q: number) {
    const n = this.n, r = new Float64Array(n), p = new Float64Array(n), ap = new Float64Array(n);
    const mul = (v: (i: number) => number, out: Float64Array) => {
      for (let i = 0; i < n; i++) {
        if (fixed[i]) { out[i] = 0; continue; }
        let s = 0;
        const row = this.rows[i], w = this.wts[i];
        for (let k = 0; k < row.length; k++) s += w[k] * (v(i) - v(row[k]));
        out[i] = s;
      }
    };
    mul((i) => x[i * 3 + q], ap);
    let rr = 0, bb = 0;
    for (let i = 0; i < n; i++) if (!fixed[i]) { r[i] = b[i * 3 + q] - ap[i]; rr += r[i] * r[i]; bb += b[i * 3 + q] ** 2; }
    p.set(r);
    const stop = 1e-12 * Math.max(bb, 1e-30);
    for (let it = 0; it < 400 && rr > stop; it++) {
      mul((i) => (fixed[i] ? 0 : p[i]), ap);
      let pap = 0;
      for (let i = 0; i < n; i++) pap += p[i] * ap[i];
      if (!(pap > 0)) break;
      const al = rr / pap;
      let rr2 = 0;
      for (let i = 0; i < n; i++) if (!fixed[i]) { x[i * 3 + q] += al * p[i]; r[i] -= al * ap[i]; rr2 += r[i] * r[i]; }
      const be = rr2 / rr;
      for (let i = 0; i < n; i++) p[i] = fixed[i] ? 0 : r[i] + be * p[i];
      rr = rr2;
    }
  }
}
