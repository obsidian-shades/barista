// Smart materials: a named recipe that builds a small layer stack — a PBR fill plus generator masks that
// react to the baked mesh maps. Not a Substance graph and not a `.spsm`; this is our own data, so a recipe
// can be edited in source and user recipes can be added later.
import type { Gen, Projection } from './paint';

export interface SmartFill {
  asset: string;
  projection?: Projection;
  tiling?: number;
  tiles?: number;
  rotation?: number;
  normalStrength?: number;
  tint?: string;
  /** Finish overrides: a satin anodize uses a scan's grain and its own roughness. */
  roughness?: number;
  metallic?: number;
}
export interface SmartLayer {
  name: string;
  fill?: SmartFill;
  gen?: Omit<Gen, 'clip'>;
}
export interface SmartMaterial {
  id: string;
  name: string;
  category: string;
  description: string;
  layers: SmartLayer[];
}

/** The gun's own look first: graphite, black oxide and the violet anodize from the reference. */
export const SMART_MATERIALS: SmartMaterial[] = [
  {
    id: 'violet-anodized', name: 'Violet Anodized', category: 'Weapon finish',
    description: 'Brushed aluminum under a deep violet anodize; the reference gun’s receiver and trigger.',
    layers: [
      { name: 'Violet anodize', fill: { asset: 'metal-brushed-dark', tiles: 8, tint: '#7c4dff', roughness: 0.24, metallic: 1, normalStrength: 0.9 } },
    ],
  },
  {
    id: 'black-cerakote', name: 'Black Cerakote', category: 'Weapon finish',
    description: 'Flat black ceramic coating over a fine mould grain: the frame and slide’s base finish.',
    layers: [
      { name: 'Cerakote', fill: { asset: 'polymer-satin-black', tiles: 10, tint: '#17181b', roughness: 0.7, metallic: 0.15, normalStrength: 0.65 } },
    ],
  },
  {
    id: 'graphite-slide', name: 'Graphite Slide', category: 'Weapon finish',
    description: 'Satin graphite steel with a faint patina; the slide in the reference image.',
    layers: [
      { name: 'Graphite steel', fill: { asset: 'metal-graphite', tiles: 7, tint: '#686c76', roughness: 0.38, metallic: 0.9, normalStrength: 0.8 } },
    ],
  },
  {
    id: 'black-nitride', name: 'Black Nitride', category: 'Weapon finish',
    description: 'Hard black oxide with a low sheen; barrels, pins and internal steel.',
    layers: [
      { name: 'Black nitride', fill: { asset: 'metal-black-oxide', tiles: 6, tint: '#16171c', roughness: 0.32, metallic: 0.92, normalStrength: 0.75 } },
    ],
  },
  {
    id: 'stippled-grip', name: 'Stippled Grip', category: 'Weapon finish',
    description: 'Black stipple rubber for the grip panels, with a hint of mould-release sheen.',
    layers: [
      { name: 'Stipple rubber', fill: { asset: 'rubber-stipple', tiles: 14, tint: '#111216', roughness: 0.84, metallic: 0, normalStrength: 1.1 } },
    ],
  },
  {
    id: 'carbon-twill', name: 'Carbon Twill', category: 'Weapon finish',
    description: '2x2 carbon twill under satin resin for handguards, stocks and wraps.',
    layers: [
      { name: 'Carbon twill', fill: { asset: 'carbon-twill', tiles: 5, tint: '#e8e8ec', roughness: 0.32, metallic: 0.2, normalStrength: 0.8 } },
    ],
  },
  {
    id: 'textured-polymer', name: 'Textured Polymer', category: 'Weapon finish',
    description: 'Micro-textured black polymer for frames, magwells and production furniture.',
    layers: [
      { name: 'Black polymer', fill: { asset: 'polymer-textured-black', tiles: 9, tint: '#26272c', roughness: 0.74, metallic: 0, normalStrength: 0.9 } },
    ],
  },
  {
    id: 'charcoal-anodized', name: 'Charcoal Anodized', category: 'Weapon finish',
    description: 'Tight brushed aluminum with a dark charcoal anodize and a clean satin sheen.',
    layers: [
      { name: 'Charcoal anodize', fill: { asset: 'metal-fine-brushed', tiles: 9, tint: '#3b3f47', roughness: 0.3, metallic: 1, normalStrength: 0.75 } },
    ],
  },
  {
    id: 'silver-anodized', name: 'Silver Anodized', category: 'Weapon finish',
    description: 'Bright brushed aluminum for triggers, selector levers and small trim.',
    layers: [
      { name: 'Silver anodize', fill: { asset: 'metal-fine-brushed', tiles: 10, tint: '#c7ccd4', roughness: 0.34, metallic: 1, normalStrength: 0.7 } },
    ],
  },
  {
    id: 'copper-accent', name: 'Copper Accent', category: 'Weapon finish',
    description: 'Warm copper anodize for a second accent colour against graphite and violet.',
    layers: [
      { name: 'Copper anodize', fill: { asset: 'metal-brushed-dark', tiles: 8, tint: '#c06b3e', roughness: 0.28, metallic: 1, normalStrength: 0.8 } },
    ],
  },
  {
    id: 'black-leather', name: 'Black Leather', category: 'Weapon finish',
    description: 'Fine black leather for grips, straps and weapon-case linings.',
    layers: [
      { name: 'Black leather', fill: { asset: 'leather-black-fine', tiles: 7, tint: '#1b1818', roughness: 0.62, metallic: 0, normalStrength: 1 } },
    ],
  },
  {
    id: 'violet-worn', name: 'Violet Worn', category: 'Weathering',
    description: 'The violet anodize broken back to bright aluminum along the edges, grime in the cuts.',
    layers: [
      { name: 'Violet anodize', fill: { asset: 'metal-brushed-dark', tiles: 8, tint: '#7c4dff', roughness: 0.24, metallic: 1, normalStrength: 0.9 } },
      { name: 'Edge wear', gen: { kind: 'edge', amount: 0.38, soft: 0.12, width: 0.0045, grunge: 0.55, scale: 0.024, color: '#d7c8f2', rough: 0.28, metal: 1 } },
      { name: 'Grime', gen: { kind: 'dirt', amount: 0.22, soft: 0.4, width: 0.012, grunge: 0.5, scale: 0.045, color: '#211d2c', rough: 0.95, metal: 0 } },
    ],
  },
  {
    id: 'battle-worn', name: 'Battle Worn', category: 'Weathering',
    description: 'Scratched charcoal steel with bright metal on the edges and dirt in the recesses.',
    layers: [
      { name: 'Scratched steel', fill: { asset: 'metal-scratched', tiles: 7, tint: '#55585f', roughness: 0.48, metallic: 0.78, normalStrength: 0.9 } },
      { name: 'Bare edges', gen: { kind: 'edge', amount: 0.52, soft: 0.1, width: 0.005, grunge: 0.6, scale: 0.022, color: '#dbd8d0', rough: 0.3, metal: 1 } },
      { name: 'Crevice dirt', gen: { kind: 'dirt', amount: 0.36, soft: 0.38, width: 0.014, grunge: 0.55, scale: 0.05, color: '#2b2620', rough: 0.95, metal: 0 } },
    ],
  },
  {
    id: 'heat-scorched', name: 'Heat Scorched', category: 'Weathering',
    description: 'A suppressor or barrel that has run hot: darkened oxide, soot and amber heat tint.',
    layers: [
      { name: 'Scorched steel', fill: { asset: 'metal-graphite-worn', tiles: 6, tint: '#453a38', roughness: 0.5, metallic: 0.85, normalStrength: 0.8 } },
      { name: 'Soot', gen: { kind: 'dirt', amount: 0.34, soft: 0.5, width: 0.01, grunge: 0.6, scale: 0.035, color: '#1a1513', rough: 0.92, metal: 0.1 } },
    ],
  },
  {
    id: 'worn-steel', name: 'Worn Steel', category: 'Weathering',
    description: 'Clean steel with bare metal on the edges and grime in the crevices.',
    layers: [
      { name: 'Steel', fill: { asset: 'metal-steel-grey', tiles: 2, normalStrength: 1 } },
      { name: 'Edge wear', gen: { kind: 'edge', amount: 0.5, soft: 0.12, width: 0.006, grunge: 0.45, scale: 0.03, color: '#c8c6bf', rough: 0.32, metal: 1 } },
      { name: 'Dirt', gen: { kind: 'dirt', amount: 0.32, soft: 0.35, width: 0.012, grunge: 0.5, scale: 0.05, color: '#3a3128', rough: 0.95, metal: 0 } },
    ],
  },
  {
    id: 'painted-metal', name: 'Painted Metal', category: 'Weathering',
    description: 'Blue-grey paint chipped back to bright metal on the edges.',
    layers: [
      { name: 'Paint', fill: { asset: 'metal-silver-clean', tiles: 2, tint: '#55788a', normalStrength: 1 } },
      { name: 'Chips', gen: { kind: 'edge', amount: 0.48, soft: 0.1, width: 0.005, grunge: 0.55, scale: 0.025, color: '#d8d5cc', rough: 0.28, metal: 1 } },
      { name: 'Grime', gen: { kind: 'dirt', amount: 0.26, soft: 0.4, width: 0.012, grunge: 0.45, scale: 0.05, color: '#2f2a24', rough: 0.9, metal: 0 } },
    ],
  },
  {
    id: 'dirty-concrete', name: 'Dirty Concrete', category: 'Environment',
    description: 'Smooth concrete with grime in the hollows and dark occlusion.',
    layers: [
      { name: 'Concrete', fill: { asset: 'concrete-smooth', tiles: 1.5, normalStrength: 1 } },
      { name: 'Grime', gen: { kind: 'dirt', amount: 0.5, soft: 0.4, width: 0.02, grunge: 0.55, scale: 0.08, color: '#4a453c', rough: 0.95, metal: 0 } },
      { name: 'Occlusion', gen: { kind: 'ao', amount: 0.55, soft: 0.6, width: 0.01, grunge: 0.15, scale: 0.05, color: '#1c1a18', rough: 0.95, metal: 0 } },
    ],
  },
  {
    id: 'worn-leather', name: 'Worn Leather', category: 'Character',
    description: 'Brown leather with rubbed edges and dirt in the seams.',
    layers: [
      { name: 'Leather', fill: { asset: 'leather-brown-worn', tiles: 3, normalStrength: 1 } },
      { name: 'Rubbed edges', gen: { kind: 'edge', amount: 0.4, soft: 0.2, width: 0.008, grunge: 0.5, scale: 0.03, color: '#8c6a45', rough: 0.55, metal: 0 } },
      { name: 'Dirt', gen: { kind: 'dirt', amount: 0.35, soft: 0.4, width: 0.014, grunge: 0.5, scale: 0.05, color: '#2b2119', rough: 0.95, metal: 0 } },
    ],
  },
  {
    id: 'scratched-gold', name: 'Scratched Gold', category: 'Prop',
    description: 'Polished gold with fine wear and a little grime.',
    layers: [
      { name: 'Gold', fill: { asset: 'metal-gold-polished', tiles: 2, normalStrength: 1 } },
      { name: 'Wear', gen: { kind: 'edge', amount: 0.35, soft: 0.15, width: 0.005, grunge: 0.4, scale: 0.03, color: '#f4d58a', rough: 0.22, metal: 1 } },
      { name: 'Grime', gen: { kind: 'dirt', amount: 0.2, soft: 0.4, width: 0.01, grunge: 0.4, scale: 0.05, color: '#2f2a1e', rough: 0.9, metal: 0 } },
    ],
  },
];
