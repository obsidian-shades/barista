// A reference picture over the 3D view (View › Reference image…), Blender's reference image as a floating card: drag
// it by its bar, resize it from the corner, fade it, close it. Only on screen: nothing of it is saved or exported.
import { useRef, useState } from 'react';
import { setRefImage, useApp } from '../store';

export function RefImage() {
  const ref = useApp((s) => s.refImage);
  const [box, setBox] = useState({ x: 16, y: 16, w: 360 });
  const drag = useRef<{ kind: 'move' | 'size'; x: number; y: number; from: typeof box } | null>(null);
  if (!ref) return null;
  const down = (kind: 'move' | 'size') => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { kind, x: e.clientX, y: e.clientY, from: box };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    setBox(d.kind === 'move' ? { ...d.from, x: d.from.x + dx, y: d.from.y + dy } : { ...d.from, w: Math.max(120, d.from.w + dx) });
  };
  const up = () => { drag.current = null; };
  return (
    <div className="refimage" style={{ left: box.x, top: box.y, width: box.w }} onPointerMove={move} onPointerUp={up} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div className="refbar" onPointerDown={down('move')}>
        <span className="caps">Reference</span>
        <input type="range" min={0.15} max={1} step={0.05} value={ref.opacity} title="Opacity" onPointerDown={(e) => e.stopPropagation()} onChange={(e) => setRefImage({ ...ref, opacity: +e.target.value })} />
        <button title="Close the reference" onPointerDown={(e) => e.stopPropagation()} onClick={() => setRefImage(null)}>×</button>
      </div>
      <img src={ref.url} alt="Reference" draggable={false} style={{ opacity: ref.opacity }} />
      <span className="refsize" title="Drag to resize" onPointerDown={down('size')} />
    </div>
  );
}
