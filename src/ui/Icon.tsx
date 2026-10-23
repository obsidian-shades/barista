// One icon language for the whole app.
//
// The standard chrome (eye, checker, chevron, delete, duplicate, layers…) is drawn filled on a 20×20 grid, the way
// Adobe's Spectrum workflow icons are: that is what makes a Photoshop-like shell read as Photoshop. Domain tools that
// Photoshop has no icon for (Cut, Stitch, Unwrap, Pin, mesh tools) stay line glyphs in the same optical weight: 20×20,
// 1.5 px effective stroke, rounded ends. Render both at 18 px in the rail and 16 px in dense rows.
import type { ReactNode } from 'react';

export type IconName = 'eye' | 'eye-off' | 'checker' | 'chevron' | 'close' | 'plus' | 'trash' | 'duplicate' | 'layers' | 'cursor' | 'lock' | 'folder' | 'fullscreen' | 'mark';

const FILLED: Record<IconName, ReactNode> = {
  eye: <path fillRule="evenodd" d="M10 4.4c-4.5 0-7.8 4.4-8.6 5.6.8 1.2 4.1 5.6 8.6 5.6s7.8-4.4 8.6-5.6c-.8-1.2-4.1-5.6-8.6-5.6Zm0 9a3.4 3.4 0 1 1 0-6.8 3.4 3.4 0 0 1 0 6.8Z" />,
  'eye-off': <><path fillRule="evenodd" d="M10 4.4c-4.5 0-7.8 4.4-8.6 5.6.8 1.2 4.1 5.6 8.6 5.6s7.8-4.4 8.6-5.6c-.8-1.2-4.1-5.6-8.6-5.6Zm0 9a3.4 3.4 0 1 1 0-6.8 3.4 3.4 0 0 1 0 6.8Z" /><path d="M3.1 1.8 18.2 16.9l-1.3 1.3L1.8 3.1z" /></>,
  checker: <path d="M3 3h4v4H3zM11 3h4v4h-4zM7 7h4v4H7zM3 11h4v4H3zM11 11h4v4h-4zM7 15h4v2H7z" />,
  chevron: <path d="M5.2 7.3 10 12l4.8-4.7 1.4 1.4-6.2 6-6.2-6z" />,
  close: <path d="M5.4 4 10 8.6 14.6 4 16 5.4 11.4 10 16 14.6 14.6 16 10 11.4 5.4 16 4 14.6 8.6 10 4 5.4z" />,
  plus: <path d="M9 3h2v6h6v2h-6v6H9v-6H3V9h6z" />,
  trash: <><path d="M7.5 2h5l1 2H17v2H3V4h3.5z" /><path fillRule="evenodd" d="M4.2 7h11.6l-1 10.5H5.2zm3.3 2 .4 6.5h1L8.7 9zm2.3 0 .1 6.5h1L11 9zm2.5 0-.4 6.5h1l.4-6.5z" /></>,
  duplicate: <><path d="M7 2h11v11h-3V5H7z" /><path fill="none" stroke="currentColor" strokeWidth="1.5" d="M2.75 6.75h10.5v10.5H2.75z" /></>,
  layers: <path d="M10 2 18 6.8l-8 4.8-8-4.8zM10 13.4l8-4.8 1 .6-9 5.4-9-5.4 1-.6z" />,
  cursor: <path d="M4 2l11.2 8.1-5.1.8 2.7 5.3-2.2 1.1-2.7-5.4L4 15z" />,
  lock: <path fillRule="evenodd" d="M6 8V6a4 4 0 0 1 8 0v2h2v10H4V8zm2 0h4V6a2 2 0 0 0-4 0z" />,
  folder: <path d="M2 4h6l2 2h8v12H2z" />,
  fullscreen: <path d="M3 3h6v2H5v4H3zM11 3h6v6h-2V5h-4zM3 11h2v4h4v2H3zM15 11h2v6h-6v-2h4z" />,
  mark: <path d="M4 7h12v5.2A5.3 5.3 0 0 1 10.7 18H9.3A5.3 5.3 0 0 1 4 12.2zM16 8.2h1.3a2.4 2.4 0 0 1 0 4.8H16v-1.8h1.3a.6.6 0 0 0 0-1.2H16zM6.2 2.4c0 1.2 1.1 1.3 1.1 2.6H5.5c0-1.3-1.1-1.4-1.1-2.6zm4 0c0 1.2 1.1 1.3 1.1 2.6H9.5c0-1.3-1.1-1.4-1.1-2.6z" />,
};

/** A filled Spectrum-style icon. `size` is the rendered square; the artwork is always 20×20. */
export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">{FILLED[name]}</svg>;
}

/** A 16-unit line drawing wrapped onto the 20-unit grid: 1.5 px at the rail's 18 px, rounded like Spectrum. */
export const glyph = (d: string, dash = '', dots: [number, number][] = []) => (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <g transform="scale(1.25)">
      <path d={d} />
      {dash && <path d={dash} strokeDasharray="1.6 1.6" />}
      {dots.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="1.4" fill="currentColor" stroke="none" />)}
    </g>
  </svg>
);

/** The app mark: a cup, the simplest thing that says Barista at 22 px. */
export const Mark = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.5 7.5h11v4.4A5 5 0 0 1 9.5 17h-1a5 5 0 0 1-5-5z" />
    <path d="M14.5 8.5h1.4a2.3 2.3 0 0 1 0 4.6h-1.4" />
    <path d="M6.4 3.2c0 1.1 1 1.2 1 2.4M10.4 3.2c0 1.1 1 1.2 1 2.4" />
  </svg>
);
