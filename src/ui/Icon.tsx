// One icon language for the whole app.
//
// The standard chrome (eye, checker, chevron, delete, duplicate, layers…) is drawn filled on a 20×20 grid, the way
// Adobe's Spectrum workflow icons are: that is what makes a Photoshop-like shell read as Photoshop. Domain tools that
// Photoshop has no icon for (Cut, Stitch, Pin, mesh tools) and the workspace tabs are two-tone `ico`s in the same optical
// weight: 20×20, 1.4 stroke, rounded ends, faces faint, what the tool acts on lit. Each one is the picture other apps
// use for that job (Blender, Maya, Photoshop, Illustrator, Substance); docs/icons.md lists which. Rendered at 18 px.
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

/** How a tool icon's path is inked: '' line, `f` faint face, `F` solid, `a` lit line, `A` lit fill, `d` dashed, `ad` lit
 *  dashed. Lit uses the app's blue selection accent to mark what the tool acts on or makes. */
type Ink = '' | 'f' | 'F' | 'a' | 'A' | 'd' | 'ad';

/** A dot as a path (fill it with `F` or `A`). */
export const dot = (x: number, y: number, r = 1.4) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
export const dots = (pts: [number, number][], r?: number) => pts.map(([x, y]) => dot(x, y, r)).join('');

/** A two-tone tool icon drawn straight on the 20×20 grid (no rescale), styled by `.ico` in base.css. */
export const ico = (...parts: (string | [string, Ink])[]) => (
  <svg className="ico" width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
    {parts.map((p, i) => { const [d, k] = typeof p === 'string' ? [p, ''] : p; return <path key={i} d={d} className={k ? `i-${k}` : undefined} />; })}
  </svg>
);

/** The app mark: an espresso cup on its saucer, steam above (public/mark.svg and the app icon are the coloured one). */
export const Mark = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 8h10v3a5 5 0 0 1-5 5 5 5 0 0 1-5-5z" fill="currentColor" fillOpacity=".25" />
    <path d="M14 9h1.2a2.1 2.1 0 0 1 0 4.2H14M2 18.2h14" />
    <path d="M7 2.2c-.9 1.2.9 1.9 0 3.3M10.6 2.2c-.9 1.2.9 1.9 0 3.3" />
  </svg>
);

/** An isometric cube of size `r` centred on (x, y): its outline and its three inner edges. */
const cube = (x: number, y: number, r: number) => {
  const w = r * 0.87, h = r / 2;
  return [`M${x} ${y - r}l${w} ${h}v${r}l${-w} ${h}l${-w} ${-h}v${-r}z`, `M${x - w} ${y - h}l${w} ${h} ${w} ${-h}M${x} ${y}v${r}`];
};
const [CUBE, CUBE_IN] = cube(10, 10, 8);
const SPHERE = 'M10 3a7 7 0 1 1 0 14a7 7 0 1 1 0-14';

/** Icons used in more than one place, and the shell's modes and commands (each named for what it stands for). */
export const ICON = {
  // Blender's select modes: the cube with the element a click takes lit; island = a UV island; part = the selected object's outline
  vert: ico(CUBE + CUBE_IN, [dot(10, 10, 2.4), 'A']),
  edge: ico(CUBE + CUBE_IN, ['M10 10v8', 'a'], [dots([[10, 10], [10, 18]], 1.5), 'A']),
  face: ico(['M10 10l7-4v8l-7 4z', 'A'], CUBE + CUBE_IN),
  island: ico(['M3 4h6l1.5 4.5L8 15H3z', 'A'], ['M12.5 3.5H17v6h-2.5l-2-2.5zM12.5 12.5H17V17h-4.5z', 'f'], 'M12.5 3.5H17v6h-2.5l-2-2.5zM12.5 12.5H17V17h-4.5z'),
  surface: ico(['M4 6v8a6 2.2 0 0 0 12 0V6a6 2.2 0 0 1-12 0z', 'A'], 'M4 6a6 2.2 0 1 0 12 0a6 2.2 0 1 0-12 0M4 6v8a6 2.2 0 0 0 12 0V6'),
  part: ico([CUBE, 'f'], CUBE_IN, [CUBE, 'a']),
  // a material ball: the shaded sphere with its highlight
  material: ico([SPHERE, 'A'], SPHERE, [dot(7.5, 7.5, 1.6), 'F']),
  // display: Blender's wireframe globe, solid-shaded ball, MatCap ball, flat disc; the UV checker; a heat ramp for stretch
  wire: ico(SPHERE + 'M10 3a3.2 7 0 1 0 0 14a3.2 7 0 1 0 0-14M3 10h14M4.2 6.2h11.6M4.2 13.8h11.6'),
  smooth: ico([SPHERE, 'f'], SPHERE, [dot(7.5, 7.5, 1.6), 'F']),
  // face orientation: a face split front (lit) and back (outline only)
  faces: ico(['M3 4l14 0-14 12z', 'A'], 'M3 4h14v12H3z', 'M17 4L3 16'),
  health: ico(['M10 17.5S2.5 13 2.5 7.6A4.1 4.1 0 0 1 10 5.2a4.1 4.1 0 0 1 7.5 2.4C17.5 13 10 17.5 10 17.5z', 'f'], 'M10 17.5S2.5 13 2.5 7.6A4.1 4.1 0 0 1 10 5.2a4.1 4.1 0 0 1 7.5 2.4C17.5 13 10 17.5 10 17.5z', ['M2.5 10.5h4l1.5-3 2.5 5 1.5-2h5.5', 'a']),
  checker: ico('M3 3h14v14H3z', ['M3 3h3.5v3.5H3zM10 3h3.5v3.5H10zM6.5 6.5H10V10H6.5zM13.5 6.5H17V10h-3.5zM3 10h3.5v3.5H3zM10 10h3.5v3.5H10zM6.5 13.5H10V17H6.5zM13.5 13.5H17V17h-3.5z', 'F']),
  stretch: ico(['M3 3h4.7v14H3z', 'f'], ['M7.7 3h4.6v14H7.7z', 'f'], ['M7.7 3h4.6v14H7.7z', 'f'], ['M12.3 3H17v14h-4.7z', 'A'], 'M3 3h14v14H3z'),
  islands: ico(['M2.5 3h7v6.5h-7z', 'A'], ['M11.5 3h6v4l-2 2.5h-4z', 'F'], ['M2.5 11.5h5.5l1.5 2.5V17h-7zM11.5 12h6v5h-6z', 'f'], 'M2.5 11.5h5.5l1.5 2.5V17h-7zM11.5 12h6v5h-6z'),
  studio: ico(['M12 6a6 6 0 1 1 0 12a6 6 0 1 1 0-12', 'f'], 'M12 6a6 6 0 1 1 0 12a6 6 0 1 1 0-12', [dot(4.5, 4.5, 2.2), 'A'], ['M8.5 4.5h1.2M4.5 8.5v1.2M7.3 7.3l.9.9', 'a']),
  matcap: ico([SPHERE, 'f'], ['M15 5A7 7 0 0 1 5 15z', 'F'], SPHERE, [dot(7.2, 7.2, 1.4), 'F']),
  flat: ico([SPHERE, 'F']),
  shading: ico(SPHERE, ['M10 3a7 7 0 0 1 0 14a4.5 7 0 0 0 0-14z', 'F']),
  options: ico('M3 6h14M3 14h14', [dots([[7, 6], [13, 14]], 2.3), 'F']),
  one: ico([CUBE, 'f'], CUBE + CUBE_IN),
  all: ico(...[cube(6, 13.5, 4.2), cube(14, 13.5, 4.2), cube(10, 6, 4.2)].flatMap(([o, i]) => [[o, 'f'] as [string, Ink], o + i])),
  fit: ico(['M7 7h6v6H7z', 'f'], 'M7 7h6v6H7zM3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4'),
  // the eyedropper, bucket and relax are tools and also buttons elsewhere
  picker: ico(['M12.5 3.2a2.4 2.4 0 0 1 3.4 0l.9.9a2.4 2.4 0 0 1 0 3.4l-2.2 2.2-4.3-4.3z', 'F'], 'M9.6 4.7l5.7 5.7M11.4 7.6l-6.9 6.9-1 2 2-1 6.9-6.9', [dot(2.6, 17.6, 1.2), 'A']),
  bucket: ico(['M3 9l13 1-6 6z', 'A'], 'M9 3l7 7-6 6-7-7zM5.5 6.2C4.6 3.6 6.8 1.6 9 3', ['M17.3 12.3s1.8 2.2 1.8 3.4a1.8 1.8 0 0 1-3.6 0c0-1.2 1.8-3.4 1.8-3.4z', 'A']),
  relax: ico(['M3 3h14v14H3z', 'f'], 'M3 3h14v14H3z', ['M10 3L6.5 6.5M3 10l3.5-3.5M17 10L6.5 6.5M10 17L6.5 6.5', 'd'], ['M10 3v14M3 10h14', 'a'], [dot(10, 10, 1.7), 'A']),
  // Photoshop's new fill / adjustment layer (the half-filled circle); metal = a glossy ball with a glint
  solidFill: ico('M10 3a7 7 0 1 1 0 14a7 7 0 1 1 0-14', ['M10 3a7 7 0 0 0 0 14z', 'F']),
  metal: ico([SPHERE, 'f'], SPHERE, 'M5.8 9a4.5 4.5 0 0 1 3.4-3.6', ['M15.5 1l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z', 'A']),
  left: ico('M16 10H4M8 6l-4 4 4 4'),
  right: ico('M4 10h12M12 6l4 4-4 4'),
};
