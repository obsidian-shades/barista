//! Topology-aware editing helpers shared by the Rust engine and editor.
use crate::mesh::{ek, sub, Mesh, V3};

fn unit(v: V3) -> V3 {
    let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if n > 1e-12 { [v[0] / n, v[1] / n, v[2] / n] } else { [0.; 3] }
}

/// Extend a picked edge along the geometrically straightest connected edge at each vertex.
/// This works on triangle soups, where the original quad-face loop structure may already be lost.
/// Returns a deterministic ordered list of endpoint pairs in the input coordinate frame.
pub fn edge_loop(positions: &[f32], seed: &[f32]) -> Result<Vec<f32>, String> {
    if seed.len() != 6 || seed.iter().any(|x| !x.is_finite()) {
        return Err("edge loop needs two finite xyz endpoints".into());
    }
    let mesh = Mesh::from_soup(positions)?;
    let a = mesh.vertex_at([seed[0] as f64, seed[1] as f64, seed[2] as f64]).ok_or("edge endpoint not on mesh")?;
    let b = mesh.vertex_at([seed[3] as f64, seed[4] as f64, seed[5] as f64]).ok_or("edge endpoint not on mesh")?;
    let first = ek(a, b);
    if !mesh.edges.contains_key(&first) { return Err("picked edge is not in mesh topology".into()); }

    let mut links = vec![Vec::<u32>::new(); mesh.p.len()];
    for &key in mesh.edges.keys() {
        let (u, v) = ((key >> 32) as u32, key as u32);
        links[u as usize].push(v);
        links[v as usize].push(u);
    }
    for n in &mut links { n.sort_unstable(); }

    let trace = |start: u32, previous: u32, used: &mut std::collections::HashSet<u64>| {
        let mut chain = Vec::new();
        let (mut prev, mut at) = (previous, start);
        for _ in 0..mesh.edges.len() {
            let incoming = unit(sub(mesh.pt(at), mesh.pt(prev)));
            let next = links[at as usize].iter().copied()
                .filter(|&v| v != prev && !used.contains(&ek(at, v)))
                .map(|v| (v, incoming[0] * unit(sub(mesh.pt(v), mesh.pt(at)))[0]
                    + incoming[1] * unit(sub(mesh.pt(v), mesh.pt(at)))[1]
                    + incoming[2] * unit(sub(mesh.pt(v), mesh.pt(at)))[2]))
                .max_by(|x, y| x.1.total_cmp(&y.1));
            let Some((next, alignment)) = next else { break };
            // Stop at ambiguous corners instead of arbitrarily taking a branch. A straight
            // geometric continuation should keep at least a modest forward component.
            if alignment < 0.25 { break; }
            used.insert(ek(at, next));
            chain.push((at, next));
            prev = at;
            at = next;
        }
        chain
    };

    let mut used = std::collections::HashSet::new();
    used.insert(first);
    let mut left = trace(a, b, &mut used);
    left.reverse();
    let right = trace(b, a, &mut used);
    let mut edges = left;
    edges.push((a, b));
    edges.extend(right);
    let mut out = Vec::with_capacity(edges.len() * 6);
    for (u, v) in edges {
        out.extend(mesh.to_world(mesh.pt(u)));
        out.extend(mesh.to_world(mesh.pt(v)));
    }
    Ok(out)
}
