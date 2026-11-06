/* Shared browser/Node logic for Excel Unlock (web).
   Globals expected: JSZip, CFB, aesjs, sha512, sha1 */
(function (root) {
  "use strict";

  // ---------- byte helpers ----------
  function strBytes(s) {
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  function b64ToU8(b64) {
    if (typeof atob === "function") {
      const bin = atob(b64);
      const a = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
      return a;
    }
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  function concat(arrs) {
    let n = 0;
    for (const a of arrs) n += a.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  }
  function eqPrefix(a, b, n) {
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function replaceBytes(data, from, to) {
    const out = new Uint8Array(data.length);
    let i = 0, o = 0, changed = false;
    while (i < data.length) {
      let m = i + from.length <= data.length;
      if (m) for (let k = 0; k < from.length; k++) if (data[i + k] !== from[k]) { m = false; break; }
      if (m) { out.set(to, o); o += to.length; i += from.length; changed = true; }
      else { out[o++] = data[i++]; }
    }
    return { data: out.subarray(0, o), changed };
  }
  function hashBytes(alg, parts) {
    const h = (alg === "SHA1" ? sha1 : sha512).create();
    for (const p of parts) h.update(p);
    return new Uint8Array(h.arrayBuffer());
  }
  function le32(n) {
    return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
  }
  function pwUtf16le(pw) {
    const out = new Uint8Array(pw.length * 2);
    for (let i = 0; i < pw.length; i++) {
      const c = pw.charCodeAt(i);
      out[i * 2] = c & 255;
      out[i * 2 + 1] = (c >>> 8) & 255;
    }
    return out;
  }
  function aesCbcDecrypt(key, iv, data) {
    const cbc = new aesjs.ModeOfOperation.cbc(key, iv.subarray(0, 16));
    return cbc.decrypt(data); // no padding, length preserved
  }

  // ---------- 1) Excel sheet/workbook protection ----------
  async function removeExcelProtection(buf) {
    const zip = await JSZip.loadAsync(buf);
    const reSheet = /<sheetProtection\b[^>]*?\/>/g;
    const reWb = /<workbookProtection\b[^>]*?\/>/g;
    let count = 0;
    for (const name of Object.keys(zip.files)) {
      const isSheet = name.startsWith("xl/worksheets/") && name.endsWith(".xml");
      const isWb = name === "xl/workbook.xml";
      if (!isSheet && !isWb) continue;
      let txt = await zip.file(name).async("string");
      const before = txt;
      txt = txt.replace(reSheet, () => { count++; return ""; });
      txt = txt.replace(reWb, () => { count++; return ""; });
      if (txt !== before) zip.file(name, txt);
    }
    const data = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    return { data, count };
  }

  // ---------- 2) VBA project password ----------
  function findStream(cfb, upper) {
    let e = null;
    try { e = CFB.find(cfb, upper); } catch (_) {}
    if (e) return e;
    for (const f of cfb.FileIndex) {
      if (f && f.name && f.name.toUpperCase() === upper && f.type === 2) return f;
    }
    return null;
  }
  function patchVbaBin(u8) {
    const cfb = CFB.read(u8, { type: "array" });
    const entry = findStream(cfb, "PROJECT");
    if (!entry || !entry.content) return { data: u8, changed: false };
    const content = Uint8Array.from(entry.content);
    const res = replaceBytes(content, strBytes("DPB="), strBytes("DPx="));
    if (!res.changed) return { data: u8, changed: false };
    entry.content = res.data;
    entry.size = res.data.length;
    const out = CFB.write(cfb, { type: "array" });
    return { data: Uint8Array.from(out), changed: true };
  }
  async function removeVbaPassword(buf) {
    const zip = await JSZip.loadAsync(buf);
    const vbaName = Object.keys(zip.files).find((n) => n.toLowerCase() === "xl/vbaproject.bin");
    if (!vbaName) throw new Error("NO_VBA");
    const bin = await zip.file(vbaName).async("uint8array");
    const { data, changed } = patchVbaBin(bin);
    zip.file(vbaName, data);
    const out = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    return { data: out, changed };
  }

  // ---------- 3) Open-password (Agile AES) ----------
  const BK_IN = new Uint8Array([0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79]);
  const BK_VAL = new Uint8Array([0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e]);
  const BK_KEY = new Uint8Array([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]);

  function attr(re, s) { const m = re.exec(s); return m ? m[1] : null; }

  function parseAgile(u8) {
    const cfb = CFB.read(u8, { type: "array" });
    const ei = findStream(cfb, "ENCRYPTIONINFO");
    const ep = findStream(cfb, "ENCRYPTEDPACKAGE");
    if (!ei || !ep) return null;
    const eiC = Uint8Array.from(ei.content);
    const major = eiC[0] | (eiC[1] << 8), minor = eiC[2] | (eiC[3] << 8);
    if (!(major === 4 && minor === 4)) throw new Error("NOT_AGILE");
    const xml = new TextDecoder("utf-8").decode(eiC.subarray(8));
    const kd = /<keyData\b[^>]*>/.exec(xml)[0];
    const ek = /<p:encryptedKey\b[^>]*>/.exec(xml)[0];
    const hashOf = (b) => { const h = attr(/hashAlgorithm="([^"]*)"/, b) || "SHA512"; return /sha-?1/i.test(h) ? "SHA1" : "SHA512"; };
    return {
      kdSalt: b64ToU8(attr(/saltValue="([^"]*)"/, kd)),
      kdHash: hashOf(kd),
      ekSalt: b64ToU8(attr(/saltValue="([^"]*)"/, ek)),
      ekHash: hashOf(ek),
      keyBytes: (parseInt(attr(/keyBits="([^"]*)"/, ek) || "256", 10)) / 8,
      spin: parseInt(attr(/spinCount="([^"]*)"/, ek) || "100000", 10),
      vIn: b64ToU8(attr(/encryptedVerifierHashInput="([^"]*)"/, ek)),
      vVal: b64ToU8(attr(/encryptedVerifierHashValue="([^"]*)"/, ek)),
      encKey: b64ToU8(attr(/encryptedKeyValue="([^"]*)"/, ek)),
      pkg: Uint8Array.from(ep.content),
    };
  }

  function deriveKey(info, pw16, blockKey) {
    let cur = hashBytes(info.ekHash, [info.ekSalt, pw16]);
    for (let i = 0; i < info.spin; i++) cur = hashBytes(info.ekHash, [le32(i), cur]);
    return hashBytes(info.ekHash, [cur, blockKey]).subarray(0, info.keyBytes);
  }

  function verify(info, password) {
    const pw16 = pwUtf16le(password);
    const kIn = deriveKey(info, pw16, BK_IN);
    const verifier = aesCbcDecrypt(kIn, info.ekSalt, info.vIn);
    const kVal = deriveKey(info, pw16, BK_VAL);
    const vHash = aesCbcDecrypt(kVal, info.ekSalt, info.vVal);
    const computed = hashBytes(info.ekHash, [verifier]);
    const n = Math.min(computed.length, vHash.length);
    return n > 0 && eqPrefix(computed, vHash, n);
  }

  function decryptPackage(info, password) {
    const pw16 = pwUtf16le(password);
    const k = deriveKey(info, pw16, BK_KEY);
    const secret = aesCbcDecrypt(k, info.ekSalt, info.encKey).subarray(0, info.keyBytes);
    const dv = new DataView(info.pkg.buffer, info.pkg.byteOffset, 8);
    const total = dv.getUint32(0, true) + dv.getUint32(4, true) * 4294967296;
    const data = info.pkg.subarray(8);
    const chunks = [];
    for (let i = 0, seg = 0; i < data.length; i += 4096, seg++) {
      let chunk = data.subarray(i, Math.min(i + 4096, data.length));
      if (chunk.length % 16 !== 0) {
        const padded = new Uint8Array(chunk.length + (16 - (chunk.length % 16)));
        padded.set(chunk); chunk = padded;
      }
      const iv = hashBytes(info.kdHash, [info.kdSalt, le32(seg)]).subarray(0, 16);
      chunks.push(aesCbcDecrypt(secret, iv, chunk));
    }
    return concat(chunks).subarray(0, total);
  }

  root.ExcelWeb = {
    removeExcelProtection, removeVbaPassword, patchVbaBin,
    parseAgile, verify, decryptPackage, _strBytes: strBytes, _replaceBytes: replaceBytes,
  };
})(typeof window !== "undefined" ? window : globalThis);
