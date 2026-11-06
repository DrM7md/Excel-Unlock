use crate::util;
use std::io::{Cursor, Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

/// Remove the VBA project password from a workbook buffer.
///
/// The VBA project "password" is not encryption — it is a protection record inside the
/// `PROJECT` stream of the embedded OLE2 file (`xl/vbaProject.bin`), referenced by the
/// `DPB` key. Renaming `DPB=` to `DPx=` makes Excel unable to read the protection record,
/// so it drops the lock and lets you open the project. This is the standard recovery
/// method for your own forgotten VBA passwords; nothing is brute-forced.
///
/// Handles both the modern package (xlsx/xlsm/xlsb, a ZIP holding vbaProject.bin) and the
/// legacy binary .xls (a raw OLE2 file).
pub fn remove_vba_password(input: &[u8]) -> anyhow::Result<(Vec<u8>, bool)> {
    if util::is_zip(input) {
        let mut changed = false;
        let mut found_vba = false;
        let out = util::rewrite_zip(input, |name, data| {
            if name.eq_ignore_ascii_case("xl/vbaProject.bin") {
                found_vba = true;
                match patch_ole(data) {
                    Ok((patched, c)) => {
                        if c {
                            changed = true;
                        }
                        Some(patched)
                    }
                    Err(_) => None,
                }
            } else {
                None
            }
        })?;
        if !found_vba {
            anyhow::bail!("NO_VBA");
        }
        Ok((out, changed))
    } else if util::is_ole(input) {
        patch_ole(input)
    } else {
        anyhow::bail!("UNSUPPORTED")
    }
}

/// Patch a raw vbaProject.bin (OLE2 compound file): neutralize the DPB protection key
/// inside the `PROJECT` stream.
fn patch_ole(data: &[u8]) -> anyhow::Result<(Vec<u8>, bool)> {
    let cursor = Cursor::new(data.to_vec());
    let mut comp = cfb::CompoundFile::open(cursor)?;

    // Locate the PROJECT stream (case-insensitive) anywhere in the compound file.
    let project_path: Option<PathBuf> = comp
        .walk()
        .find(|e| e.is_stream() && e.name().eq_ignore_ascii_case("PROJECT"))
        .map(|e| e.path().to_path_buf());

    let project_path = match project_path {
        Some(p) => p,
        None => return Ok((data.to_vec(), false)),
    };

    let mut content = Vec::new();
    {
        let mut s = comp.open_stream(&project_path)?;
        s.read_to_end(&mut content)?;
    }

    // Neutralize ONLY the DPB protection key. Excel will warn once ("invalid key
    // 'DPx' - Continue Loading Project?"), you click Yes, and the project opens
    // unlocked. Touching CMG as well causes error 40230, so we leave it alone.
    let (patched, changed) = util::replace_all_bytes(&content, b"DPB=", b"DPx=");

    if changed {
        // Replacement keeps the stream the same length, so an in-place write is safe.
        let mut s = comp.open_stream(&project_path)?;
        s.seek(SeekFrom::Start(0))?;
        s.write_all(&patched)?;
        s.flush()?;
    }

    comp.flush()?;
    let inner = comp.into_inner();
    Ok((inner.into_inner(), changed))
}
