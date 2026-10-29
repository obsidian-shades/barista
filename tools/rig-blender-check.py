# blender -b --factory-startup --python tools/rig-blender-check.py -- arm.fbx
# Imports an FBX written by `node src/rig.check.ts arm.fbx` and prints what Blender made of the rig: the armature, each
# bone's head / tail (Blender's Z-up metres), the mesh's vertex groups, and the hand corner after turning "Fore" 90°.
import sys, bpy
from mathutils import Euler
path = sys.argv[sys.argv.index('--') + 1]
bpy.ops.import_scene.fbx(filepath=path)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
mesh = next(o for o in bpy.data.objects if o.type == 'MESH')
w = arm.matrix_world
for b in arm.data.bones:
    print('bone', b.name, 'parent', b.parent.name if b.parent else None, 'head', tuple(round(x, 4) for x in w @ b.head_local), 'tail', tuple(round(x, 4) for x in w @ b.tail_local))
print('groups', [g.name for g in mesh.vertex_groups], 'modifiers', [m.type for m in mesh.modifiers])
pb = arm.pose.bones['Fore']
pb.rotation_mode = 'XYZ'
pb.rotation_euler = Euler((0, 0, 1.5707963), 'XYZ')
bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()
ev = mesh.evaluated_get(dg)
print('posed', sorted(tuple(round(x, 3) for x in mesh.matrix_world @ v.co) for v in ev.data.vertices))
