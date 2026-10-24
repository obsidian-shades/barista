//! `.barista` project files: one SQLite file with the editor's document (JSON) and its binary blobs (meshes, UVs,
//! paint tiles), each lz4-compressed. A save replaces the file's contents in one transaction, so a crash mid-save
//! leaves the last good save. The editor and the engine swap a project as a `Pack` (`Pack::encode` / `decode`):
//! u32 JSON length, the JSON, then per blob u32 name length, name, u32 data length, data (all little-endian).
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// Bumped when the layout changes in a way an older Barista can't read.
pub const FORMAT: i64 = 1;
pub const EXT: &str = "barista";

pub struct Pack {
    pub json: String,
    pub blobs: Vec<(String, Vec<u8>)>,
}

impl Pack {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + self.json.len() + self.blobs.iter().map(|(n, d)| 8 + n.len() + d.len()).sum::<usize>());
        let mut put = |b: &[u8]| {
            out.extend_from_slice(&(b.len() as u32).to_le_bytes());
            out.extend_from_slice(b);
        };
        put(self.json.as_bytes());
        for (name, data) in &self.blobs {
            put(name.as_bytes());
            put(data);
        }
        out
    }

    pub fn decode(mut b: &[u8]) -> Result<Pack, String> {
        let mut take = || -> Result<Option<&[u8]>, String> {
            if b.is_empty() {
                return Ok(None);
            }
            if b.len() < 4 {
                return Err("project data is cut short".into());
            }
            let n = u32::from_le_bytes(b[..4].try_into().unwrap()) as usize;
            if b.len() < 4 + n {
                return Err("project data is cut short".into());
            }
            let (v, rest) = b[4..].split_at(n);
            b = rest;
            Ok(Some(v))
        };
        let json = String::from_utf8(take()?.ok_or("empty project data")?.to_vec()).map_err(|e| e.to_string())?;
        let mut blobs = Vec::new();
        while let Some(name) = take()? {
            let name = String::from_utf8(name.to_vec()).map_err(|e| e.to_string())?;
            let data = take()?.ok_or("project data is cut short")?.to_vec();
            blobs.push((name, data));
        }
        Ok(Pack { json, blobs })
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                      CREATE TABLE IF NOT EXISTS blob(name TEXT PRIMARY KEY, data BLOB NOT NULL);";

/// Write `doc` and every blob to `path`, replacing what was there.
pub fn save(path: &Path, p: &Pack) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    let mut c = Connection::open(path).map_err(err)?;
    c.execute_batch(SCHEMA).map_err(err)?;
    let t = c.transaction().map_err(err)?;
    t.execute("DELETE FROM blob", []).map_err(err)?;
    for (k, v) in [("format", FORMAT.to_string()), ("app", env!("CARGO_PKG_VERSION").to_string()), ("doc", p.json.clone())] {
        t.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?1, ?2)", params![k, v]).map_err(err)?;
    }
    {
        let mut ins = t.prepare("INSERT INTO blob(name, data) VALUES (?1, ?2)").map_err(err)?;
        for (name, data) in &p.blobs {
            ins.execute(params![name, lz4_flex::compress_prepend_size(data)]).map_err(err)?;
        }
    }
    t.commit().map_err(err)
}

/// The document and every blob of the project at `path`.
pub fn load(path: &Path) -> Result<Pack, String> {
    let c = Connection::open(path).map_err(err)?;
    let meta = |k: &str| c.query_row("SELECT value FROM meta WHERE key = ?1", [k], |r| r.get::<_, String>(0)).optional().map_err(err);
    let format: i64 = meta("format")?.ok_or_else(|| format!("{} isn't a Barista project", path.display()))?.parse().map_err(err)?;
    if format > FORMAT {
        return Err(format!("{} was saved by a newer Barista (format {format}); update to open it", path.display()));
    }
    let json = meta("doc")?.ok_or("the project has no document")?;
    let mut q = c.prepare("SELECT name, data FROM blob").map_err(err)?;
    let blobs = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)))
        .map_err(err)?
        .map(|r| {
            let (name, z) = r.map_err(err)?;
            let data = lz4_flex::decompress_size_prepended(&z).map_err(|e| format!("{name}: {e}"))?;
            Ok((name, data))
        })
        .collect::<Result<_, String>>()?;
    Ok(Pack { json, blobs })
}

/// Where unsaved work autosaves: %APPDATA%\Barista\autosave (or ~/.barista/autosave).
pub fn autosave_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(|d| PathBuf::from(d).join("Barista"))
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".barista")))
        .unwrap_or_else(std::env::temp_dir)
        .join("autosave")
}

/// The system's open / save dialog for projects (the engine shows it, so the browser editor and the app match).
pub fn pick(save: bool, name: &str, dir: Option<&Path>) -> Option<PathBuf> {
    let mut d = rfd::FileDialog::new().add_filter("Barista project", &[EXT]);
    if let Some(dir) = dir {
        d = d.set_directory(dir);
    }
    if save {
        d.set_file_name(format!("{name}.{EXT}")).save_file()
    } else {
        d.pick_file()
    }
}

/// What the editor sends with a save: the target (`path`, else a dialog; `autosave` writes to `autosave_dir` under
/// `name` without asking), and the document.
#[derive(Deserialize)]
pub struct SaveHead {
    pub path: Option<String>,
    #[serde(default)]
    pub save_as: bool,
    #[serde(default)]
    pub autosave: bool,
    pub name: String,
    pub doc: serde_json::Value,
}

/// A save: the path written (None: the dialog was cancelled).
pub fn save_pack(body: &[u8]) -> Result<Option<String>, String> {
    let p = Pack::decode(body)?;
    let head: SaveHead = serde_json::from_str(&p.json).map_err(err)?;
    let path = if head.autosave {
        autosave_dir().join(format!("{}.{EXT}", head.name))
    } else {
        match head.path.as_ref().filter(|_| !head.save_as).map(PathBuf::from) {
            Some(p) => p,
            None => match pick(true, &head.name, head.path.as_deref().map(Path::new).and_then(Path::parent)) {
                Some(p) => p.with_extension(EXT),
                None => return Ok(None),
            },
        }
    };
    save(&path, &Pack { json: head.doc.to_string(), blobs: p.blobs })?;
    Ok(Some(path.display().to_string()))
}

#[derive(Deserialize, Default)]
pub struct OpenReq {
    pub path: Option<String>,
    /// Open the dialog in the autosave folder.
    #[serde(default)]
    pub recover: bool,
}

/// An open: the project as a Pack whose JSON is `{"path", "doc"}`, or `{"cancelled": true}`.
pub fn open_pack(r: &OpenReq) -> Result<Vec<u8>, String> {
    let path = match &r.path {
        Some(p) => PathBuf::from(p),
        None => {
            let dir = r.recover.then(autosave_dir);
            match pick(false, "", dir.as_deref()) {
                Some(p) => p,
                None => return Ok(Pack { json: r#"{"cancelled":true}"#.into(), blobs: vec![] }.encode()),
            }
        }
    };
    let p = load(&path)?;
    let json = format!(r#"{{"path":{},"doc":{}}}"#, serde_json::to_string(&path.display().to_string()).map_err(err)?, p.json);
    Ok(Pack { json, blobs: p.blobs }.encode())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_then_load_round_trips() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("project-test-{}", std::process::id()));
        let path = dir.join("t.barista");
        let blobs = vec![("part/0/soup".to_string(), (0..10_000u32).flat_map(|i| i.to_le_bytes()).collect::<Vec<u8>>()), ("empty".into(), vec![])];
        let p = Pack { json: r#"{"a":1}"#.into(), blobs: blobs.clone() };
        save(&path, &p).unwrap();
        // a second save replaces, never appends
        save(&path, &p).unwrap();
        let back = load(&path).unwrap();
        assert_eq!(back.json, p.json);
        let mut got = back.blobs;
        got.sort();
        let mut want = blobs;
        want.sort();
        assert_eq!(got, want);
        let wire = Pack::decode(&p.encode()).unwrap();
        assert_eq!(wire.json, p.json);
        assert_eq!(wire.blobs.len(), 2);
        std::fs::remove_dir_all(dir).ok();
    }
}
