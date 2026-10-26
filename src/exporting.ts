// What File › Export actually writes, per destination. The dialog and the File menu both read this, so a preset's
// label, its explanation and the list of files cannot drift from what the engine's exporter produces
// (engine/src/texture/mod.rs): which channels are packed, the normal convention and the colour spaces.
import type { ExportTarget } from './store';

export interface MapSpec {
  file: string;
  /** What the pixels hold. */
  holds: string;
  /** Only written when the texture set has this channel (`BaseColor` and the packed map are always written). */
  when?: string;
}

export interface TargetInfo {
  id: ExportTarget;
  label: string;
  target: string;
  summary: string;
  detail: string;
  normal: string;
  maps: MapSpec[];
}

const genericMaps: MapSpec[] = [
  { file: 'BaseColor.png', holds: 'Base colour, sRGB' },
  { file: 'Normal.png', holds: 'Tangent-space normal, OpenGL (+Y up), linear' },
  { file: 'Roughness.png', holds: 'Grey, linear', when: 'Roughness' },
  { file: 'Metallic.png', holds: 'Grey, linear', when: 'Metallic' },
  { file: 'Height.png', holds: 'Grey, mid grey = flat', when: 'Height' },
  { file: 'AmbientOcclusion.png', holds: 'Grey, white = open' },
  { file: 'ORM.png', holds: 'R = AO, G = Roughness, B = Metallic' },
];

/** The dialog's destination cards, in this order. */
export const EXPORT_TARGETS: TargetInfo[] = [
  {
    id: 'generic', label: 'Generic PBR', target: 'Blender · Substance · glTF',
    summary: 'Each map on its own, plus an ORM pack',
    detail: 'The portable set: every channel as its own image, plus ORM for engines that want one packed mask. Channels a texture set does not have are left out.',
    normal: 'OpenGL (+Y up)', maps: genericMaps,
  },
  {
    id: 'blender', label: 'Blender ready', target: 'Blender · one click',
    summary: 'The generic maps, and an FBX that links them',
    detail: 'The generic set, and an FBX beside it whose materials point at the PNGs — Blender’s own FBX import comes in fully textured, with no material to wire by hand.',
    normal: 'OpenGL (+Y up)', maps: genericMaps,
  },
  {
    id: 'unreal', label: 'Unreal Engine', target: 'UE4 · UE5',
    summary: 'DX normal, packed ORM',
    detail: 'Unreal reads the normal’s green channel the other way (DirectX) and wants occlusion, roughness and metallic in one ORM texture. Height comes along when the set has it.',
    normal: 'DirectX (−Y: green flipped)',
    maps: [
      { file: 'BaseColor.png', holds: 'Base colour, sRGB' },
      { file: 'Normal.png', holds: 'Tangent-space normal, DirectX (−Y), linear' },
      { file: 'ORM.png', holds: 'R = AO, G = Roughness, B = Metallic' },
      { file: 'Height.png', holds: 'Grey, mid grey = flat', when: 'Height' },
    ],
  },
  {
    id: 'unity-hdrp', label: 'Unity HDRP', target: 'HDRP',
    summary: 'Normal, and a Mask Map',
    detail: 'HDRP packs four masks in one texture: metallic, ambient occlusion, a detail mask (none is painted, so 0) and smoothness (1 − roughness).',
    normal: 'OpenGL (+Y up)',
    maps: [
      { file: 'BaseColor.png', holds: 'Base colour, sRGB' },
      { file: 'Normal.png', holds: 'Tangent-space normal, OpenGL (+Y up), linear' },
      { file: 'MaskMap.png', holds: 'R = Metallic, G = AO, B = Detail mask (0), A = Smoothness' },
      { file: 'Height.png', holds: 'Grey, mid grey = flat', when: 'Height' },
    ],
  },
  {
    id: 'unity-urp', label: 'Unity URP', target: 'URP · Built-in',
    summary: 'Normal, and Metallic/Smoothness',
    detail: 'URP’s packed map: metallic in red and smoothness (1 − roughness) in alpha. No separate AO is written; AO is only baked if a generator needs it.',
    normal: 'OpenGL (+Y up)',
    maps: [
      { file: 'BaseColor.png', holds: 'Base colour, sRGB' },
      { file: 'Normal.png', holds: 'Tangent-space normal, OpenGL (+Y up), linear' },
      { file: 'MetallicSmoothness.png', holds: 'R = Metallic, G and B unused, A = Smoothness' },
      { file: 'Height.png', holds: 'Grey, mid grey = flat', when: 'Height' },
    ],
  },
];

export const targetInfo = (id: ExportTarget): TargetInfo => EXPORT_TARGETS.find((t) => t.id === id) ?? EXPORT_TARGETS[0];
/** The File menu's one-line explanations; the same words as the cards. */
export const targetTitle = (id: ExportTarget): string => {
  const t = targetInfo(id);
  return `${t.summary}. ${t.maps.map((m) => m.file.replace('.png', '')).join(', ')}. ${t.normal} normal.`;
};
