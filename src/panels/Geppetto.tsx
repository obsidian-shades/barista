// Geppetto: rigging by parts. Auto-rig lays a bone at every part's joint, parents them by contact and reads each one's
// motion (a magazine slides, a trigger hinges, buttons press); fixed housing follows its parent. Then the artist fixes
// the guess directly in the viewport: drag a bone to move it, a joint to reshape it, its tip to aim it. The panel has
// the precise values, limits, and constraints (Follow / Aim / Stretch / Piston); G / R adds an axis gizmo when wanted.
// The FBX export carries the skeleton and the binding to Blender and engines.
import { Fragment, useState, type ReactNode } from 'react';
import { boneLength, isAncestor, isDescendant, motionOf, moveRange, type Bone, type ConstraintKind, type Range, type V3 } from '../rig';
import type { Motion } from '../autorig';
import {
  addConstraint, autoRigModel, bindNearest, bindPart, bonesForParts, boundCounts, deleteBone, endChain, flipBone, partBone, partsMenu, rangeToPose, rigMenu, rigStep, removeConstraint, resetPose, selectBone,
  setBoneMotion, setPose, setRigMode, setRigTool, toggleRigGizmo, updateBone, updateConstraint, useApp, type RigTool,
} from '../store';
import { boneColor } from '../views/RigView';
import { ToolStrip, type ToolDef } from '../shell/PolyTools';
import { dots, ico } from '../ui/Icon';
import { Panel } from './Dock';

const RIG_TOOLS: Partial<Record<RigTool, ToolDef>>[] = [{
  select: { name: 'Select', key: 'V', tip: 'Click a part (then Auto-rig or Add bone), or a bone; Move / Rotate with the gizmo (G / R)', run: () => setRigTool('select'), on: () => true,
    icon: ico(['M4 2l11.2 8.1-5.1.8 2.7 5.3-2.2 1.1-2.7-5.4L4 15z', 'F']) },
  bone: { name: 'Draw bones', key: 'B', tip: 'Extra bones by hand: click on the model for the head, then once per joint (each lands halfway through the surface). Esc ends the chain', run: () => setRigTool('bone'), on: () => true,
    icon: ico(['M3.5 16.5L5.5 10 16.5 3.5 10 14.5z', 'A'], 'M3.5 16.5L5.5 10 16.5 3.5 10 14.5zM5.5 10L10 14.5', [dots([[3.5, 16.5], [16.5, 3.5]], 1.6), 'F']) },
}];

export function RigToolStrip() {
  const tool = useApp((s) => s.rigTool), pose = useApp((s) => s.rigMode === 'pose');
  return <ToolStrip label="Geppetto tools" groups={RIG_TOOLS} pressed={(id) => tool === id} mode={() => true} on={(t) => !pose || t === RIG_TOOLS[0].select} pick={(id) => setRigTool(id)} />;
}

/** The tool, Edit / Pose, Auto-rig, Add bone, the optional gizmo, and what to do next. */
export function RigOptionsBar() {
  const tool = useApp((s) => s.rigTool), mode = useApp((s) => s.rigMode), gizmo = useApp((s) => s.rigGizmo), gizmoOn = useApp((s) => s.rigGizmoOn), chain = useApp((s) => !!s.rigChain);
  const pick = useApp((s) => s.rigPick);
  const has = useApp((s) => s.rig.bones.length > 0), bone = useApp((s) => s.rig.bones[s.rigSel]?.name), part = useApp((s) => s.parts[s.activePart]?.name);
  const free = useApp((s) => { const p = s.parts[s.activePart]; if (!p) return false; const b = partBone(s.rig, s.activePart); return !(b >= 0 && s.rig.bones[b]?.name === p.name); });
  const t = RIG_TOOLS[0][tool] ?? RIG_TOOLS[0].select!;
  const constrained = useApp((s) => !!s.rig.bones[s.rigSel]?.constraints?.length);
  const hint = pick
    ? `${pick === 'copyRot' ? 'Copy rotation' : pick === 'copyLoc' ? 'Copy location' : pick[0].toUpperCase() + pick.slice(1)}: click the target bone or part`
    : !has ? 'Auto-rig (Shift+A) puts a bone at every part’s joint and parents them by contact'
      : gizmoOn ? `Gizmo on (${gizmo === 'move' ? 'Move' : 'Rotate'}): drag its handles, or click Gizmo off to drag bones directly`
        : mode === 'pose'
          ? bone ? (constrained ? `${bone} is driven by a constraint: pose its target, or lower its influence` : `Drag ${bone} to slide it, its tip to turn it — limits hold`) : 'Click a part to pose its bone'
          : tool === 'bone' ? (chain ? 'Click the next joint · Esc ends the chain' : 'Click the model where the first joint goes')
            : !part ? 'Click a part' : free ? `${part} has no bone of its own: Add bone (A) or Auto-rig` : bone ? 'Drag a bone to move it · drag a joint to reshape it · drag its tip to aim it' : 'Click a part';
  return (
    <div className="options">
      <span className="toolname">{t.icon}{t.name}</span>
      <span className="seg" role="group" aria-label="Mode" title="Edit lays the bones out, Pose moves them (Tab)">
        <button aria-pressed={mode === 'edit'} onClick={() => setRigMode('edit')}>Edit</button>
        <button aria-pressed={mode === 'pose'} disabled={!has && mode !== 'pose'} title={has ? 'Pose the bones (Tab)' : 'Auto-rig or add a bone first'} onClick={() => setRigMode('pose')}>Pose</button>
      </span>
      {mode === 'edit' && <>
        <button onClick={() => autoRigModel()} title="A bone for every part, at its joint, with its parent and range of motion guessed (Shift+A). Replaces the rig; Ctrl+Z puts the old one back">Auto-rig</button>
        <button disabled={!part || !free} onClick={() => bonesForParts([useApp.getState().activePart])}
          title={free ? `A bone along ${part}, bound to it (A); a part riding a shared parent bone gets its own` : part ? `${part} already has its own bone` : 'Click a part first'}>Add bone</button>
        {bone && <button onClick={() => flipBone()} title="Swap the bone’s ends: it turns about the other one">Flip</button>}
      </>}
      {has && <button className={gizmoOn ? 'on' : ''} aria-pressed={gizmoOn} onClick={toggleRigGizmo}
        title={`Gizmo: ${gizmo === 'move' ? 'Move' : 'Rotate'} (G / R switch, click to hide). Not needed: drag bones and joints directly.`}>Gizmo</button>}
      {chain && <button onClick={endChain} title="End the chain (Esc)">Finish chain</button>}
      {mode === 'pose' && <button onClick={() => resetPose()} title="Every bone back to its rest pose">Reset pose</button>}
      <span className="hint">{hint}</span>
    </div>
  );
}

/** The bones as a tree: depth by indent, each row in its bone's colour with how many triangles it moves. */
function BoneTree() {
  const rig = useApp((s) => s.rig), sel = useApp((s) => s.rigSel);
  const counts = boundCounts(rig);
  const rows: { i: number; depth: number }[] = [];
  const walk = (parent: number, depth: number) => rig.bones.forEach((b, i) => { if (b.parent === parent) { rows.push({ i, depth }); walk(i, depth + 1); } });
  walk(-1, 0);
  if (!rows.length) return <p className="hint">No bones yet. Auto-rig (Shift+A) lays a bone at every part’s joint and parents them by contact.</p>;
  return (
    <div className="rules" role="listbox" aria-label="Bones">
      {rows.map(({ i, depth }) => {
        const b = rig.bones[i], motion = motionOf(b);
        return (
          <button key={i} role="option" aria-selected={i === sel} className={`rule${i === sel ? ' on' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => selectBone(i)}
            onContextMenu={(e) => { e.preventDefault(); selectBone(i); rigMenu(e.clientX, e.clientY); }}
            title={`${counts[i] ? `${counts[i].toLocaleString()} triangles follow ${b.name}` : 'Nothing is bound to this bone yet'}${motion === 'custom' ? '' : ` · ${motion}`}${b.constraints?.length ? ` · ${b.constraints.length} constraint${b.constraints.length > 1 ? 's' : ''}` : ''}`}>
            <span className="swatch" style={{ background: `#${boneColor(i).getHexString()}`, width: 10, height: 10, borderRadius: 2, flex: 'none' }} />
            <span className="rname">{b.name}</span>
            {b.connected && <span className="hint" title="Connected: its head is its parent’s tail">⛓</span>}
            {motion === 'hinge' && <span className="hint" title="Hinge: it turns about one axis">⟳</span>}
            {(motion === 'slide' || motion === 'press') && <span className="hint" title={motion === 'slide' ? 'Slides along the bone' : 'Presses in and out'}>↔</span>}
            {motion === 'fixed' && <span className="hint" title="Locked">▣</span>}
            {!!b.constraints?.length && <span className="hint" title="Driven by a constraint">⇢</span>}
            <span className="num">{counts[i] ? counts[i].toLocaleString() : ''}</span>
          </button>
        );
      })}
    </div>
  );
}

const AXES = ['x', 'y', 'z'] as const;
const ZERO = (): { x: Range; y: Range; z: Range } => ({ x: [0, 0], y: [0, 0], z: [0, 0] });
/** A number field that commits on Enter or blur (typing "-" on the way to "-45" must not snap back). */
function Num({ value, onSet, title, step = 1 }: { value: number; onSet: (v: number) => void; title: string; step?: number }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => { if (text !== null && Number.isFinite(+text)) onSet(+text); setText(null); };
  return <input type="number" className="inc" step={step} title={title} value={text ?? +value.toFixed(3)} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}

const CONSTRAINTS: { kind: ConstraintKind; label: string; tip: string }[] = [
  { kind: 'follow', label: 'Follow', tip: 'Blender’s Child Of: it moves with the target, keeping the offset it has now' },
  { kind: 'aim', label: 'Aim', tip: 'Damped Track: its Y points at the target point, whatever the target does' },
  { kind: 'stretch', label: 'Stretch', tip: 'Aims and stretches the bone until its tail reaches the target point' },
  { kind: 'piston', label: 'Piston', tip: 'Aim + stretch: a rod that stays in the socket it points at' },
  { kind: 'copyRot', label: 'Copy rotation', tip: 'Takes the target’s rotation, keeping this bone’s offset' },
  { kind: 'copyLoc', label: 'Copy location', tip: 'Takes the target’s position, keeping this bone’s offset' },
];
const MOTIONS: { kind: Motion; label: string; tip: string }[] = [
  { kind: 'free', label: 'Free', tip: 'No limits: it turns and moves freely' },
  { kind: 'hinge', label: 'Hinge', tip: 'Turns about its own X, ±90°; it does not translate. Lays the bone on its part so it swings across the part’s thin side, pivot at the contact' },
  { kind: 'slide', label: 'Slide', tip: 'Locked rotation, translation along its part’s length (a magazine, a rail); the bone is laid along the part' },
  { kind: 'press', label: 'Press', tip: 'Locked rotation, a short press inward (a button); the bone is laid across the part' },
  { kind: 'fixed', label: 'Fixed', tip: 'Locked rotation and translation: it rides its parent rigidly' },
];

/** The active bone: name, parent, joint, roll, motion, limits, constraints, and (Pose) where it is now. */
function BoneSettings() {
  const rig = useApp((s) => s.rig), i = useApp((s) => s.rigSel), mode = useApp((s) => s.rigMode), pose = useApp((s) => s.pose[s.rigSel]);
  const [kind, setKind] = useState<ConstraintKind>('follow'), [target, setTarget] = useState(-1), [limitsOpen, setLimitsOpen] = useState(false);
  const b = rig.bones[i];
  if (!b) return <p className="hint">Pick a bone to set its parent, joint, roll, range of motion and constraints.</p>;
  const set = (p: Partial<Bone>) => updateBone(i, p);
  const lim = b.limit, mr = moveRange(b), motion = motionOf(b), cs = b.constraints ?? [];
  const full = (c: (typeof cs)[number]) => c.influence >= 0.999;
  const drivenRot = cs.some((c) => full(c) && (c.kind === 'follow' || c.kind === 'copyRot'));
  const aimed = cs.some((c) => full(c) && (c.kind === 'aim' || c.kind === 'stretch' || c.kind === 'piston'));
  const drivenLoc = cs.some((c) => full(c) && (c.kind === 'follow' || c.kind === 'copyLoc'));
  const setAxis = (k: (typeof AXES)[number], r: Range) => lim && set({ limit: { ...lim, [k]: r } });
  const setMoveAxis = (k: (typeof AXES)[number], r: Range) => mr && set({ move: { ...mr, [k]: r } });
  const row = (label: ReactNode, body: ReactNode, title?: string) => <label title={title}><span>{label}</span><span>{body}</span></label>;
  const rot = pose?.rot ?? [0, 0, 0], loc = pose?.loc ?? [0, 0, 0], slide = pose?.slide ?? 0;
  // the constraint target may not be this bone or one of its descendants (that would feed back)
  const targets = rig.bones.map((_, j) => j).filter((j) => j !== i && !isDescendant(rig.bones, j, i));
  const t = targets.includes(target) ? target : targets[0] ?? -1;
  return (
    <div className="settings">
      {row('Name', <input key={`${i}:${b.name}`} defaultValue={b.name} style={{ width: 144 }} onBlur={(e) => set({ name: e.target.value.trim() })} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />)}
      {row('Parent', (
        <select value={b.parent} onChange={(e) => set({ parent: +e.target.value })}>
          <option value={-1}>None (root)</option>
          {rig.bones.map((o, j) => (isAncestor(rig.bones, i, j) ? null : <option key={j} value={j}>{o.name}</option>))}
        </select>
      ), 'The bone this one moves with')}
      <label className="toggle" title="Blender’s Connected: the head is glued to the parent’s tail (a chain joint), so it can only turn">
        <input type="checkbox" checked={!!b.connected} disabled={b.parent < 0} onChange={(e) => set({ connected: e.target.checked })} />Connected
      </label>
      {row('Length', <span className="num">{+boneLength(b).toPrecision(4)}</span>)}
      {row('Roll', <><Num value={b.roll ?? 0} onSet={(v) => set({ roll: v })} title="Turn the bone about its own length: where its hinge (local X) points" />°</>)}
      <div className="tsec"><span className="caps">Motion</span><button onClick={() => setBoneMotion(i, 'auto')} title="Fit the joint, direction, roll and range to the part bound to this bone">Auto fit</button></div>
      <span className="seg motion" role="group" aria-label="Motion">
        {MOTIONS.map((m) => <button key={m.kind} aria-pressed={motion === m.kind} onClick={() => setBoneMotion(i, m.kind)} title={m.tip}>{m.label}</button>)}
      </span>
      {motion === 'custom' && <p className="hint">Custom limits: pick a preset, or edit them under Limits.</p>}

      <details className="tsec-details">
        <summary><span className="caps">Joint</span></summary>
        {(['head', 'tail'] as const).map((k) => (
          <label key={k} title={`${k === 'head' ? 'The joint it turns about' : 'The far end'} in model units`}><span>{k === 'head' ? 'Head' : 'Tail'}</span><span>
            {[0, 1, 2].map((a) => <Num key={a} value={b[k][a]} step={0.1} onSet={(v) => { const p = [...b[k]] as V3; p[a] = v; set({ [k]: p }); }} title={`${k} ${'XYZ'[a]}`} />)}
          </span></label>
        ))}
      </details>

      <div className="tsec"><span className="caps">Constraints</span><span className="hint">editor</span></div>
      {cs.map((c, k) => (
        <div className="crow" key={k} title={CONSTRAINTS.find((x) => x.kind === c.kind)?.tip}>
          <span className="cname">{CONSTRAINTS.find((x) => x.kind === c.kind)?.label ?? c.kind}</span>
          <select value={c.target} onChange={(e) => updateConstraint(i, k, { target: +e.target.value })}>
            {rig.bones.map((o, j) => (j === i || isDescendant(rig.bones, j, i) ? null : <option key={j} value={j}>{o.name}</option>))}
          </select>
          <input type="range" min={0} max={1} step={0.01} value={c.influence} title="Influence" onChange={(e) => updateConstraint(i, k, { influence: +e.target.value })} />
          <button onClick={() => removeConstraint(i, k)} title="Remove this constraint">×</button>
        </div>
      ))}
      {targets.length > 0 ? (
        <div className="crow">
          <select value={kind} onChange={(e) => setKind(e.target.value as ConstraintKind)} title="What the target drives" style={{ width: 96 }}>
            {CONSTRAINTS.map((c) => <option key={c.kind} value={c.kind} title={c.tip}>{c.label}</option>)}
          </select>
          <select value={t} onChange={(e) => setTarget(+e.target.value)} title="The part (bone) that drives it">
            {targets.map((j) => <option key={j} value={j}>{rig.bones[j].name}</option>)}
          </select>
          <button disabled={t < 0} onClick={() => addConstraint(i, kind, t)} title="Add the constraint, keeping the offset it has now">Add</button>
        </div>
      ) : <p className="hint">No other bone to follow yet.</p>}
      {cs.some((c) => c.kind === 'aim' || c.kind === 'stretch' || c.kind === 'piston') && <p className="hint">Aim and stretch read the point on the target nearest this bone’s tail; it moves with the target.</p>}

      <details className="tsec-details" open={limitsOpen} onToggle={(e) => setLimitsOpen(e.currentTarget.open)}>
        <summary className="tsec"><span className="caps">Limits</span><span className="hint">{lim ? `${AXES.filter((k) => lim[k][0] !== lim[k][1]).length || 'no'} turning` : 'free'}{mr ? ` · ${AXES.filter((k) => mr[k][0] !== mr[k][1]).length || 'no'} moving` : ' · free to move'}</span></summary>
        <label className="toggle" title="Off: it turns freely. On: each axis turns only between its min and max (min = max locks it), as Blender’s Limit Rotation">
          <input type="checkbox" checked={!!lim} onChange={(e) => set({ limit: e.target.checked ? { x: [-90, 90], y: [0, 0], z: [0, 0] } : null })} />Limited rotation
        </label>
        {lim && (
          <>
            <span className="seg" role="group" aria-label="Limit presets">
              <button title="Turns on X only, ±90° (an elbow, a trigger, a hinge)" onClick={() => set({ limit: { x: [-90, 90], y: [0, 0], z: [0, 0] } })}>Hinge</button>
              <button title="Turns on every axis, ±45° (a shoulder, a ball joint)" onClick={() => set({ limit: { x: [-45, 45], y: [-45, 45], z: [-45, 45] } })}>Ball</button>
              <button title="Does not turn (a piston rod that only slides, a fixed plate)" onClick={() => set({ limit: { x: [0, 0], y: [0, 0], z: [0, 0] } })}>Locked</button>
            </span>
            {AXES.map((k) => <Fragment key={`turn-${k}`}>{row(`${k.toUpperCase()} min / max`, <>
              <Num value={lim[k][0]} onSet={(v) => setAxis(k, [v, lim[k][1]])} title={`Lowest turn about the bone's ${k.toUpperCase()}, degrees`} />
              <Num value={lim[k][1]} onSet={(v) => setAxis(k, [lim[k][0], v])} title={`Highest turn about the bone's ${k.toUpperCase()}, degrees`} />°
            </>, k === 'y' ? 'Y runs along the bone: a turn about it is a twist' : undefined)}</Fragment>)}
          </>
        )}
        <label className="toggle" title="Off: it translates freely (Move in Pose). On: each axis is held between min and max (min = max locks it). Connected bones cannot translate, as in Blender">
          <input type="checkbox" checked={!!mr} disabled={!!b.connected} onChange={(e) => set({ move: e.target.checked ? ZERO() : null })} />Limited movement
        </label>
        {mr && AXES.map((k) => <Fragment key={`move-${k}`}>{row(`${k.toUpperCase()} min / max`, <>
          <Num value={mr[k][0]} step={0.1} onSet={(v) => setMoveAxis(k, [v, mr[k][1]])} title={`Furthest back along the bone's ${k.toUpperCase()}`} />
          <Num value={mr[k][1]} step={0.1} onSet={(v) => setMoveAxis(k, [mr[k][0], v])} title={`Furthest out along the bone's ${k.toUpperCase()}`} />
        </>)}</Fragment>)}
      </details>

      {mode === 'pose' && (
        <>
          <div className="tsec"><span className="caps">Pose</span><span className="pbtns">
            <button disabled={!pose || (!lim && !mr)} onClick={() => rangeToPose(i)} title="Make where it is now the end of its travel: each axis it is turned or moved on gets rest … here as its range. Pull the slide back, the trigger in, the magazine out, then click">Range to here</button>
            <button onClick={() => resetPose(false)} title="This bone back to its rest pose">Reset</button>
          </span></div>
          {(drivenRot || aimed || drivenLoc) && <p className="hint">Driven by a constraint: {drivenRot || drivenLoc ? 'pose its target' : 'only the twist about its own Y is free'}.</p>}
          {!drivenRot && AXES.map((k, a) => {
            if (aimed && k !== 'y') return null;
            const r = lim ? lim[k] : [-180, 180];
            if (r[0] === r[1]) return null;
            return <Fragment key={`rot-${k}`}>{row(k.toUpperCase(), <>
              <input type="range" min={Math.min(...r)} max={Math.max(...r)} step={1} value={rot[a]} onPointerDown={rigStep} onChange={(e) => { const v = [...rot] as typeof rot; v[a] = +e.target.value; setPose(i, { rot: v, slide, loc }); }} />
              <output>{Math.round(rot[a])}°</output>
            </>)}</Fragment>;
          })}
          {!b.connected && !drivenLoc && AXES.map((k, a) => {
            const r = mr ? mr[k] : [-Math.max(boneLength(b), 1e-3), Math.max(boneLength(b), 1e-3)];
            if (r[0] === r[1]) return null;
            return <Fragment key={`loc-${k}`}>{row(`Move ${k.toUpperCase()}`, <>
              <input type="range" min={Math.min(...r)} max={Math.max(...r)} step={(Math.abs(r[1] - r[0]) || 1) / 200} value={loc[a]} onPointerDown={rigStep}
                onChange={(e) => { const v = [...loc] as typeof loc; v[a] = +e.target.value; setPose(i, { rot, slide, loc: v }); }} />
              <output>{+loc[a].toPrecision(3)}</output>
            </>)}</Fragment>;
          })}
          {b.connected && <p className="hint">Connected to its parent: it turns only.</p>}
        </>
      )}

      <div className="tgrid two">
        <button onClick={() => bindNearest(useApp.getState().activePart)} disabled={!rig.bones.length} title="Give each triangle of the active part to the bone nearest it: one mesh that spans a joint gets a piece per bone">Skin part</button>
        <button onClick={deleteBone} disabled={mode === 'pose'} title="Delete this bone (X): its children and parts go to its parent">Delete bone</button>
      </div>
    </div>
  );
}

/** Each part and the bone it follows: the plain way to bind (the Parts list and clicking a part do the same). */
function RigParts() {
  const parts = useApp((s) => s.parts), rig = useApp((s) => s.rig), pose = useApp((s) => s.rigMode === 'pose'), active = useApp((s) => s.activePart);
  if (!parts.length) return <p className="hint">No model open.</p>;
  return (
    <div className="settings">
      {parts.map((p, i) => {
        const b = partBone(rig, i);
        return (
          <label key={i} onContextMenu={(e) => { e.preventDefault(); partsMenu(e.clientX, e.clientY, i); }} title={b === -2 ? 'Its pieces follow different bones (Skin part); picking one binds the whole part' : `The bone ${p.name} moves with`}>
            <span role="button" style={{ cursor: 'pointer', color: i === active ? 'var(--fg)' : undefined }} onClick={(e) => { e.preventDefault(); useApp.setState({ activePart: i, rigSel: b >= 0 ? b : -1, rigEnd: 'body' }); }}>
              {b >= 0 && <span style={{ background: `#${boneColor(b).getHexString()}`, width: 8, height: 8, borderRadius: 2, flex: 'none' }} />}{p.name}
            </span>
            <select value={b} disabled={pose} onChange={(e) => bindPart(i, +e.target.value)}>
              <option value={-1}>No bone</option>
              {b === -2 && <option value={-2} disabled>Mixed</option>}
              {rig.bones.map((o, j) => <option key={j} value={j}>{o.name}</option>)}
            </select>
          </label>
        );
      })}
    </div>
  );
}

export function Geppetto() {
  return (
    <aside className="dock">
      <Panel title="Bones" grow>
        <BoneTree />
        <div className="tsec"><span className="caps">Bone</span></div>
        <BoneSettings />
      </Panel>
      <Panel title="Parts"><RigParts /></Panel>
    </aside>
  );
}
