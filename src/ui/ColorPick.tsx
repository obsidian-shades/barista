// The colour field everywhere but Van Gogh's wheel: a swatch that opens Photoshop's picker in a popover — a
// saturation / brightness square, a hue strip, hex, R G B and H S B fields, the screen eyedropper where the browser
// has one, and the recent colours (the store's `recentColors`, shared by every picker). The native <input type=color>
// opened the OS dialog: no hex field on most systems, and nothing like the rest of the app.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { hsvToRgb, rgbToHsv } from '../panels/ColorWheel';
import { rememberColor, useApp } from '../store';
import { ICON } from './Icon';

type Hsv = [number, number, number];
const hexOf = (rgb: number[]) => `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
const rgbOf = (hex: string) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) || 0) as [number, number, number];
/** "#abc", "abc", "AABBCC", "#aabbcc" → "#aabbcc", or null. */
export function parseHex(text: string) {
  let h = text.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/i.test(h) ? `#${h.toLowerCase()}` : null;
}

interface Props {
  value: string;
  /** Every move while picking (a drag of the square calls it many times). */
  onChange: (hex: string) => void;
  /** Before the first change of an opening (the editors' undo step: `beginPaintEdit`). */
  onStart?: () => void;
  /** The colour the popover closed on, when it changed. */
  onCommit?: (hex: string) => void;
  /** Presets shown above the recent colours (the scene's backdrops). */
  swatches?: string[];
  title?: string;
  label?: string;
}

export function ColorPick({ value, onChange, onStart, onCommit, swatches, title, label }: Props) {
  const [open, setOpen] = useState(false), btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={btn} type="button" className="cswatch" style={{ background: value }} title={title ?? `${value.toUpperCase()}: click to pick`}
        aria-label={label ?? 'Color'} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      {open && <Picker anchor={btn.current!} value={value} onChange={onChange} onStart={onStart} swatches={swatches}
        onClose={(changed) => { setOpen(false); if (changed) { rememberColor(changed); onCommit?.(changed); } }} />}
    </>
  );
}

const W = 220;
function Picker({ anchor, value, onChange, onStart, swatches, onClose }: Omit<Props, 'onCommit' | 'title' | 'label'> & { anchor: HTMLElement; onClose: (changed: string | null) => void }) {
  const recent = useApp((s) => s.recentColors);
  // the hue is kept here: a grey or black has none, and the strip mustn't jump back to red
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(...rgbOf(value)));
  const [hexText, setHexText] = useState(value.replace('#', '').toUpperCase());
  const first = useRef(value), started = useRef(false), last = useRef(value), box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<[number, number]>([-9999, 0]);

  useLayoutEffect(() => {
    // in the top layer (a popover), so it opens over the Scene popover and every other one; below the swatch, flipped
    // above or pulled in when the window edge is near
    box.current?.showPopover?.();
    const r = anchor.getBoundingClientRect(), h = box.current?.offsetHeight ?? 320;
    const x = Math.max(8, Math.min(innerWidth - W - 8, r.left)), y = r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - 6 - h) : r.bottom + 6;
    setAt([x, y]);
  }, [anchor]);
  useEffect(() => {
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); set(first.current); close(); }
      else if (e.key === 'Enter' && !(e.target instanceof HTMLInputElement)) close();
    };
    addEventListener('pointerdown', away, true); addEventListener('keydown', key, true);
    return () => { removeEventListener('pointerdown', away, true); removeEventListener('keydown', key, true); };
  });
  const close = () => onClose(last.current !== first.current ? last.current : null);

  /** A new colour: the editors hear it, the fields follow (`keepHue` from the square / strip, which know it). */
  const set = (hex: string, next?: Hsv) => {
    if (hex === last.current && !next) return;
    if (!started.current && hex !== first.current) { started.current = true; onStart?.(); }
    last.current = hex;
    setHexText(hex.replace('#', '').toUpperCase());
    setHsv((o) => { if (next) return next; const n = rgbToHsv(...rgbOf(hex)); return [n[1] && n[2] ? n[0] : o[0], n[1], n[2]]; });
    onChange(hex);
  };
  const pickHsv = (n: Hsv) => set(hexOf(hsvToRgb(n)), n);

  const drag = (el: HTMLElement, e: React.PointerEvent, to: (fx: number, fy: number) => void) => {
    const move = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      to(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
    };
    el.setPointerCapture(e.pointerId);
    move(e);
    el.onpointermove = (ev) => move(ev);
    el.onpointerup = () => { el.onpointermove = null; el.onpointerup = null; };
  };

  const rgb = hsvToRgb(hsv), cur = last.current, [r, g, b] = rgbOf(cur);
  const num = (v: number, max: number, put: (n: number) => void, name: string) => (
    <label>{name}<input className="num" type="number" min={0} max={max} value={Math.round(v)}
      onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) put(Math.max(0, Math.min(max, n))); }} /></label>
  );
  const dropper = 'EyeDropper' in window;
  const commitHex = () => { const h = parseHex(hexText); if (h) set(h); else setHexText(cur.replace('#', '').toUpperCase()); };
  const chips = [...new Set([...(swatches ?? []), ...recent])].slice(0, 16);

  return createPortal(
    <div ref={box} className="cpick" popover="manual" role="dialog" aria-label="Color picker" style={{ left: at[0], top: at[1], width: W }}>
      <div className="cpsv" style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv[0]} 100% 50%))` }}
        onPointerDown={(e) => drag(e.currentTarget, e, (fx, fy) => pickHsv([hsv[0], fx, 1 - fy]))}
        aria-label="Saturation and brightness: drag">
        <span className="cpdot" style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, borderColor: hsv[2] > 0.6 && hsv[1] < 0.5 ? '#111' : '#fff' }} />
      </div>
      <div className="cphue" onPointerDown={(e) => drag(e.currentTarget, e, (fx) => pickHsv([Math.min(359.9, fx * 360), hsv[1], hsv[2]]))} aria-label="Hue: drag">
        <span className="cpbar" style={{ left: `${(hsv[0] / 360) * 100}%` }} />
      </div>
      <div className="cprow">
        <span className="cpcmp" title="New / original (click the original to go back)">
          <span style={{ background: hexOf(rgb) }} />
          <span style={{ background: first.current }} onClick={() => set(first.current)} />
        </span>
        <label className="cphex" title="Hex: 6 or 3 digits">#<input value={hexText} maxLength={7} spellCheck={false}
          onChange={(e) => { setHexText(e.target.value); const h = parseHex(e.target.value); if (h && e.target.value.replace('#', '').length === 6) set(h); }}
          onBlur={commitHex} onKeyDown={(e) => { if (e.key === 'Enter') { commitHex(); close(); } }} onFocus={(e) => e.target.select()} /></label>
        {dropper && (
          <button type="button" title="Pick a color from anywhere on screen" aria-label="Eyedropper"
            onClick={async () => { try { const res = await new (window as unknown as { EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper().open(); const h = parseHex(res.sRGBHex); if (h) set(h); } catch { /* cancelled */ } }}>
            {ICON.picker}
          </button>
        )}
      </div>
      <div className="cpnums">
        {num(r, 255, (n) => set(hexOf([n, g, b])), 'R')}
        {num(g, 255, (n) => set(hexOf([r, n, b])), 'G')}
        {num(b, 255, (n) => set(hexOf([r, g, n])), 'B')}
        {num(hsv[0], 359, (n) => pickHsv([n, hsv[1], hsv[2]]), 'H')}
        {num(hsv[1] * 100, 100, (n) => pickHsv([hsv[0], n / 100, hsv[2]]), 'S')}
        {num(hsv[2] * 100, 100, (n) => pickHsv([hsv[0], hsv[1], n / 100]), 'B')}
      </div>
      {chips.length > 0 && (
        <div className="cpchips">{chips.map((c) => <button key={c} type="button" style={{ background: c }} title={c.toUpperCase()} aria-label={c} onClick={() => set(c)} />)}</div>
      )}
    </div>,
    document.body,
  );
}
