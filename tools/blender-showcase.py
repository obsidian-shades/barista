# blender -b --factory-startup --python tools/blender-showcase.py -- job.json
# Da Vinci's showcase as a Blender project: the Blender-ready FBX (textured, with its armature) on a turntable that
# turns once a cycle, opening to the editor's pose and closing again, under softbox area lights in a dark studio with a
# glossy floor, atmospheric haze and dust; Cycles on the GPU (OptiX, else CUDA / HIP / oneAPI / Metal) with denoising,
# motion blur, depth of field and a compositor grade, an MP4 output. Saves job["blend"] beside the FBX with every texture
# packed into it, so the one file can be shared and rendered on another machine. The engine runs it after a Blender-ready
# export (`showcase`), embedded in the engine (texture/mod.rs). Distances follow Da Vinci's view, where the model is
# 2 units long: `u` is half the model's longest side, so the scene is the same at any file scale. Three's Y-up ->
# Blender's Z-up: (x, y, z) -> (x, -z, y).
import json, math, random, sys
import bpy
import bmesh
from mathutils import Vector

job = json.load(open(sys.argv[sys.argv.index('--') + 1], encoding='utf-8'))
show = job['show']
cine = bool(show.get('cine', True))
dust = bool(show.get('dust', True))
letterbox = bool(show.get('letterbox', False))
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
bpy.ops.import_scene.fbx(filepath=job['fbx'])
imported = list(bpy.context.selected_objects) or list(scene.objects)
meshes = [o for o in imported if o.type == 'MESH']
arm = next((o for o in imported if o.type == 'ARMATURE'), None)
if not meshes:
    raise RuntimeError('the FBX has no mesh')
bpy.context.view_layer.update()

# the model's box, posed at rest
pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
centre, u = (lo + hi) / 2, max(hi - lo) / 2 or 1.0
at = lambda x, y, z: centre + Vector((x, -z, y)) * u  # a point in Da Vinci's view space

# collections: a shared .blend is a lot easier to read when the model, studio, atmosphere and cameras are separate
def coll(name):
    c = bpy.data.collections.new(name)
    scene.collection.children.link(c)
    return c
def put(o, c):
    for old in list(o.users_collection):
        old.objects.unlink(o)
    c.objects.link(o)
model_c, studio_c, air_c, cam_c = coll('Model'), coll('Studio'), coll('Atmosphere'), coll('Camera')
for o in imported:
    put(o, model_c)

# what reads as a photo, not CG: no real edge is knife-sharp (a Bevel shader rounds every edge at render time, so each
# catches a thin highlight) and no real finish is one roughness (a faint world-space break-up of the painted roughness)
for m in {s.material for o in meshes for s in o.material_slots if s.material and s.material.node_tree}:
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not bsdf:
        continue
    bevel = nodes.new('ShaderNodeBevel')
    bevel.samples = 8
    bevel.inputs['Radius'].default_value = 0.006 * u
    if bsdf.inputs['Normal'].links:
        links.new(bsdf.inputs['Normal'].links[0].from_socket, bevel.inputs['Normal'])
    links.new(bevel.outputs['Normal'], bsdf.inputs['Normal'])
    rough = nodes.new('ShaderNodeMath')
    rough.operation, rough.use_clamp = 'MULTIPLY', True
    if bsdf.inputs['Roughness'].links:
        links.new(bsdf.inputs['Roughness'].links[0].from_socket, rough.inputs[0])
    else:
        rough.inputs[0].default_value = bsdf.inputs['Roughness'].default_value
    coords, noise, spread = nodes.new('ShaderNodeTexCoord'), nodes.new('ShaderNodeTexNoise'), nodes.new('ShaderNodeMapRange')
    noise.inputs['Scale'].default_value = 2.5 / u
    noise.inputs['Detail'].default_value = 8
    spread.inputs['To Min'].default_value, spread.inputs['To Max'].default_value = 0.8, 1.2
    links.new(coords.outputs['Object'], noise.inputs['Vector'])
    links.new(noise.outputs['Fac'], spread.inputs['Value'])
    links.new(spread.outputs['Result'], rough.inputs[1])
    links.new(rough.outputs['Value'], bsdf.inputs['Roughness'])

fps = 30
cycle = 360 / show['spin'] if show['spin'] > 0 else 6.0
frames = max(2, round(cycle * fps))
width = int(job.get('width', 3840))
height = int(job.get('height', 2160))
if letterbox:
    height = max(1, round(width / 2.39))
aspect = width / height
scene.render.fps, scene.frame_start, scene.frame_end = fps, 1, frames
scene.frame_current = 1
frame = lambda t: 1 + t * fps

# turntable: an empty under the model's middle, every imported root parented to it; one linear turn a cycle
table = bpy.data.objects.new('Turntable', None)
model_c.objects.link(table)
table.empty_display_size = 0.3 * u
table.location = (centre.x, centre.y, lo.z)
bpy.context.view_layer.update()
for o in imported:
    if o.parent is None:
        o.parent = table
        o.matrix_parent_inverse = table.matrix_world.inverted()
def fcurves(o):
    ad = o.animation_data
    try:  # Blender 4.4+: layered actions (5.0 dropped Action.fcurves)
        from bpy_extras.anim_utils import action_get_channelbag_for_slot
        return action_get_channelbag_for_slot(ad.action, ad.action_slot).fcurves
    except (ImportError, AttributeError):
        return ad.action.fcurves
def linear(o):
    for fc in fcurves(o):
        for k in fc.keyframe_points:
            k.interpolation = 'LINEAR'
if show['spin'] > 0:
    table.rotation_euler.z = 0
    table.keyframe_insert('rotation_euler', index=2, frame=1)
    table.rotation_euler.z = 2 * math.pi
    table.keyframe_insert('rotation_euler', index=2, frame=frames + 1)  # frame N+1 = frame 1: the loop has no seam
    linear(table)

# open and close: rest -> the editor's pose (its bone frames are Blender's: Y along the bone, roll about it) -> rest,
# shut for the first quarter, eased (Bezier keys) open, held, shut by 85% of the cycle, as Da Vinci's `openness`
posed = 0
if arm and show.get('open') and job.get('pose'):
    a, d = 0.25 * cycle, 0.85 * cycle
    tw = max(1 / fps, min(show.get('tween', 0.9), (d - a) / 2))
    for p in job['pose']:
        pb = arm.pose.bones.get(p['name'])
        if not pb:
            continue
        pb.rotation_mode = 'XYZ'
        rot = [math.radians(v) for v in p['rot']]
        loc = list(p.get('loc') or (0, 0, 0))
        loc[1] += p.get('slide', 0)
        if not any(rot) and not any(loc):
            continue
        posed += 1
        for t, w in ((a, 0), (a + tw, 1), (d - tw, 1), (d, 0)):
            pb.rotation_euler = [v * w for v in rot]
            pb.location = [v * w for v in loc]
            pb.keyframe_insert('rotation_euler', frame=frame(t))
            pb.keyframe_insert('location', frame=frame(t))
    for pb in arm.pose.bones:
        pb.rotation_euler, pb.location = (0, 0, 0), (0, 0, 0)
    scene.timeline_markers.new('Open', frame=max(1, round(frame(a))))
    scene.timeline_markers.new('Close', frame=max(1, round(frame(d - tw))))

# camera: Da Vinci's three-quarter product angle, a slow push-in over the cycle, a tracked target and real depth of field.
# Its view is 32 degrees tall; the turntable does the turn, the camera only breathes.
cam_data = bpy.data.cameras.new('Hero')
cam = bpy.data.objects.new('Camera - Hero', cam_data)
cam_c.objects.link(cam)
scene.camera = cam
# a 2.39 frame is the preview's letterbox's visible part: keep its horizontal field of view, not more vertical
cam_angle = math.radians(32)
if letterbox:
    cam_angle = 2 * math.atan(math.tan(cam_angle / 2) * (16 / 9) / 2.39)
# the same framing through a product photographer's long lens (~100 mm): from Da Vinci's distance a 32 degree view bends
# the near end of the model larger, which reads as CG; the camera stands `tele` times farther back instead
tele_angle = 2 * math.atan(math.tan(cam_angle / 2) * 0.44)
tele = math.tan(cam_angle / 2) / math.tan(tele_angle / 2)
back = lambda p: centre + (p - centre) * tele
cam_angle = tele_angle
cam_data.sensor_fit, cam_data.angle = 'VERTICAL', cam_angle
cam_data.clip_start, cam_data.clip_end = 0.01 * u, 100 * u
target = bpy.data.objects.new('Camera Target', None)
cam_c.objects.link(target)
target.empty_display_size = 0.2 * u
target.location = centre
track = cam.constraints.new('TRACK_TO')
track.target, track.track_axis, track.up_axis = target, 'TRACK_NEGATIVE_Z', 'UP_Y'
p0, p1 = back(at(2.8, 0.8, 3.8)), back(at(2.55, 0.7, 3.55))
if show.get('handheld', True):
    for f, p in ((1, p0), (max(2, round(frames / 2)), p1), (frames + 1, p0)):
        cam.location = p
        cam.keyframe_insert('location', frame=f)
    for fc in fcurves(cam):
        for k in fc.keyframe_points:
            k.interpolation, k.handle_left_type, k.handle_right_type = 'BEZIER', 'AUTO_CLAMPED', 'AUTO_CLAMPED'
else:
    cam.location = p0
dof = float(show.get('dof', 0.45))
cam_data.dof.use_dof = dof > 0.02
cam_data.dof.focus_object = target
cam_data.dof.aperture_fstop = max(1.2, 0.9 + (1.0 - dof) * 4.0)
cam_data.dof.aperture_blades, cam_data.dof.aperture_ratio = 7, 1.0
# a second angle is cheap to include and makes the .blend more useful to hand to someone else
low_data = bpy.data.cameras.new('Low')
low = bpy.data.objects.new('Camera - Low', low_data)
cam_c.objects.link(low)
low_data.sensor_fit, low_data.angle = 'VERTICAL', cam_angle * (34 / 32)
low_data.clip_start, low_data.clip_end = 0.01 * u, 100 * u
low.location = back(at(-3.4, 0.32, 4.3))
lt = low.constraints.new('TRACK_TO')
lt.target, lt.track_axis, lt.up_axis = target, 'TRACK_NEGATIVE_Z', 'UP_Y'

def srgb(hexs):
    c = [int(hexs.lstrip('#')[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]

def aim(o, target):
    o.rotation_euler = (target - o.location).to_track_quat('-Z', 'Y').to_euler()

# softboxes: Da Vinci's Lightformers as area lights (power grows with the square of the scene's size); the back halo and
# top strip give the long product-shot highlights and the haze something to catch. Dark rough paint shows mostly what it
# reflects, so: the key is a big box on the camera's side (a gradient down every face, as in a studio photo; a sun lit
# faces flat), the rims stand behind the model so they draw its edges (beside it, one washed a whole flank flat grey)
def area(name, pos, w, h, power, color='#ffffff', spread=180):
    data = bpy.data.lights.new(name, 'AREA')
    data.shape, data.size, data.size_y, data.spread = 'RECTANGLE', w * u, h * u, math.radians(spread)
    data.energy, data.color = power * u * u, srgb(color)
    o = bpy.data.objects.new(name, data)
    studio_c.objects.link(o)
    o.location = pos
    aim(o, centre)
    return o
key, rim, rimc = show['key'], show['rimPower'], show['rim']
area('Softbox top', at(0, 4, 0.5), 5, 3, 66 * key)
area('Key', at(0.8, 2.2, 3.4), 3, 2, 130 * key)
area('Rim left', at(-2.2, 0.9, -4), 0.35, 5, 27 * rim, rimc, 40)
area('Rim right', at(2.2, 0.9, -4), 0.35, 5, 27 * rim, rimc, 40)
area('Fill', at(0, -0.4, 4), 6, 0.6, 5.4 * key)
area('Back halo', at(0, 1.2, -5.2), 4.5, 3.2, 36 * rim, rimc, 130)

# the backdrop as the world: camera rays see the exact show.bg, everything else sees a much dimmer version of it, so the
# dark studio does not flood the model with light; a glossy floor reflects the model and fades into the backdrop
bg = srgb(show['bg'])
world = bpy.data.worlds.new('Barista World')
world.use_nodes = True
nt = world.node_tree
nt.nodes.clear()
out = nt.nodes.new('ShaderNodeOutputWorld')
lp = nt.nodes.new('ShaderNodeLightPath')
visible = nt.nodes.new('ShaderNodeBackground'); visible.inputs['Color'].default_value = (*bg, 1); visible.inputs['Strength'].default_value = 1
ambient = nt.nodes.new('ShaderNodeBackground'); ambient.inputs['Color'].default_value = (*bg, 1); ambient.inputs['Strength'].default_value = 0.22
mixw = nt.nodes.new('ShaderNodeMixShader')
nt.links.new(lp.outputs['Is Camera Ray'], mixw.inputs[0])
nt.links.new(ambient.outputs['Background'], mixw.inputs[1])
nt.links.new(visible.outputs['Background'], mixw.inputs[2])
nt.links.new(mixw.outputs['Shader'], out.inputs['Surface'])
scene.world = world
if show.get('floor', True):
    bpy.ops.mesh.primitive_plane_add(size=8 * u, location=(centre.x, centre.y, lo.z - 0.001 * u))
    floor = bpy.context.active_object
    floor.name = 'Floor'
    put(floor, studio_c)
    mat = bpy.data.materials.new('Floor')
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*[c * 0.45 + 0.002 for c in bg], 1)
    bsdf.inputs['Roughness'].default_value = 0.46
    coords, mapping, grad, ramp = nodes.new('ShaderNodeTexCoord'), nodes.new('ShaderNodeMapping'), nodes.new('ShaderNodeTexGradient'), nodes.new('ShaderNodeMapRange')
    mapping.inputs['Scale'].default_value = (1 / (3 * u),) * 3
    grad.gradient_type = 'SPHERICAL'
    ramp.interpolation_type = 'SMOOTHSTEP'
    ramp.inputs['From Max'].default_value = 0.7
    glow, mix = nodes.new('ShaderNodeEmission'), nodes.new('ShaderNodeMixShader')
    glow.inputs['Color'].default_value = (*bg, 1)
    links.new(coords.outputs['Object'], mapping.inputs['Vector'])
    links.new(mapping.outputs['Vector'], grad.inputs['Vector'])
    links.new(grad.outputs['Fac'], ramp.inputs['Value'])
    links.new(ramp.outputs['Result'], mix.inputs['Fac'])
    links.new(glow.outputs['Emission'], mix.inputs[1])
    links.new(bsdf.outputs['BSDF'], mix.inputs[2])
    links.new(mix.outputs['Shader'], nodes['Material Output'].inputs['Surface'])
    # a faint roughness break-up keeps the mirror from looking like a shader
    noise = nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 0.55 / u
    noise.inputs['Detail'].default_value = 2
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.06
    bump.inputs['Distance'].default_value = 0.006 * u
    links.new(noise.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    floor.data.materials.append(mat)

# atmosphere: a large volume box (gentle, so the softboxes read as beams) and dust motes that catch the rim colour
if dust:
    bpy.ops.mesh.primitive_cube_add(size=16 * u, location=centre)
    volume = bpy.context.active_object
    volume.name = 'Haze'
    put(volume, air_c)
    vm = bpy.data.materials.new('Haze')
    vm.use_nodes = True
    vn = vm.node_tree.nodes
    vn.clear()
    vout = vn.new('ShaderNodeOutputMaterial')
    scatter = vn.new('ShaderNodeVolumeScatter')
    scatter.inputs['Color'].default_value = (0.78, 0.84, 1.0, 1)
    scatter.inputs['Density'].default_value = 0.0008 / u
    scatter.inputs['Anisotropy'].default_value = 0.38
    vm.node_tree.links.new(scatter.outputs['Volume'], vout.inputs['Volume'])
    volume.data.materials.append(vm)
    # tiny emissive icospheres; one mesh, so Cycles sees a single object and the loop is cheap
    rng = random.Random(20261029)
    bm = bmesh.new()
    for i in range(150):
        r = 0.004 * u * (0.55 + rng.random())
        geom = bmesh.ops.create_icosphere(bm, subdivisions=1, radius=r)
        bmesh.ops.translate(bm, verts=geom['verts'], vec=(
            rng.uniform(-3.6, 3.6) * u,
            rng.uniform(-3.6, 3.6) * u,
            rng.uniform(-0.6, 2.8) * u,
        ))
    dust_mesh = bpy.data.meshes.new('Dust')
    bm.to_mesh(dust_mesh)
    bm.free()
    dust_obj = bpy.data.objects.new('Dust', dust_mesh)
    air_c.objects.link(dust_obj)
    dm = bpy.data.materials.new('Dust')
    dm.use_nodes = True
    dn = dm.node_tree.nodes
    dn.clear()
    dout = dn.new('ShaderNodeOutputMaterial')
    em = dn.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = (*srgb(rimc), 1)
    em.inputs['Strength'].default_value = 2.4
    dm.node_tree.links.new(em.outputs['Emission'], dout.inputs['Surface'])
    dust_obj.data.materials.append(dm)

# compositor: a soft fog glow on the highlights, a trace of radial dispersion, an elliptical vignette and film grain.
# Blender 5's compositor is a node group; older versions still use scene.node_tree, so a failed grade is a warning only.
def build_grade():
    if hasattr(scene, 'compositing_node_group'):
        tree = bpy.data.node_groups.new('Barista Grade', 'CompositorNodeTree')
        scene.compositing_node_group = tree
        tree.interface.new_socket(name='Image', in_out='OUTPUT', socket_type='NodeSocketColor')
        final = tree.nodes.new('NodeGroupOutput')
    else:
        scene.use_nodes = True
        tree = scene.node_tree
        tree.nodes.clear()
        final = tree.nodes.new('CompositorNodeComposite')
    nt = tree
    rl = nt.nodes.new('CompositorNodeRLayers')
    glare = nt.nodes.new('CompositorNodeGlare')
    glare.inputs['Type'].default_value = 'Fog Glow'
    glare.inputs['Quality'].default_value = 'High'
    glare.inputs['Threshold'].default_value = 1.05
    glare.inputs['Strength'].default_value = 0.18 + 0.55 * float(show.get('bloom', 0.55))
    glare.inputs['Size'].default_value = 0.55
    lens = nt.nodes.new('CompositorNodeLensdist')
    lens.inputs['Type'].default_value = 'Radial'
    lens.inputs['Distortion'].default_value = 0.0
    lens.inputs['Dispersion'].default_value = 0.009
    coords = nt.nodes.new('CompositorNodeImageCoordinates')
    nt.links.new(lens.outputs['Image'], coords.inputs['Image'])
    # distance from the frame's middle, stretched to the frame's aspect, for the vignette
    sub = nt.nodes.new('ShaderNodeVectorMath'); sub.operation = 'SUBTRACT'; sub.inputs[1].default_value = (0.5, 0.5, 0.5)
    mul = nt.nodes.new('ShaderNodeVectorMath'); mul.operation = 'MULTIPLY'; mul.inputs[1].default_value = (aspect, 1, 1)
    length = nt.nodes.new('ShaderNodeVectorMath'); length.operation = 'LENGTH'
    nt.links.new(coords.outputs['Normalized'], sub.inputs[0])
    nt.links.new(sub.outputs['Vector'], mul.inputs[0])
    nt.links.new(mul.outputs['Vector'], length.inputs[0])
    vign = nt.nodes.new('ShaderNodeMapRange')
    vign.inputs['From Min'].default_value = 0.38
    vign.inputs['From Max'].default_value = 0.98
    vign.inputs['To Min'].default_value = 0.0
    vign.inputs['To Max'].default_value = 0.42
    vign.clamp = True
    nt.links.new(length.outputs['Value'], vign.inputs['Value'])
    mixv = nt.nodes.new('ShaderNodeMix'); mixv.data_type = 'RGBA'; mixv.blend_type = 'MIX'
    nt.links.new(vign.outputs['Result'], mixv.inputs[0])
    nt.links.new(lens.outputs['Image'], mixv.inputs[6])
    mixv.inputs[7].default_value = (0, 0, 0, 1)
    # film grain: white noise in screen space, animated with the frame, added in linear light
    time = nt.nodes.new('CompositorNodeSceneTime')
    wn = nt.nodes.new('ShaderNodeTexWhiteNoise')
    wn.noise_dimensions = '4D'
    nt.links.new(coords.outputs['Normalized'], wn.inputs['Vector'])
    nt.links.new(time.outputs['Frame'], wn.inputs['W'])
    grain = nt.nodes.new('ShaderNodeMapRange')
    amp = 0.045 * float(show.get('grain', 0.28))
    grain.inputs['To Min'].default_value = -amp
    grain.inputs['To Max'].default_value = amp
    nt.links.new(wn.outputs['Value'], grain.inputs['Value'])
    comb = nt.nodes.new('CompositorNodeCombineColor')
    for s in ('Red', 'Green', 'Blue'):
        nt.links.new(grain.outputs['Result'], comb.inputs[s])
    mixg = nt.nodes.new('ShaderNodeMix'); mixg.data_type = 'RGBA'; mixg.blend_type = 'ADD'
    mixg.inputs[0].default_value = 1.0
    nt.links.new(mixv.outputs[2], mixg.inputs[6])
    nt.links.new(comb.outputs['Image'], mixg.inputs[7])
    nt.links.new(rl.outputs['Image'], glare.inputs['Image'])
    nt.links.new(glare.outputs['Image'], lens.inputs['Image'])
    nt.links.new(mixg.outputs[2], final.inputs[0])
    scene.render.use_compositing = True
    try:
        scene.render.use_sequencer = False
    except Exception:
        pass

if cine:
    try:
        build_grade()
        print('showcase: compositor grade on')
    except Exception as e:
        print('showcase: compositor grade skipped:', e)
        try:
            scene.render.use_compositing = False
        except Exception:
            pass
        try:
            if hasattr(scene, 'compositing_node_group'):
                scene.compositing_node_group = None
        except Exception:
            pass

# the model's own pose: a still frame for F12; the .blend opens at frame 1
bpy.context.view_layer.update()

# Cycles on the GPU with the denoiser; the compute device is the user's preference in their own Blender (not saved in
# a .blend), so this picks one for the session and the scene asks for the GPU
scene.render.engine = 'CYCLES'
device = None
try:
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for kind in ('OPTIX', 'CUDA', 'HIP', 'ONEAPI', 'METAL'):
        try:
            prefs.compute_device_type = kind
        except TypeError:
            continue
        prefs.get_devices()
        if any(d.type == kind for d in prefs.devices):
            for d in prefs.devices:
                d.use = d.type == kind
            device = kind
            break
except Exception as e:
    print('showcase: no GPU device:', e)
scene.cycles.device = 'GPU' if device else 'CPU'
# final-frame quality: adaptive sampling stops each pixel once it is clean (most of the dark backdrop at the minimum), so
# the ceiling costs time only where the model's glossy edges need it. Measured on the gun at 2560x1440 (RTX 4070, OptiX):
# threshold 0.004 / 1024 samples / 24 bounces / caustics took 8.6 s a frame, this 4.9 s, and the denoised frames differ
# by 0.05/255 on average: a model floating in a dark room has nothing for caustics or deep bounces to light
scene.cycles.samples = int(job.get('samples', 512))
scene.cycles.use_denoising = True
scene.cycles.use_adaptive_sampling = True
scene.cycles.adaptive_threshold = 0.01
scene.cycles.adaptive_min_samples = 32
scene.cycles.max_bounces = 12
scene.cycles.diffuse_bounces = 4
scene.cycles.glossy_bounces = 8
scene.cycles.transmission_bounces = 8
scene.cycles.transparent_max_bounces = 16
scene.cycles.volume_bounces = 4
scene.cycles.caustics_reflective = scene.cycles.caustics_refractive = False
scene.cycles.blur_glossy = 0.5
# no Persistent Data: faster per frame, but on the 4070 a 360-frame OptiX run died at frame 303 (OPTIX_ERROR_INVALID_VALUE)
# while that frame rendered fine on its own
scene.cycles.sample_clamp_indirect = 20
scene.cycles.filter_width = 1.5
try:
    scene.cycles.denoiser = 'OPENIMAGEDENOISE'
    scene.cycles.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
    scene.cycles.denoising_prefilter = 'ACCURATE'
    scene.cycles.denoising_quality = 'HIGH'
except Exception:
    pass
try:
    scene.cycles.use_light_tree = True
except Exception:
    pass
try:
    scene.cycles.denoising_use_gpu = True
except Exception:
    pass
scene.render.use_motion_blur = True
scene.render.motion_blur_shutter = 0.35
scene.render.film_transparent = False

scene.render.resolution_x, scene.render.resolution_y = width, height
scene.render.resolution_percentage = 100
try:
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = next(l for l in ('AgX - Medium High Contrast', 'Medium High Contrast') if l in [i.identifier for i in scene.view_settings.bl_rna.properties['look'].enum_items])
except Exception:
    pass
try:
    scene.view_settings.exposure = float(show.get('exposure', 0.15))
except Exception:
    pass

# the turn as an MP4 beside the project (Render > Render Animation); a PNG sequence where this Blender has no FFmpeg
scene.render.filepath = f"//render/{job['name']}-"
video = False
try:
    s = scene.render.image_settings
    if hasattr(s, 'media_type'):
        s.media_type = 'VIDEO'
    s.file_format = 'FFMPEG'
    scene.render.ffmpeg.format, scene.render.ffmpeg.codec = 'MPEG4', 'H264'
    scene.render.ffmpeg.constant_rate_factor = 'HIGH'
    try:
        scene.render.ffmpeg.audio_codec = 'NONE'
    except Exception:
        pass
    video = True
except Exception as e:
    print('showcase: no FFmpeg output, PNG frames instead:', e)

# a README inside the .blend, for whoever receives the file
readme = bpy.data.texts.new('README - Barista showcase')
readme.write(
    "Barista / Da Vinci showcase\n"
    "===========================\n\n"
    "The model, materials and textures are packed into this .blend, so the single file is the deliverable.\n\n"
    "Turntable\n"
    "  The 'Turntable' empty in the Model collection turns one full revolution over the timeline. Keys at the\n"
    "  first and last frame make the loop seamless; the camera only breathes in and out.\n\n"
    "Render\n"
    "  Render > Render Animation writes //render/%s-....mp4 (H.264, high quality).\n"
    "  F12 renders the current frame. The scene is Cycles on the GPU with denoising, motion blur and\n"
    "  depth of field, 512 samples (adaptive, noise threshold 0.01) and the denoiser on the GPU. A\n"
    "  quick look: drop Render > Sampling > Render to 128 and raise the noise threshold to 0.02.\n"
    "  For a poster, switch Output to PNG and render at 4K or higher.\n\n"
    "Look\n"
    "  The 'Barista Grade' compositor node group does the bloom, lens dispersion, vignette and grain.\n"
    "  The 'Atmosphere' collection holds the haze volume and the dust; disable it for a clean product shot.\n"
    "  'Camera - Hero' is the edit; 'Camera - Low' is a second angle. The camera target empty can be moved\n"
    "  to reframe without touching either camera.\n" % job['name']
)

scene['barista_showcase'] = True
scene['barista_show_json'] = json.dumps(show)
scene['barista_name'] = job['name']

# save once so Blender knows the file's folder, then pack every texture and make the paths relative: the .blend moves as
# one file, and unpacking it still writes the maps beside it instead of to the old machine's paths
bpy.ops.wm.save_as_mainfile(filepath=job['blend'], compress=True)
try:
    bpy.ops.file.pack_all()
except Exception as e:
    print('showcase: could not pack every image:', e)
try:
    bpy.ops.file.make_paths_relative()
except Exception as e:
    print('showcase: relative paths:', e)
bpy.ops.wm.save_mainfile(compress=True)
print('showcase:', json.dumps({
    'blend': job['blend'], 'frames': frames, 'posed': posed, 'device': device, 'video': video, 'size': u * 2,
    'grade': cine, 'dust': dust, 'dof': cam_data.dof.use_dof, 'resolution': [width, height],
}))
