# Icons: what each button stands for, and the picture other apps use for it

All custom icons are two-tone `ico()` drawings on a 20×20 grid (`src/ui/Icon.tsx`): the mesh in line, faces faint, what
the tool acts on or makes lit in Blender's selection orange (white on a pressed blue button). Generic chrome (eye,
trash, plus, duplicate, chevron, cursor) stays Spectrum's filled set. Each icon below copies the usual picture for that
job; "ours" says how it is drawn.

## Workspace tabs and app
| Button | What it does | Usual icon (where) | Ours |
|---|---|---|---|
| App / favicon / installer | Barista | brand mark | espresso cup on a saucer, body a UV checker |
| Poly Doc | mesh inspect-and-fix | mesh cube + medical cross (diagnostics) | cube with an orange cross |
| UV Magician | automatic unwrap | unfolded cube net (UV tools) | the cube's Latin-cross net + spark |
| Van Gogh | texture painting | painter's palette (Painter, Krita) | palette with paint dabs |

## Selection and display modes (options bar, view headers)
| Button | What it does | Usual icon (where) | Ours |
|---|---|---|---|
| Vertex / Edge / Face | what a click selects | cube with that element lit (Blender's select modes) | same |
| Island | select whole UV islands | UV island shape (Blender UV sticky/island) | lit island beside faint ones |
| Surface | flood to sharp edges | a smooth surface patch lit | cylinder with its side lit |
| Part | the whole part | selected object = orange outline (Blender) | cube with an orange outline |
| Wire | wireframe view | wireframe globe (Blender) | same |
| Smooth | smooth shaded view | shaded sphere (Blender Solid) | faint ball with a highlight |
| Health | Poly Doc's check view | heart with a pulse line (diagnostics) | same |
| Checker | UV checker view | checkerboard | same |
| Stretch | stretch heat map | heat ramp | three bands, faint to orange |
| Islands | colour per island | coloured patches | three islands in three tones |
| Studio | lit with lights + HDRI | light shining on a ball (Blender Studio) | lamp + ball |
| MatCap | material-capture shading | two-tone ball (Blender MatCap) | ball half shaded diagonally |
| Flat | unlit | flat filled disc (Blender Flat) | same |
| Shading (popover) | viewport shading options | shaded sphere (Blender's shading dropdown) | ball with a shaded side |
| UV options | settings dialog | sliders / "tune" | two sliders |
| Part / All (UV scope) | this part / every part | one object / several objects | one cube / three cubes |
| Fit | frame all | corner brackets (zoom extents) | corners round a box |

## Poly Doc tool strip
| Button | What it does | Usual icon (where) | Ours |
|---|---|---|---|
| Dissolve | merge faces / remove edges | face with the removed edge dashed (Blender, Maya Delete Edge) | quad pair, dashed orange middle edge |
| Limited Dissolve | dissolve flat edges only | same, crease kept | flat edges dashed, crease solid |
| Tris to Quads | pair triangles into quads | quad with the diagonal removed (Maya Quadrangulate) | dashed orange diagonal |
| Connect | new edge between vertices | edge drawn across a polygon (Maya Connect) | orange edge across an n-gon |
| Merge | weld at centre | arrows converging on a point (Maya Merge to Center) | four arrows to an orange dot |
| Collapse | edge to a point | edge shrinking to a vertex (Maya Collapse) | edge, arrow, dot |
| Rotate Edge | turn an edge | quad, diagonal + turn arrow (Blender Rotate Edge) | old diagonal dashed, new orange, arrow |
| Grid Fill | fill a hole with a grid | hole with a grid (Blender Grid Fill) | n-gon with an orange grid |
| Move | move selection | four-way arrows (everywhere) | same |
| Even Out | relax vertices | uneven mesh evened (Blender Smooth / Maya Relax) | dashed old edges, orange even ones |
| Subdivide | split polygons | square cut into four (Maya Subdivide) | same, new vertices lit |
| Loop Cut | add an edge loop | box with a ring round it (Blender Loop Cut) | same |
| Edge Slide | slide along rails | edge between rails + arrows (Blender Edge Slide) | same |
| Space / Straighten / Circle | LoopTools shapes | before → after on the loop | dashed before, orange after |

## UV Magician tool strip and island bar
| Button | What it does | Usual icon (where) | Ours |
|---|---|---|---|
| Box Select | drag a box | dashed box + cursor (Blender) | same |
| Select Loop | edge loop | ring round a cylinder | same |
| Select Linked | grow to whole islands | chain link ("linked") | chain link |
| Cut | make seams | scissors (Maya Cut UV Edges, RizomUV) | scissors on an orange seam |
| Stitch | join edges | needle and thread (Maya Sew UV Edges) | needle with an orange thread |
| Pin / Unpin | hold UVs | pushpin (Blender UV pin) / pin struck through | same |
| Align ×9 | align islands | key line + bars (Illustrator / Figma) | edge line + two bars; corners: L + square |
| Distribute U / V | even spacing | three evenly spaced bars (Illustrator) | same, gaps lit |
| Rotate 90° CCW / CW | turn | curved arrow over a square (Material, Photoshop) | same |
| Rotate 180° | turn half way | U-turn arrow | same |
| Flip H / V | mirror | mirrored triangles across a dashed axis (Photoshop, Figma) | same |
| Relax | relax islands | as Even Out | Even Out's icon |
| Pack | pack into the square | rectangles packed in a square (UVPackmaster, Blender) | same, biggest lit |

## Van Gogh tool strip and layer bar
| Button | What it does | Usual icon (where) | Ours |
|---|---|---|---|
| Marquee | rectangle select | dashed rectangle (Photoshop) | same |
| Lasso | freehand select | loop with a tail (Photoshop) | same |
| Select Faces | pick a face / island / part | mesh with one polygon filled + cursor (Substance Polygon Fill) | same |
| Decal | place / edit marks | sticker with a peeling corner (stickers, Substance stencil) | same |
| Brush | paint | round brush (Photoshop) | same, orange tip |
| Eraser | erase | angled eraser block (Photoshop) | same |
| Bucket / Fill layer | fill | tipped paint bucket with drip (Photoshop) | same |
| Eyedropper (+ colour pickers) | sample colour / material | pipette (Photoshop) | same |
| Solid fill layer | one-colour fill layer | half-filled circle (Photoshop "new fill or adjustment layer") | same |
| Metal sheen | metallic layer | glossy ball with a glint (material/metal) | ball, highlight, orange spark |
| Slide ← / → (Edge Slide bar) | slide direction | arrows | same |
