// The island task bar: Photoshop's contextual bar for a selection, floating over the UV view. Alignment, distribution,
// rotation/flip, relax and pack are here, so the dock can hold settings and the long tail instead of 50 equal buttons.
import type { ReactNode } from 'react';
import { alignSel, distributeSel, flipSel, relaxSel, repack, rotateSel, useApp, type Edge } from '../store';
import { glyph } from '../ui/Icon';

const ALIGN: [Edge, string, string][] = [
  ['top-left', 'Align top left', 'M1.5 1.5h13M1.5 1.5v13M3 3h5v5H3z'],
  ['top', 'Align top', 'M1.5 1.5h13M5.5 3h5v5h-5z'],
  ['top-right', 'Align top right', 'M1.5 1.5h13M14.5 1.5v13M8 3h5v5H8z'],
  ['left', 'Align left', 'M1.5 1.5v13M3 5.5h5v5H3z'],
  ['center', 'Align center', 'M2 8h12M8 2v12M5.5 5.5h5v5h-5z'],
  ['right', 'Align right', 'M14.5 1.5v13M8 5.5h5v5H8z'],
  ['bottom-left', 'Align bottom left', 'M1.5 1.5v13M1.5 14.5h13M3 8h5v5H3z'],
  ['bottom', 'Align bottom', 'M1.5 14.5h13M5.5 8h5v5h-5z'],
  ['bottom-right', 'Align bottom right', 'M1.5 14.5h13M14.5 1.5v13M8 8h5v5H8z'],
];

export function IslandBar() {
  const n = useApp((s) => s.selected.length);
  if (!n) return null;
  const b = (title: string, run: () => void, icon: ReactNode, off = false) => (
    <button key={title} title={title} disabled={off} aria-label={title} onClick={run}>{icon}</button>
  );
  return (
    <div className="islandbar" role="toolbar" aria-label="Selected islands">
      <span className="count">{n} island{n > 1 ? 's' : ''}</span>
      <span className="sep" />
      <div className="align3">
        {ALIGN.map(([edge, title, d]) => b(title, () => alignSel(edge), glyph(d)))}
      </div>
      <span className="sep" />
      {b('Distribute along U (3 or more islands)', () => distributeSel('u'), glyph('M2 2v12M14 2v12M6 5h4v6H6z'), n < 3)}
      {b('Distribute along V (3 or more islands)', () => distributeSel('v'), glyph('M2 2h12M2 14h12M5 6h6v4H5z'), n < 3)}
      <span className="sep" />
      {b('Rotate 90° counter-clockwise', () => rotateSel(90), glyph('M5 4a5 5 0 1 0-1 6M5 1v3H2'))}
      {b('Rotate 180°', () => rotateSel(180), glyph('M4 5a5 5 0 0 1 8 0M12 2v3H9M12 11a5 5 0 0 1-8 0M4 14v-3h3'))}
      {b('Rotate 90° clockwise', () => rotateSel(-90), glyph('M11 4a5 5 0 1 1 1 6M11 1v3h3'))}
      {b('Flip left–right (F)', () => flipSel(true), glyph('M8 2v12M3 5l4 3-4 3zM13 5l-4 3 4 3z'))}
      {b('Flip up–down (Shift+F)', () => flipSel(false), glyph('M2 8h12M5 3l3 4 3-4zM5 13l3-4 3 4z'))}
      <span className="sep" />
      {b('Relax the selected islands from their current shape', () => void relaxSel(), glyph('M1.5 9c2.2-4 4.3-4 6.5 0s4.3 4 6.5 0', '', [[1.5, 9], [8, 9], [14.5, 9]]))}
      {b('Pack every island into the square (Ctrl+P)', () => void repack(), glyph('M2 2h5v5H2zM9 2h5v3H9zM9 7h5v7H9zM2 9h5v5H2z'))}
    </div>
  );
}
