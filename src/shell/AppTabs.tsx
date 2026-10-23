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
  const source = useApp((s) => s.source);
  const edited = useApp((s) => s.edited || s.parts.some((p) => p.stale));
  return (
    <header className="apptabs">
      <div className="personas" role="tablist" aria-label="Workspace">
        {TABS.map(([id, label, d]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => showWorkspace(id)}>
            {glyph(d)}{label}
          </button>
        ))}
      </div>
      <div className="docid" title={edited ? 'Edited since the last unwrap; Auto Unwrap starts over' : undefined}>
        <span className="file">{source ?? 'No file open'}</span>
        {source && <span className={`dirty${edited ? ' on' : ''}`} aria-label={edited ? 'Edited' : 'Unedited'} />}
      </div>
    </header>
  );
}
