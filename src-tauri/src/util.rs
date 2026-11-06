use std::io::{Cursor, Read, Write};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

/// Rewrite a ZIP archive (an .xlsx/.xlsm/.xlsb is a ZIP) in memory.
///
/// `transform(name, bytes)` is called for every file entry. Return `Some(new_bytes)`
/// to replace that entry's contents, or `None` to keep it unchanged.
pub fn rewrite_zip(
    input: &[u8],
    mut transform: impl FnMut(&str, &[u8]) -> Option<Vec<u8>>,
) -> anyhow::Result<Vec<u8>> {
    let reader = Cursor::new(input);
    let mut archive = ZipArchive::new(reader)?;
    let mut out = Cursor::new(Vec::new());
    {
        let mut zw = ZipWriter::new(&mut out);
        for i in 0..archive.len() {
            let mut file = archive.by_index(i)?;
            if !file.is_file() {
                continue;
            }
            let name = file.name().to_string();
            let mut data = Vec::new();
            file.read_to_end(&mut data)?;
            let new_data = transform(&name, &data).unwrap_or(data);
            let options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Deflated)
                .unix_permissions(0o644);
            zw.start_file(name, options)?;
            zw.write_all(&new_data)?;
        }
        zw.finish()?;
    }
    Ok(out.into_inner())
}

/// Replace every occurrence of `from` with `to` in a byte buffer.
/// Returns the new buffer and whether any replacement happened.
pub fn replace_all_bytes(data: &[u8], from: &[u8], to: &[u8]) -> (Vec<u8>, bool) {
    if from.is_empty() {
        return (data.to_vec(), false);
    }
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0usize;
    let mut changed = false;
    while i < data.len() {
        if i + from.len() <= data.len() && &data[i..i + from.len()] == from {
            out.extend_from_slice(to);
            i += from.len();
            changed = true;
        } else {
            out.push(data[i]);
            i += 1;
        }
    }
    (out, changed)
}

/// True if the buffer looks like a ZIP container (xlsx/xlsm/xlsb).
pub fn is_zip(data: &[u8]) -> bool {
    data.starts_with(b"PK\x03\x04") || data.starts_with(b"PK\x05\x06")
}

/// True if the buffer looks like an OLE2 / Compound File (legacy .xls, or a raw vbaProject.bin).
pub fn is_ole(data: &[u8]) -> bool {
    data.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
}
