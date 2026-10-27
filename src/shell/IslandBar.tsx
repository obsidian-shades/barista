// The island task bar: Photoshop's contextual bar for a selection, floating over the UV view. Alignment, distribution,
// rotation/flip, relax and pack are here, so the dock can hold settings and the long tail instead of 50 equal buttons.
import type { ReactNode } from 'react';
import { alignSel, distributeSel, flipSel, relaxSel, repack, rotateSel, useApp, type Edge } from '../store';
import { ico, ICON } from '../ui/Icon';

// Illustrator's align icons: the key line the islands line up on, two bars of unlike length against it (a corner: the
// corner and one square). Distribute: three bars evenly spaced. Rotate: the curved arrow round a square (180: a U-turn).
// Flip: Photoshop's mirrored triangles across a dashed axis. Pack: islands packed in the 0–1 square.
const bars = (key: string, d: string) => ico(key, [d, 'F']);
const ALIGN: [Edge, string, ReactNode][] = [
  ['top-left', 'Align top left', bars('M3 17V3h14', 'M5 5h6v6H5z')],
  ['top', 'Align top', bars('M2 3h16', 'M5 5h3.5v11H5zM11.5 5H15v6.5h-3.5z')],
  ['top-right', 'Align top right', bars('M3 3h14v14', 'M9 5h6v6H9z')],
  ['left', 'Align left', bars('M3 2v16', 'M5 5h11v3.5H5zM5 11.5h6.5V15H5z')],
  ['center', 'Align center', ico(['M10 2v16M2 10h16', 'd'], ['M6.5 6.5h7v7h-7z', 'F'])],
  ['right', 'Align right', bars('M17 2v16', 'M4 5h11v3.5H4zM8.5 11.5H15V15H8.5z')],
  ['bottom-left', 'Align bottom left', bars('M3 3v14h14', 'M5 9h6v6H5z')],
  ['bottom', 'Align bottom', bars('M2 17h16', 'M5 4h3.5v11H5zM11.5 8.5H15V15h-3.5z')],
  ['bottom-right', 'Align bottom right', bars('M17 3v14H3', 'M9 9h6v6H9z')],
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
        {ALIGN.map(([edge, title, d]) => b(title, () => alignSel(edge), d))}
      </div>
      <span className="sep" />
      {b('Distribute along U (3 or more islands)', () => distributeSel('u'), ico(['M2 5h3.5v10H2zM8.25 7h3.5v6h-3.5zM14.5 4h3.5v12h-3.5z', 'F'], ['M5.5 10h2.75M11.75 10h2.75', 'a']), n < 3)}
      {b('Distribute along V (3 or more islands)', () => distributeSel('v'), ico(['M5 2h10v3.5H5zM7 8.25h6v3.5H7zM4 14.5h12V18H4z', 'F'], ['M10 5.5v2.75M10 11.75v2.75', 'a']), n < 3)}
      <span className="sep" />
      {b('Rotate 90° counter-clockwise', () => rotateSel(90), ico(['M8 9h9v9H8z', 'f'], 'M8 9h9v9H8zM15 5.5A7 7 0 0 0 4 9.5M2 7.2l2 2.6 2.6-2'))}
      {b('Rotate 180°', () => rotateSel(180), ico('M15 17V9a5 5 0 0 0-10 0v4M2.5 10.8 5 13.5l2.5-2.7'))}
      {b('Rotate 90° clockwise', () => rotateSel(-90), ico(['M3 9h9v9H3z', 'f'], 'M3 9h9v9H3zM5 5.5A7 7 0 0 1 16 9.5M18 7.2l-2 2.6-2.6-2'))}
      {b('Flip left–right (F)', () => flipSel(true), ico(['M10 2v16', 'd'], ['M8 5 2.5 15H8z', 'F'], 'M12 5l5.5 10H12z'))}
      {b('Flip up–down (Shift+F)', () => flipSel(false), ico(['M2 10h16', 'd'], ['M5 8 15 2.5V8z', 'F'], 'M5 12l10 5.5V12z'))}
      <span className="sep" />
      {b('Relax the selected islands from their current shape', () => void relaxSel(), ICON.relax)}
      {b('Pack every island into the square (Ctrl+P)', () => void repack(), ico('M2 2h16v16H2z', ['M4.5 4.5h6v6h-6z', 'A'], ['M12.5 4.5h3v4h-3zM4.5 12.5h6v3h-6z', 'F'], ['M12.5 10.5h3v5h-3z', 'f'], 'M12.5 10.5h3v5h-3z'))}
    </div>
  );
}
