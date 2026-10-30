import { showWorkspace, useApp, type Workspace } from '../store';
import type { ReactNode } from 'react';
import { dot, dots, ico } from '../ui/Icon';

// Poly Doc: a mesh with the doctor's cross. UV Magician: the cube's ideal net (the Latin cross) and a spark. Van Gogh: the palette.
const TABS: [Workspace, string, ReactNode][] = [
  ['doc', 'Poly Doc', ico(['M8 2l6 3.5v7L8 16l-6-3.5v-7z', 'f'], 'M8 2l6 3.5v7L8 16l-6-3.5v-7zM2 5.5L8 9l6-3.5M8 9v7', ['M15.5 11.5v7M12 15h7', 'a'])],
  ['uv', 'UV Magician', ico(['M6 2h4v4h4v4h-4v8H6v-8H2V6h4z', 'f'], 'M6 2h4v4h4v4h-4v8H6v-8H2V6h4zM6 6h4v4H6zM6 14h4', ['M16 1l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z', 'A'])],
  ['paint', 'Van Gogh', ico(['M10 2.5c-4.4 0-8 3.2-8 7.3 0 4 3.4 7.7 7.4 7.7 1.4 0 1.9-1 1.4-2-.6-1.2.2-2.5 1.6-2.5h2.1c2.2 0 3.5-1.6 3.5-3.6 0-3.8-3.6-6.9-8-6.9z', 'f'], 'M10 2.5c-4.4 0-8 3.2-8 7.3 0 4 3.4 7.7 7.4 7.7 1.4 0 1.9-1 1.4-2-.6-1.2.2-2.5 1.6-2.5h2.1c2.2 0 3.5-1.6 3.5-3.6 0-3.8-3.6-6.9-8-6.9z', [dot(6, 9.5, 1.5), 'A'], [dots([[8.5, 6], [12.6, 6.3], [6.6, 13.4]], 1.3), 'F'])],
  // Geppetto: the puppet maker's control bar, its strings down to a jointed limb
  ['rig', 'Geppetto', ico(['M3 3.5h14M10 1.5v6', 'a'], ['M4 3.5v6M16 3.5v4', 'd'], 'M4 9.5l3 4.5 6-3 3 6', [dots([[4, 9.5], [7, 14], [13, 11], [16, 17]], 1.4), 'A'])],
  // Da Vinci: a turntable under a softbox
  ['render', 'Da Vinci', ico(['M3 15.5h14', 'a'], 'M4.5 15.5a5.5 2 0 0 0 11 0', ['M6 3h8l-1.5 3h-5z', 'A'], 'M10 6v4M7 12.5l3-2.5 3 2.5')],
];

/** The workspace switcher: square tabs in a bar, with the current file on the right. A switch never moves anything. */
export function AppTabs() {
  const tab = useApp((s) => s.workspace);
  const source = useApp((s) => s.source), project = useApp((s) => s.project);
  const unsaved = useApp((s) => !s.saved);
  const label = project ? project.split(/[\\/]/).pop() : source;
  return (
    <header className="apptabs">
      <div className="personas" role="tablist" aria-label="Workspace">
        {TABS.map(([id, label, icon]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => showWorkspace(id)}>
            {icon}{label}
          </button>
        ))}
      </div>
      <div className="docid" title={project ?? (source ? 'Not saved as a project yet (Ctrl+S)' : undefined)}>
        <span className="file">{label ?? 'No file open'}</span>
        {label && <span className={`dirty${unsaved ? ' on' : ''}`} aria-label={unsaved ? 'Unsaved changes' : 'Saved'} />}
      </div>
    </header>
  );
}
