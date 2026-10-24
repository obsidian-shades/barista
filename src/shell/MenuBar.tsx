import * as M from '@radix-ui/react-menubar';
import type { ReactNode } from 'react';
import {
  clearRecent, clearSeams, clearSelection, cutSelection, deselectPaint, displayChoices, exportFbx, exportObjParts, exportTextures, fillPaintSelection, setTexturePreset, flipSel, invertPaintSelection, invertSelection,
  loadShape, openProject, openRecent, saveProject, selectAllPaint, setDisplay, setTriangulate, pinSelected, unwrapSelected, pickFile, redo, repack, rotateSel, selectAll, selectEdgeLoop, selectLinked,
  stitchSelection, undo, undoPaint, redoPaint, unwrap, useApp, viewOp, pointer,
} from '../store';
import { Icon, Mark } from '../ui/Icon';

function Menu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <M.Menu>
      <M.Trigger className="mt">{label}</M.Trigger>
      <M.Portal>
        <M.Content className="mc" align="start" sideOffset={2}>{children}</M.Content>
      </M.Portal>
    </M.Menu>
  );
}
const Item = ({ onSelect, kbd, meta, disabled, children }: { onSelect: () => void; kbd?: string; meta?: string; disabled?: boolean; children: ReactNode }) => (
  <M.Item className="mi" disabled={disabled} onSelect={() => onSelect()}>{children}{meta && <span className="item-meta">{meta}</span>}{kbd && <kbd>{kbd}</kbd>}</M.Item>
);
const Sep = () => <M.Separator className="msep" />;
/** When a recent file was opened, short: "now", "5 min", "3 h", "2 d". */
function ago(t: number) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'now' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
}
export function MenuBar() {
  const has = useApp((s) => !!s.result), none = useApp((s) => !s.selected.length);
  const size = useApp((s) => (s.exportSize >= 1024 ? `${s.exportSize / 1024}K` : `${s.exportSize}`));
  const tri = useApp((s) => s.triangulate), workspace = useApp((s) => s.workspace), recent = useApp((s) => s.recent), shapes = useApp((s) => s.shapes);
  // subscribe to the one value the Display radio group shows, then read the same choices the Z pie and options bar use
  const display = useApp((s) => (s.workspace === 'doc' ? s.docView : s.workspace === 'paint' ? s.scene.lighting : s.mode));
  const choices = displayChoices();
  const doc = workspace === 'doc', paint = workspace === 'paint';
  const canUndo = useApp((s) => s.past.length > 0 || s.partsPast.length > 0), canRedo = useApp((s) => s.future.length > 0 || s.partsFuture.length > 0);
  return (
    <nav className="menubar">
      <Mark size={19} />
      <span className="brandname">Barista</span>
      <M.Root className="mroot">
        <Menu label="File">
          <Item onSelect={() => void openProject()}>Open project…</Item>
          <Item onSelect={() => void pickFile()} kbd="Ctrl+O">Open model…</Item>
          <M.Sub>
            <M.SubTrigger className="mi subtrigger">Open Recent<span className="subarrow" aria-hidden="true"><Icon name="chevron" size={12} /></span></M.SubTrigger>
            <M.Portal>
              <M.SubContent className="mc" sideOffset={4} alignOffset={-4}>
                {recent.length ? recent.map((r) => <Item key={r.name} onSelect={() => void openRecent(r.name)} meta={ago(r.time)}>{r.name}</Item>)
                  : <M.Item className="mi" disabled>No recent files</M.Item>}
                <Sep />
                <Item onSelect={() => void clearRecent()} disabled={!recent.length}>Clear Recent</Item>
              </M.SubContent>
            </M.Portal>
          </M.Sub>
          <Item onSelect={() => void openProject(undefined, true)}>Recover autosave…</Item>
          <Sep />
          <Item onSelect={() => void saveProject()} disabled={!has} kbd="Ctrl+S">Save project</Item>
          <Item onSelect={() => void saveProject(true)} disabled={!has} kbd="Ctrl+Shift+S">Save project as…</Item>
          <Sep />
          <M.Sub>
            <M.SubTrigger className="mi subtrigger">New from Shape<span className="subarrow" aria-hidden="true"><Icon name="chevron" size={12} /></span></M.SubTrigger>
            <M.Portal>
              <M.SubContent className="mc" sideOffset={4} alignOffset={-4}>
                {shapes.length ? shapes.map((s) => <Item key={s} onSelect={() => void loadShape(s)}>{s}</Item>) : <M.Item className="mi" disabled>No test shapes</M.Item>}
              </M.SubContent>
            </M.Portal>
          </M.Sub>
          <Sep />
          <M.Sub>
            <M.SubTrigger className="mi subtrigger">Export<span className="subarrow" aria-hidden="true"><Icon name="chevron" size={12} /></span></M.SubTrigger>
            <M.Portal>
              <M.SubContent className="mc" sideOffset={4} alignOffset={-4}>
                <Item onSelect={exportFbx} disabled={!has} kbd="Ctrl+Shift+E">FBX (Blender, Substance Painter)</Item>
                <Item onSelect={exportObjParts} disabled={!has}>OBJ per part (ZIP)</Item>
                <Sep />
                <Item onSelect={() => void exportTextures(true)} disabled={!has} meta={size}>Blender ready (FBX + textures)…</Item>
                {([['generic', 'Textures (PNG + ORM)…'], ['unreal', 'Textures for Unreal (DX normal, ORM)…'], ['unity-hdrp', 'Textures for Unity HDRP (MaskMap)…'],
                  ['unity-urp', 'Textures for Unity URP (Metallic/Smoothness)…']] as const).map(([preset, label]) =>
                  <Item key={preset} onSelect={() => { setTexturePreset(preset); void exportTextures(); }} disabled={!has} meta={size}>{label}</Item>)}
              </M.SubContent>
            </M.Portal>
          </M.Sub>
          <Sep />
          <M.CheckboxItem className="mi" checked={tri} onCheckedChange={(v) => setTriangulate(!!v)} onSelect={(e) => e.preventDefault()}>
            <M.ItemIndicator className="check">✓</M.ItemIndicator>Triangulate on export (for baking)
          </M.CheckboxItem>
        </Menu>
        <Menu label="Edit">
          {paint ? (
            <>
              <Item onSelect={undoPaint} disabled={!has} kbd="Ctrl+Z">Undo paint or selection</Item>
              <Item onSelect={redoPaint} disabled={!has} kbd="Ctrl+Shift+Z">Redo paint or selection</Item>
              <Sep />
              <Item onSelect={() => fillPaintSelection()} disabled={!has} kbd="Alt+Backspace">Fill selection</Item>
              <Item onSelect={() => fillPaintSelection(true)} disabled={!has} kbd="Delete">Clear selection</Item>
            </>
          ) : (
            <>
              <Item onSelect={undo} disabled={!canUndo} kbd="Ctrl+Z">{doc ? 'Undo mesh edit' : 'Undo UV or mesh edit'}</Item>
              <Item onSelect={redo} disabled={!canRedo} kbd="Ctrl+Shift+Z">{doc ? 'Redo mesh edit' : 'Redo UV or mesh edit'}</Item>
            </>
          )}
        </Menu>
        <Menu label="Select">
          {paint ? (
            <>
              <Item onSelect={selectAllPaint} kbd="Ctrl+A">All</Item>
              <Item onSelect={deselectPaint} kbd="Ctrl+D">None</Item>
              <Item onSelect={invertPaintSelection} kbd="Ctrl+Shift+I">Invert</Item>
            </>
          ) : (
            <>
              <Item onSelect={selectAll} disabled={!has} kbd="A">All</Item>
              <Item onSelect={clearSelection} disabled={none} kbd="Alt+A">None</Item>
              <Item onSelect={invertSelection} disabled={!has} kbd="Ctrl+I">Invert</Item>
              <Sep />
              <Item onSelect={selectLinked} disabled={none} kbd="Ctrl+L">Linked</Item>
              <Item onSelect={() => void selectEdgeLoop()} disabled={none} kbd="Alt+click">Edge loops</Item>
            </>
          )}
        </Menu>
        {!doc && !paint && (
          <>
            <Menu label="Edge">
              <Item onSelect={cutSelection} disabled={none} kbd="C">Cut (make a seam)</Item>
              <Item onSelect={stitchSelection} disabled={none} kbd="V">Stitch (join along it)</Item>
              <Item onSelect={() => void selectEdgeLoop()} disabled={none} kbd="Alt+click">Select edge loops</Item>
            </Menu>
            <Menu label="UV">
              <Item onSelect={() => rotateSel(90)} disabled={none}>Rotate 90°</Item>
              <Item onSelect={() => flipSel(true)} disabled={none} kbd="F">Flip left–right</Item>
              <Item onSelect={() => flipSel(false)} disabled={none} kbd="Shift+F">Flip up–down</Item>
              <Sep />
              <Item onSelect={() => pinSelected(true)} disabled={none} kbd="P">Pin</Item>
              <Item onSelect={() => pinSelected(false)} disabled={none} kbd="Alt+P">Unpin</Item>
              <Sep />
              <Item onSelect={() => void unwrapSelected()} disabled={none} kbd="U">Unwrap selection</Item>
            </Menu>
            <Menu label="Unwrap">
              <Item onSelect={unwrap} kbd="Ctrl+Enter">Auto unwrap (start over)</Item>
              <Item onSelect={repack} disabled={!has} kbd="Ctrl+P">Pack islands</Item>
              <Item onSelect={clearSeams}>Clear marked seams on active mesh</Item>
            </Menu>
          </>
        )}
        <Menu label="View">
          <M.Label className="mlabel">Display · Z</M.Label>
          <M.RadioGroup value={display} onValueChange={(v) => setDisplay(v)}>
            {choices.map((c) => (
              <M.RadioItem key={c.id} className="mi" value={c.id} title={c.title}>
                <M.ItemIndicator className="check">✓</M.ItemIndicator>
                {c.label}
              </M.RadioItem>
            ))}
          </M.RadioGroup>
          <Sep />
          <Item onSelect={() => viewOp(pointer.view, 'all')} kbd="Home">Frame all</Item>
          {!paint && <Item onSelect={() => viewOp(pointer.view, 'selected')} disabled={none} kbd="Space">Frame selected</Item>}
          <Item onSelect={() => viewOp('3d', 'front')} kbd="Numpad 1">Front</Item>
          <Item onSelect={() => viewOp('3d', 'right')} kbd="Numpad 3">Right</Item>
          <Item onSelect={() => viewOp('3d', 'top')} kbd="Numpad 7">Top</Item>
        </Menu>
      </M.Root>
    </nav>
  );
}
