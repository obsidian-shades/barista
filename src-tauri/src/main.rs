//! The desktop app: the editor (Vite's build, or `pnpm dev` while developing) in a webview, the engine as commands.
//! Each command takes the same JSON body as its route in engine/src/main.rs, which stays for browser work.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use auto_unwrap::edit::{relax as relax_island, reseam as reseam_part, Reseamed};
use auto_unwrap::req::{EdgeLoopReq, IslandsReq, PackReq, ReseamReq, UnwrapReq};
use auto_unwrap::topology::edge_loop as walk_loop;
use auto_unwrap::{repack, shapes as core_shapes, unwrap as unwrap_parts, Output};

/// Solver work runs off the async threads; a panic comes back as an error instead of killing the app.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("unwrap crashed: {e}"))?
}

#[tauri::command]
async fn unwrap(body: UnwrapReq) -> Result<Output, String> {
    blocking(move || unwrap_parts(&body.parts, body.params)).await
}

#[tauri::command]
async fn reseam(body: ReseamReq) -> Result<Reseamed, String> {
    blocking(move || reseam_part(&body.part, &body.params)).await
}

#[tauri::command]
async fn pack(body: PackReq) -> Result<Vec<Vec<f32>>, String> {
    blocking(move || Ok(repack(body.islands, body.rotate))).await
}

#[tauri::command]
async fn relax(body: IslandsReq) -> Result<Vec<Vec<f32>>, String> {
    blocking(move || body.islands.iter().map(relax_island).collect()).await
}

#[tauri::command]
async fn edge_loop(body: EdgeLoopReq) -> Result<Vec<f32>, String> {
    blocking(move || walk_loop(&body.positions, &body.edge)).await
}

#[tauri::command]
fn shapes() -> &'static [&'static str] {
    &core_shapes::NAMES[..]
}

#[tauri::command]
fn shape(body: String) -> Result<Vec<f32>, String> {
    core_shapes::get(&body).ok_or(format!("no shape called {body}"))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![unwrap, reseam, pack, relax, edge_loop, shapes, shape])
        .run(tauri::generate_context!())
        .expect("couldn't start Auto Unwrap");
}
