// File › Export: one dialog for everything the editor writes. Textures go through the engine (full-size render into a
// folder it asks for); a model-only export downloads from the browser. The preset cards say exactly what each
// destination writes, because the labels alone ("Unreal (DX normal, ORM)") don't: engine/src/texture/mod.rs is the
// source of truth, mirrored in src/exporting.ts.
import { EXPORT_TARGETS, targetInfo } from '../exporting';
import { setIfAny } from '../paint';
import {
  closeExport, runExport, scopeIndices, setExportKind, setExportModel, setExportPadding, setExportScope, setExportSize, setExportTarget, setTriangulate,
  useApp, type ExportModel, type ExportScope, type ExportTarget,
} from '../store';

const SCOPES: [ExportScope, string][] = [['visible', 'Visible parts'], ['selected', 'Selected parts'], ['all', 'All parts']];
const SIZES = [1024, 2048, 4096, 8192, 16384];
const sizeLabel = (n: number) => (n >= 1024 ? `${n / 1024}K` : `${n}`);
const PAD = [4, 8, 16, 32, 64, 128];

export function ExportDialog() {
  const open = useApp((s) => s.exportOpen), kind = useApp((s) => s.exportKind), model = useApp((s) => s.exportModel);
  const scope = useApp((s) => s.exportScope), size = useApp((s) => s.exportSize), padding = useApp((s) => s.exportPadding);
  const preset = useApp((s) => s.texturePreset), fbx = useApp((s) => s.exportFbx), tri = useApp((s) => s.triangulate);
  const parts = useApp((s) => s.parts);
  useApp((s) => s.layerSel); useApp((s) => s.activePart); // scopeIndices reads them
  const src = useApp((s) => s.source), res = useApp((s) => s.textureResolution), has = useApp((s) => !!s.result), busy = useApp((s) => !!s.busy);
  const unit = useApp((s) => s.unit);
  useApp((s) => s.paintRev); // making a texture set changes how many parts the engine will render

  if (!open) return null;

  const target: ExportTarget = fbx ? 'blender' : preset, info = targetInfo(target);
  const idx = scopeIndices(scope), count = idx.length, textured = idx.filter((i) => setIfAny(parts[i].soup)).length;
  const base = (src ?? 'mesh').replace(/\.[^.]+$/, '');
  const autoPad = Math.max(4, Math.round(size / 64));
  const out = () => { closeExport(); runExport(); };
  const partsField = (
    <label>Parts
      <select value={scope} onChange={(e) => setExportScope(e.target.value as ExportScope)} aria-label="Which parts">
        {SCOPES.map(([v, label]) => <option key={v} value={v}>{label} ({scopeIndices(v).length})</option>)}
      </select>
    </label>
  );
  const triToggle = (
    <label className="toggle" title="Write the polygons as triangles. Do it before baking normal maps: a baker and a game engine may split a non-planar quad differently.">
      <input type="checkbox" checked={tri} onChange={(e) => setTriangulate(e.target.checked)} />Triangulate polygons on export (for baking)
    </label>
  );

  return (
    <div className="exp-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) closeExport(); }}>
      <div className="exp-dialog" role="dialog" aria-modal="true" aria-labelledby="exp-title">
        <header className="exp-head">
          <div>
            <h2 id="exp-title">Export</h2>
            <span className="hint">{src ?? 'Untitled'} · {parts.length} {parts.length === 1 ? 'part' : 'parts'} · {sizeLabel(res)} working paint</span>
          </div>
          <button className="exp-close" aria-label="Close" title="Close (Esc)" onClick={closeExport}>×</button>
        </header>
        <div className="exp-tabs" role="tablist" aria-label="What to export">
          <button role="tab" aria-selected={kind === 'textures'} onClick={() => setExportKind('textures')}>Textures</button>
          <button role="tab" aria-selected={kind === 'model'} onClick={() => setExportKind('model')}>Model</button>
        </div>

        {kind === 'textures' ? (
          <div className="exp-body">
            <div className="exp-presets" role="radiogroup" aria-label="Texture destination">
              {EXPORT_TARGETS.map((t) => (
                <button key={t.id} role="radio" aria-checked={target === t.id} className="exp-preset" onClick={() => setExportTarget(t.id)}>
                  <span className="exp-preset-head"><b>{t.label}</b><span className="target">{t.target}</span></span>
                  <span className="what">{t.summary}</span>
                </button>
              ))}
            </div>
            <p className="exp-detail">{info.detail}</p>
            <div className="exp-grid">
              <label>Resolution
                <select value={size} onChange={(e) => setExportSize(+e.target.value)} aria-label="Texture resolution">
                  {SIZES.map((n) => <option key={n} value={n}>{sizeLabel(n)} — {n}×{n}</option>)}
                </select>
              </label>
              {partsField}
              <label title="How far painted texels are carried out past each UV island, so mipmaps don't average in the empty texture. Auto follows the texture size.">Gutter
                <select value={padding} onChange={(e) => setExportPadding(+e.target.value)} aria-label="Gutter">
                  <option value={0}>Auto ({autoPad} px)</option>
                  {PAD.map((p) => <option key={p} value={p}>{p} px</option>)}
                </select>
              </label>
            </div>
            <div className="exp-files">
              <div className="caps">What gets written</div>
              <ul>
                {info.maps.map((m) => (
                  <li key={m.file}><span className="fn">{m.file}</span><span>{m.holds}{m.when ? ` · only when the set has ${m.when}` : ''}</span></li>
                ))}
                {target === 'blender' && <li><span className="fn">{base}.fbx</span><span>One material per part, its maps linked (Diffuse, Shininess, Reflection, NormalMap)</span></li>}
              </ul>
              <p className="hint">
                {textured} of {count} parts in scope have a texture set; the engine renders those, into a folder it asks for.
                Fills, decals and generators (AO, Edge Wear, Dirt) are drawn fresh at the export size; hand paint is scaled up
                from the {sizeLabel(res)} working resolution.
              </p>
            </div>
            {triToggle}
          </div>
        ) : (
          <div className="exp-body">
            <div className="exp-grid two">
              <div className="exp-field">Format
                <span className="seg3" role="radiogroup" aria-label="Model format">
                  {([['fbx', 'FBX'], ['obj', 'OBJ per part (ZIP)']] as [ExportModel, string][]).map(([v, label]) =>
                    <button key={v} role="radio" aria-checked={model === v} onClick={() => setExportModel(v)}>{label}</button>)}
                </span>
              </div>
              {partsField}
            </div>
            <p className="exp-detail">
              {model === 'fbx'
                ? 'One binary FBX with one material per part (per texture set with One atlas), its UVs and the file’s own normals. Blender and Substance Painter both read it.'
                : 'A ZIP with one OBJ per part, each naming its material. OBJ stores metres and has no materials, so textures must be wired by hand.'}
            </p>
            <div className="exp-files">
              <div className="caps">What gets written</div>
              <ul>
                <li><span className="fn">{model === 'fbx' ? `${base}-unwrapped.fbx` : `${base}-unwrapped-obj.zip`}</span>
                  <span>{model === 'fbx' ? 'one file, every part in scope' : 'one .obj per part, in scope'}</span></li>
              </ul>
              <p className="hint">Downloads in the browser. Parts that Poly Doc changed are unwrapped first. Units are written as {unit} (cm per unit).</p>
            </div>
            {triToggle}
          </div>
        )}

        <footer className="exp-foot">
          <span className="hint">{kind === 'textures' ? 'The engine asks for the folder after Export.' : 'Downloads in the browser.'}</span>
          <button onClick={closeExport}>Cancel</button>
          <button className="primary" disabled={!has || busy || count === 0 || (kind === 'textures' && textured === 0)} onClick={out}
            title={!has ? 'Open a model first' : count === 0 ? 'Nothing in scope to export' : kind === 'textures' && textured === 0 ? 'No part in scope has a texture set to render' : 'Export'}>
            {busy ? 'Busy…' : 'Export'}
          </button>
        </footer>
      </div>
    </div>
  );
}
