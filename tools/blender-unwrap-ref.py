# Blender's own manual Unwrap as the reference for engine/src/abf.rs:
#   blender -b --factory-startup --python tools/blender-unwrap-ref.py -- out.json
# Each case is triangulated first (so both sides solve the same triangles), seamed, unwrapped Angle Based with Fill
# Holes, and written as positions + UVs per corner and its seams; `cargo run --release --example blender_parity --
# out.json` solves the same and compares each island's shape.
import bpy, bmesh, json, math, sys

def case(name, make, seam=lambda a, b: False, pins=None):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    make()
    ob = bpy.context.active_object
    bpy.ops.object.mode_set(mode='EDIT')
    bm = bmesh.from_edit_mesh(ob.data)
    for e in bm.edges:
        e.seam = seam(e.verts[0].co, e.verts[1].co)
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method='FIXED', ngon_method='BEAUTY')
    bmesh.update_edit_mesh(ob.data)
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.unwrap(method='ANGLE_BASED', fill_holes=True, correct_aspect=True, margin=0.0)
    bpy.ops.object.mode_set(mode='OBJECT')
    me = ob.data
    uv = me.uv_layers.active.data
    before, pinned = None, []
    if pins:
        # pins: {vertex index: uv offset}; every corner of the vertex pinned and moved, then unwrapped again
        pin = me.uv_layers.active.pin_ensure().data
        for li, lp in enumerate(me.loops):
            if lp.vertex_index in pins:
                d = pins[lp.vertex_index]
                uv[li].uv = (uv[li].uv[0] + d[0], uv[li].uv[1] + d[1])
                pin[li].value = True
        before = [x for p in me.polygons for li in p.loop_indices for x in uv[li].uv]
        pinned = [k for k, li in enumerate(li for p in me.polygons for li in p.loop_indices) if me.loops[li].vertex_index in pins]
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.unwrap(method='ANGLE_BASED', fill_holes=True, correct_aspect=True, margin=0.0)
        bpy.ops.object.mode_set(mode='OBJECT')
        uv = me.uv_layers.active.data
    pos, uvs = [], []
    for p in me.polygons:
        for li in p.loop_indices:
            pos += list(me.vertices[me.loops[li].vertex_index].co)
            uvs += list(uv[li].uv)
    seams = []
    for e in me.edges:
        if e.use_seam:
            seams += list(me.vertices[e.vertices[0]].co) + list(me.vertices[e.vertices[1]].co)
    return {"name": name, "positions": pos, "uvs": uvs, "seams": seams, "before": before or uvs, "pins": pinned}

eps = 1e-4
def holed():
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=16, y_subdivisions=16, size=2)
    me = bpy.context.active_object.data
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_center_median().length < 0.3], context='FACES')
    for v in bm.verts: v.co.z = 0.25 * math.sin(3 * v.co.x) * math.cos(2 * v.co.y)
    bm.to_mesh(me)

cases = [
    case("sphere", lambda: bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16),
         lambda a, b: abs(a.y) < eps and abs(b.y) < eps and a.x > -eps and b.x > -eps),
    case("cylinder", lambda: bpy.ops.mesh.primitive_cylinder_add(vertices=32),
         lambda a, b: (abs(abs(a.z) - 1) < eps and abs(a.z - b.z) < eps) or (abs(a.y) < eps and abs(b.y) < eps and a.x > 0 and b.x > 0)),
    case("cube", lambda: bpy.ops.mesh.primitive_cube_add(),
         lambda a, b: (abs(abs(a.z) - 1) < eps and abs(a.z - b.z) < eps and not (a.y > 0.5 and b.y > 0.5))
                      or (a.x < -0.5 and b.x < -0.5 and a.y < -0.5 and b.y < -0.5)),
    case("torus", lambda: bpy.ops.mesh.primitive_torus_add(),
         lambda a, b: abs(a.y) < eps and abs(b.y) < eps and a.x > 0 and b.x > 0),
    case("holed", holed),
    case("suzanne", lambda: bpy.ops.mesh.primitive_monkey_add()),
    case("pinned", holed, pins={0: (0, 0), 16: (0.1, 0.05), 288: (0, 0)}),
]
json.dump(cases, open(sys.argv[sys.argv.index("--") + 1], "w"))
