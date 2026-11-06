//! Decryption of "Encrypt with Password" (ECMA-376 Agile) Excel files.
//!
//! Unlike sheet/VBA protection, this is real AES encryption (MS-OFFCRYPTO). The file is
//! an OLE2 compound file with `EncryptionInfo` + `EncryptedPackage` streams. We can only
//! open it by finding the correct password — there is no bypass. Once the password is
//! known, we derive the key, verify it, decrypt the package, and get back the plain xlsx.

use aes::cipher::{BlockDecryptMut, KeyIvInit};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use regex::Regex;
use std::io::{Cursor, Read};

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;
type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

const BK_VERIFIER_INPUT: [u8; 8] = [0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79];
const BK_VERIFIER_VALUE: [u8; 8] = [0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e];
const BK_KEY_VALUE: [u8; 8] = [0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6];

#[derive(Clone, Copy, PartialEq)]
enum HashAlg {
    Sha512,
    Sha1,
}

impl HashAlg {
    fn parse(s: &str) -> HashAlg {
        if s.eq_ignore_ascii_case("SHA1") || s.eq_ignore_ascii_case("SHA-1") {
            HashAlg::Sha1
        } else {
            HashAlg::Sha512
        }
    }
    fn hash(&self, parts: &[&[u8]]) -> Vec<u8> {
        match self {
            HashAlg::Sha512 => {
                use sha2::{Digest, Sha512};
                let mut h = Sha512::new();
                for p in parts {
                    h.update(p);
                }
                h.finalize().to_vec()
            }
            HashAlg::Sha1 => {
                use sha1::{Digest, Sha1};
                let mut h = Sha1::new();
                for p in parts {
                    h.update(p);
                }
                h.finalize().to_vec()
            }
        }
    }
}

/// Parsed parameters needed to verify a password and decrypt the package.
pub struct AgileInfo {
    // keyData (used for the package segments)
    kd_salt: Vec<u8>,
    kd_hash: HashAlg,
    kd_key_bytes: usize,
    // encryptedKey (used for key derivation + verifier)
    ek_salt: Vec<u8>,
    ek_hash: HashAlg,
    ek_key_bytes: usize,
    spin_count: u32,
    enc_verifier_hash_input: Vec<u8>,
    enc_verifier_hash_value: Vec<u8>,
    enc_key_value: Vec<u8>,
    // the EncryptedPackage stream
    encrypted_package: Vec<u8>,
}

fn attr(re_src: &str, hay: &str) -> Option<String> {
    Regex::new(re_src)
        .ok()?
        .captures(hay)
        .map(|c| c[1].to_string())
}

/// Load and parse an Agile-encrypted workbook from raw OLE2 bytes.
/// Returns Ok(None) if the file is not an Agile-encrypted package.
pub fn load(ole_bytes: &[u8]) -> anyhow::Result<Option<AgileInfo>> {
    let cursor = Cursor::new(ole_bytes.to_vec());
    let mut comp = match cfb::CompoundFile::open(cursor) {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };

    // Must have EncryptionInfo + EncryptedPackage.
    let has_ei = comp.walk().any(|e| e.name().eq_ignore_ascii_case("EncryptionInfo"));
    let has_ep = comp.walk().any(|e| e.name().eq_ignore_ascii_case("EncryptedPackage"));
    if !has_ei || !has_ep {
        return Ok(None);
    }

    let mut ei = Vec::new();
    comp.open_stream("EncryptionInfo")?.read_to_end(&mut ei)?;
    if ei.len() < 8 {
        return Ok(None);
    }
    let (major, minor) = (ei[0] as u16 | (ei[1] as u16) << 8, ei[2] as u16 | (ei[3] as u16) << 8);
    // Agile = 4.4. Anything else (standard 3.2/4.2, legacy) we don't handle.
    if !(major == 4 && minor == 4) {
        anyhow::bail!("NOT_AGILE");
    }
    let xml = String::from_utf8_lossy(&ei[8..]).to_string();

    // keyData block
    let kd = Regex::new(r"(?s)<keyData\b[^>]*>")?
        .find(&xml)
        .map(|m| m.as_str().to_string())
        .ok_or_else(|| anyhow::anyhow!("no keyData"))?;
    // encryptedKey block
    let ek = Regex::new(r#"(?s)<p:encryptedKey\b[^>]*>"#)?
        .find(&xml)
        .map(|m| m.as_str().to_string())
        .ok_or_else(|| anyhow::anyhow!("no encryptedKey"))?;

    let kd_salt = B64.decode(attr(r#"saltValue="([^"]*)""#, &kd).unwrap_or_default())?;
    let kd_hash = HashAlg::parse(&attr(r#"hashAlgorithm="([^"]*)""#, &kd).unwrap_or_default());
    let kd_key_bytes = attr(r#"keyBits="([^"]*)""#, &kd)
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(256)
        / 8;

    let ek_salt = B64.decode(attr(r#"saltValue="([^"]*)""#, &ek).unwrap_or_default())?;
    let ek_hash = HashAlg::parse(&attr(r#"hashAlgorithm="([^"]*)""#, &ek).unwrap_or_default());
    let ek_key_bytes = attr(r#"keyBits="([^"]*)""#, &ek)
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(256)
        / 8;
    let spin_count = attr(r#"spinCount="([^"]*)""#, &ek)
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(100_000);
    let enc_verifier_hash_input =
        B64.decode(attr(r#"encryptedVerifierHashInput="([^"]*)""#, &ek).unwrap_or_default())?;
    let enc_verifier_hash_value =
        B64.decode(attr(r#"encryptedVerifierHashValue="([^"]*)""#, &ek).unwrap_or_default())?;
    let enc_key_value =
        B64.decode(attr(r#"encryptedKeyValue="([^"]*)""#, &ek).unwrap_or_default())?;

    let mut encrypted_package = Vec::new();
    comp.open_stream("EncryptedPackage")?
        .read_to_end(&mut encrypted_package)?;

    Ok(Some(AgileInfo {
        kd_salt,
        kd_hash,
        kd_key_bytes,
        ek_salt,
        ek_hash,
        ek_key_bytes,
        spin_count,
        enc_verifier_hash_input,
        enc_verifier_hash_value,
        enc_key_value,
        encrypted_package,
    }))
}

fn pw_utf16le(password: &str) -> Vec<u8> {
    password.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
}

/// Derive a key for a given block key (the expensive step: `spinCount` hash rounds).
fn derive_key(info: &AgileInfo, pw16: &[u8], block_key: &[u8]) -> Vec<u8> {
    let h = info.ek_hash;
    let mut cur = h.hash(&[&info.ek_salt, pw16]);
    for i in 0..info.spin_count {
        cur = h.hash(&[&i.to_le_bytes(), &cur]);
    }
    let mut key = h.hash(&[&cur, block_key]);
    key.truncate(info.ek_key_bytes);
    key
}

fn aes_cbc_decrypt(key: &[u8], iv: &[u8], data: &[u8]) -> Vec<u8> {
    let mut buf = data.to_vec();
    let iv16 = &iv[..16.min(iv.len())];
    match key.len() {
        16 => {
            let dec = Aes128CbcDec::new_from_slices(key, iv16).unwrap();
            decrypt_blocks_128(dec, &mut buf);
        }
        _ => {
            let dec = Aes256CbcDec::new_from_slices(key, iv16).unwrap();
            decrypt_blocks_256(dec, &mut buf);
        }
    }
    buf
}

fn decrypt_blocks_128(mut dec: Aes128CbcDec, buf: &mut [u8]) {
    use aes::cipher::generic_array::GenericArray;
    for chunk in buf.chunks_exact_mut(16) {
        let mut block = GenericArray::clone_from_slice(chunk);
        dec.decrypt_block_mut(&mut block);
        chunk.copy_from_slice(&block);
    }
}
fn decrypt_blocks_256(mut dec: Aes256CbcDec, buf: &mut [u8]) {
    use aes::cipher::generic_array::GenericArray;
    for chunk in buf.chunks_exact_mut(16) {
        let mut block = GenericArray::clone_from_slice(chunk);
        dec.decrypt_block_mut(&mut block);
        chunk.copy_from_slice(&block);
    }
}

/// Return true if `password` is correct for this file.
pub fn verify(info: &AgileInfo, password: &str) -> bool {
    let pw16 = pw_utf16le(password);
    let k_in = derive_key(info, &pw16, &BK_VERIFIER_INPUT);
    let verifier = aes_cbc_decrypt(&k_in, &info.ek_salt, &info.enc_verifier_hash_input);
    let k_val = derive_key(info, &pw16, &BK_VERIFIER_VALUE);
    let v_hash = aes_cbc_decrypt(&k_val, &info.ek_salt, &info.enc_verifier_hash_value);
    let computed = info.ek_hash.hash(&[&verifier]);
    let n = computed.len().min(v_hash.len());
    n > 0 && computed[..n] == v_hash[..n]
}

/// Decrypt the full package (assumes `password` already verified). Returns the plain xlsx zip.
pub fn decrypt_package(info: &AgileInfo, password: &str) -> anyhow::Result<Vec<u8>> {
    let pw16 = pw_utf16le(password);
    let k = derive_key(info, &pw16, &BK_KEY_VALUE);
    let mut secret = aes_cbc_decrypt(&k, &info.ek_salt, &info.enc_key_value);
    secret.truncate(info.kd_key_bytes);

    if info.encrypted_package.len() < 8 {
        anyhow::bail!("bad package");
    }
    let total = u64::from_le_bytes(info.encrypted_package[..8].try_into().unwrap()) as usize;
    let data = &info.encrypted_package[8..];

    let mut out = Vec::with_capacity(total + 16);
    for (i, chunk) in data.chunks(4096).enumerate() {
        let iv = info.kd_hash.hash(&[&info.kd_salt, &(i as u32).to_le_bytes()]);
        // Each segment must be block-aligned; pad the final short segment to 16.
        let mut seg = chunk.to_vec();
        if seg.len() % 16 != 0 {
            seg.resize(seg.len() + (16 - seg.len() % 16), 0);
        }
        let pt = aes_cbc_decrypt(&secret, &iv[..16], &seg);
        out.extend_from_slice(&pt);
    }
    out.truncate(total);
    Ok(out)
}
