//! `.barista` project files: one SQLite file with the editor's document (JSON) and its binary blobs (meshes, UVs,
//! paint tiles), each lz4-compressed. The editor and the engine swap a project as a `Pack` (`Pack::encode` / `decode`):
//! u32 JSON length, the JSON, then per blob u32 name length, name, u32 data length, data (all little-endian). An open's
//! Pack says `"lz4": true` and carries each blob still compressed, as the file holds it; a save's carries them raw.
//!
//! A save is incremental: the editor sends the document, the names of the blobs the file already holds unchanged
//! (`keep`, only valid against the file `rev` it last saw) and just the blobs that changed, so a Ctrl+S after a paint
//! stroke writes a few tiles instead of the whole project. The file carries a revision that every save bumps; a save
//! against an older revision is refused (`Saved::stale`) and the editor sends everything again, so two windows on one
//! project can never leave it with half of each. A save that replaces the file outright (Save As, or a stale retry) is
//! still written beside it and renamed over, so a failed one leaves the last good project alone.
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Bumped when the layout changes in a way an older Barista can't read.
pub const FORMAT: i64 = 2;
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

/// A project as it comes off disk.
pub struct Loaded {
    pub pack: Pack,
    /// Bumped by every save; 0 for a file written before revisions (its names can't be trusted for a `keep`).
    pub rev: i64,
    pub format: i64,
}

/// The project format this engine reads and writes. An editor that finds an engine older than its own sends every
/// blob on a save instead of a `keep` list the old engine would drop on the floor.
pub fn format() -> i64 {
    FORMAT
}

#[derive(Serialize, Debug, Default)]
pub struct Saved {
    /// The path written (None: the dialog was cancelled).
    pub path: Option<String>,
    /// The file's revision after the write (0 when nothing was written).
    pub rev: i64,
    /// The file was saved by someone else since this editor last saw it: nothing was written, send everything again.
    #[serde(default)]
    pub stale: bool,
    /// Blobs written this time (the status bar's "saving 3.2 MB" is the editor's own sum).
    #[serde(default)]
    pub written: usize,
}

fn meta_i64(c: &Connection, key: &str) -> Result<Option<i64>, String> {
    c.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get::<_, String>(0))
        .optional()
        .map_err(err)?
        .map(|v| v.parse::<i64>().map_err(err))
        .transpose()
}

fn meta_str(c: &Connection, key: &str) -> Result<Option<String>, String> {
    c.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get::<_, String>(0)).optional().map_err(err)
}

/// The revision an existing file carries (0: older format or unreadable, so the editor rewrites it whole).
pub fn revision(path: &Path) -> i64 {
    if !path.exists() {
        return 0;
    }
    Connection::open(path).ok().and_then(|c| meta_i64(&c, "rev").ok().flatten()).unwrap_or(0)
}

fn file_why(path: &Path, e: String) -> String {
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    format!("Couldn't save {}: {e}. Check that {} exists and this program may write there.", path.display(), dir.display())
}

/// Write `doc` and every blob to `path`, replacing what was there: written whole beside it, then renamed over it, so a
/// failed save never leaves half a project and another program holding the old file can't make SQLite report a
/// "readonly database". Errors say which file and folder, not SQLite's words alone. Returns the new revision.
pub fn save(path: &Path, p: &Pack) -> Result<i64, String> {
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| file_why(path, e.to_string()))?;
    let rev = revision(path) + 1;
    let tmp = path.with_extension(format!("{EXT}.saving"));
    let _ = std::fs::remove_file(&tmp);
    write_full(&tmp, p, rev).map_err(|e| { let _ = std::fs::remove_file(&tmp); file_why(path, e) })?;
    std::fs::rename(&tmp, path)
        .map_err(|e| { let _ = std::fs::remove_file(&tmp); file_why(path, format!("{e} (is it open in another program?)")) })?;
    Ok(rev)
}

fn write_full(path: &Path, p: &Pack, rev: i64) -> Result<(), String> {
    let mut c = Connection::open(path).map_err(err)?;
    c.execute_batch(SCHEMA).map_err(err)?;
    let t = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
    t.execute("DELETE FROM blob", []).map_err(err)?;
    write_meta(&t, p, rev)?;
    insert_blobs(&t, &p.blobs)?;
    t.commit().map_err(err)
}

fn write_meta(t: &rusqlite::Transaction<'_>, p: &Pack, rev: i64) -> Result<(), String> {
    for (k, v) in [("format", FORMAT.to_string()), ("app", env!("CARGO_PKG_VERSION").to_string()), ("rev", rev.to_string()), ("doc", p.json.clone())] {
        t.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?1, ?2)", params![k, v]).map_err(err)?;
    }
    Ok(())
}

fn insert_blobs(t: &rusqlite::Transaction<'_>, blobs: &[(String, Vec<u8>)]) -> Result<usize, String> {
    let mut ins = t.prepare("INSERT OR REPLACE INTO blob(name, data) VALUES (?1, ?2)").map_err(err)?;
    for (name, data) in blobs {
        ins.execute(params![name, lz4_flex::compress_prepend_size(data)]).map_err(err)?;
    }
    Ok(blobs.len())
}

/// The document and every blob of the project at `path`.
pub fn load(path: &Path) -> Result<Loaded, String> {
    read(path, true)
}

/// `unpack` false leaves each blob as the file stores it (u32 size + LZ4 block): an open sends those to the editor,
/// an eighth of the bytes (Gun_Low: 97 MB instead of 811 MB), and it unpacks each tile straight into its layer.
fn read(path: &Path, unpack: bool) -> Result<Loaded, String> {
    // read-only: a path that isn't there must not be created as an empty file
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    let format: i64 = meta_str(&c, "format")?
        .ok_or_else(|| format!("{} isn't a Barista project", path.display()))?
        .parse()
        .map_err(err)?;
    if format > FORMAT {
        return Err(format!("{} was saved by a newer Barista (format {format}); update to open it", path.display()));
    }
    let rev = meta_i64(&c, "rev")?.unwrap_or(0);
    let json = meta_str(&c, "doc")?.ok_or("the project has no document")?;
    let mut q = c.prepare("SELECT name, data FROM blob").map_err(err)?;
    let blobs = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)))
        .map_err(err)?
        .map(|r| {
            let (name, z) = r.map_err(err)?;
            let data = if unpack { lz4_flex::decompress_size_prepended(&z).map_err(|e| format!("{name}: {e}"))? } else { z };
            Ok((name, data))
        })
        .collect::<Result<_, String>>()?;
    Ok(Loaded { pack: Pack { json, blobs }, rev, format })
}

/// Add `p.blobs` to the project at `path`, keeping every blob named in `keep` as it is, and drop the rest. Only valid
/// against `rev`: a file that moved on since the editor saw it gets `Saved::stale`, so the editor can send it all again.
pub fn save_keep(path: &Path, p: &Pack, rev: i64, keep: &[String]) -> Result<Saved, String> {
    // a path that is not there any more must not be created empty and half a project
    if !path.exists() {
        return Ok(Saved { path: Some(path.display().to_string()), rev: 0, stale: true, written: 0 });
    }
    let mut c = match Connection::open(path) {
        Ok(c) => c,
        // deleted or never written under that name: the editor's `keep` names have nowhere to live
        Err(_) => return Ok(Saved { path: Some(path.display().to_string()), rev: 0, stale: true, written: 0 }),
    };
    c.execute_batch(SCHEMA).map_err(err)?;
    let t = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
    let stored = meta_i64(&t, "rev")?.unwrap_or(0);
    let format = meta_i64(&t, "format")?.unwrap_or(0);
    if stored != rev || format > FORMAT || format == 0 {
        return Ok(Saved { path: Some(path.display().to_string()), rev: stored, stale: true, written: 0 });
    }
    // a name the editor thinks it kept but the file doesn't have would come back missing from the document
    {
        let mut has = t.prepare("SELECT 1 FROM blob WHERE name = ?1").map_err(err)?;
        for name in keep {
            if has.query_row([name], |_| Ok(())).optional().map_err(err)?.is_none() {
                return Ok(Saved { path: Some(path.display().to_string()), rev: stored, stale: true, written: 0 });
            }
        }
    }
    t.execute_batch("CREATE TEMP TABLE IF NOT EXISTS keep(name TEXT PRIMARY KEY); DELETE FROM keep;").map_err(err)?;
    {
        let mut ins = t.prepare("INSERT OR IGNORE INTO keep(name) VALUES (?1)").map_err(err)?;
        for name in keep {
            ins.execute([name]).map_err(err)?;
        }
        for (name, _) in &p.blobs {
            ins.execute([name]).map_err(err)?;
        }
    }
    t.execute("DELETE FROM blob WHERE name NOT IN (SELECT name FROM keep)", []).map_err(err)?;
    let written = insert_blobs(&t, &p.blobs)?;
    write_meta(&t, p, rev + 1)?;
    t.commit().map_err(err)?;
    Ok(Saved { path: Some(path.display().to_string()), rev: rev + 1, stale: false, written })
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
/// `name` without asking), the document, and what the file already has: `rev` is the revision the editor last saw and
/// `keep` the blobs unchanged since then (both absent: write the project whole).
#[derive(Deserialize)]
pub struct SaveHead {
    pub path: Option<String>,
    #[serde(default)]
    pub save_as: bool,
    #[serde(default)]
    pub autosave: bool,
    pub name: String,
    pub doc: serde_json::Value,
    #[serde(default)]
    pub rev: Option<i64>,
    #[serde(default)]
    pub keep: Vec<String>,
}

/// A save: the path written (None: the dialog was cancelled) and the revision it now carries.
pub fn save_pack(body: &[u8]) -> Result<Saved, String> {
    let p = Pack::decode(body)?;
    let head: SaveHead = serde_json::from_str(&p.json).map_err(err)?;
    let path = if head.autosave {
        // per process: the desktop app and a browser editor open on the same model must not overwrite each other
        // ponytail: one file per run piles up in the autosave folder; prune old ones if it grows
        autosave_dir().join(format!("{}-{}.{EXT}", head.name, std::process::id()))
    } else {
        match head.path.as_ref().filter(|_| !head.save_as).map(PathBuf::from) {
            Some(p) => p,
            None => match pick(true, &head.name, head.path.as_deref().map(Path::new).and_then(Path::parent)) {
                Some(p) => p.with_extension(EXT),
                None => return Ok(Saved::default()),
            },
        }
    };
    let doc = head.doc.to_string();
    match head.rev {
        // the file this editor had in hand: write just what changed
        Some(rev) => save_keep(&path, &Pack { json: doc, blobs: p.blobs }, rev, &head.keep),
        // a whole new project (Save As, the first save, or a retry after `stale`)
        None => {
            let written = p.blobs.len();
            save(&path, &Pack { json: doc, blobs: p.blobs }).map(|rev| Saved {
                path: Some(path.display().to_string()),
                rev,
                stale: false,
                written,
            })
        }
    }
}

#[derive(Deserialize, Default)]
pub struct OpenReq {
    pub path: Option<String>,
    /// Open the dialog in the autosave folder.
    #[serde(default)]
    pub recover: bool,
}

/// An open: the project as a Pack whose JSON is `{"path", "doc", "rev"}`, or `{"cancelled": true}`.
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
    let Loaded { pack, rev, .. } = read(&path, false)?;
    let json = format!(
        r#"{{"path":{},"rev":{rev},"lz4":true,"doc":{}}}"#,
        serde_json::to_string(&path.display().to_string()).map_err(err)?,
        pack.json
    );
    Ok(Pack { json, blobs: pack.blobs }.encode())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("project-test-{}", std::process::id()))
    }

    fn blob(name: &str, n: u32) -> (String, Vec<u8>) {
        (name.to_string(), (0..n).flat_map(|i| i.to_le_bytes()).collect::<Vec<u8>>())
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = dir();
        let path = dir.join("roundtrip").join("t.barista");
        let blobs = vec![blob("part/0/soup", 10_000), ("empty".into(), vec![])];
        let p = Pack { json: r#"{"a":1}"#.into(), blobs: blobs.clone() };
        let rev = save(&path, &p).unwrap();
        assert_eq!(rev, 1, "a fresh file starts at revision 1");
        // a second save replaces, never appends, and moves the revision on
        assert_eq!(save(&path, &p).unwrap(), 2);
        let back = load(&path).unwrap();
        assert_eq!(back.pack.json, p.json);
        assert_eq!(back.rev, 2);
        assert_eq!(back.format, FORMAT);
        let mut got = back.pack.blobs;
        got.sort();
        let mut want = blobs;
        want.sort();
        assert_eq!(got, want);
        let wire = Pack::decode(&p.encode()).unwrap();
        assert_eq!(wire.json, p.json);
        assert_eq!(wire.blobs.len(), 2);
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn keep_writes_only_what_changed() {
        let dir = dir();
        let path = dir.join("keep").join("keep.barista");
        let big = blob("part/0/soup", 50_000);
        let tile = blob("set/0/1/color/0_0", 10);
        save(&path, &Pack { json: r#"{"v":1}"#.into(), blobs: vec![big.clone(), tile.clone(), blob("gone", 4)] }).unwrap();
        // the second save keeps the mesh and the tile, drops `gone`, writes a new tile
        let fresh = blob("set/0/1/color/1_0", 10);
        let r = save_keep(&path, &Pack { json: r#"{"v":2}"#.into(), blobs: vec![fresh.clone()] }, 1, &[big.0.clone(), tile.0.clone()]).unwrap();
        assert!(!r.stale);
        assert_eq!(r.rev, 2);
        assert_eq!(r.written, 1);
        let back = load(&path).unwrap();
        assert_eq!(back.rev, 2);
        assert_eq!(back.pack.json, r#"{"v":2}"#);
        let names: Vec<&str> = back.pack.blobs.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"part/0/soup"), "a kept blob stays");
        assert!(names.contains(&"set/0/1/color/0_0"));
        assert!(names.contains(&"set/0/1/color/1_0"));
        assert!(!names.contains(&"gone"), "a blob nobody kept or sent is removed");
        // the next save is against revision 2: the old revision is refused and writes nothing
        let stale = save_keep(&path, &Pack { json: r#"{"v":3}"#.into(), blobs: vec![] }, 1, &[big.0.clone()]).unwrap();
        assert!(stale.stale);
        assert_eq!(stale.rev, 2);
        assert_eq!(load(&path).unwrap().pack.json, r#"{"v":2}"#, "a stale save leaves the file alone");
        // a keep name the file doesn't have is caught too (never a document missing a blob)
        let missing = save_keep(&path, &Pack { json: r#"{"v":4}"#.into(), blobs: vec![] }, 2, &["nope".into()]).unwrap();
        assert!(missing.stale);
        assert_eq!(load(&path).unwrap().pack.json, r#"{"v":2}"#);
        // a file that vanished is not recreated empty: the editor is told to write the project whole instead
        let gone = path.with_file_name("gone.barista");
        let r = save_keep(&gone, &Pack { json: "{}".into(), blobs: vec![] }, 2, &[]).unwrap();
        assert!(r.stale);
        assert!(!gone.exists(), "a stale save leaves nothing behind");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn save_pack_reads_rev_and_keep() {
        let dir = dir();
        let dir = dir.join("pack");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("p.barista");
        let head = |doc: &str, extra: &str| {
            format!(r#"{{"path":{},"name":"p","doc":{doc}{extra}}}"#, serde_json::to_string(&path.display().to_string()).unwrap())
        };
        let first = save_pack(&Pack { json: head(r#"{"v":1}"#, ""), blobs: vec![blob("part/0/soup", 1000), blob("set/0/1/color/0_0", 20)] }.encode()).unwrap();
        assert!(!first.stale);
        assert_eq!(first.rev, 1);
        assert_eq!(first.path.as_deref(), Some(path.display().to_string().as_str()));
        // a second save keeps the mesh and writes just the tile it changed
        let pack = Pack {
            json: head(r#"{"v":2}"#, r#","rev":1,"keep":["part/0/soup"]"#),
            blobs: vec![blob("set/0/1/color/1_0", 20)],
        };
        let second = save_pack(&pack.encode()).unwrap();
        assert!(!second.stale);
        assert_eq!(second.rev, 2);
        assert_eq!(second.written, 1);
        let back = load(&path).unwrap();
        assert_eq!(back.pack.json, r#"{"v":2}"#);
        let names: Vec<&str> = back.pack.blobs.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"part/0/soup") && names.contains(&"set/0/1/color/1_0"));
        assert!(!names.contains(&"set/0/1/color/0_0"), "the tile it replaced is gone");
        // a save from an editor that saw an older revision writes nothing
        let stale = Pack { json: head(r#"{"v":3}"#, r#","rev":1,"keep":["part/0/soup"]"#), blobs: vec![] };
        let r = save_pack(&stale.encode()).unwrap();
        assert!(r.stale);
        assert_eq!(load(&path).unwrap().pack.json, r#"{"v":2}"#);
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn a_version_1_file_opens_and_reports_no_revision() {
        let dir = dir();
        let path = dir.join("old").join("old.barista");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let c = Connection::open(&path).unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c.execute("INSERT INTO meta(key, value) VALUES ('format', '1'), ('doc', '{\"old\":true}')", []).unwrap();
        let data = lz4_flex::compress_prepend_size(&[1u8, 2, 3]);
        c.execute("INSERT INTO blob(name, data) VALUES ('part/0/soup', ?1)", params![data]).unwrap();
        drop(c);
        let back = load(&path).unwrap();
        assert_eq!(back.format, 1);
        assert_eq!(back.rev, 0);
        assert_eq!(back.pack.blobs[0].1, vec![1u8, 2, 3]);
        // a version 1 file has no revision to keep against: a save replaces it and stamps the current format
        let r = save_keep(&path, &Pack { json: "{\"new\":true}".into(), blobs: vec![] }, 0, &[]).unwrap();
        assert!(!r.stale);
        assert_eq!(r.rev, 1);
        let now = load(&path).unwrap();
        assert_eq!(now.format, FORMAT);
        assert_eq!(now.rev, 1);
        assert_eq!(now.pack.json, "{\"new\":true}");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn an_open_sends_blobs_as_stored_and_never_creates_a_file() {
        let dir = dir().join("open");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("p.barista");
        let tile = vec![7u8; 4096];
        save(&path, &Pack { json: "{}".into(), blobs: vec![("set/0/1/color/0_0".into(), tile.clone())] }).unwrap();
        let open = Pack::decode(&open_pack(&OpenReq { path: Some(path.display().to_string()), recover: false }).unwrap()).unwrap();
        assert!(open.json.contains(r#""lz4":true"#));
        assert_eq!(lz4_flex::decompress_size_prepended(&open.blobs[0].1).unwrap(), tile, "the editor unpacks what the file holds");
        assert!(open.blobs[0].1.len() < 100, "a flat tile travels compressed");
        let missing = dir.join("nope.barista");
        assert!(open_pack(&OpenReq { path: Some(missing.display().to_string()), recover: false }).is_err());
        assert!(!missing.exists(), "opening a wrong path must not leave an empty project behind");
        std::fs::remove_dir_all(&dir).ok();
    }
}
