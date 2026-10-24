//! The desktop app: the editor (Vite's build, or `pnpm dev` while developing) in a webview, the engine as commands.
//! Each command takes the same JSON body as its route in engine/src/main.rs, which stays for browser work.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use barista::edit::{relax as relax_island, reseam as reseam_part, Reseamed};
use barista::project::{open_pack, save_pack, OpenReq};
use barista::texture::{export as texture_export_run, status, ExportDone};
use barista::req::{EdgeLoopReq, IslandsReq, PackReq, ReseamReq, UnwrapReq};
use barista::topology::edge_loop as walk_loop;
use barista::{repack, shapes as core_shapes, unwrap as unwrap_parts, Output};

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

/// `.barista` save: the Pack arrives as the raw request body (src/api.ts `callBin`).
#[tauri::command]
async fn project_save(request: tauri::ipc::Request<'_>) -> Result<Option<String>, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else { return Err("project-save takes raw bytes".into()) };
    let body = body.clone();
    blocking(move || save_pack(&body)).await
}

#[tauri::command]
async fn project_open(body: OpenReq) -> Result<tauri::ipc::Response, String> {
    blocking(move || open_pack(&body)).await.map(tauri::ipc::Response::new)
}

/// Full-resolution textures: the Pack arrives as the raw request body.
#[tauri::command]
async fn texture_export(request: tauri::ipc::Request<'_>) -> Result<Option<ExportDone>, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else { return Err("texture-export takes raw bytes".into()) };
    let body = body.clone();
    blocking(move || texture_export_run(&body)).await
}

#[tauri::command]
fn texture_status() -> String {
    status()
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
        .invoke_handler(tauri::generate_handler![unwrap, reseam, pack, relax, edge_loop, project_save, project_open, texture_export, texture_status, shapes, shape])
        .run(tauri::generate_context!())
        .expect("couldn't start Barista");
}
