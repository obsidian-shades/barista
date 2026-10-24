//! HTTP server: the unwrap engine on /api, nothing else. The editor is served by Vite (`pnpm dev`, :5173), which
//! proxies /api here, so there is only ever one editor to open.
use barista::edit::{relax, reseam, Reseamed};
use barista::project::{open_pack, save_pack, OpenReq};
use barista::texture::{export as texture_export, status as texture_status, ExportDone};
use barista::req::{EdgeLoopReq, IslandsReq, PackReq, ReseamReq, UnwrapReq};
use barista::topology::edge_loop;
use barista::{repack, shapes, unwrap, Output};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path};
use axum::http::header;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use tower_http::compression::CompressionLayer;

type Fail = (StatusCode, String);

/// Solver work runs off the async threads; a panic comes back as a 500 instead of killing the server.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<Json<T>, Fail> {
    match tokio::task::spawn_blocking(f).await {
        Ok(Ok(v)) => Ok(Json(v)),
        Ok(Err(e)) => Err((StatusCode::BAD_REQUEST, e)),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, format!("unwrap crashed: {e}"))),
    }
}

async fn unwrap_h(Json(r): Json<UnwrapReq>) -> Result<Json<Output>, Fail> {
    blocking(move || unwrap(&r.parts, r.params)).await
}

async fn reseam_h(Json(r): Json<ReseamReq>) -> Result<Json<Reseamed>, Fail> {
    blocking(move || reseam(&r.part, &r.params)).await
}

async fn pack_h(Json(r): Json<PackReq>) -> Result<Json<Vec<Vec<f32>>>, Fail> {
    blocking(move || Ok(repack(r.islands, r.rotate))).await
}

async fn edge_loop_h(Json(r): Json<EdgeLoopReq>) -> Result<Json<Vec<f32>>, Fail> {
    blocking(move || edge_loop(&r.positions, &r.edge)).await
}

async fn relax_h(Json(r): Json<IslandsReq>) -> Result<Json<Vec<Vec<f32>>>, Fail> {
    blocking(move || r.islands.iter().map(relax).collect()).await
}

/// `.barista` save: a Pack (project.rs) in, the path written out (null: the dialog was cancelled).
async fn project_save_h(body: Bytes) -> Result<Json<Option<String>>, Fail> {
    blocking(move || save_pack(&body)).await
}

/// `.barista` open: the project back as a Pack (binary).
async fn project_open_h(Json(r): Json<OpenReq>) -> Result<([(header::HeaderName, &'static str); 1], Vec<u8>), Fail> {
    let Json(bytes) = blocking(move || open_pack(&r)).await?;
    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes))
}

/// Full-resolution textures: a Pack (ExportReq + optional FBX) in, the folder and files written out.
async fn texture_export_h(body: Bytes) -> Result<Json<Option<ExportDone>>, Fail> {
    blocking(move || texture_export(&body)).await
}

async fn texture_status_h() -> String {
    texture_status()
}

async fn shapes_h() -> Json<&'static [&'static str]> {
    Json(&shapes::NAMES[..])
}

async fn shape_h(Path(name): Path<String>) -> Result<Json<Vec<f32>>, Fail> {
    shapes::get(&name).map(Json).ok_or((StatusCode::NOT_FOUND, format!("no shape called {name}")))
}

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/api/unwrap", post(unwrap_h))
        .route("/api/reseam", post(reseam_h))
        .route("/api/pack", post(pack_h))
        .route("/api/edge-loop", post(edge_loop_h))
        .route("/api/relax", post(relax_h))
        .route("/api/project-save", post(project_save_h))
        .route("/api/project-open", post(project_open_h))
        .route("/api/texture-export", post(texture_export_h))
        .route("/api/texture-status", get(texture_status_h))
        .route("/api/shapes", get(shapes_h))
        .route("/api/shape/{name}", get(shape_h))
        .layer(DefaultBodyLimit::max(512 << 20)) // meshes come as JSON floats: big files are big requests
        .layer(CompressionLayer::new())
        .fallback(|| async { (StatusCode::NOT_FOUND, "This is the unwrap engine's API (/api/...). The editor runs at http://localhost:5173 (pnpm dev).") });
    let addr = std::env::var("ADDR").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap_or_else(|e| panic!("can't listen on {addr}: {e}"));
    println!("Barista engine API on http://{addr}/api (open the editor at http://localhost:5173, pnpm dev)");
    axum::serve(listener, app).await.unwrap();
}
