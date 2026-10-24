import { showWorkspace, useApp, type Workspace } from '../store';
import { glyph } from '../ui/Icon';

const TABS: [Workspace, string, string][] = [
  ['doc', 'Poly Doc', 'M3 13L8 3l5 10zM5.5 8h5M6.5 11h3'],
  ['uv', 'UV Magician', 'M2 2h12v12H2zM2 8h12M8 2v12'],
  ['paint', 'Van Gogh', 'M9.5 2.5l4 4-6 6H4v-3.5zM8 4l4 4'],
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
        {TABS.map(([id, label, d]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => showWorkspace(id)}>
            {glyph(d)}{label}
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
