// Open /src/relief.check.html on the dev server: the imported DECALmachine decals load, decode and bake in a browser.
// (The Node checks cover the maths; this covers `createImageBitmap`, the library's second index and the shelf's data.)
import { loadDecalLibrary, reliefPixels, decalUrl } from './decals.ts';
import { bakeRelief, newLayer, setOf, type Decal, type PaintLayer, type ReliefPixels } from './paint.ts';

const out = document.querySelector('pre')!;
const say = (s: string) => { out.textContent = s; };
/** A map's RGBA rows bottom-up, as paint.ts's buffers hold them (v = 0 first), from an image's top-down rows. */
function flipRows(m: { width: number; height: number; data: Uint8ClampedArray }) {
  const o = new Uint8ClampedArray(m.data.length), row = m.width * 4;
  for (let y = 0; y < m.height; y++) o.set(m.data.subarray(y * row, (y + 1) * row), (m.height - 1 - y) * row);
  return o;
}
try {
  const lib = await loadDecalLibrary();
  const relief = lib.filter((d) => d.relief);
  const a = relief.find((d) => d.id === 'dm-detail-001') ?? relief[0];
  if (!a) throw new Error('no imported relief decals: run tools/dm-decals.mjs into public/decals-dm');
  const maps: ReliefPixels = await reliefPixels(a);
  const img = new Image();
  img.src = decalUrl(a);
  await img.decode().catch(() => undefined);
  // a 1 × 1 quad, UV 0..1: the mark covers all of it
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]);
  const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
  const s = setOf(pos, 64);
  const d: Decal = {
    asset: a.id, center: [0.5, 0.5, 0], normal: [0, 0, 1], up: [0, 1, 0], width: 1, rotation: 0, aspect: 1,
    tint: '#ffffff', roughness: 0.5, metallic: 0, channels: ['normal', 'height'], reliefNormal: 1, reliefHeight: 1,
  };
  const l: PaintLayer = { ...newLayer(1), decal: d };
  s.layers = [l]; s.active = 0;
  bakeRelief(s, l, maps, pos, uv, 1);
  const nm = l.px.normal!, ht = l.px.height!;
  let cov = 0, tilt = 0, low = 255;
  for (let i = 0; i < 64 * 64; i++) {
    if (nm[i * 4 + 3] > 0) { cov++; low = Math.min(low, ht[i * 2]); }
    tilt = Math.max(tilt, Math.abs(nm[i * 4] - 128), Math.abs(nm[i * 4 + 1] - 128));
  }
  const pct = Math.round((cov / (64 * 64)) * 100);
  say(`library ${lib.length} (${relief.length} imported relief) · ${a.name} ${a.width}×${a.height}\n` +
    `maps ${maps.normal.width}×${maps.normal.height}, ${maps.mask.width}×${maps.mask.height}\n` +
    `baked coverage ${pct}%, normal tilt ${tilt}, lowest height ${low}`);
  // The mark's own normal map beside the baked one: the same shape, on the same diagonal, is the proof the projector
  // and the tangent frame agree (a flip or a turn would show at once).
  const pair = document.createElement('div');
  pair.style.cssText = 'display:flex;gap:12px;margin-top:12px;font:12px sans-serif;color:#ccc';
  const show = (label: string, w: number, h: number, data: ArrayLike<number>) => {
    const box = document.createElement('div');
    const c = document.createElement('canvas');
    c.width = w; c.height = h; c.style.cssText = `width:${w * 3}px;height:${h * 3}px;image-rendering:pixelated;background:#222`;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
    box.append(label, c);
    pair.append(box);
  };
  show('normal.png (flipped to paint\'s rows)', maps.normal.width, maps.normal.height, flipRows(maps.normal));
  show('baked Normal', 64, 64, nm);
  out.after(pair);
  const ok = relief.length >= 100 && maps.normal.width > 16 && pct > 5 && tilt > 2 && low < 126;
  document.title = ok ? 'relief ok' : 'relief FAIL';
} catch (e) {
  say(`relief FAIL: ${e instanceof Error ? e.message : String(e)}`);
  document.title = 'relief FAIL';
}
