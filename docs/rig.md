# Geppetto — current rigging flow and what is left

## The short version

The common path is now:

1. **Geppetto → Auto-rig** (`Shift+A`).
2. **Drag the model or a bone** to move it; **drag a joint** to reshape it; **drag a tip** to aim it.
3. Pick a **motion preset** in the panel (Free / Hinge / Slide / Press / Fixed) — one click.
4. **Tab → Pose**, then **drag a part/bone to slide it, its tip to turn it**.
5. Add a **constraint** from the right-click menu (`F` Follow, `T` Aim, `P` Piston) and click the target.

The Move/Rotate buttons are gone from the main bar. They were a required step before; now they are an optional
**Gizmo** (`G` / `R`, off by default) for axis-precise work. Direct dragging works everywhere.

## Controls

| Action | How |
|---|---|
| Auto-rig | `Shift+A`, or the **Auto-rig** button |
| One bone on a part | Click the part, `A` / **Add bone** |
| Move a bone / part | Drag its body (Edit) |
| Move a joint | Drag its round handle (Edit) |
| Aim a bone | Drag its tip (Edit) |
| Pose a bone | `Tab`, then drag the part/body to translate, the tip to turn |
| Switch Edit / Pose | `Tab` |
| Motion preset | Click Free / Hinge / Slide / Press / Fixed in the panel |
| Re-read the part | **Auto fit** |
| Follow / Aim / Piston | Right-click the bone → the item, or `F` / `T` / `P`, then click the target |
| Connect to parent | `C`, or the right-click menu |
| Add a child bone | Right-click → **Add child bone…**, then click on the model |
| Delete | `X` / Delete |
| Gizmo | `G` = Move, `R` = Rotate; the **Gizmo** button shows/hides it |
| Undo (rig only) | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Context menu | Right-click a bone, or empty space |

Dragging a part only moves it directly when the part has **its own bone** (the usual auto-rig case). A fixed detail
that rides a parent bone is not dragged by the detail — that would move the parent by accident.

## Done

- Auto-rig: one undo step; a bone per part or loose shell; contact joints; minimum-spanning parent tree rooted at the
  model's middle; motion guessed from name first, shape second; fixed housing shares its parent's bone.
- Roll for hinges (local X on the part's thin axis); connected bones; per-axis rotation and translation limits.
- Direct manipulation of parts, bones, joints and tips, in Edit and Pose, with undo and constraint limits.
- Animated hinge arc, constraint lines, joint handles for every bone, hover/cursor feedback.
- One-click motion presets and a right-click menu; target-picking for Follow/Aim/Piston.
- Constraints: Follow, Aim, Stretch, Piston, Copy rotation, Copy location; influence.
- `Skin part` for a single mesh across a joint.
- FBX: skeleton, hierarchy and roll with the skin; constraints/limits stay editor-side.
- Checks: `node src/rig.check.ts`, `node src/project.check.ts`, `node src/files.check.ts`.

## What is left

Only the first three are the next slice; the rest are later ideas, not hidden work. Nothing else is planned behind them.

### Next

1. **Part-grab with IK / reach.** Dragging a part currently translates its bone. Dragging an endpoint to reach a point
   (two-bone IK, like Blender's auto-IK) would make limb posing direct instead of rotating one bone at a time.
2. **Pick a constraint's socket.** Aim/Stretch/Piston start at the nearest point on the target. Let the artist click the
   exact socket (or drag the target point) and keep it in the target's space.
3. **Mirror / symmetry.** Mirror a chain or a solved auto-rig across X, and use symmetry to name/link left/right parts.

### Later

4. **Bone collections / visibility.** For rigs over ~20 bones: collections, hide/filter, search, and a compact tree.
5. **Auto-skin a connected mesh.** Loose shells get their own bones; a single connected limb still needs `Skin part`.
   Automatic region weights (nearest bone + a falloff at the joint) would finish the one-mesh case.
6. **Pose is still not saved and has no undo.** Add pose undo and optional keyframes/save; bake constraints to FBX
   transform keys so a Blender/engine export can reproduce the aim/stretch.
7. **Snapping.** Joint-to-vertex, grid, and 15° angle snaps while dragging; numeric entry for the gizmo.
8. **Rig presets / rules.** Editable name rules and saved auto-rig presets (e.g., "weapon", "robot arm").
9. **Very large rigs.** The pair search is capped at 120 loose shells; beyond that it rigs by whole part. Add a busy
   state and a faster broad phase before raising the cap.
10. **Dragging fixed details.** They share a parent bone today. A "detach" gesture (Alt-drag) could give one its own bone
    in place.

## Known limitations

- Auto-rig is a guess. The Motion preset and **Auto fit** are the corrections; names are a strong hint by design.
- Constraints and limits are editor-side, not written to FBX.
- Pose is a viewport state: not saved, not in the rig undo.
- Labels are part names; a fixed detail has no bone row of its own until you `Add bone` it.
- Part dragging only applies when the part's own bone is named after it (or after a rename, use the bone handles).

## Check it

```
node src/rig.check.ts
node src/project.check.ts
node src/files.check.ts
npx tsc --noEmit -p .
```
