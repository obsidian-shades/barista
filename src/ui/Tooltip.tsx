// The app's one tooltip. Every `title` in the UI is upgraded in place: on first hover it moves the text to `data-tip`
// and draws a dark, 4 px panel instead of the browser's yellow one. That keeps the ~100 existing explanatory titles
// working without a wrapper around each control, and it lets a disabled button keep its reason on a parent `title`.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface Tip { el: HTMLElement; name: string; text: string; kbd?: string }
const DELAY = 380;

/** "Dissolve (Ctrl+X)\nFaces: merge…" → name, shortcut, body. A one-line title is body text. */
function parse(title: string): Omit<Tip, 'el'> {
  const [first, ...rest] = title.split('\n');
  const body = rest.join('\n').trim();
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(first);
  if (body && m) return { name: m[1], kbd: m[2], text: body };
  if (body) return { name: first, text: body };
  return { name: '', text: first };
}

export function Tooltip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const clear = () => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } };
    // Give the native title back when the pointer leaves, so the next hover starts the same way.
    const hide = () => {
      clear();
      setTip((cur) => {
        if (cur && !cur.el.getAttribute('title') && cur.el.dataset.tip) cur.el.setAttribute('title', cur.el.dataset.tip);
        return null;
      });
    };
    const over = (e: PointerEvent) => {
      const t = e.target as Element | null;
      const el = t?.closest?.('[title]') as HTMLElement | null;
      if (!el) return;
      const title = el.getAttribute('title');
      if (!title) return;
      el.dataset.tip = title;
      el.removeAttribute('title');
      clear();
      timer.current = window.setTimeout(() => setTip({ el, ...parse(title) }), DELAY);
    };
    const out = (e: PointerEvent) => {
      if (!tip) return;
      const to = e.relatedTarget as Node | null;
      if (to && tip.el.contains(to)) return;
      if (to && (to as Element).closest?.('[title], [data-tip]') === tip.el) return;
      hide();
    };
    const down = () => hide();
    addEventListener('pointerover', over, true);
    addEventListener('pointerout', out, true);
    addEventListener('pointerdown', down, true);
    addEventListener('blur', hide);
    addEventListener('scroll', hide, true);
    return () => {
      clear();
      removeEventListener('pointerover', over, true);
      removeEventListener('pointerout', out, true);
      removeEventListener('pointerdown', down, true);
      removeEventListener('blur', hide);
      removeEventListener('scroll', hide, true);
    };
  }, [tip]);

  useLayoutEffect(() => {
    const el = ref.current, anchor = tip?.el;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
    let left = Math.min(innerWidth - w - 8, Math.max(8, a.left));
    let top = a.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, a.top - h - 6);
    left = Math.min(left, innerWidth - w - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [tip]);

  if (!tip) return null;
  return (
    <div className="tip" ref={ref} role="tooltip">
      {(tip.name || tip.kbd) && <div className="tipname"><span>{tip.name}</span>{tip.kbd && <kbd>{tip.kbd}</kbd>}</div>}
      {tip.text && <div className="tiptext">{tip.text}</div>}
    </div>
  );
}
