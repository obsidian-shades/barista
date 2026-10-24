# Health: the pre-bake mesh check

Poly Doc is not a DCC and not a retopology suite. Its job is the five-minute pass before a bake: **look at the mesh,
find what will make the bake or the engine unhappy, fix it in place, go back to the pipeline.** Health is the part that
answers the question. It must therefore be trustworthy: a green torus should be green, and a red face should be worth
stopping for.

This note records the research and the model behind the rework (`src/health.ts`, `src/quality.ts`, `src/polygeo.ts`).

## What was wrong

The old report mixed three different kinds of statement, used simulation limits as green limits, and measured sampling
against the model's bounding box. The visible failure was a good torus lighting up all yellow. Reproduced on the
engine's own torus (64×32 quads) and on the same torus triangulated, as an OBJ/STL/glTF import arrives:

| mesh | old report |
| --- | --- |
| 64×32 **quad** torus | green (quad valence 4 is “regular”) |
| 64×32 **triangle** torus | 11,718 `poleBig` hits, every face yellow/red |
| 48×12 quad torus | `faceted` on most faces (model-relative chord error) |

Four separate causes:

1. **Quad regularity was applied to every mesh.** `poles` called any vertex with 5+ polygon edges a “big pole”. On a
   quad mesh regular is 4; on a triangle mesh regular is 6. Every vertex of a triangulated torus is valence 6, so every
   face was flagged.
2. **Poles were treated as defects.** They are topology. Their indices are constrained by the Euler characteristic
   (Poincaré–Hopf); a torus may have none, a sphere must have curvature. Their placement and valence can matter, but
   “a pole exists” is not an error, and colouring the faces round every one made smooth organic meshes noisy.
3. **Faceting was measured as a share of the model's bounding box.** A 12-sided tube on a large model failed while a
   small bevel was ignored. Scale-free curvature is the meaningful quantity.
4. **The colour ramp jumped at 0.5.** `healthColor` went from yellow at 0.499 to red at 0.5. A “worth a look” score
   could render as a hard red, and vice versa.

Two more false positives came from the same simulation-first framing: a pole fan or cylinder cap is a 5–15° wedge, so
the 30° minimum-angle rule painted every cap red; and aspect ratio painted every long, flat bevel strip or cylinder
side yellow even though a long quad on a flat strip is fine.

## Research notes

### Validity first: what a bake and an unwrapper assume

A triangle soup is usable only when it is a 2-manifold, consistently orientable surface (with boundaries allowed). The
failure modes are well known from mesh-repair work ([Attene et al., *Polygon mesh repairing: an application
perspective*](https://data.cnr.it/data/http://www.cnr.it/ontology/cnr/individuo/prodotto/ID206368)):

- an edge with more than two faces — the side facing out is ambiguous;
- a **non-manifold vertex** (a bow-tie): two fans meet at one point, so the link is not one circle; unwrappers split it
  and leave a pinhole;
- a face wound the other way from its neighbours;
- an entire **closed shell wound inward** — no minority face reveals it, but backface culling removes it and a
  normal/AO bake sees the inside;
- zero-area faces, duplicate faces, polygons whose triangles do not make one simple loop.

The first three need connectivity and orientation tests, not shape metrics. The inside-out case needs a global test:
the signed volume of each closed piece (divergence theorem). That was missing entirely. One exception matters: the
inner wall of a cavity (a cup, a hollow casting) is a closed piece with negative volume on purpose. A negative shell
whose bounding box lies inside another closed shell's is therefore read as a cavity, not an inside-out shell; the
simple containment test avoids a false red on hollow assets.

### Topology: poles are structural

For a quad mesh, a vertex's singularity index is

```
k(v) = (4 − valence(v)) / 4
```

and for a closed surface the Poincaré–Hopf theorem gives

```
Σ k(v) = χ(surface)
```

([Jezdimirović et al., *Quad layouts with high valence singularities for flexible quad
meshing*](https://arxiv.org/abs/2103.02939), §4; see also [Liu & Bommes, *Locally Meshable Frame
Fields*](https://www.algohex.eu/publications/locally-meshable-frame-fields/), which uses the same constraint to check
whether a singularity pattern is admissible). A torus has χ = 0 and can be all valence 4. A sphere has χ = 2 and must
carry +2 of index, e.g. eight valence-3 corners or a different split of the same total. A 3-5 pair has net index 0 and
can be inserted to improve flow; that is a layout choice, not an error.

The triangle-mesh analogue uses regular valence 6: `(6 − valence) / 6`, summing to χ. So a 5- or 7-valent vertex in a
triangle mesh is mild, and a 6-valent vertex is regular. The old “5+ = big pole” rule was a quad-only rule applied to
triangles.

Consequences for Health:

- compute regular valence from the part's own polygon mix (mode of `sides`: 4 for quads, 6 for triangles,
  `2s/(s−2)` in general);
- report low/high valence in the census, do not colour it;
- compute and show **χ, genus, shells, boundary loops** so the user can see *why* a pole set is what it is.

Boundary vertices are left out of the census: their valence is set by the border, and the index theorem applies to
the interior. Genus per piece is `(2 − χ − boundaries) / 2` for an orientable manifold; a torus gives 1, a sphere/disc
0, a two-handle shape 2. A half-integer or negative result means the piece is non-manifold or non-orientable, so the
panel says “not an orientable manifold” instead of inventing a number.

A quad layout is also an **edge flow**: loops follow principal curvature on organic forms and feature lines on hard
surface. Field-aligned meshing makes this the objective ([Instant
Meshes](https://igl.ethz.ch/projects/instant-meshes/), [QuadriFlow](https://onlinelibrary.wiley.com/doi/10.1111/cgf.13498)).
Health cannot judge flow from a single face, so it does not try: the pole census and genus line are the topological
skeleton, and an artist can select a high-valence pole and follow its loops. A pole on a hard crease is usually a flow
mistake; a 3-5 pair on a smooth surface is usually a layout choice.

### Baking: triangulation is part of the contract

A normal map is baked in a tangent space. MikkTSpace, the industry standard
([MikkTSpace](https://github.com/mmikk/MikkTSpace)), derives tangents from positions, UVs, normals and the
**triangulation**. A quad or n-gon is not a surface until it is split; its two possible diagonal splits are different
surfaces, and the tangent frames follow them. Substance's own guidance is explicit: if the runtime triangulates
differently from the baker, normals decode wrong and black seams appear — “triangulating before baking” removes the
ambiguity ([Substance 3D, *Triangulating before
baking*](https://experienceleague.adobe.com/en/docs/substance-3d/bakers/guides/triangulating-before-baking)).

So the **bake** layer is small and specific: a strongly non-planar quad, a folded/concave quad, a bent n-gon. A planar
quad is safe whatever the diagonal; a non-planar one is not. The threshold is advisory (18° green), because a model
that is exported triangulated, or whose baker and engine share the same triangulation, is safe even when warped. This
also explains why a torus quad is *not* flagged: its four corners are nearly coplanar (the non-planarity of a small
quad on a smooth surface is third-order), even though the surface is doubly curved.

### Shape metrics: use the game-art end of the range

Sandia's Verdict / CUBIT metrics are the standard quad quality library ([Knupp et al., *The Verdict Geometric Quality
Library*](https://www.osti.gov/biblio/901967); [CUBIT quadrilateral
metrics](https://cubit.sandia.gov/files/cubit/17.04/help_manual/WebHelp/mesh_generation/mesh_quality_assessment/quadrilateral_metrics.htm)).
Their acceptable ranges are written for finite-element solvers: minimum angle 30–60°, maximum 90°, scaled Jacobian
0.5, skew 0.5, taper 0.7, warpage 0.9. Those are not shading or baking limits. A cylinder cap fan is a 7.5° wedge at
48 segments and shades correctly; a UV sphere pole is a fan; a bevelled edge is deliberately long and thin.

The rework keeps the metric definitions (they are good, cheap, and well understood) but moves the bands to where a game
mesh actually stops shading or baking well:

| rule | green | red | why |
| --- | --- | --- | --- |
| `triMin` | ≥ 6° | ≤ 1.5° | only true needles; pole fans pass |
| `triMax` | ≤ 150° | ≥ 179° | a cap with almost no height |
| `quadJacobian` | ≥ 0.4 | ≤ 0.05 | folded/concave quad |
| `quadSkew` | ≤ 0.7 | ≥ 0.95 | strong shear |
| `quadTaper` | ≤ 0.8 | ≥ 0.98 | triangle-with-a-cut-corner |
| `quadWarp` | ≤ 18° | ≥ 50° | triangulation ambiguity |
| `ngonBent` | ≤ 2% | ≥ 20% | off its own plane |
| `faceted` | ≤ 32°/segment | (capped at 0.55) | visible silhouette corners |
| `dense` | ≥ 1°/segment | — | more segments than a screen shows |

Aspect ratio was **removed**: a long quad on a flat strip is not a defect, and curvature sampling already catches the
case where length hides a bend. Geometric metrics also correlate only loosely with perceived quality
([Corsini et al., *Perceptual metrics for static and dynamic triangle
meshes*](https://data.cnr.it/data/http://www.cnr.it/ontology/cnr/individuo/prodotto/ID276826)); the layer and severity
model is a response to that.

### Sampling: curvature, not model size

For a polyline approximating a circle, a segment's turn `θ`, chord length `l`, local radius `r` and chord sagitta `s`
are related by

```
r = l / (2 sin(θ/2))          s = r (1 − cos(θ/2)) ≈ l θ / 8
```

The ratio `s/r = 1 − cos(θ/2)` is scale-free and is exactly what the eye reads on a silhouette. A 12-sided circle turns
30° per segment (sagitta ≈ 3.4% of the radius); an 8-sided one turns 45° (7.6%); a 6-sided one 60° (13.4%). So the
turn angle itself is the natural faceting measure. The rework uses the turn, plus:

- a **size gate**: only curves whose local radius is > 0.2% of the model are judged (a 1 mm bevel on a 1 m gun is not a
  visible silhouette);
- an **even-width gate**: both sides of the edge must be within 3× in width, so a deliberate chamfer/bevel beside a wide
  face is not mistaken for a sampled smooth curve;
- a **craft cap**: faceting never becomes a red “fix” face. It is a yellow hint, because a low-poly button may be
  exactly what was asked for. This also keeps the gun benchmark's buttons from drowning the report in red.

Turns above 45° are treated as creases/corners, not sampled curves. That is a deliberate conservative choice: without
smoothing groups/normals, a hex prism and a 6-segment cylinder are the same geometry.

Over-dense curves are the mirror image: a run of segments each turning < 1° is more than a screen can show, and a normal
map carries the smoothness. It is a 0.15 hint, not a defect.

### What is still out of scope

- Health reads the mesh only; it has no UVs (that is UV Magician's stretch/overlap checks) and no smoothing groups.
  A true “hard edge without a UV seam” check needs the file's normals and belongs with the unwrap.
- Self-intersections, T-junctions and cracks are not detected yet. They are worth adding as **broken** checks if real
  files show them; they are expensive and should stay opt-in.
- Mixed triangle/quad meshes use the dominant polygon kind for regular valence. A per-vertex expected valence could be
  sharper, but the census is information, not a score.

## The model

Three layers, because they call for different reactions:

- **Broken** — not a valid surface. `nonManifold`, `nonManifoldVert`, `flipped`, `insideOut`, `zero`, `duplicate`,
  `outline`. Red, score 1 (outline 0.75). Fix before anything else.
- **Bake** — valid, but the bake can disagree with the engine. `quadWarp`, `ngonBent`, `quadJacobian`. Triangulate or
  flatten.
- **Craft** — shape/sampling an artist would look at. `triMin`, `triMax`, `quadSkew`, `quadTaper`, `faceted`, `dense`.
  Yellow bands, never blocking.

The panel shows a one-line verdict from `healthVerdict` (`ready to bake` / `worth a look` / `fix before baking`, plus
broken counts), the area bar, then the rules grouped by layer. Polygon colour is still the worst rule on all of a
polygon's triangles (one face, one colour), but the colour ramp is now continuous:

```
0.00 green → 0.35 yellow-green → 0.65 amber → 1.00 red
```

`healthSummary` bands are solid < 0.2, worth a look < 0.6, fix ≥ 0.6, so a 0.15 “dense” hint stays mostly green.

## Validation

`node src/health.check.ts` is the regression suite. It builds the cases that motivated the rework:

- 48×12, 64×32 and 32×16 tori, **both as quads and as triangles** → zero issues, all green (the old triangle case had
  `poleBig` on every vertex);
- a 48-triangle flat cap fan → green, with one high-valence vertex reported by the census but not coloured;
- a long 20:1 flat quad → green (no aspect rule);
- 12-sided and 96-sided prisms → green; 9-sided → nine “worth a look” faces, no red;
- needle triangle, bent quad, sheared quad → still flagged;
- a bow-tie vertex → `nonManifoldVert`; a correct tetrahedron → clean; an inside-out tetrahedron → one inverted shell,
  four red faces, genus 0; a hollow box (outer shell + inward inner wall) → green, not inside-out;
- colour continuity across 0.5.

`node src/polygeo.check.ts` covers the tools and the geometry checks (including the new pole census and mesh check).
`node tools/polydoc.ts testdata/gun.fbx` is the real-model smoke test: after the rework the buttons are green with
faceted hints, the grip's genuine defects (non-manifold, zero-area, folded quads) stay red, and the summary is no longer
dominated by “every vertex is a 5+ pole”.

## Sources

- P. Knupp et al., *The Verdict Geometric Quality Library*, Sandia SAND2007-1751, 2006.
  <https://www.osti.gov/biblio/901967>
- Sandia CUBIT, *Metrics for Quadrilateral Elements*.
  <https://cubit.sandia.gov/files/cubit/17.04/help_manual/WebHelp/mesh_generation/mesh_quality_assessment/quadrilateral_metrics.htm>
- D. Bommes et al., *Quad-Mesh Generation and Processing: A Survey*, Computer Graphics Forum 32(6), 2013.
  <https://onlinelibrary.wiley.com/doi/10.1111/cgf.12014>
- J. Jezdimirović et al., *Quad layouts with high valence singularities for flexible quad meshing*, 2021.
  <https://arxiv.org/abs/2103.02939>
- H. Liu, D. Bommes, *Locally Meshable Frame Fields*, ACM TOG (SIGGRAPH 2023).
  <https://www.algohex.eu/publications/locally-meshable-frame-fields/>
- Adobe Substance 3D, *Triangulating before baking*.
  <https://experienceleague.adobe.com/en/docs/substance-3d/bakers/guides/triangulating-before-baking>
- MikkTSpace, the tangent-space standard. <https://github.com/mmikk/MikkTSpace>
- W. Jakob et al., *Instant Field-Aligned Meshes*, SIGGRAPH Asia 2015.
  <https://igl.ethz.ch/projects/instant-meshes/>
- J. Huang et al., *QuadriFlow: A Scalable and Robust Method for Quadrangulation*, SGP 2018.
  <https://onlinelibrary.wiley.com/doi/10.1111/cgf.13498>
- M. Botsch, L. Kobbelt, *A Remeshing Approach to Multiresolution Modeling*, SGP 2004 (curvature-adaptive sampling).
  <https://www.graphics.rwth-aachen.de/media/papers/remeshing_slides1.pdf>
- M. Corsini et al., *Perceptual metrics for static and dynamic triangle meshes*, Computer Graphics Forum 32(1), 2013.
  <https://data.cnr.it/data/http://www.cnr.it/ontology/cnr/individuo/prodotto/ID276826>
- M. Attene et al., *Polygon mesh repairing: an application perspective*, ACM Computing Surveys 45(2), 2013.
  <https://data.cnr.it/data/http://www.cnr.it/ontology/cnr/individuo/prodotto/ID206368>
