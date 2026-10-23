import * as M from '@radix-ui/react-menubar';
import type { ReactNode } from 'react';
import logo from '../assets/logo.svg';
import {
  clearRecent, clearSeams, clearSelection, cutSelection, exportFbx, exportObjParts, openRecent, setTriangulate, flipSel, invertSelection, pinSelected, setLiveUnwrap, unwrapSelected, pickFile, redo, repack, rotateSel,
  selectAll, selectEdgeLoop, selectLinked, stitchSelection, undo, unwrap, useApp, viewOp, type Mode,
} from '../store';
import { SelectModes } from './Chrome';

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
const Item = ({ onSelect, kbd, disabled, children }: { onSelect: () => void; kbd?: string; disabled?: boolean; children: ReactNode }) => (
  <M.Item className="mi" disabled={disabled} onSelect={() => onSelect()}>{children}{kbd && <kbd>{kbd}</kbd>}</M.Item>
);
const Sep = () => <M.Separator className="msep" />;
/** When a recent file was opened, short: "now", "5 min", "3 h", "2 d". */
function ago(t: number) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'now' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
}
const MODES: [Mode, string][] = [['checker', 'Checker texture'], ['stretch', 'Stretch'], ['islands', 'Islands']];

export function MenuBar() {
  const mode = useApp((s) => s.mode), has = useApp((s) => !!s.result), none = useApp((s) => !s.selected.length);
  const live = useApp((s) => s.liveUnwrap), tri = useApp((s) => s.triangulate), doc = useApp((s) => s.workspace === 'doc'), recent = useApp((s) => s.recent);
  const canUndo = useApp((s) => s.past.length > 0 || s.partsPast.length > 0), canRedo = useApp((s) => s.future.length > 0 || s.partsFuture.length > 0);
  return (
    <nav className="menubar">
      <img className="brand" src={logo} alt="Barista" />
      <M.Root className="mroot">
        <Menu label="File">
          <Item onSelect={() => void pickFile()} kbd="Ctrl+O">Open model… (FBX, glTF, OBJ, STL)</Item>
          <M.Sub>
            <M.SubTrigger className="mi subtrigger">Open Recent<span className="subarrow" aria-hidden="true">{'›'}</span></M.SubTrigger>
            <M.Portal>
              <M.SubContent className="mc" sideOffset={4} alignOffset={-4}>
                {recent.length ? recent.map((r) => <Item key={r.name} onSelect={() => void openRecent(r.name)} kbd={ago(r.time)}>{r.name}</Item>)
                  : <M.Item className="mi" disabled>No recent files</M.Item>}
                <Sep />
                <Item onSelect={() => void clearRecent()} disabled={!recent.length}>Clear Recent</Item>
              </M.SubContent>
            </M.Portal>
          </M.Sub>
          <Sep />
          <Item onSelect={exportFbx} disabled={!has} kbd="Ctrl+Shift+E">Export FBX (Blender, Substance Painter)</Item>
          <Item onSelect={exportObjParts} disabled={!has}>Export OBJ per part (ZIP)</Item>
          <M.CheckboxItem className="mi" checked={tri} onCheckedChange={(v) => setTriangulate(!!v)} onSelect={(e) => e.preventDefault()}>
            <M.ItemIndicator className="check">✓</M.ItemIndicator>Triangulate on export (for baking)
          </M.CheckboxItem>
        </Menu>
        <Menu label="Edit">
          <Item onSelect={undo} disabled={!canUndo} kbd="Ctrl+Z">Undo (UV edit, seam or cut)</Item>
          <Item onSelect={redo} disabled={!canRedo} kbd="Ctrl+Shift+Z">Redo UV or mesh edit</Item>
        </Menu>
        <Menu label="Select">
          <Item onSelect={selectAll} disabled={!has} kbd="A">All</Item>
          <Item onSelect={clearSelection} disabled={none} kbd="Alt+A">None</Item>
          <Item onSelect={invertSelection} disabled={!has} kbd="Ctrl+I">Invert</Item>
          <Sep />
          <Item onSelect={selectLinked} disabled={none} kbd="Ctrl+L">Linked (whole islands)</Item>
          <Item onSelect={() => void selectEdgeLoop()} disabled={none} kbd="Alt+click">Edge loops</Item>
        </Menu>
        {!doc && (
          <>
            <Menu label="Edge">
              <Item onSelect={cutSelection} disabled={none} kbd="Ctrl+E">Cut (make a seam)</Item>
              <Item onSelect={stitchSelection} disabled={none} kbd="Ctrl+E">Stitch (join along it)</Item>
            </Menu>
            <Menu label="UV">
              <Item onSelect={() => rotateSel(90)} disabled={none}>Rotate 90°</Item>
              <Item onSelect={() => flipSel(true)} disabled={none} kbd="F">Flip left–right</Item>
              <Item onSelect={() => flipSel(false)} disabled={none} kbd="Shift+F">Flip up–down</Item>
              <Sep />
              <Item onSelect={() => pinSelected(true)} disabled={none} kbd="P">Pin</Item>
              <Item onSelect={() => pinSelected(false)} disabled={none} kbd="Alt+P">Unpin</Item>
              <M.CheckboxItem className="mi" checked={live} onCheckedChange={(v) => setLiveUnwrap(!!v)}>
                <M.ItemIndicator className="check">✓</M.ItemIndicator>Live unwrap (pins drag their islands)
              </M.CheckboxItem>
              <Sep />
              <Item onSelect={() => void unwrapSelected()} disabled={none} kbd="U">Unwrap selection</Item>
            </Menu>
            <Menu label="Unwrap">
              <Item onSelect={unwrap} kbd="Ctrl+Enter">Auto unwrap (start over)</Item>
              <Item onSelect={repack} disabled={!has} kbd="Ctrl+P">Repack islands</Item>
              <Item onSelect={clearSeams}>Clear marked seams on active mesh</Item>
            </Menu>
          </>
        )}
        <Menu label="View">
          <M.RadioGroup value={mode} onValueChange={(v) => useApp.setState({ mode: v as Mode })}>
            {MODES.map(([v, label]) => (
              <M.RadioItem key={v} className="mi" value={v}>
                <M.ItemIndicator className="check">✓</M.ItemIndicator>
                {label}<kbd>Z cycles</kbd>
              </M.RadioItem>
            ))}
          </M.RadioGroup>
          <Sep />
          <Item onSelect={() => viewOp('3d', 'all')} kbd="Home">Frame all</Item>
          <Item onSelect={() => viewOp('3d', 'selected')} disabled={none} kbd="Space">Frame selected</Item>
          <Item onSelect={() => viewOp('3d', 'front')} kbd="Numpad 1">Front</Item>
          <Item onSelect={() => viewOp('3d', 'right')} kbd="Numpad 3">Right</Item>
          <Item onSelect={() => viewOp('3d', 'top')} kbd="Numpad 7">Top</Item>
        </Menu>
      </M.Root>
      <SelectModes />
    </nav>
  );
}
