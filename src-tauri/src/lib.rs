pub mod crypto;
pub mod excel;
pub mod util;
pub mod vba;

use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, State, Window};

#[derive(Serialize, Default)]
pub struct OpResult {
    /// Operation completed and an output file was written.
    success: bool,
    /// Whether anything was actually changed (vs. the file was already unprotected).
    changed: bool,
    /// How many protection elements were removed (Excel protection only).
    count: usize,
    /// Absolute path of the written output file.
    output_path: Option<String>,
    /// Machine-readable error code for the UI to localize/display.
    error: Option<String>,
}

impl OpResult {
    fn err(code: impl Into<String>) -> Self {
        OpResult {
            error: Some(code.into()),
            ..Default::default()
        }
    }
}

/// Build an output path next to the input: "book.xlsx" -> "book{suffix}.xlsx".
fn derive_output(path: &str, suffix: &str) -> String {
    let p = Path::new(path);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("xlsx");
    let file = format!("{stem}{suffix}.{ext}");
    match p.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => {
            parent.join(file).to_string_lossy().into_owned()
        }
        _ => file,
    }
}

#[tauri::command]
fn remove_excel_protection(path: String) -> OpResult {
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => return OpResult::err(format!("READ_FAILED: {e}")),
    };
    if !util::is_zip(&bytes) {
        // Legacy binary .xls sheet protection is not supported.
        return OpResult::err("NOT_XLSX");
    }
    match excel::remove_protection(&bytes) {
        Ok((out, count)) => {
            let outp = derive_output(&path, "_unlocked");
            if let Err(e) = std::fs::write(&outp, out) {
                return OpResult::err(format!("WRITE_FAILED: {e}"));
            }
            OpResult {
                success: true,
                changed: count > 0,
                count,
                output_path: Some(outp),
                error: None,
            }
        }
        Err(e) => OpResult::err(format!("PROCESS_FAILED: {e}")),
    }
}

#[tauri::command]
fn remove_vba_password(path: String) -> OpResult {
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => return OpResult::err(format!("READ_FAILED: {e}")),
    };
    match vba::remove_vba_password(&bytes) {
        Ok((out, changed)) => {
            let outp = derive_output(&path, "_vba_unlocked");
            if let Err(e) = std::fs::write(&outp, out) {
                return OpResult::err(format!("WRITE_FAILED: {e}"));
            }
            OpResult {
                success: true,
                changed,
                count: if changed { 1 } else { 0 },
                output_path: Some(outp),
                error: None,
            }
        }
        Err(e) => OpResult::err(format!("PROCESS_FAILED: {e}")),
    }
}

// ---------- Open-password recovery (real AES decryption) ----------

pub struct CrackState {
    cancel: Arc<AtomicBool>,
}

impl Default for CrackState {
    fn default() -> Self {
        CrackState {
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[derive(Serialize, Default)]
pub struct CrackResult {
    /// The correct password was found.
    found: bool,
    password: Option<String>,
    output_path: Option<String>,
    tried: usize,
    /// "wrong" | "cancelled" | "exhausted" | an error code.
    reason: Option<String>,
    error: Option<String>,
}

impl CrackResult {
    fn err(code: impl Into<String>) -> Self {
        CrackResult {
            error: Some(code.into()),
            ..Default::default()
        }
    }
}

fn load_encrypted(path: &str) -> Result<crypto::AgileInfo, CrackResult> {
    let bytes = std::fs::read(path).map_err(|e| CrackResult::err(format!("READ_FAILED: {e}")))?;
    if !util::is_ole(&bytes) {
        // Not encrypted at the file level (plain xlsx is a ZIP).
        return Err(CrackResult::err("NOT_ENCRYPTED"));
    }
    match crypto::load(&bytes) {
        Ok(Some(info)) => Ok(info),
        Ok(None) => Err(CrackResult::err("NOT_ENCRYPTED")),
        Err(e) => {
            let m = e.to_string();
            if m.contains("NOT_AGILE") {
                Err(CrackResult::err("NOT_AGILE"))
            } else {
                Err(CrackResult::err(format!("PARSE_FAILED: {m}")))
            }
        }
    }
}

fn save_decrypted(path: &str, info: &crypto::AgileInfo, password: &str) -> Result<String, String> {
    let plain = crypto::decrypt_package(info, password).map_err(|e| e.to_string())?;
    let outp = derive_output(path, "_decrypted");
    std::fs::write(&outp, plain).map_err(|e| e.to_string())?;
    Ok(outp)
}

/// Try a single password the user typed (instant).
#[tauri::command]
fn try_password(path: String, password: String) -> CrackResult {
    let info = match load_encrypted(&path) {
        Ok(i) => i,
        Err(r) => return r,
    };
    if crypto::verify(&info, &password) {
        match save_decrypted(&path, &info, &password) {
            Ok(outp) => CrackResult {
                found: true,
                password: Some(password),
                output_path: Some(outp),
                tried: 1,
                reason: None,
                error: None,
            },
            Err(e) => CrackResult::err(format!("WRITE_FAILED: {e}")),
        }
    } else {
        CrackResult {
            found: false,
            tried: 1,
            reason: Some("wrong".into()),
            ..Default::default()
        }
    }
}

const BUILTIN: &str = include_str!("wordlist.txt");

fn charset_for(name: &str) -> Vec<char> {
    match name {
        "digits" => ('0'..='9').collect(),
        "lower" => ('a'..='z').collect(),
        "lower_digits" => ('a'..='z').chain('0'..='9').collect(),
        "alpha" => ('a'..='z').chain('A'..='Z').collect(),
        "alnum" => ('a'..='z').chain('A'..='Z').chain('0'..='9').collect(),
        _ => vec![],
    }
}

/// Lazy brute-force generator: yields every string over `charset` of length 1..=max.
struct BruteForce {
    charset: Vec<char>,
    max: usize,
    len: usize,
    idx: Vec<usize>,
    done: bool,
}
impl BruteForce {
    fn new(charset: Vec<char>, max: usize) -> Self {
        BruteForce { charset, max, len: 1, idx: vec![0; 1], done: false }
    }
}
impl Iterator for BruteForce {
    type Item = String;
    fn next(&mut self) -> Option<String> {
        if self.done || self.len > self.max || self.charset.is_empty() {
            return None;
        }
        let s: String = self.idx.iter().map(|&i| self.charset[i]).collect();
        // advance odometer
        let mut pos = self.len;
        let mut overflow = false;
        loop {
            if pos == 0 {
                overflow = true;
                break;
            }
            pos -= 1;
            self.idx[pos] += 1;
            if self.idx[pos] < self.charset.len() {
                break;
            }
            self.idx[pos] = 0;
            if pos == 0 {
                overflow = true;
                break;
            }
        }
        if overflow {
            self.len += 1;
            if self.len <= self.max {
                self.idx = vec![0; self.len];
            } else {
                self.done = true;
            }
        }
        Some(s)
    }
}

fn thread_count(power: &str) -> usize {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    match power {
        "saver" => (cores / 2).max(1),
        "max" => cores.saturating_sub(1).max(1),
        _ => ((cores * 3) / 4).max(1), // balanced
    }
}

/// Run a dictionary and/or brute-force attack in parallel across CPU cores.
/// Emits "crack-progress" events and honours cancellation. Returns the final result.
#[tauri::command]
async fn crack_password(
    window: Window,
    state: State<'_, CrackState>,
    path: String,
    use_builtin: bool,
    wordlist_path: String,
    brute_charset: String,
    brute_max: usize,
    power: String,
) -> Result<CrackResult, ()> {
    state.cancel.store(false, Ordering::Relaxed);
    let cancel = state.cancel.clone();
    let info = match load_encrypted(&path) {
        Ok(i) => i,
        Err(r) => return Ok(r),
    };
    let threads = thread_count(&power);

    // Build one lazy candidate stream: builtin -> wordlist -> brute force.
    let mut parts: Vec<Box<dyn Iterator<Item = String> + Send>> = Vec::new();
    if use_builtin {
        let v: Vec<String> = BUILTIN
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        parts.push(Box::new(v.into_iter()));
    }
    if !wordlist_path.is_empty() {
        if let Ok(content) = std::fs::read_to_string(&wordlist_path) {
            let v: Vec<String> = content
                .lines()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            parts.push(Box::new(v.into_iter()));
        }
    }
    let charset = charset_for(&brute_charset);
    if !charset.is_empty() && brute_max > 0 {
        parts.push(Box::new(BruteForce::new(charset, brute_max)));
    }
    let candidates: Box<dyn Iterator<Item = String> + Send> = Box::new(parts.into_iter().flatten());

    let result = tauri::async_runtime::spawn_blocking(move || {
        let info = Arc::new(info);
        let candidates = Arc::new(Mutex::new(candidates));
        let tried = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let found: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let active = Arc::new(AtomicUsize::new(threads));

        let mut handles = Vec::new();
        for _ in 0..threads {
            let info = info.clone();
            let candidates = candidates.clone();
            let tried = tried.clone();
            let stop = stop.clone();
            let found = found.clone();
            let active = active.clone();
            let cancel = cancel.clone();
            handles.push(std::thread::spawn(move || {
                loop {
                    if stop.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    // Hold the lock only long enough to pull the next candidate.
                    let cand = {
                        let mut it = candidates.lock().unwrap();
                        it.next()
                    };
                    let cand = match cand {
                        Some(c) => c,
                        None => break,
                    };
                    tried.fetch_add(1, Ordering::Relaxed);
                    if crypto::verify(&info, &cand) {
                        *found.lock().unwrap() = Some(cand);
                        stop.store(true, Ordering::Relaxed);
                        break;
                    }
                }
                active.fetch_sub(1, Ordering::Relaxed);
            }));
        }

        // Manager: emit progress until every worker is done.
        loop {
            std::thread::sleep(Duration::from_millis(200));
            if cancel.load(Ordering::Relaxed) {
                stop.store(true, Ordering::Relaxed);
            }
            let t = tried.load(Ordering::Relaxed);
            let _ = window.emit(
                "crack-progress",
                serde_json::json!({ "tried": t, "threads": threads }),
            );
            if active.load(Ordering::Relaxed) == 0 {
                break;
            }
        }
        for h in handles {
            let _ = h.join();
        }

        let tried_total = tried.load(Ordering::Relaxed);
        let pw = found.lock().unwrap().take();
        if let Some(p) = pw {
            match save_decrypted(&path, &info, &p) {
                Ok(outp) => CrackResult {
                    found: true,
                    password: Some(p),
                    output_path: Some(outp),
                    tried: tried_total,
                    reason: None,
                    error: None,
                },
                Err(e) => CrackResult::err(format!("WRITE_FAILED: {e}")),
            }
        } else if cancel.load(Ordering::Relaxed) {
            CrackResult { found: false, tried: tried_total, reason: Some("cancelled".into()), ..Default::default() }
        } else {
            CrackResult { found: false, tried: tried_total, reason: Some("exhausted".into()), ..Default::default() }
        }
    })
    .await
    .unwrap_or_else(|_| CrackResult::err("JOIN_FAILED"));

    Ok(result)
}

#[tauri::command]
fn cancel_crack(state: State<'_, CrackState>) {
    state.cancel.store(true, Ordering::Relaxed);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(CrackState::default())
        .invoke_handler(tauri::generate_handler![
            remove_excel_protection,
            remove_vba_password,
            try_password,
            crack_password,
            cancel_crack
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
