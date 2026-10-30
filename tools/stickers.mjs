#!/usr/bin/env node
// Draw Barista's built-in sticker library (the Stickers tab: prints, stencils and engraves the Decal tool places).
//
//     node tools/stickers.mjs [id-filter]
//
// Every sticker is SVG drawn here, rendered to a transparent PNG by headless Edge (the export engine reads PNG,
// not SVG) into public/assets/decals with its manifest, index.json. Makers, units and numbers are fictional.
// The glyphs are the SIL OFL faces in tools/fonts. Originals, CC0. `EDGE` overrides the browser's path.
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'assets', 'decals');
const FONTS = pathToFileURL(join(HERE, 'fonts')).href;
const EDGE = process.env.EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const W = '#fff', K = '#111214', Y = '#f2c14e', R = '#d4322b', O = '#f2811d', BL = '#1d5fbf', BAND = '#e8c547';
/** Engraves start as bright cut metal; one-colour prints take the brush colour; coloured signs keep their palette. */
const METAL = '#b9bdc2', OWN = '#ffffff';

// ---------- drawing helpers (units are output pixels) ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
/** Text; `max` shrinks it to that width once the fonts are in (the page's script measures it). */
const T = (x, y, s, { f = 'B', size = 40, ls = 0, a = 'start', fill = W, max, rot } = {}) =>
  `<text x="${x}" y="${y}" font-family="${f}" font-size="${size}" letter-spacing="${ls}" text-anchor="${a}" fill="${fill}"${max ? ` data-max="${max}"` : ''}${rot ? ` transform="rotate(${rot} ${x} ${y})"` : ''}>${esc(s)}</text>`;
const box = (x, y, w, h, { r = 0, sw = 5, fill = 'none', stroke = W } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${fill !== 'none' && stroke === W ? 'none' : stroke}" stroke-width="${sw}"/>`;
const solid = (x, y, w, h, fill = W, r = 0) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`;
const ln = (x1, y1, x2, y2, sw = 5, c = W) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="${sw}"/>`;
const circ = (cx, cy, r, { sw = 0, fill = W, stroke = W } = {}) =>
  sw ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>` : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`;
const poly = (pts, fill = W) => `<polygon points="${pts.map((p) => p.join(',')).join(' ')}" fill="${fill}"/>`;
const path = (d, { fill = W, stroke = 'none', sw = 0, cap = 'butt', join = 'miter', rule = 'nonzero' } = {}) =>
  `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="${cap}" stroke-linejoin="${join}" fill-rule="${rule}"/>`;
/** A 100-unit icon placed with its top left at (x, y), `s` pixels across. */
const at = (x, y, s, body) => `<g transform="translate(${x} ${y}) scale(${s / 100})">${body}</g>`;
/** Corner brackets round a box, as on the reference plates. */
const brackets = (x, y, w, h, l = 36, sw = 5) => path(
  `M${x} ${y + l}V${y}H${x + l}M${x + w - l} ${y}H${x + w}V${y + l}M${x + w} ${y + h - l}V${y + h}H${x + w - l}M${x + l} ${y + h}H${x}V${y + h - l}`,
  { fill: 'none', stroke: W, sw });
/** A white panel with its inner drawing cut out of it (one ink: works tinted and engraved). */
let maskId = 0;
const knock = (x, y, w, h, inner, r = 0) => {
  const id = `k${maskId++}`;
  return `<mask id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="#fff"/>${inner}</mask><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${W}" mask="url(#${id})"/>`;
};
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
/** Code-128-looking bars: widths 1..4 units, bar and gap alternating. */
const barcode = (x, y, w, h, seed = 1, fill = W) => {
  const r = rng(seed), runs = [];
  let units = 0;
  while (units < w / 3.2) { const u = 1 + Math.floor(r() * 4); runs.push(u); units += u; }
  const k = w / units;
  let px = x, out = '';
  runs.forEach((u, i) => { if (i % 2 === 0) out += solid(+px.toFixed(2), y, +(u * k).toFixed(2), h, fill); px += u * k; });
  return out;
};
/** A Data Matrix look: solid L finder on the left and bottom, a clock track top and right, data inside. */
const matrix = (x, y, s, n = 18, seed = 7, fill = W) => {
  const r = rng(seed), m = s / n;
  let out = '';
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const on = i === 0 || j === n - 1 || (j === 0 && i % 2 === 0) || (i === n - 1 && j % 2 === 1) || (i > 0 && j > 0 && i < n - 1 && j < n - 1 && r() < 0.5);
    if (on) out += solid(+(x + i * m).toFixed(2), +(y + j * m).toFixed(2), +m.toFixed(2) + 0.3, +m.toFixed(2) + 0.3, fill);
  }
  return out;
};
let clipId = 0;
const stripes = (x, y, w, h, { a = Y, b = K, step = 64 } = {}) => {
  const id = `c${clipId++}`;
  let out = `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></clipPath><g clip-path="url(#${id})">`;
  if (b !== 'none') out += solid(x, y, w, h, b);
  for (let i = -h; i < w + h; i += step) out += poly([[x + i, y + h], [x + i + h, y], [x + i + h + step / 2, y], [x + i + step / 2, y + h]], a);
  return out + '</g>';
};
const star = (cx, cy, ro, ri, n = 5, fill = W, turn = 0) => poly(Array.from({ length: n * 2 }, (_, i) => {
  const a = (Math.PI * i) / n - Math.PI / 2 + turn, r = i % 2 ? ri : ro;
  return [+(cx + r * Math.cos(a)).toFixed(2), +(cy + r * Math.sin(a)).toFixed(2)];
}), fill);
const gear = (cx, cy, ro, ri, n, hole, fill = W) => {
  const pts = [];
  for (let i = 0; i < n; i++) for (const [f, r] of [[0, ri], [0.15, ro], [0.5, ro], [0.65, ri]]) {
    const a = ((i + f) / n) * Math.PI * 2;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return path(`M${pts.join('L')}Z M${cx + hole} ${cy}A${hole} ${hole} 0 1 0 ${cx - hole} ${cy}A${hole} ${hole} 0 1 0 ${cx + hole} ${cy}Z`, { fill, rule: 'evenodd' });
};
const bullet = (x, y, w, h, fill = W) =>
  path(`M${x} ${y + h}V${y + w}C${x} ${y + w * 0.35} ${x + w / 2} ${y} ${x + w / 2} ${y}C${x + w / 2} ${y} ${x + w} ${y + w * 0.35} ${x + w} ${y + w}V${y + h}Z`, { fill }) + solid(x - w * 0.08, y + h - w * 0.5, w * 1.16, w * 0.18, fill);
const arrow = (x, y, len, w, dir = 0, fill = W) =>
  `<g transform="rotate(${dir} ${x} ${y})">${poly([[x - len / 2, y - w * 0.22], [x + len / 2 - w * 0.7, y - w * 0.22], [x + len / 2 - w * 0.7, y - w / 2], [x + len / 2, y], [x + len / 2 - w * 0.7, y + w / 2], [x + len / 2 - w * 0.7, y + w * 0.22], [x - len / 2, y + w * 0.22]], fill)}</g>`;
/** Rows of key / value text. */
const table = (x, y, rows, { kx = 0, vx = 200, dy = 44, size = 32, f = 'M', ls = 3 } = {}) =>
  rows.map(([k, v], i) => T(x + kx, y + i * dy, k, { f, size, ls }) + (v ? T(x + vx, y + i * dy, v, { f, size, ls }) : '')).join('');

// ---------- icons (100-unit box) ----------
const I = {
  bolt: (c = W) => path('M60 2L20 56H46L34 98L80 40H54L68 2Z', { fill: c }),
  flame: (c = W) => path('M50 2C58 22 80 32 80 60C80 82 66 96 50 96C34 96 20 84 20 62C20 46 30 36 36 26C38 40 44 46 50 50C46 34 44 18 50 2Z', { fill: c }),
  hot: (c = W) => [26, 50, 74].map((x) => path(`M${x} 76C${x - 12} 64 ${x + 12} 52 ${x} 40C${x - 12} 28 ${x + 12} 16 ${x} 4`, { fill: 'none', stroke: c, sw: 8, cap: 'round' })).join('') + solid(8, 84, 84, 10, c, 2),
  pinch: (c = W) => circ(74, 28, 24, { fill: c }) + circ(74, 78, 24, { fill: c }) + solid(0, 40, 30, 30, c, 6) + [42, 50, 58, 66].map((y, i) => solid(22, y - 3, 34 - i * 4, 7, c, 3.5)).join('') + `<g transform="rotate(-28 26 40)">${solid(22, 36, 24, 7, c, 3.5)}</g>`,
  gears: (c = W) => gear(36, 40, 30, 22, 9, 8, c) + gear(72, 72, 24, 17, 8, 6, c),
  burst: (c = W) => star(50, 52, 40, 18, 9, c, 0.2) + poly([[8, 10], [20, 14], [14, 24]], c) + poly([[86, 6], [96, 18], [82, 18]], c) + poly([[4, 82], [16, 78], [12, 92]], c) + poly([[90, 84], [98, 96], [84, 94]], c),
  trefoil: (c = W) => {
    const blade = (a) => { const r0 = 18, r1 = 46, a0 = ((a - 30) * Math.PI) / 180, a1 = ((a + 30) * Math.PI) / 180, p = (r, t) => `${(50 + r * Math.cos(t)).toFixed(2)} ${(50 + r * Math.sin(t)).toFixed(2)}`;
      return `M${p(r0, a0)}L${p(r1, a0)}A${r1} ${r1} 0 0 1 ${p(r1, a1)}L${p(r0, a1)}A${r0} ${r0} 0 0 0 ${p(r0, a0)}Z`; };
    return path([-90, 30, 150].map(blade).join(''), { fill: c }) + circ(50, 50, 12, { fill: c });
  },
  ground: (c = W) => ln(50, 8, 50, 52, 9, c) + ln(14, 52, 86, 52, 9, c) + ln(28, 70, 72, 70, 9, c) + ln(40, 88, 60, 88, 9, c),
  laser: (c = W) => circ(62, 50, 10, { fill: c }) + Array.from({ length: 12 }, (_, i) => { const a = (i * Math.PI) / 6, r = i % 2 ? 26 : 38; return ln(62 + 16 * Math.cos(a), 50 + 16 * Math.sin(a), 62 + r * Math.cos(a), 50 + r * Math.sin(a), 6, c); }).join('') + ln(2, 50, 46, 50, 7, c),
  vessel: (c = W) => solid(14, 40, 72, 46, c, 22) + circ(50, 20, 15, { sw: 6, stroke: c }) + ln(50, 20, 58, 12, 5, c) + solid(46, 34, 8, 8, c),
  eye: (c = W) => path('M6 50Q50 8 94 50Q50 92 6 50ZM50 32A18 18 0 1 0 50 68A18 18 0 1 0 50 32Z', { fill: c, rule: 'evenodd' }) + circ(50, 50, 8, { fill: c }),
  hook: (c = W) => circ(50, 12, 9, { sw: 7, stroke: c }) + path('M50 21V52A20 20 0 1 1 30 72', { fill: 'none', stroke: c, sw: 10, cap: 'round' }) + poly([[22, 66], [38, 66], [30, 80]], c),
  lock: (open = false, c = W) => path('M29 46H71A7 7 0 0 1 78 53V83A7 7 0 0 1 71 90H29A7 7 0 0 1 22 83V53A7 7 0 0 1 29 46ZM50 58A6 6 0 1 0 50 70A6 6 0 1 0 50 58ZM47 66H53V80H47Z', { fill: c, rule: 'evenodd' }) + path(open ? 'M34 46V26A16 16 0 0 1 66 26V32' : 'M34 46V30A16 16 0 0 1 66 30V46', { fill: 'none', stroke: c, sw: 9 }),
  rotate: (cw = true, c = W) => `<g transform="${cw ? '' : 'translate(100 0) scale(-1 1)'}">${path('M50 14A36 36 0 1 1 18 32', { fill: 'none', stroke: c, sw: 9 })}${poly([[50, 0], [68, 14], [50, 28]], c)}</g>`,
  umbrella: (c = W) => path('M8 52A42 42 0 0 1 92 52Z', { fill: c }) + path('M50 52V84A8 8 0 0 1 34 84', { fill: 'none', stroke: c, sw: 7, cap: 'round' }) + [[20, 4], [50, 0], [80, 4]].map(([x, y]) => path(`M${x} ${y}Q${x + 5} ${y + 9} ${x} ${y + 12}Q${x - 5} ${y + 9} ${x} ${y}Z`, { fill: c })).join(''),
  bird: (c = W) => poly([[0, 14], [40, 40], [46, 30], [50, 22], [54, 30], [60, 40], [100, 14], [70, 54], [58, 56], [64, 92], [50, 80], [36, 92], [42, 56], [30, 54]], c),
  arcane: (c = W) => poly([[0, 100], [42, 0], [60, 0], [18, 100]], c) + poly([[28, 100], [70, 0], [88, 0], [46, 100]], c) + poly([[56, 100], [96, 6], [100, 6], [100, 100]], c),
  hex: (c = W) => path(`M${Array.from({ length: 6 }, (_, i) => `${(50 + 46 * Math.cos((i * Math.PI) / 3)).toFixed(2)} ${(50 + 46 * Math.sin((i * Math.PI) / 3)).toFixed(2)}`).join('L')}ZM70 50A20 20 0 1 0 30 50A20 20 0 1 0 70 50Z`, { fill: c, rule: 'evenodd' }),
  bomb: (c = W) => circ(50, 66, 32, { fill: c }) + solid(42, 28, 16, 10, c, 2) + at(32, 0, 36, path('M50 2C58 22 80 32 80 60C80 82 66 96 50 96C34 96 20 84 20 62C20 46 30 36 36 26C38 40 44 46 50 50C46 34 44 18 50 2Z', { fill: c })),
};
/** ISO-style warning: black-bordered yellow triangle with a black pictogram (coloured). */
const warnSign = (icon, size = 512) => at(0, 0, size, path('M50 6L95 88H5Z', { fill: Y, stroke: K, sw: 7, join: 'round' }) + at(27, 37, 46, icon(K)));

// ---------- the library ----------
const stickers = [];
const CATS = {
  Receiver: { engrave: 0.5, tint: METAL, size: 16, tags: ['engrave', 'roll mark', 'receiver', 'gun'] },
  Controls: { engrave: 0.5, tint: METAL, size: 7, tags: ['engrave', 'selector', 'control', 'gun'] },
  Proof: { engrave: 0.6, tint: METAL, size: 2.5, tags: ['engrave', 'proof', 'stamp', 'inspection'] },
  'Part Stamps': { engrave: 0.5, tint: METAL, size: 6, tags: ['engrave', 'stamp', 'part', 'factory'] },
  'Data Plates': { size: 12, tags: ['plate', 'label', 'data', 'factory'] },
  Ordnance: { size: 24, tags: ['stencil', 'ammo', 'crate', 'ordnance'] },
  Military: { size: 20, tags: ['stencil', 'military', 'vehicle', 'marking'] },
  Industrial: { size: 8, tags: ['safety', 'sign', 'industrial', 'hazard'] },
};
/** One sticker: `own` = coloured, keeps its palette (white tint, never engraved). */
const S = (category, id, name, w, h, body, { tags = [], notes = '', own = false, size, engrave } = {}) => {
  const c = CATS[category];
  stickers.push({
    id, name, category, tags: [...c.tags, ...tags], notes, file: `${id}.png`, width: w, height: h,
    ...(own ? { tint: OWN } : c.tint ? { tint: c.tint } : {}),
    ...(!own && (engrave ?? c.engrave) ? { engrave: engrave ?? c.engrave } : {}),
    size: size ?? c.size, license: 'CC0-1.0', source: 'Barista original', svg: body,
  });
};

// Receiver: roll marks and laser engraving on receivers, slides and barrels
S('Receiver', 'rm-arcane-mod7', 'Arcane Arms Mod 7', 1024, 320,
  at(24, 50, 190, I.arcane()) + T(250, 140, 'ARCANE ARMS', { size: 118, ls: 6, max: 750 }) + ln(252, 168, 1000, 168, 4) +
  T(252, 228, 'MOD 7   ·   CAL 5.56×45 MM', { f: 'BB', size: 56, ls: 4, max: 748 }) + T(252, 286, 'NEW ARDEN, TX   ·   U.S.A.', { f: 'BB', size: 42, ls: 10, max: 748 }),
  { notes: 'Two-line receiver roll mark with the maker\'s slash logo.' });
S('Receiver', 'rm-kestrel', 'Kestrel K19 Slide', 1024, 256,
  at(16, 58, 150, I.bird()) + T(190, 112, 'KESTREL ORDNANCE WORKS', { size: 86, ls: 3, max: 820 }) + T(192, 196, 'K19  ·  9×19 MM  ·  SEMI-AUTOMATIC', { f: 'BB', size: 56, ls: 5, max: 818 }),
  { tags: ['slide', 'pistol'], notes: 'Pistol slide roll mark: maker, model and calibre.' });
S('Receiver', 'rm-serial', 'Serial Number', 1024, 176,
  T(10, 120, 'SER. NO.', { f: 'BB', size: 64, ls: 4 }) + T(250, 124, 'A7-204917', { f: 'M', size: 112, ls: 10, max: 760 }),
  { tags: ['serial'], notes: 'Serial number in a monospaced stamp.' });
S('Receiver', 'rm-made-in', 'Made in U.S.A.', 1024, 150,
  T(512, 115, 'MADE IN U.S.A.', { f: 'BB', size: 124, ls: 14, a: 'middle', max: 1000 }), { size: 10, notes: 'Country-of-origin line.' });
S('Receiver', 'rm-read-manual', 'Read Manual Warning', 1024, 180,
  T(512, 76, 'READ OWNER\'S MANUAL BEFORE USE', { f: 'BB', size: 70, ls: 4, a: 'middle', max: 1000 }) + T(512, 154, 'KEEP CHAMBER CLEAR  ·  ARCANE ARMS  ·  NEW ARDEN TX', { f: 'BB', size: 42, ls: 6, a: 'middle', max: 1000 }),
  { tags: ['warning'], notes: 'The barrel or frame warning line.' });
S('Receiver', 'rm-barrel', 'Barrel Stamp', 1024, 130,
  T(512, 98, '7.62×39  ◆  1:9.5  ◆  CHROME LINED  ◆  MP', { f: 'BB', size: 80, ls: 4, a: 'middle', max: 1010 }),
  { tags: ['barrel'], notes: 'Calibre, twist rate, lining and the magnetic-particle tested mark.' });
S('Receiver', 'rm-property', 'Government Property', 1024, 280,
  T(512, 64, 'PROPERTY OF THE', { f: 'BB', size: 56, ls: 18, a: 'middle' }) + T(512, 170, 'ARDEN DEFENSE FORCE', { size: 112, ls: 4, a: 'middle', max: 1000 }) +
  T(512, 252, 'CONTRACT ADF-26-C-0412', { f: 'M', size: 50, ls: 8, a: 'middle' }), { tags: ['military', 'contract'], notes: 'Issue weapon property mark.' });
S('Receiver', 'rm-import', 'Import Mark', 1024, 170,
  T(10, 70, 'IMP. BY HALVARD INTL  ·  PORT ARDEN', { f: 'BB', size: 60, ls: 4, max: 1004 }) + T(10, 150, 'CAL .308 WIN  ·  MADE IN NORDMARK', { f: 'BB', size: 60, ls: 4, max: 1004 }),
  { size: 12, notes: 'Small importer\'s mark under the barrel.' });
S('Receiver', 'rm-vx09', 'VX-09 Model', 1024, 320,
  T(10, 250, 'VX-09', { size: 280, ls: 6, max: 620 }) + ln(668, 40, 668, 280, 6) + T(700, 140, 'MULTI-ROLE', { f: 'BB', size: 68, ls: 4, max: 320 }) + T(700, 226, 'CARBINE', { f: 'BB', size: 68, ls: 12, max: 320 }),
  { notes: 'Large model name for magwells and dust covers.' });
S('Receiver', 'rm-caliber-box', 'Calibre Box', 1024, 220,
  box(8, 8, 1008, 204, { sw: 8, r: 10 }) + T(512, 152, 'CAL .300 BLK', { size: 140, ls: 10, a: 'middle', max: 940 }), { size: 10, notes: 'Boxed calibre mark for a barrel or upper.' });
S('Receiver', 'rm-patent', 'Patent Pending', 1024, 130,
  T(512, 96, 'PAT. PEND.   ·   MADE UNDER LICENSE', { f: 'BB', size: 72, ls: 6, a: 'middle', max: 1000 }), { size: 10, notes: 'Small patent line.' });
S('Receiver', 'rm-emblem', 'Arcane Emblem', 1024, 1024,
  circ(512, 512, 470, { sw: 18 }) + circ(512, 512, 330, { sw: 8 }) + at(352, 352, 320, I.arcane()) +
  `<path id="top" d="M112 512A400 400 0 0 1 912 512" fill="none"/><path id="bot" d="M132 512A380 380 0 0 0 892 512" fill="none"/>` +
  `<text font-family="B" font-size="104" letter-spacing="14" fill="${W}" text-anchor="middle"><textPath href="#top" startOffset="50%">ARCANE ARMS</textPath></text>` +
  `<text font-family="BB" font-size="78" letter-spacing="22" fill="${W}" text-anchor="middle" dominant-baseline="hanging"><textPath href="#bot" startOffset="50%">EST. 2049</textPath></text>` +
  star(152, 512, 22, 9) + star(872, 512, 22, 9),
  { size: 8, tags: ['logo'], notes: 'Round maker emblem for grips and stocks.' });
// Arcane Arms A19: the striker pistol's set, the marks a US handgun carries (maker, city and state, model, calibre,
// serial on the frame) laid out as a polymer pistol's laser engraving, the serial repeated on slide and barrel
const A19 = 'ARC 7049';
S('Receiver', 'rm-arcane-a19', 'Arcane A19 Slide', 1024, 240,
  at(10, 26, 170, I.arcane()) + T(206, 128, 'ARCANE', { size: 136, ls: 8, max: 470 }) + T(1014, 128, 'A19', { size: 150, ls: 4, a: 'end', max: 300 }) +
  T(208, 212, 'RICHMOND, VA  ·  U.S.A.', { f: 'BB', size: 54, ls: 6, max: 500 }) + T(1014, 212, '9×19', { f: 'BB', size: 70, ls: 4, a: 'end' }),
  { size: 18, tags: ['slide', 'pistol', 'arcane'], notes: 'Pistol slide mark: maker, city and state, model and calibre.' });
S('Receiver', 'rm-arcane-a19-serial', 'Arcane A19 Serial', 1024, 160,
  T(512, 122, A19, { f: 'M', size: 132, ls: 16, a: 'middle', max: 1000 }), { size: 9, tags: ['serial', 'pistol', 'arcane'], notes: 'The slide\'s serial, matching the frame plate.' });
S('Receiver', 'rm-arcane-a19-plate', 'Arcane A19 Serial Plate', 1024, 300,
  box(10, 10, 1004, 280, { sw: 12, r: 26 }) + T(56, 104, 'SN', { f: 'BB', size: 62, ls: 8 }) + at(900, 36, 64, I.arcane()) +
  T(512, 246, A19, { f: 'M', size: 140, ls: 14, a: 'middle', max: 860 }),
  { size: 8, tags: ['serial', 'plate', 'frame', 'pistol', 'arcane'], notes: 'The frame\'s serial plate: the frame is the legal firearm.' });
S('Receiver', 'rm-arcane-a19-frame', 'Arcane Arms Frame Mark', 1024, 130,
  T(512, 100, 'ARCANE ARMS  ·  RICHMOND, VA  ·  U.S.A.', { f: 'BB', size: 84, ls: 6, a: 'middle', max: 1010 }),
  { size: 16, tags: ['frame', 'pistol', 'arcane'], notes: 'Maker and place of manufacture on the frame.' });
S('Receiver', 'rm-arcane-a19-barrel', 'Arcane A19 Barrel', 1024, 800,
  T(512, 440, '9×19', { size: 470, ls: 10, a: 'middle', max: 940 }) + T(512, 700, A19, { f: 'M', size: 190, ls: 14, a: 'middle', max: 940 }),
  { size: 7, tags: ['barrel', 'pistol', 'arcane'], notes: 'Barrel hood: calibre and the matching serial, seen through the ejection port.' });

// Controls: selector, sight and control markings
const arcWords = (cx, cy, r, words, a0, a1, size) => words.map((w, i) => {
  const a = a0 + ((a1 - a0) * i) / Math.max(1, words.length - 1), t = ((a - 90) * Math.PI) / 180;
  const p = (rr) => [+(cx + rr * Math.cos(t)).toFixed(1), +(cy + rr * Math.sin(t)).toFixed(1)];
  const [x0, y0] = p(r - 70), [x1, y1] = p(r), [tx, ty] = p(r + 26);
  return ln(x0, y0, x1, y1, 16) + T(tx, ty, w, { size, ls: 4, a: 'middle', rot: a });
}).join('');
S('Controls', 'sel-safe-semi-auto', 'Safe / Semi / Auto', 1024, 420,
  arcWords(512, 520, 380, ['SAFE', 'SEMI', 'AUTO'], -55, 55, 96) + path('M240.1 393.2A300 300 0 0 1 783.9 393.2', { fill: 'none', stroke: W, sw: 12 }),
  { tags: ['safe', 'semi', 'auto'], notes: 'Selector words on an arc round the lever pivot (below the art).' });
const pict = (n, x, s) => {
  let out = box(x, 20, s, s * 1.5, { sw: 10, r: 14 });
  const bw = s * 0.16, bh = s * 0.6;
  if (n === 0) out += bullet(x + s / 2 - bw / 2, 60, bw, bh) + ln(x + 30, s * 1.5 - 20, x + s - 30, 60, 14);
  else {
    const rows = n > 3 ? 2 : 1, per = Math.ceil(n / rows), gap = (s - 40) / per;
    for (let i = 0; i < n; i++) { const r = Math.floor(i / per), c = i % per; out += bullet(x + 20 + gap * c + (gap - bw) / 2, 60 + r * (bh * 0.75 + 10), bw, rows > 1 ? bh * 0.72 : bh); }
  }
  return out;
};
S('Controls', 'sel-pictogram', 'Bullet Selector', 1024, 380,
  pict(0, 20, 220) + pict(1, 270, 220) + pict(3, 520, 220) + pict(6, 770, 220),
  { tags: ['pictogram', 'burst'], notes: 'Pictogram selector: safe, single, burst, automatic.' });
S('Controls', 'sel-sef', 'S · E · F', 1024, 240,
  ['S', 'E', 'F'].map((c, i) => T(150 + i * 362, 170, c, { size: 190, a: 'middle' }) + (i < 2 ? ln(250 + i * 362, 108, 412 + i * 362, 108, 10) : '')).join(''),
  { notes: 'Letter selector: safe, single, fire.' });
S('Controls', 'sel-fire-safe', 'Fire / Safe Dots', 512, 512,
  T(40, 210, 'F', { size: 230 }) + circ(380, 136, 78, { fill: R }) + T(40, 470, 'S', { size: 230 }) + circ(380, 396, 78, { fill: W }),
  { own: true, tags: ['red dot'], notes: 'Painted-fill selector: red dot fire, white dot safe.' });
S('Controls', 'sight-elevation', 'Elevation Ladder', 256, 1024,
  T(128, 70, '×100', { f: 'BB', size: 56, a: 'middle' }) + ln(70, 110, 70, 990, 10) +
  Array.from({ length: 8 }, (_, i) => { const y = 980 - i * 120; return ln(70, y, 130, y, 10) + T(150, y + 24, i + 1, { f: 'BB', size: 70 }) + (i < 7 ? ln(70, y - 60, 104, y - 60, 6) : ''); }).join(''),
  { size: 3, tags: ['sight', 'elevation'], notes: 'Rear sight elevation scale, 100 to 800 m.' });
S('Controls', 'sight-windage', 'Windage Scale', 1024, 260,
  T(30, 150, 'L', { size: 150 }) + T(994, 150, 'R', { size: 150, a: 'end' }) + arrow(190, 100, 90, 60, 180) + arrow(834, 100, 90, 60) +
  Array.from({ length: 11 }, (_, i) => ln(262 + i * 50, i === 5 ? 30 : 60, 262 + i * 50, 150, i === 5 ? 12 : 7)).join('') +
  T(512, 236, '1 CLICK = ½ MOA', { f: 'BB', size: 54, ls: 8, a: 'middle' }), { tags: ['sight', 'windage'], notes: 'Windage drum scale with click value.' });
S('Controls', 'sight-up', 'UP Arrow Drum', 512, 512,
  at(26, 26, 460, I.rotate(true)) + T(256, 320, 'UP', { size: 170, a: 'middle' }),
  { size: 4, tags: ['sight'], notes: 'Turret direction: turn this way to raise impact.' });
S('Controls', 'ctrl-push', 'PUSH Arrow', 512, 220,
  T(20, 150, 'PUSH', { size: 150, ls: 4 }) + arrow(420, 98, 150, 110), { size: 4, notes: 'Push-button / takedown pin direction.' });
S('Controls', 'ctrl-mag', 'MAG Release', 512, 260,
  T(30, 180, 'MAG', { size: 180, ls: 4 }) + arrow(426, 130, 200, 120, 90), { size: 4, notes: 'Magazine release marking.' });
S('Controls', 'ctrl-takedown', 'Lock / Open', 1024, 300,
  at(20, 30, 220, I.lock(false)) + at(784, 30, 220, I.lock(true)) + arrow(512, 130, 440, 70, 180) + arrow(512, 130, 440, 70, 0) +
  T(130, 290, 'LOCK', { f: 'BB', size: 60, ls: 8, a: 'middle' }) + T(894, 290, 'OPEN', { f: 'BB', size: 60, ls: 8, a: 'middle' }),
  { notes: 'Takedown lever: padlock closed / open.' });
S('Controls', 'ctrl-rotate', 'Tighten / Loosen', 1024, 420,
  at(30, 20, 300, I.rotate(true)) + at(694, 20, 300, I.rotate(false)) + T(180, 400, 'TIGHTEN', { f: 'BB', size: 70, ls: 6, a: 'middle' }) + T(844, 400, 'LOOSEN', { f: 'BB', size: 70, ls: 6, a: 'middle' }),
  { notes: 'Barrel nut, muzzle device or suppressor mount direction.' });
S('Controls', 'ctrl-charge', 'Pull to Charge', 1024, 220,
  arrow(170, 110, 300, 110, 180) + T(360, 148, 'PULL TO CHARGE', { size: 110, ls: 4, max: 650 }), { size: 9, notes: 'Charging handle direction.' });

// Proof: proof, inspection and acceptance stamps (tiny, struck into the metal)
S('Proof', 'proof-star', 'Star Proof', 512, 512, circ(256, 256, 226, { sw: 30 }) + star(256, 268, 170, 68), { notes: 'Proof-house star in a ring.' });
const hexAt = (r) => Array.from({ length: 6 }, (_, i) => { const a = (i * Math.PI) / 3 - Math.PI / 2; return [+(256 + r * Math.cos(a)).toFixed(1), +(256 + r * Math.sin(a)).toFixed(1)]; });
S('Proof', 'proof-arcane-sigil', 'Arcane Proof Sigil', 512, 512,
  path(`M${hexAt(230).map((p) => p.join(' ')).join('L')}Z`, { fill: 'none', stroke: W, sw: 26, join: 'round' }) +
  hexAt(176).map(([x, y]) => circ(x, y, 14)).join('') + at(150, 150, 212, I.arcane()),
  { tags: ['arcane'], notes: 'Arcane Arms proof house: the slash in a hex with its six seals.' });
S('Proof', 'proof-arrows', 'Crossed Arrows', 512, 512,
  path('M256 20L470 90V250C470 380 370 470 256 496C142 470 42 380 42 250V90Z', { fill: 'none', stroke: W, sw: 26 }) +
  [-38, 38].map((a) => `<g transform="rotate(${a} 256 270)">${ln(256, 80, 256, 440, 22)}${poly([[256, 60], [292, 130], [220, 130]])}${poly([[226, 400], [256, 440], [286, 400], [286, 450], [256, 470], [226, 450]])}</g>`).join(''),
  { notes: 'Shield with crossed arrows: final proof.' });
S('Proof', 'proof-hp', 'HP Oval', 512, 320, `<ellipse cx="256" cy="160" rx="234" ry="138" fill="none" stroke="${W}" stroke-width="26"/>` + T(256, 236, 'HP', { size: 230, ls: 6, a: 'middle' }), { notes: 'High-pressure tested.' });
S('Proof', 'proof-mp', 'MP Circle', 512, 512, circ(256, 256, 226, { sw: 30 }) + T(256, 340, 'MP', { size: 250, a: 'middle' }), { notes: 'Magnetic-particle inspected.' });
S('Proof', 'proof-inspector', 'Inspector 07', 512, 512,
  circ(256, 256, 230, { sw: 24 }) + T(256, 222, 'QC', { size: 170, a: 'middle' }) + ln(80, 262, 432, 262, 16) + T(256, 420, '07', { f: 'M', size: 170, a: 'middle' }),
  { notes: 'Inspector\'s personal acceptance stamp.' });
S('Proof', 'proof-acc', 'Accepted', 640, 360,
  box(16, 16, 608, 328, { sw: 24, r: 40 }) + T(320, 190, 'ACC', { size: 170, ls: 16, a: 'middle' }) + T(320, 300, 'A.R.  26', { f: 'M', size: 82, ls: 6, a: 'middle' }),
  { size: 3, notes: 'Acceptance stamp with inspector initials and year.' });
S('Proof', 'proof-date', 'Date Wheel', 512, 512,
  circ(256, 256, 230, { sw: 20 }) + Array.from({ length: 12 }, (_, i) => { const a = (i * Math.PI) / 6 - Math.PI / 2; return circ(256 + 180 * Math.cos(a), 256 + 180 * Math.sin(a), i === 2 ? 0 : 16); }).join('') +
  arrow(256 + 80 * Math.cos(-Math.PI / 6), 256 + 80 * Math.sin(-Math.PI / 6), 180, 60, -30) + T(256, 330, '26', { f: 'M', size: 110, a: 'middle' }),
  { tags: ['date code'], notes: 'Moulded date clock: year in the middle, the arrow on the month (March).' });
S('Proof', 'proof-ordnance', 'Flaming Bomb', 512, 512, at(16, 6, 480, I.bomb()), { notes: 'Flaming bomb: ordnance acceptance.' });
S('Proof', 'proof-triangle', 'P Triangle', 512, 480, path('M256 24L490 456H22Z', { fill: 'none', stroke: W, sw: 30, join: 'round' }) + T(256, 410, 'P', { size: 270, a: 'middle' }), { notes: 'Definitive proof in a triangle.' });
S('Proof', 'proof-shield', 'V Shield', 512, 512,
  path('M256 24L470 92V250C470 380 370 468 256 492C142 468 42 380 42 250V92Z', { fill: 'none', stroke: W, sw: 28 }) + T(256, 370, 'V', { size: 300, a: 'middle' }), { notes: 'Viewed (visually inspected).' });
S('Proof', 'proof-strip', 'Proof Strip', 1024, 200,
  circ(100, 100, 82, { sw: 14 }) + star(100, 106, 60, 24) +
  `<ellipse cx="290" cy="100" rx="88" ry="62" fill="none" stroke="${W}" stroke-width="12"/>` + T(290, 136, 'HP', { size: 100, a: 'middle' }) +
  circ(480, 100, 82, { sw: 14 }) + T(480, 140, 'MP', { size: 104, a: 'middle' }) +
  path('M670 22L760 178H580Z', { fill: 'none', stroke: W, sw: 14, join: 'round' }) + T(670, 166, 'P', { size: 100, a: 'middle' }) +
  T(900, 140, '26', { f: 'M', size: 120, a: 'middle' }), { size: 7, notes: 'The usual row of proof marks under a barrel.' });
S('Proof', 'proof-test-fired', 'Test Fired', 1024, 320,
  box(10, 10, 1004, 300, { sw: 12, r: 12 }) + box(34, 34, 956, 252, { sw: 5, r: 6 }) + T(512, 172, 'TEST FIRED', { size: 140, ls: 12, a: 'middle', max: 900 }) +
  T(512, 250, 'LOT 26-117   ·   RANGE 3', { f: 'M', size: 54, ls: 6, a: 'middle', max: 900 }), { size: 8, notes: 'Factory test-fire acceptance block.' });

// Part Stamps: part numbers and factory codes on components
S('Part Stamps', 'pn-rev', 'Part Number + Rev', 1024, 160,
  T(10, 116, 'P/N 7C-1105-04', { f: 'M', size: 104, ls: 4, max: 760 }) + box(798, 14, 214, 132, { sw: 8, r: 8 }) + T(905, 112, 'REV C', { f: 'BB', size: 84, a: 'middle', max: 190 }),
  { notes: 'Part number with a boxed revision letter.' });
S('Part Stamps', 'pn-cage', 'CAGE Code', 1024, 190,
  T(10, 78, 'CAGE 4K7R2', { f: 'BB', size: 84, ls: 8 }) + T(10, 170, 'P/N 1105-04   S/N 00417', { f: 'M', size: 66, ls: 4, max: 1000 }), { notes: 'Supplier code, part and serial.' });
S('Part Stamps', 'pn-nsn', 'NSN', 1024, 130, T(10, 100, 'NSN 1005-01-647-2210', { f: 'M', size: 92, ls: 4, max: 1000 }), { notes: 'Stock number line.' });
S('Part Stamps', 'pn-cast', 'Casting Number', 640, 300,
  T(20, 210, 'C-4415-A', { size: 190, ls: 6, max: 440 }) + circ(560, 150, 66, { sw: 12 }) + T(560, 190, '2', { f: 'BB', size: 110, a: 'middle' }),
  { size: 4, tags: ['casting', 'cavity'], notes: 'Casting number with the mould cavity in a circle.' });
S('Part Stamps', 'pn-material', 'Material + Hardness', 1024, 140, T(512, 108, '4140 HT  ·  RC 38–42', { f: 'BB', size: 108, ls: 6, a: 'middle', max: 1000 }), { notes: 'Steel grade and heat-treat hardness.' });
S('Part Stamps', 'pn-torque', 'Torque Spec', 1024, 260,
  at(10, 20, 220, I.hex()) + T(260, 130, 'TORQUE 35 IN-LB', { f: 'BB', size: 110, ls: 4, max: 750 }) + T(262, 220, 'BLUE THREADLOCKER  ·  DO NOT OVERTIGHTEN', { f: 'BB', size: 50, ls: 4, max: 750 }),
  { size: 8, tags: ['torque'], notes: 'Fastener torque spec with a hex head.' });
S('Part Stamps', 'pn-fwd', 'FWD Arrow', 512, 220, T(20, 160, 'FWD', { size: 170, ls: 6 }) + arrow(410, 100, 170, 120), { size: 4, notes: 'Install direction for rails, springs and handguards.' });
S('Part Stamps', 'pn-side-out', 'This Side Out', 1024, 240,
  arrow(80, 120, 150, 110, -90) + arrow(944, 120, 150, 110, -90) + T(512, 156, 'THIS SIDE OUT', { f: 'BB', size: 120, ls: 8, a: 'middle', max: 700 }), { notes: 'Orientation for a symmetric part.' });
S('Part Stamps', 'pn-lot-heat', 'Lot + Heat', 1024, 130, T(512, 98, 'LOT 26-117   HEAT 8842', { f: 'M', size: 84, ls: 4, a: 'middle', max: 1000 }), { notes: 'Traceability: production lot and steel heat.' });
S('Part Stamps', 'pn-date', 'Manufacture Date', 512, 200, T(256, 136, 'MFD 03/26', { f: 'M', size: 100, ls: 4, a: 'middle', max: 490 }), { size: 4, notes: 'Month and year of manufacture.' });
S('Part Stamps', 'pn-align', 'Index Marks', 1024, 240,
  poly([[120, 40], [200, 40], [160, 110]]) + poly([[824, 40], [904, 40], [864, 110]]) + ln(160, 130, 160, 210, 10) + ln(864, 130, 864, 210, 10) + T(512, 156, 'ALIGN', { f: 'BB', size: 120, ls: 30, a: 'middle' }),
  { tags: ['index'], notes: 'Index marks for timing a muzzle device or a two-part assembly.' });
S('Part Stamps', 'pn-assy', 'Assembly Number', 1024, 230,
  T(10, 112, 'ASSY 7C-2000', { f: 'BB', size: 120, ls: 6 }) + T(12, 206, 'SUB 3 OF 9   ·   ARCANE ARMS', { f: 'BB', size: 60, ls: 8, max: 1000 }), { notes: 'Assembly and sub-assembly number.' });

// Data Plates: printed and etched labels with fields
S('Data Plates', 'plate-unit', 'Unit Data Plate', 1024, 640,
  box(6, 6, 1012, 628, { sw: 6, r: 18 }) + T(44, 66, 'UNIT DATA', { f: 'M', size: 34, ls: 10 }) + T(42, 168, 'AS-2049-77-A', { size: 118, ls: 4, max: 940 }) +
  barcode(44, 206, 640, 104, 11) + matrix(770, 196, 210, 18, 3) + ln(44, 352, 980, 352, 4) +
  table(44, 410, [['MODEL', 'VX-09'], ['REV', 'A'], ['MFG', '2049-03-17'], ['SITE', 'A7']], { vx: 170, dy: 56, size: 36 }) +
  ln(580, 380, 580, 600, 4) + table(620, 410, [['ARCANE'], ['SYSTEMS'], ['DEFENSE'], ['HARDWARE']], { dy: 56, size: 36 }),
  { notes: 'Full unit plate: serial, barcode, data matrix and fields.' });
S('Data Plates', 'plate-uid', 'UID Label', 1024, 460,
  box(6, 6, 1012, 448, { sw: 6, r: 14 }) + matrix(36, 36, 388, 22, 41) + T(470, 100, 'UII', { size: 80, ls: 6 }) +
  table(470, 170, [['MFR', '4K7R2'], ['PN', '7C-1105'], ['SER', '00417'], ['', '']], { vx: 120, dy: 66, size: 44 }) + T(470, 410, 'D4K7R2 7C1105 00417', { f: 'M', size: 32, ls: 2, max: 520 }),
  { tags: ['uid', 'matrix'], notes: 'Unique-ID label: data matrix with its readable fields.' });
S('Data Plates', 'plate-weapon', 'Weapon Data Plate', 1024, 600,
  box(6, 6, 1012, 588, { sw: 6, r: 10 }) + knock(6, 6, 1012, 100, T(512, 80, 'WEAPON DATA', { size: 76, ls: 14, a: 'middle', fill: '#000' }), 10) +
  table(40, 172, [['NOMEN.', 'RIFLE, 5.56 MM, MOD 7'], ['NSN', '1005-01-647-2210'], ['SERIAL', 'A7-204917'], ['CONTRACT', 'ADF-26-C-0412'], ['MFR', 'ARCANE ARMS, NEW ARDEN']], { vx: 250, dy: 86, size: 44 }),
  { notes: 'Nomenclature plate with a solid header.' });
S('Data Plates', 'plate-barcode', 'Barcode Label', 1024, 300,
  barcode(30, 20, 964, 170, 5) + T(30, 260, 'SN 2049-77-A', { f: 'M', size: 70, ls: 8 }) + T(994, 260, 'ARCANE SYSTEMS', { f: 'BB', size: 44, ls: 8, a: 'end' }), { notes: 'Barcode with its serial.' });
S('Data Plates', 'plate-calibrated', 'Calibrated Sticker', 1024, 560,
  box(6, 6, 1012, 548, { sw: 6, r: 20 }) + knock(6, 6, 1012, 120, T(512, 92, 'CALIBRATED', { size: 92, ls: 18, a: 'middle', fill: '#000' }), 20) +
  ['DATE', 'DUE', 'BY', 'ID'].map((k, i) => T(50 + (i % 2) * 490, 236 + Math.floor(i / 2) * 150, k, { f: 'BB', size: 52, ls: 6 }) + ln(200 + (i % 2) * 490, 244 + Math.floor(i / 2) * 150, 470 + (i % 2) * 490, 244 + Math.floor(i / 2) * 150, 5)).join('') +
  T(512, 520, 'DO NOT USE AFTER DUE DATE', { f: 'BB', size: 40, ls: 10, a: 'middle' }), { size: 7, notes: 'Calibration label with blank fields.' });
S('Data Plates', 'plate-inspected', 'Inspection Tag', 1024, 560,
  box(6, 6, 1012, 548, { sw: 6, r: 10 }) + knock(6, 6, 1012, 110, T(512, 86, 'INSPECTED', { size: 86, ls: 18, a: 'middle', fill: '#000' }), 10) +
  ['VISUAL', 'FUNCTION', 'HEADSPACE', 'TRIGGER PULL'].map((k, i) => box(50 + (i % 2) * 480, 170 + Math.floor(i / 2) * 120, 60, 60, { sw: 6 }) + T(134 + (i % 2) * 480, 218 + Math.floor(i / 2) * 120, k, { f: 'BB', size: 52, ls: 4 })).join('') +
  T(50, 500, 'INSP. NO. 07', { f: 'M', size: 50, ls: 4 }) + T(974, 500, 'DATE ____', { f: 'M', size: 50, ls: 4, a: 'end' }), { size: 7, notes: 'Checklist tag for a finished weapon.' });
S('Data Plates', 'plate-power', 'Power Cell Plate', 1024, 640,
  box(6, 6, 1012, 628, { sw: 6, r: 18 }) + T(40, 100, 'POWER CELL', { size: 96, ls: 4 }) + T(40, 150, 'LITHIUM MODULE', { f: 'M', size: 38, ls: 8 }) + box(830, 40, 150, 76, { sw: 5, r: 6 }) + T(905, 94, 'PC-3', { f: 'BB', size: 52, a: 'middle' }) +
  stripes(40, 180, 944, 50, { a: W, b: 'none', step: 56 }) +
  table(40, 300, [['NOMINAL VOLTAGE', '28.8 V'], ['CAPACITY', '12.0 Ah'], ['MAX DISCHARGE', '120 A'], ['PART NO.', 'AS-PC-003'], ['REV', 'A']], { vx: 380, dy: 52, size: 34 }) +
  ln(680, 270, 680, 560, 4) + matrix(730, 280, 230, 18, 9) + T(845, 600, 'ARCANE SYSTEMS', { f: 'M', size: 28, ls: 4, a: 'middle' }),
  { notes: 'Battery or power module plate.' });
S('Data Plates', 'plate-scan', 'Scan for Service', 768, 840,
  box(6, 6, 756, 828, { sw: 6, r: 18 }) + matrix(84, 70, 600, 24, 23) + T(384, 744, 'SCAN FOR SERVICE', { size: 74, ls: 6, a: 'middle', max: 680 }) + T(384, 800, 'ID 7C-00417-A', { f: 'M', size: 40, ls: 6, a: 'middle' }),
  { size: 6, notes: 'Service matrix code with its ID.' });
S('Data Plates', 'plate-rating', 'Electrical Rating', 1024, 360,
  box(6, 6, 1012, 348, { sw: 6, r: 12 }) + T(40, 90, 'INPUT', { f: 'BB', size: 60, ls: 8 }) + T(984, 90, 'IP67', { size: 80, a: 'end' }) + ln(40, 120, 984, 120, 4) +
  table(40, 190, [['VOLTAGE', '24 VDC'], ['CURRENT', '6.5 A MAX'], ['TEMP', '−40 … +71 °C']], { vx: 280, dy: 60, size: 42 }) + at(800, 160, 170, I.ground()),
  { notes: 'Electrical rating plate with the ground symbol.' });
S('Data Plates', 'plate-micro', 'Micro Data Strip', 1024, 140,
  T(4, 34, 'SYS/7  ARC-0417  ▲  LOT 26-117', { f: 'M', size: 30, ls: 3 }) + barcode(4, 52, 760, 46, 19) + T(4, 132, 'CHK 9F3A  ◆  KEEP FREE OF SOLVENT', { f: 'M', size: 28, ls: 3, max: 760 }) + matrix(800, 18, 120, 14, 77) + T(1020, 132, '01', { f: 'M', size: 48, a: 'end' }),
  { size: 10, notes: 'Fine data strip for small flat faces.' });
S('Data Plates', 'plate-maint', 'Maintenance Record', 1024, 760,
  box(6, 6, 1012, 748, { sw: 6, r: 10 }) + knock(6, 6, 1012, 100, T(512, 78, 'MAINTENANCE RECORD', { size: 68, ls: 12, a: 'middle', fill: '#000' }), 10) +
  [['DATE', 40], ['ROUNDS', 280], ['ACTION', 520], ['INSP.', 840]].map(([k, x]) => T(x, 160, k, { f: 'BB', size: 46, ls: 6 })).join('') +
  Array.from({ length: 6 }, (_, i) => ln(30, 190 + i * 92, 994, 190 + i * 92, 4)).join('') + [260, 500, 820].map((x) => ln(x, 120, x, 650, 4)).join(''),
  { size: 9, notes: 'Blank service log grid for cases and stocks.' });
S('Data Plates', 'plate-prototype', 'Prototype Plate', 1024, 560,
  brackets(10, 10, 1004, 540, 50, 8) + T(60, 150, 'PROTOTYPE', { size: 150, ls: 6, max: 900 }) + T(64, 216, 'ENGINEERING SAMPLE  ·  NOT FOR ISSUE', { f: 'M', size: 38, ls: 6, max: 900 }) + ln(60, 256, 964, 256, 4) +
  table(60, 330, [['PART NO.', 'AS-PC-3108'], ['REV', 'B'], ['DATE', '2049-02-11']], { vx: 230, dy: 66, size: 40 }) + matrix(780, 290, 184, 16, 13),
  { notes: 'R&D sample plate with corner brackets.' });

// Ordnance: ammunition and explosive container stencils
S('Ordnance', 'ord-cartridges', 'Cartridges Crate', 1024, 460,
  T(512, 120, '1000 CARTRIDGES', { f: 'S', size: 110, ls: 6, a: 'middle', max: 1000 }) + T(512, 250, '5.56 MM BALL · LINKED', { f: 'S', size: 84, ls: 4, a: 'middle', max: 1000 }) +
  T(512, 380, 'LOT ARD-26-0117', { f: 'S', size: 76, ls: 8, a: 'middle', max: 1000 }), { notes: 'Ammo can / crate contents stencil.' });
const diamond = (top, mid, low) => path('M256 8L504 256L256 504L8 256Z', { fill: O }) + path('M256 36L476 256L256 476L36 256Z', { fill: 'none', stroke: K, sw: 10 }) +
  at(186, 72, 140, I.burst(K)) + T(256, 340, top, { size: 120, a: 'middle', fill: K }) + T(256, 400, mid, { size: 64, a: 'middle', fill: K }) + T(256, 462, low, { size: 46, a: 'middle', fill: K });
S('Ordnance', 'ord-div-14', 'Explosive 1.4S', 512, 512, diamond('1.4', 'S', '1'), { own: true, size: 10, tags: ['explosive', 'hazmat'], notes: 'Explosive hazard diamond, division 1.4, group S.' });
S('Ordnance', 'ord-div-11', 'Explosive 1.1D', 512, 512, diamond('1.1', 'D', '1'), { own: true, size: 10, tags: ['explosive', 'hazmat'], notes: 'Explosive hazard diamond, division 1.1, group D.' });
S('Ordnance', 'ord-he-band', 'HE Band', 1024, 260,
  solid(0, 20, 1024, 110, BAND) + T(512, 104, 'HIGH EXPLOSIVE', { f: 'S', size: 80, ls: 10, a: 'middle', fill: K, max: 980 }) + T(512, 226, 'HE-FRAG  ·  105 MM  ·  FUZE PD', { f: 'S', size: 60, ls: 4, a: 'middle', max: 1000 }),
  { own: true, tags: ['he', 'band'], notes: 'Yellow high-explosive band with the round under it.' });
S('Ordnance', 'ord-inert-band', 'Inert Band', 1024, 260,
  solid(0, 20, 1024, 110, BL) + T(512, 104, 'INERT', { f: 'S', size: 90, ls: 30, a: 'middle' }) + T(512, 226, 'TRAINING  ·  NO EXPLOSIVE FILL', { f: 'S', size: 60, ls: 4, a: 'middle', max: 1000 }),
  { own: true, tags: ['inert', 'training', 'band'], notes: 'Blue training band.' });
S('Ordnance', 'ord-grenade', 'Grenade Crate', 1024, 380,
  T(10, 100, 'GRENADE, HAND, FRAG', { f: 'S', size: 84, ls: 4, max: 1000 }) + T(10, 220, 'MOD 67  ·  DELAY 4.5 S', { f: 'S', size: 72, ls: 4, max: 1000 }) + T(10, 340, 'LOT ARD-26-B-0412', { f: 'S', size: 72, ls: 4, max: 1000 }),
  { notes: 'Grenade box contents stencil.' });
S('Ordnance', 'ord-weight', 'Weight / Cube', 1024, 330,
  T(20, 140, 'WT 34 LB', { f: 'S', size: 120, ls: 4, max: 980 }) + T(20, 300, 'CU 0.8 FT³', { f: 'S', size: 120, ls: 4, max: 980 }), { notes: 'Gross weight and volume.' });
S('Ordnance', 'ord-side-up', 'This Side Up', 512, 560,
  arrow(170, 210, 280, 150, -90) + arrow(342, 210, 280, 150, -90) + solid(60, 380, 392, 30) + T(256, 520, 'THIS SIDE UP', { f: 'S', size: 54, ls: 2, a: 'middle', max: 490 }),
  { size: 10, tags: ['handling'], notes: 'Two arrows over a bar.' });
S('Ordnance', 'ord-keep-dry', 'Keep Dry', 512, 560, at(56, 20, 400, I.umbrella()) + T(256, 520, 'KEEP DRY', { f: 'S', size: 70, ls: 4, a: 'middle' }), { size: 10, tags: ['handling'], notes: 'Umbrella: protect from rain.' });
S('Ordnance', 'ord-no-flame', 'No Open Flame', 512, 600,
  at(116, 60, 280, I.flame()) + circ(256, 210, 190, { sw: 34, stroke: R }) + ln(122, 76, 390, 344, 34, R) + T(256, 560, 'NO OPEN FLAME', { f: 'S', size: 56, ls: 2, a: 'middle', max: 490 }),
  { own: true, size: 10, tags: ['handling', 'fire'], notes: 'Prohibition: no flame near the store.' });
S('Ordnance', 'ord-lot', 'Lot Number', 1024, 180, T(512, 134, 'LOT ARD-26-B-0412', { f: 'S', size: 110, ls: 6, a: 'middle', max: 1000 }), { notes: 'Big lot stencil.' });
S('Ordnance', 'ord-rocket', 'Rocket Tube', 1024, 380,
  T(10, 100, 'ROCKET, 84 MM, HEAT', { f: 'S', size: 86, ls: 4, max: 1000 }) + T(10, 220, 'RANGE 400 M · ARM 10 M', { f: 'S', size: 72, ls: 4, max: 1000 }) +
  stripes(10, 270, 1004, 90, { step: 70 }), { own: true, notes: 'Launcher tube stencil with a hazard band.' });

// Military: equipment and vehicle stencils
S('Military', 'mil-bumper', 'Bumper Code', 1024, 220, T(20, 160, '3-7 IN', { f: 'S', size: 150, ls: 6 }) + T(1004, 160, 'A-12', { f: 'S', size: 150, ls: 6, a: 'end' }), { notes: 'Unit / vehicle bumper number.' });
S('Military', 'mil-tac-infantry', 'Infantry Symbol', 768, 640,
  ln(330, 30, 330, 140, 22) + ln(438, 30, 438, 140, 22) + box(40, 180, 688, 420, { sw: 26 }) + ln(40, 180, 728, 600, 22) + ln(728, 180, 40, 600, 22),
  { tags: ['tactical', 'symbol'], notes: 'Tactical map symbol: infantry, battalion (II).' });
S('Military', 'mil-tac-armor', 'Armour Symbol', 768, 640,
  ln(276, 30, 276, 140, 22) + ln(384, 30, 384, 140, 22) + ln(492, 30, 492, 140, 22) + box(40, 180, 688, 420, { sw: 26 }) + box(170, 300, 428, 180, { sw: 22, r: 90 }),
  { tags: ['tactical', 'symbol'], notes: 'Tactical map symbol: armour, regiment (III).' });
S('Military', 'mil-chevron', 'Recognition Chevron', 1024, 560, poly([[20, 20], [240, 20], [512, 360], [784, 20], [1004, 20], [512, 540]]), { notes: 'Inverted V identification chevron.' });
S('Military', 'mil-callsign', 'Call Sign', 1024, 220, T(512, 166, 'VIPER 2-1', { f: 'S', size: 160, ls: 8, a: 'middle', max: 1000 }), { notes: 'Call-sign stencil.' });
S('Military', 'mil-rank', 'Rank Chevrons', 512, 512,
  [0, 1, 2].map((i) => poly([[30, 210 + i * 110], [256, 40 + i * 110], [482, 210 + i * 110], [482, 290 + i * 110], [256, 120 + i * 110], [30, 290 + i * 110]])).join(''),
  { size: 6, tags: ['rank'], notes: 'Three stacked rank chevrons.' });
S('Military', 'mil-crest', 'Recon Crest', 768, 1024,
  path('M384 120L640 200V470C640 690 500 800 384 850C268 800 128 690 128 470V200Z', { fill: 'none', stroke: W, sw: 26 }) +
  [1, -1].map((s) => `<g transform="translate(384 0) scale(${s} 1) translate(-384 0)">${[0, 1, 2, 3].map((i) => poly([[400, 400 + i * 46], [730 - i * 40, 330 + i * 56], [700 - i * 46, 372 + i * 56], [400, 436 + i * 46]])).join('')}</g>`).join('') +
  poly([[384, 220], [410, 300], [400, 720], [384, 760], [368, 720], [358, 300]]) + solid(320, 640, 128, 20) +
  path('M40 880H728L690 940L728 1000H40L78 940Z', { fill: W }) + T(384, 966, '7TH RECON', { f: 'S', size: 72, ls: 8, a: 'middle', fill: K }) + star(384, 60, 46, 18),
  { own: true, size: 10, tags: ['insignia', 'crest', 'wings'], notes: 'Unit crest: shield, wings and blade, with a banner.' });
S('Military', 'mil-fuel', 'Fuel Stencil', 1024, 400,
  box(10, 10, 1004, 380, { sw: 10 }) + T(512, 210, 'JP-8', { f: 'S', size: 200, ls: 12, a: 'middle' }) + T(512, 330, 'FUEL ONLY  ·  35 GAL', { f: 'S', size: 66, ls: 4, a: 'middle', max: 940 }),
  { size: 14, notes: 'Fuel filler marking.' });
S('Military', 'mil-tiedown', 'Tiedown', 640, 420, circ(320, 140, 100, { sw: 30 }) + solid(270, 230, 100, 40) + T(320, 390, 'TIEDOWN', { f: 'S', size: 96, ls: 4, a: 'middle', max: 620 }), { size: 8, notes: 'Lashing point marking.' });
S('Military', 'mil-rescue', 'Rescue / Cut Here', 1024, 560,
  T(20, 120, 'RESCUE', { f: 'S', size: 120, ls: 8 }) + arrow(800, 80, 300, 100) +
  `<rect x="20" y="180" width="984" height="360" fill="none" stroke="${W}" stroke-width="14" stroke-dasharray="60 30"/>` + T(512, 400, 'CUT HERE', { f: 'S', size: 120, ls: 12, a: 'middle', max: 900 }),
  { notes: 'Emergency cut-in panel.' });
S('Military', 'mil-star', 'Star in Ring', 768, 768, circ(384, 384, 350, { sw: 44 }) + star(384, 400, 300, 116), { size: 14, tags: ['insignia'], notes: 'Five-point star in a ring.' });
S('Military', 'mil-reg', 'Registration Number', 1024, 200, T(512, 150, 'REG. 4K 22 17', { f: 'S', size: 140, ls: 6, a: 'middle', max: 1000 }), { notes: 'Equipment registration stencil.' });
S('Military', 'mil-no-step', 'No Step', 1024, 240, T(512, 150, 'NO STEP', { f: 'S', size: 160, ls: 16, a: 'middle', max: 1000 }) + solid(40, 196, 944, 16), { notes: 'Walkway warning.' });
S('Military', 'mil-lift', 'Lift Here', 1024, 240, arrow(90, 110, 160, 120, 90) + arrow(934, 110, 160, 120, 90) + T(512, 156, 'LIFT HERE', { f: 'S', size: 130, ls: 8, a: 'middle', max: 680 }), { notes: 'Lifting point with down arrows.' });

// Industrial: safety signs (coloured) and mono hazard marks
S('Industrial', 'ind-high-voltage', 'High Voltage', 512, 512, warnSign(I.bolt), { own: true, tags: ['electric'], notes: 'Warning: electricity.' });
S('Industrial', 'ind-pinch', 'Pinch Point', 512, 512, warnSign(I.pinch), { own: true, tags: ['crush'], notes: 'Warning: crushing between rollers.' });
S('Industrial', 'ind-hot', 'Hot Surface', 512, 512, warnSign(I.hot), { own: true, tags: ['heat'], notes: 'Warning: hot surface.' });
S('Industrial', 'ind-rotating', 'Rotating Parts', 512, 512, warnSign(I.gears), { own: true, tags: ['gears'], notes: 'Warning: entanglement in gears.' });
S('Industrial', 'ind-pressure', 'Pressurised', 512, 512, warnSign(I.vessel), { own: true, tags: ['pressure'], notes: 'Warning: pressurised vessel.' });
S('Industrial', 'ind-laser', 'Laser', 512, 512, warnSign(I.laser), { own: true, tags: ['laser'], notes: 'Warning: laser beam.' });
S('Industrial', 'ind-radiation', 'Radiation', 512, 512, warnSign(I.trefoil), { own: true, tags: ['radiation'], notes: 'Warning: radioactive material.' });
S('Industrial', 'ind-explosive', 'Explosive', 512, 512, warnSign(I.burst), { own: true, tags: ['explosive'], notes: 'Warning: explosive material.' });
S('Industrial', 'ind-eye', 'Eye Protection', 512, 512, circ(256, 256, 248, { fill: BL }) + at(76, 76, 360, I.eye()), { own: true, tags: ['mandatory', 'ppe'], notes: 'Mandatory: wear eye protection.' });
S('Industrial', 'ind-ground', 'Ground', 512, 512, circ(256, 256, 226, { sw: 26 }) + at(106, 100, 300, I.ground()), { tags: ['electric', 'earth'], notes: 'Protective earth terminal.' });
const banner = (word, color, ink, lines) => solid(0, 0, 1024, 512, W, 22) + solid(12, 12, 1000, 150, color, 14) +
  T(512, 122, `⚠ ${word}`, { size: 118, ls: 12, a: 'middle', fill: ink }) + lines.map((l, i) => T(512, 280 + i * 120, l, { size: 100, ls: 4, a: 'middle', fill: K, max: 960 })).join('');
S('Industrial', 'ind-danger', 'Danger Sign', 1024, 512, banner('DANGER', R, W, ['HIGH VOLTAGE', 'KEEP OUT']), { own: true, size: 14, tags: ['danger', 'banner'], notes: 'Header sign: DANGER.' });
S('Industrial', 'ind-warning', 'Warning Sign', 1024, 512, banner('WARNING', O, K, ['MOVING PARTS', 'CAN CRUSH AND CUT']), { own: true, size: 14, tags: ['warning', 'banner'], notes: 'Header sign: WARNING.' });
S('Industrial', 'ind-caution', 'Caution Sign', 1024, 512, banner('CAUTION', Y, K, ['HOT SURFACE', 'DO NOT TOUCH']), { own: true, size: 14, tags: ['caution', 'banner'], notes: 'Header sign: CAUTION.' });
S('Industrial', 'ind-stripes', 'Hazard Stripes', 1024, 160, stripes(0, 0, 1024, 160, { step: 112 }), { own: true, size: 24, tags: ['stripes'], notes: 'Yellow and black hazard band.' });
S('Industrial', 'ind-stripes-mono', 'Hazard Stripes (one ink)', 1024, 160, stripes(0, 0, 1024, 160, { a: W, b: 'none', step: 112 }), { size: 24, tags: ['stripes'], notes: 'Stripes in one ink: paint them any colour.' });
S('Industrial', 'ind-lift-point', 'Lift Point', 512, 600, at(96, 10, 320, I.hook()) + T(256, 450, 'LIFT POINT', { f: 'BB', size: 86, ls: 6, a: 'middle', max: 490 }) + T(256, 550, 'WLL 500 KG', { f: 'M', size: 62, ls: 4, a: 'middle' }),
  { tags: ['lifting'], notes: 'Crane lifting point with its working load limit.' });
S('Industrial', 'ind-lockout', 'Lockout', 1024, 380,
  at(20, 40, 300, I.lock(false)) + T(360, 150, 'LOCK OUT', { f: 'BB', size: 120, ls: 6, max: 640 }) + T(360, 250, 'TAG OUT', { f: 'BB', size: 92, ls: 6, max: 640 }) + T(362, 330, 'BEFORE SERVICING', { f: 'M', size: 48, ls: 6, max: 640 }),
  { size: 12, tags: ['lockout'], notes: 'Lockout / tagout reminder.' });

// ---------- render ----------
const page = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s.width}" height="${s.height}" viewBox="0 0 ${s.width} ${s.height}">
<style>${[['S', 'AllertaStencil-Regular'], ['B', 'BarlowCondensed-ExtraBold'], ['BB', 'BarlowCondensed-Bold'], ['M', 'ShareTechMono-Regular']].map(([f, n]) => `@font-face{font-family:${f};src:url(${FONTS}/${n}.ttf)}`).join('')}</style>
${s.svg}
<script><![CDATA[document.fonts.ready.then(()=>{for(const t of document.querySelectorAll('text[data-max]')){const m=+t.getAttribute('data-max');if(t.getComputedTextLength()>m){t.setAttribute('textLength',m);t.setAttribute('lengthAdjust','spacingAndGlyphs')}}})]]></script></svg>`;

const run = (args) => new Promise((ok, no) => execFile(EDGE, args, { timeout: 60000 }, (e) => (e ? no(e) : ok())));
const only = process.argv[2];
const todo = stickers.filter((s) => !only || s.id.includes(only));
const tmp = mkdtempSync(join(tmpdir(), 'barista-stickers-'));
let next = 0;
await Promise.all(Array.from({ length: 6 }, async (_, w) => {
  while (next < todo.length) {
    const s = todo[next++], svg = join(tmp, `${s.id}.svg`);
    writeFileSync(svg, page(s));
    await run(['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${join(tmp, `p${w}`)}`, '--default-background-color=00000000',
      `--window-size=${s.width},${s.height}`, '--virtual-time-budget=3000', `--screenshot=${join(OUT, s.file)}`, pathToFileURL(svg).href]);
    process.stdout.write('.');
  }
}));
rmSync(tmp, { recursive: true, force: true });
if (!only) {
  const keep = new Set(stickers.map((s) => s.file));
  for (const f of readdirSync(OUT)) if (/\.(png|svg)$/.test(f) && !keep.has(f)) rmSync(join(OUT, f));
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify({ version: 2, source: 'Barista original stickers (tools/stickers.mjs)', license: 'CC0-1.0', decals: stickers.map(({ svg, ...s }) => s) }, null, 2) + '\n');
console.log(`\n${todo.length} stickers → ${OUT}`);
