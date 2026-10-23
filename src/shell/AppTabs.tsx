import { showWorkspace, useApp, type Workspace } from '../store';

const TABS: [Workspace, string, string][] = [
  ['doc', 'Poly Doc', 'M4 20L12 4l8 16zM8 12h8M10 16h4'],
  ['uv', 'UV Magician', 'M3 3h18v18H3zM3 12h18M12 3v18'],
  ['paint', 'Van Gogh', 'M14 4l6 6-9 9H5v-6zM12 6l6 6M5 19c-1 2-3 2-3 2'],
];
/** The tool switcher under the menu bar, a pill group like Affinity's Vector | Pixel | Layout. */
export function AppTabs() {
  const tab = useApp((s) => s.workspace);
  return (
    <header className="apptabs" role="tablist" aria-label="Tool">
      <div className="pills">
        {TABS.map(([id, label, d]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => showWorkspace(id)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"><path d={d} /></svg>{label}
          </button>
        ))}
      </div>
    </header>
  );
}
