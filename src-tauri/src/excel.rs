use crate::util;
use regex::Regex;

/// Remove worksheet and workbook *protection* from an xlsx/xlsm buffer.
///
/// These protections (protect sheet / protect workbook structure) are stored as a
/// removable `<sheetProtection .../>` / `<workbookProtection .../>` element inside the
/// package XML. Deleting the element unlocks the sheet — no password is cracked.
///
/// Returns the rewritten buffer and the number of protection elements removed.
pub fn remove_protection(input: &[u8]) -> anyhow::Result<(Vec<u8>, usize)> {
    let sheet_re = Regex::new(r"(?s)<sheetProtection\b[^>]*?/>")?;
    let wb_re = Regex::new(r"(?s)<workbookProtection\b[^>]*?/>")?;

    let mut count = 0usize;
    let out = util::rewrite_zip(input, |name, data| {
        let is_sheet = name.starts_with("xl/worksheets/") && name.ends_with(".xml");
        let is_wb = name == "xl/workbook.xml";
        if !is_sheet && !is_wb {
            return None;
        }
        let text = match std::str::from_utf8(data) {
            Ok(t) => t,
            Err(_) => return None,
        };
        let mut s = text.to_string();
        if is_sheet {
            let n = sheet_re.find_iter(&s).count();
            if n > 0 {
                count += n;
                s = sheet_re.replace_all(&s, "").into_owned();
            }
        }
        if is_wb {
            let n = wb_re.find_iter(&s).count();
            if n > 0 {
                count += n;
                s = wb_re.replace_all(&s, "").into_owned();
            }
        }
        Some(s.into_bytes())
    })?;

    Ok((out, count))
}
