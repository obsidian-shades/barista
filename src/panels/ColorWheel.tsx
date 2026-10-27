// Van Gogh's colour panel, Affinity's / Krita's: a hue ring round a triangle whose tip is the pure hue and whose other
// corners are white and black (HSV: the tip–white edge is brightness 1, the black corner brightness 0). Drag the ring
// for hue, the triangle for saturation and brightness. Below: the swatch, the eyedropper, H S L, hex, and Flow.
import { useEffect, useRef, useState } from 'react';
import { setPaint, useApp } from '../store';
import { ICON } from '../ui/Icon';

const SIZE = 160, RING = 14;
type Hsv = [h: number, s: number, v: number];

export function hsvToRgb([h, s, v]: Hsv): [number, number, number] {
  const f = (n: number) => { const k = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); };
  return [f(5), f(3), f(1)];
}
export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255, d = max - min;
  let h = 0;
  if (d) h = max === r / 255 ? ((g - b) / 255 / d) % 6 : max === g / 255 ? (b - r) / 255 / d + 2 : (r - g) / 255 / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max];
}
const hexOf = (rgb: number[]) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
const rgbOf = (hex: string) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)) as [number, number, number];
/** H (°), S and L (%) as Affinity reads them out. */
function hsl([r, g, b]: number[]) {
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255, l = (max + min) / 2, d = max - min;
  return [Math.round(rgbToHsv(r, g, b)[0]), Math.round(d ? (d / (1 - Math.abs(2 * l - 1))) * 100 : 0), Math.round(l * 100)];
}

/** The triangle's corners for hue h: tip (the hue), white, black; hue runs clockwise from red at the right, as Affinity's. */
function corners(h: number) {
  const c = SIZE / 2, r = SIZE / 2 - RING - 6, a = (h * Math.PI) / 180;
  return [0, 2, 4].map((k) => [c + r * Math.cos(a + (k * Math.PI) / 3), c + r * Math.sin(a + (k * Math.PI) / 3)]) as [number, number][];
}
/** Barycentric weights of point p in the triangle (tip, white, black). */
function weights(t: [number, number][], [x, y]: [number, number]) {
  const [[ax, ay], [bx, by], [cx, cy]] = t, d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  const w0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d, w1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
  return [w0, w1, 1 - w0 - w1];
}

export function ColorWheel() {
  const color = useApp((s) => s.paint.color), flow = useApp((s) => s.paint.flow), tool = useApp((s) => s.paint.tool);
  // the hue is kept here too: a grey has none, and dragging to grey shouldn't throw the ring back to red
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(...rgbOf(color)));
  const [hex, setHex] = useState(color);
  const cv = useRef<HTMLCanvasElement>(null), drag = useRef<'ring' | 'tri' | null>(null), mine = useRef(color);
  // a colour set elsewhere (the eyedropper, the options bar) moves the wheel
  useEffect(() => {
    setHex(color);
    if (color === mine.current) return;
    mine.current = color;
    const [h, s, v] = rgbToHsv(...rgbOf(color));
    setHsv((o) => [s && v ? h : o[0], s, v]);
  }, [color]);
  const pick = (next: Hsv) => { setHsv(next); mine.current = hexOf(hsvToRgb(next)); setPaint({ color: mine.current }); };

  useEffect(() => {
    const el = cv.current!, dpr = devicePixelRatio, x = el.getContext('2d')!, c = SIZE / 2;
    el.width = el.height = SIZE * dpr;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, SIZE, SIZE);
    // the ring: hue at its canvas angle (clockwise from the right)
    const ring = x.createConicGradient(0, c, c);
    for (let k = 0; k <= 12; k++) ring.addColorStop(k / 12, `hsl(${k * 30} 100% 50%)`);
    x.beginPath(); x.arc(c, c, c - 1, 0, 2 * Math.PI); x.arc(c, c, c - 1 - RING, 0, 2 * Math.PI, true);
    x.fillStyle = ring; x.fill();
    // the triangle, texel by texel: tip · hue + white · 1
    const t = corners(hsv[0]), hue = hsvToRgb([hsv[0], 1, 1]), n = SIZE * dpr, img = x.getImageData(0, 0, n, n);
    for (let py = 0; py < n; py++) for (let px = 0; px < n; px++) {
      const [w0, w1, w2] = weights(t, [(px + 0.5) / dpr, (py + 0.5) / dpr]);
      if (w0 < -0.01 || w1 < -0.01 || w2 < -0.01) continue;
      const o = (py * n + px) * 4;
      for (let k = 0; k < 3; k++) img.data[o + k] = hue[k] * Math.max(0, w0) + 255 * Math.max(0, w1);
      img.data[o + 3] = 255 * Math.min(1, 1 + Math.min(w0, w1, w2) * 100);
    }
    x.putImageData(img, 0, 0);
    // markers: a ring at the hue, a circle at the colour (dark on light colours, light on dark)
    const a = (hsv[0] * Math.PI) / 180, rm = c - 1 - RING / 2, [s, v] = [hsv[1], hsv[2]];
    const mark = (mx: number, my: number, r: number, dark: boolean) => { x.beginPath(); x.arc(mx, my, r, 0, 2 * Math.PI); x.lineWidth = 2; x.strokeStyle = dark ? '#111' : '#fff'; x.stroke(); };
    mark(c + rm * Math.cos(a), c + rm * Math.sin(a), RING / 2 - 1, false);
    const w = [s * v, v * (1 - s), 1 - v];
    mark(w[0] * t[0][0] + w[1] * t[1][0] + w[2] * t[2][0], w[0] * t[0][1] + w[1] * t[1][1] + w[2] * t[2][1], 5, v > 0.6 && s < 0.5);
  }, [hsv]);

  const at = (e: React.PointerEvent): [number, number] => { const r = cv.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const move = (e: React.PointerEvent) => {
    const p = at(e), c = SIZE / 2;
    if (drag.current === 'ring') return pick([((Math.atan2(p[1] - c, p[0] - c) * 180) / Math.PI + 360) % 360, hsv[1], hsv[2]]);
    if (drag.current !== 'tri') return;
    // outside the triangle: the nearest point on it (weights clipped at 0)
    const w = weights(corners(hsv[0]), p).map((q) => Math.max(0, q)), sum = w[0] + w[1] + w[2] || 1, [w0, w1] = [w[0] / sum, w[1] / sum];
    const v = w0 + w1;
    pick([hsv[0], v ? w0 / v : 0, v]);
  };
  const down = (e: React.PointerEvent) => {
    const p = at(e), c = SIZE / 2, d = Math.hypot(p[0] - c, p[1] - c);
    drag.current = d > c - RING - 3 && d <= c ? 'ring' : Math.min(...weights(corners(hsv[0]), p)) > -0.05 ? 'tri' : null;
    if (!drag.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    move(e);
  };
  const rgb = rgbOf(color), [H, S, L] = hsl(rgb);
  const commitHex = () => { const h = hex.startsWith('#') ? hex : `#${hex}`; if (/^#[0-9a-f]{6}$/i.test(h)) setPaint({ color: h.toLowerCase() }); else setHex(color); };
  return (
    <div className="colorwheel">
      <div className="cwhead">
        <span className="caps">Color</span>
        <div className="cwtop">
          <span className="cwswatch" style={{ background: color }} title="The paint color" />
          <button aria-pressed={tool === 'picker'} title="Eyedropper: click the model or the texture to take its color (I)" aria-label="Eyedropper" onClick={() => setPaint({ tool: 'picker', pickMode: 'color' })}>
            {ICON.picker}
          </button>
        </div>
      </div>
      <canvas ref={cv} style={{ width: SIZE, height: SIZE }} onPointerDown={down} onPointerMove={(e) => drag.current && move(e)} onPointerUp={() => { drag.current = null; }}
        aria-label="Color wheel: drag the ring for hue, the triangle for saturation and brightness" />
      <div className="cwread">
        <span className="num">H: {H}<br />S: {S}<br />L: {L}</span>
        <label title="Hex color">#<input value={hex.replace('#', '').toUpperCase()} maxLength={7} spellCheck={false} onChange={(e) => setHex(e.target.value)} onBlur={commitHex} onKeyDown={(e) => e.key === 'Enter' && commitHex()} /></label>
      </div>
      <label className="cwflow" title="How much each dab lays down; strokes build up">Flow
        <input type="range" min={0.05} max={1} step={0.05} value={flow} onChange={(e) => setPaint({ flow: +e.target.value })} />
        <span className="num">{Math.round(flow * 100)} %</span>
      </label>
    </div>
  );
}
