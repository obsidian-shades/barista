// A draggable divider between columns, as espresso-level-designer's dock resizer: drag it, or focus it and use the arrow keys.
export function Resizer({ label, onDrag, onStep }: { label: string; onDrag: (clientX: number) => void; onStep: (dir: -1 | 1) => void }) {
  return (
    <div className="dock-resizer" role="separator" aria-label={label} aria-orientation="vertical" tabIndex={0} title={`${label}: drag, or use the arrow keys`}
      onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
      onPointerMove={(e) => { if (e.buttons === 1) onDrag(e.clientX); }}
      onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); onStep(e.key === 'ArrowLeft' ? -1 : 1); } }} />
  );
}
