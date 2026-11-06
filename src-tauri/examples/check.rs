// Quick CLI harness to verify the unlock logic outside the GUI.
// Usage: cargo run --example check -- <path> [excel|vba]
use excel_unlock_lib::{excel, util, vba};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("vbaself") {
        vba_self_test();
        return;
    }
    let path = &args[1];
    let mode = args.get(2).map(|s| s.as_str()).unwrap_or("excel");

    if mode == "pcrack" {
        // Parallel crack over a wordlist file, mirroring the app's logic.
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Mutex};
        let wl = &args[3];
        let threads: usize = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(14);
        let bytes = std::fs::read(path).expect("read");
        let info = Arc::new(excel_unlock_lib::crypto::load(&bytes).expect("load").expect("agile"));
        let words: Vec<String> = std::fs::read_to_string(wl).unwrap()
            .lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        let total = words.len();
        let it = Arc::new(Mutex::new(words.into_iter()));
        let tried = Arc::new(AtomicUsize::new(0));
        let found: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let t0 = std::time::Instant::now();
        let mut hs = vec![];
        for _ in 0..threads {
            let (info, it, tried, found, stop) = (info.clone(), it.clone(), tried.clone(), found.clone(), stop.clone());
            hs.push(std::thread::spawn(move || loop {
                if stop.load(Ordering::Relaxed) { break; }
                let c = { it.lock().unwrap().next() };
                let c = match c { Some(c) => c, None => break };
                tried.fetch_add(1, Ordering::Relaxed);
                if excel_unlock_lib::crypto::verify(&info, &c) {
                    *found.lock().unwrap() = Some(c);
                    stop.store(true, Ordering::Relaxed);
                    break;
                }
            }));
        }
        for h in hs { h.join().unwrap(); }
        let ms = t0.elapsed().as_millis().max(1);
        let n = tried.load(Ordering::Relaxed);
        println!("threads={threads} wordlist={total} tried={n} in {ms}ms => {:.0}/s | found={:?}",
            n as f64 * 1000.0 / ms as f64, found.lock().unwrap().clone());
        return;
    }

    if mode == "bench" {
        let bytes = std::fs::read(path).expect("read");
        let info = excel_unlock_lib::crypto::load(&bytes).expect("load").expect("not agile");
        let n = 100;
        let t = std::time::Instant::now();
        for i in 0..n {
            std::hint::black_box(excel_unlock_lib::crypto::verify(&info, &format!("x{i}")));
        }
        let ms = t.elapsed().as_millis();
        println!("{n} verifies in {ms} ms  =>  {:.0} guesses/sec", n as f64 * 1000.0 / ms as f64);
        return;
    }

    if mode == "decrypt" {
        let pw = &args[3];
        let bytes = std::fs::read(path).expect("read");
        let info = excel_unlock_lib::crypto::load(&bytes).expect("load").expect("not agile");
        let ok = excel_unlock_lib::crypto::verify(&info, pw);
        println!("password '{pw}' correct = {ok}");
        if ok {
            let plain = excel_unlock_lib::crypto::decrypt_package(&info, pw).expect("decrypt");
            let outp = format!("{path}.decrypted.xlsx");
            std::fs::write(&outp, &plain).unwrap();
            println!(
                "decrypted {} bytes, starts_with_zip={} -> {outp}",
                plain.len(),
                plain.starts_with(b"PK")
            );
        }
        return;
    }

    let bytes = std::fs::read(path).expect("read");
    println!("input {} bytes, zip={}, ole={}", bytes.len(), util::is_zip(&bytes), util::is_ole(&bytes));

    if mode == "excel" {
        let (out, count) = excel::remove_protection(&bytes).expect("excel");
        let outp = format!("{path}.unlocked.xlsx");
        std::fs::write(&outp, &out).unwrap();
        println!("EXCEL: removed {count} protection element(s) -> {outp}");
    } else {
        match vba::remove_vba_password(&bytes) {
            Ok((out, changed)) => {
                let outp = format!("{path}.vba_unlocked.bin");
                std::fs::write(&outp, &out).unwrap();
                println!("VBA: changed={changed} -> {outp}");
            }
            Err(e) => println!("VBA error: {e}"),
        }
    }
}

// Build a real OLE2 compound file with a PROJECT stream that carries a DPB
// protection key, then confirm remove_vba_password neutralizes it.
fn vba_self_test() {
    use std::io::{Cursor, Write};
    let project = b"ID=\"{00000000}\"\r\nCMG=\"ABCD1234\"\r\nDPB=\"DEADBEEF00\"\r\nGC=\"11223344\"\r\n";
    let mut comp = cfb::CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    {
        let mut s = comp.create_stream("PROJECT").unwrap();
        s.write_all(project).unwrap();
        s.flush().unwrap();
    }
    comp.flush().unwrap();
    let ole_bytes = comp.into_inner().into_inner();
    println!("built OLE: {} bytes, ole={}", ole_bytes.len(), util::is_ole(&ole_bytes));

    let (out, changed) = vba::remove_vba_password(&ole_bytes).expect("vba");
    // Re-open the patched OLE and read PROJECT back.
    let mut comp2 = cfb::CompoundFile::open(Cursor::new(out)).unwrap();
    let mut back = Vec::new();
    {
        use std::io::Read;
        comp2.open_stream("PROJECT").unwrap().read_to_end(&mut back).unwrap();
    }
    let text = String::from_utf8_lossy(&back);
    let has_dpb = text.contains("DPB=");
    let has_dpx = text.contains("DPx=");
    let cmg_intact = text.contains("CMG=");
    println!("changed={changed} | DPB present={has_dpb} | DPx present={has_dpx} | CMG intact={cmg_intact}");
    assert!(changed && !has_dpb && has_dpx && cmg_intact, "VBA patch failed");
    println!("VBA SELF-TEST PASSED");
}
