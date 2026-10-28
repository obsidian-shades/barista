// Viewport Shading, laid out like Blender's popover: Lighting (Studio / MatCap / Flat), the material view's two
// switches (Lift and Shadow), a collapsed lighting setup (map and its sliders), background, the display options and the
// overlays. The Display modes themselves live in the 3D view header, next to this, with Z and View › Display. It's a
// popover, so it sits above the view and closes on Esc or a click outside.
import { useEnvironment } from '@react-three/drei';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { MATCAPS, matcapCanvas } from '../shading';
import { HDRI_PRESETS, resetScene, setDocColor, setPaintLift, setSceneHdri, setSceneHdriPreset, updateScene, useApp, type Scene } from '../store';
import { ColorPick } from '../ui/ColorPick';
import { ICON } from '../ui/Icon';

/** Viewport backdrops: the app canvas, a few studio sweeps, and black. */
const BACKDROPS = ['#1a1c1f', '#2a2d31', '#3c4654', '#d8d4ce', '#eceae6', '#e6dfd4', '#111111'];

function place(pop: HTMLElement, btn: HTMLElement) {
  const r = btn.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  if (!w || !h) return;
  const left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8));
  const below = r.bottom + 4;
  pop.style.left = `${left}px`;
  pop.style.top = `${(below + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : below)}px`;
}

function Slider({ label, title, min, max, step, value, text, disabled, onChange }: {
  label: string; title: string; min: number; max: number; step: number; value: number; text: string; disabled?: boolean; onChange: (v: number) => void;
}) {
  return (
    <label title={title}>{label}
      <span>
        <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} aria-label={label} onChange={(e) => onChange(+e.target.value)} />
        <output className="num">{text}</output>
      </span>
    </label>
  );
}

/** A labelled on/off switch: the shape of every option here, so a setting takes one click and reads at a glance. */
function Switch({ label, title, checked, onChange, disabled }: { label: string; title: string; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <label className="switch" title={title}>
      <span>{label}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** Blender's full-width segmented buttons. */
function Seg<T extends string>({ value, options, onPick, titles, disabled }: { value: T; options: [T, string][]; onPick: (v: T) => void; titles?: Partial<Record<T, string>>; disabled?: Partial<Record<T, boolean>> }) {
  return (
    <div className="seg3" role="radiogroup">
      {options.map(([v, label]) => <button key={v} role="radio" aria-checked={value === v} disabled={disabled?.[v]} title={titles?.[v]} onClick={() => onPick(v)}>{label}</button>)}
    </div>
  );
}
const thumbs = new Map<string, string>();
const thumb = (id: string) => { let u = thumbs.get(id); if (!u) thumbs.set(id, u = matcapCanvas(id).toDataURL()); return u; };

export function SceneSettings() {
  const scene = useApp((s) => s.scene), menu = useApp((s) => s.menu);
  const doc = useApp((s) => s.workspace === 'doc'), docColor = useApp((s) => s.docColor);
  const [open, setOpen] = useState(false);
  const pop = useRef<HTMLDivElement>(null), btn = useRef<HTMLButtonElement>(null), file = useRef<HTMLInputElement>(null);
  const titleId = useId();
  // Van Gogh's Studio lights with its own plate when none is picked, so World is there too
  const paintWs = useApp((s) => s.workspace === 'paint');
  const map = !!scene.hdriUrl || (paintWs && scene.lighting === 'studio');
  // the material view has a sun shadow of its own instead of Blender's contact shadow
  const materialView = paintWs && scene.lighting === 'studio' && !scene.hdriUrl;
  // Van Gogh's material view (no plate) lights by its own plate and sun: the workspace lamps are off there, so their
  // sliders would only wash out UV Magician and Poly Doc, where they do apply
  const lamps = !(paintWs && !scene.hdriUrl);
  const lift = scene.paintLift ?? 0.4;
  const plate = scene.hdriName || (paintWs && scene.lighting === 'studio' ? 'Paint studio' : 'No map');

  useEffect(() => { if (open) for (const p of Object.values(HDRI_PRESETS)) useEnvironment.preload({ files: p.url }); }, [open]);
  useLayoutEffect(() => { if (open && pop.current && btn.current) place(pop.current, btn.current); }, [open, map]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || btn.current?.contains(t)) return;
      pop.current?.hidePopover();
      // A click in the 3D view only closes the panel; it does not also pick or clear a selection.
      if (t instanceof Element && t.closest('.vbody')) { e.preventDefault(); e.stopPropagation(); }
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') pop.current?.hidePopover(); };
    addEventListener('pointerdown', down, true);
    addEventListener('keydown', key);
    return () => { removeEventListener('pointerdown', down, true); removeEventListener('keydown', key); };
  }, [open]);
  // A pie or list at the pointer takes over; don't leave the popover floating above it.
  useEffect(() => { if (menu) pop.current?.hidePopover(); }, [menu]);

  const toggle = () => {
    const el = pop.current;
    if (!el) return;
    if (el.matches(':popover-open')) el.hidePopover();
    else { el.showPopover(); if (btn.current) place(el, btn.current); }
  };

  return (
    <>
      <button ref={btn} type="button" className="scene-btn" aria-expanded={open} aria-haspopup="dialog" title="Shading and viewport options" onClick={toggle}><span className="mico">{ICON.shading}</span>Shading</button>
      <div ref={pop} popover="manual" className="scene-pop" role="dialog" aria-labelledby={titleId}
        onToggle={(e) => setOpen(e.newState === 'open')}>
        <div className="scene-body">
          <div className="tsec"><span className="caps" id={titleId}>Lighting</span></div>
          <Seg value={scene.lighting} options={[['studio', 'Studio'], ['matcap', 'MatCap'], ['flat', 'Flat']]} onPick={(lighting) => updateScene({ lighting })}
            titles={{ studio: 'Lights and an environment map, as the model will be lit', matcap: 'A lit sphere the model takes its shading from by normal: reads shape at a glance', flat: 'Unlit: just the colors' }} />
          {scene.lighting === 'matcap' && (
            <div className="matcaps" role="radiogroup" aria-label="MatCap">
              {Object.entries(MATCAPS).map(([id, m]) => (
                <button key={id} role="radio" aria-checked={scene.matcap === id} title={m.label} onClick={() => updateScene({ matcap: id })}>
                  <img src={thumb(id)} alt={m.label} width={44} height={44} />
                </button>
              ))}
            </div>
          )}
          {scene.lighting === 'studio' && <>
            {paintWs && <>
              <div className="tsec"><span className="caps">Look</span></div>
              <Switch label="Lift" title="Work light: a second light opposite the key and a brighter environment, so both sides are lit and the texture reads everywhere. Off shows the true studio light." checked={lift > 0} onChange={(on) => setPaintLift(on ? 0.4 : 0)} />
              {materialView && <Switch label="Shadow" title="The key light’s shadow on the floor and between the parts. Off, the model is lit evenly with no ground shadow (Shift+right-drag turns the key)." checked={scene.paintShadow !== false} onChange={(paintShadow) => updateScene({ paintShadow })} />}
            </>}
            <details className="scene-adv">
              <summary><span>Lighting setup</span><em>{plate}</em></summary>
              <div className="settings">
                <label title="A studio plate lights the model. None puts the workspace lights back.">Map
                  <select aria-label="Environment map" value={scene.hdriId || 'none'} onChange={(e) => { const id = e.target.value; if (id !== 'custom') setSceneHdriPreset(id === 'none' ? '' : id); }}>
                    <option value="none">None</option>
                    {Object.entries(HDRI_PRESETS).map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
                    {scene.hdriId === 'custom' && <option value="custom">{scene.hdriName}</option>}
                  </select>
                </label>
                <Slider label="Strength" title="How strongly the environment lights the model." min={0} max={3} step={0.05} value={scene.hdriStrength} text={scene.hdriStrength.toFixed(2)} disabled={!map} onChange={(hdriStrength) => updateScene({ hdriStrength })} />
                <Slider label="Rotation" title="Turns the environment so its bright light sits on the front-left." min={-180} max={180} step={1} value={Math.round(scene.hdriRotation * 180 / Math.PI)} text={`${Math.round(scene.hdriRotation * 180 / Math.PI)}°`} disabled={!map} onChange={(deg) => updateScene({ hdriRotation: deg * Math.PI / 180 })} />
                <Slider label="Blur" title="Softens the backdrop. Higher hides a low-resolution plate and reads as a studio sweep." min={0} max={100} step={1} value={Math.round(scene.hdriBlur * 100)} text={`${Math.round(scene.hdriBlur * 100)}%`} disabled={!map} onChange={(pct) => updateScene({ hdriBlur: pct / 100 })} />
                <Slider label="Ambient" title="Fill from the sky and the ground. With an environment map this stays low, so the map does the lighting." min={0} max={10} step={0.05} value={scene.ambient} text={scene.ambient.toFixed(2)} disabled={!lamps} onChange={(ambient) => updateScene({ ambient })} />
                <Slider label="Key" title="The lamp on the front-left. With an environment map it shapes the subject; the map supplies the room." min={0} max={10} step={0.05} value={scene.key} text={scene.key.toFixed(2)} disabled={!lamps} onChange={(key) => updateScene({ key })} />
                <Slider label="Exposure" title="Camera exposure. Lower it when the highlights clip." min={0} max={5} step={0.05} value={scene.exposure} text={scene.exposure.toFixed(2)} onChange={(exposure) => updateScene({ exposure })} />
              </div>
              <button type="button" className="wide" onClick={() => file.current?.click()}>Load HDRI…</button>
            </details>
            <input ref={file} type="file" accept=".hdr,.exr" hidden onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ''; if (f) setSceneHdri(f); }} />
          </>}

          {/* UV Magician's Checker / Stretch / Islands lives in the UV view's Display menu, where it is used. Poly Doc's
              own colours stay here with the rest of its viewport shading. */}
          {doc && <>
            <div className="tsec"><span className="caps">Face color</span></div>
            <Seg value={docColor} options={[['single', 'Single'], ['random', 'Random']]}
              onPick={setDocColor}
              titles={{ single: 'One gray for every face', random: 'A color per part' }} />
          </>}

          <div className="tsec"><span className="caps">Background</span></div>
          <Seg value={scene.hdriBackground && map ? 'world' : scene.bg} options={[['theme', 'Theme'], ['world', 'World'], ['custom', 'Custom']]}
            disabled={{ world: !map || scene.lighting !== 'studio' }}
            onPick={(b) => updateScene(b === 'world' ? { hdriBackground: true } : { bg: b, hdriBackground: false })}
            titles={{ theme: 'The app’s own backdrop', world: 'The environment map behind the model (Studio lighting with a map)', custom: 'A color of your own' }} />
          {scene.bg === 'custom' && !(scene.hdriBackground && map) && (
            <div className="settings">
              <label>Color
                <ColorPick value={scene.background} onChange={(c) => updateScene({ background: c })} swatches={BACKDROPS} label="Background color" />
              </label>
            </div>
          )}

          <div className="tsec"><span className="caps">Options</span></div>
          <div className="scene-switches">
            <Switch label="Backface" title="Hide faces seen from behind: shows flipped normals as holes" checked={scene.backface} onChange={(backface) => updateScene({ backface })} />
            <Switch label="Outline" title="A 1 px line round each part’s silhouette. Unlike Wireframe, the surface itself stays clean." checked={scene.outline} onChange={(outline) => updateScene({ outline })} />
            <Switch label="Specular" title="Shiny highlights under Studio lighting" checked={scene.specular} disabled={scene.lighting !== 'studio'} onChange={(specular) => updateScene({ specular })} />
            <Switch label="X-Ray" title="See through the model" checked={scene.xray} onChange={(xray) => updateScene({ xray })} />
            {!materialView && <Switch label="Shadow" title="A soft contact shadow under the model" checked={scene.shadow} onChange={(shadow) => updateScene({ shadow })} />}
            <Switch label="Cavity" title="Darken creases and lighten edges from how the mesh bends: shape reads without lights" checked={scene.cavity} onChange={(cavity) => updateScene({ cavity })} />
          </div>
          {scene.xray && <div className="settings"><Slider label="Alpha" title="How solid the model stays in X-Ray" min={0} max={1} step={0.01} value={scene.xrayAlpha} text={scene.xrayAlpha.toFixed(2)} onChange={(xrayAlpha) => updateScene({ xrayAlpha })} /></div>}
          {!materialView && scene.shadow && <div className="settings"><Slider label="Amount" title="How dark the shadow is" min={0} max={1} step={0.01} value={scene.shadowAmount} text={scene.shadowAmount.toFixed(2)} onChange={(shadowAmount) => updateScene({ shadowAmount })} /></div>}
          {scene.cavity && <div className="settings">
            <Seg value={scene.cavityType} options={[['world', 'World'], ['screen', 'Screen'], ['both', 'Both']]} onPick={(cavityType) => updateScene({ cavityType })}
              titles={{ world: 'Soft darkening in grooves and corners, from the surfaces near each pixel (screen-space AO)', screen: 'Crisp light and dark lines on every edge, a pixel wide (Blender’s Screen Space curvature)', both: 'World and Screen together' }} />
            <Slider label="Ridge" title="How much edges brighten" min={0} max={2} step={0.01} value={scene.ridge} text={scene.ridge.toFixed(3)} onChange={(ridge) => updateScene({ ridge })} />
            <Slider label="Valley" title="How much creases darken" min={0} max={2} step={0.01} value={scene.valley} text={scene.valley.toFixed(3)} onChange={(valley) => updateScene({ valley })} />
            {scene.cavityType !== 'screen' && <Slider label="Distance" title="How far World cavity looks round each pixel, in halves of the model" min={0.01} max={1} step={0.01} value={scene.cavityDistance} text={scene.cavityDistance.toFixed(2)} onChange={(cavityDistance) => updateScene({ cavityDistance })} />}
          </div>}

          <div className="tsec"><span className="caps">Overlays</span></div>
          <div className="scene-switches">
            <Switch label="Wireframe" title="Draw every triangle edge: a wireframe, not the silhouette (that is Outline)." checked={scene.wireframe} onChange={(wireframe) => updateScene({ wireframe })} />
            <Switch label="Edges" title="Draw the polygon edges" checked={scene.showEdges} onChange={(showEdges) => updateScene({ showEdges })} />
            <Switch label="Vertices" title="Draw every vertex in vertex mode" checked={scene.showVertices} onChange={(showVertices) => updateScene({ showVertices })} />
            {!doc && <Switch label="Seams" title="Draw the UV seams on the model" checked={scene.showSeams} onChange={(showSeams) => updateScene({ showSeams })} />}
            <Switch label="Grid" title="The floor grid" checked={scene.showGrid} onChange={(showGrid) => updateScene({ showGrid })} />
            <Switch label="Axes" title="The world axes" checked={scene.showAxes} onChange={(showAxes) => updateScene({ showAxes })} />
          </div>
          <button type="button" className="wide" title="Lighting, lamps, map, background, options and overlays back to their defaults" onClick={resetScene}>Reset scene and lights</button>
        </div>
      </div>
    </>
  );
}
