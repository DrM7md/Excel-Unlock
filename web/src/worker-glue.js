/* Web Worker crypto: AES-Agile key derivation, verify, and package decryption.
   Prepended libs (aes-js, js-sha512, js-sha1) provide: aesjs, sha512, sha1. */
(function () {
  "use strict";
  function u8(a) { return a instanceof Uint8Array ? a : new Uint8Array(a); }
  function hashBytes(alg, parts) {
    const h = (alg === "SHA1" ? sha1 : sha512).create();
    for (const p of parts) h.update(p);
    return new Uint8Array(h.arrayBuffer());
  }
  function le32(n) { return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]); }
  function pwUtf16le(pw) {
    const out = new Uint8Array(pw.length * 2);
    for (let i = 0; i < pw.length; i++) { const c = pw.charCodeAt(i); out[i * 2] = c & 255; out[i * 2 + 1] = (c >>> 8) & 255; }
    return out;
  }
  function aesDec(key, iv, data) { return new aesjs.ModeOfOperation.cbc(key, iv.subarray(0, 16)).decrypt(data); }
  function concat(arrs) { let n = 0; for (const a of arrs) n += a.length; const o = new Uint8Array(n); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; }

  const BK_IN = new Uint8Array([0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79]);
  const BK_VAL = new Uint8Array([0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e]);
  const BK_KEY = new Uint8Array([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]);

  function deriveKey(info, pw16, bk) {
    let cur = hashBytes(info.ekHash, [info.ekSalt, pw16]);
    for (let i = 0; i < info.spin; i++) cur = hashBytes(info.ekHash, [le32(i), cur]);
    return hashBytes(info.ekHash, [cur, bk]).subarray(0, info.keyBytes);
  }
  function verify(info, pw) {
    const p = pwUtf16le(pw);
    const kIn = deriveKey(info, p, BK_IN);
    const ver = aesDec(kIn, info.ekSalt, info.vIn);
    const kVal = deriveKey(info, p, BK_VAL);
    const vh = aesDec(kVal, info.ekSalt, info.vVal);
    const c = hashBytes(info.ekHash, [ver]);
    const n = Math.min(c.length, vh.length);
    if (n === 0) return false;
    for (let i = 0; i < n; i++) if (c[i] !== vh[i]) return false;
    return true;
  }
  function decryptPackage(info, pw) {
    const p = pwUtf16le(pw);
    const k = deriveKey(info, p, BK_KEY);
    const secret = aesDec(k, info.ekSalt, info.encKey).subarray(0, info.keyBytes);
    const dv = new DataView(info.pkg.buffer, info.pkg.byteOffset, 8);
    const total = dv.getUint32(0, true) + dv.getUint32(4, true) * 4294967296;
    const data = info.pkg.subarray(8);
    const chunks = [];
    for (let i = 0, seg = 0; i < data.length; i += 4096, seg++) {
      let chunk = data.subarray(i, Math.min(i + 4096, data.length));
      if (chunk.length % 16 !== 0) { const q = new Uint8Array(chunk.length + (16 - (chunk.length % 16))); q.set(chunk); chunk = q; }
      const iv = hashBytes(info.kdHash, [info.kdSalt, le32(seg)]).subarray(0, 16);
      chunks.push(aesDec(secret, iv, chunk));
    }
    return concat(chunks).subarray(0, total);
  }

  function prep(info) {
    info.ekSalt = u8(info.ekSalt); info.vIn = u8(info.vIn); info.vVal = u8(info.vVal);
    if (info.kdSalt) info.kdSalt = u8(info.kdSalt);
    if (info.encKey) info.encKey = u8(info.encKey);
    if (info.pkg) info.pkg = u8(info.pkg);
    return info;
  }

  self.onmessage = function (e) {
    const m = e.data;
    const info = prep(m.info);
    if (m.cmd === "decrypt") {
      const plain = decryptPackage(info, m.password);
      self.postMessage({ id: m.id, type: "plain", data: plain }, [plain.buffer]);
      return;
    }
    if (m.cmd === "verify") {
      let tried = 0;
      for (const pw of m.passwords) {
        tried++;
        if (verify(info, pw)) { self.postMessage({ id: m.id, type: "found", password: pw }); self.postMessage({ id: m.id, type: "done", tried }); return; }
        if (tried % 8 === 0) self.postMessage({ id: m.id, type: "progress", tried });
      }
      self.postMessage({ id: m.id, type: "done", tried });
      return;
    }
    if (m.cmd === "brute") {
      const cs = m.charset;
      let tried = 0;
      // length 1 = this worker's assigned first chars
      for (const fc of m.firstChars) {
        tried++;
        if (verify(info, fc)) { self.postMessage({ id: m.id, type: "found", password: fc }); self.postMessage({ id: m.id, type: "done", tried }); return; }
      }
      for (let len = 2; len <= m.maxLen; len++) {
        for (const fc of m.firstChars) {
          const idx = new Array(len - 1).fill(0);
          while (true) {
            let s = fc;
            for (let k = 0; k < idx.length; k++) s += cs[idx[k]];
            tried++;
            if (verify(info, s)) { self.postMessage({ id: m.id, type: "found", password: s }); self.postMessage({ id: m.id, type: "done", tried }); return; }
            if (tried % 8 === 0) self.postMessage({ id: m.id, type: "progress", tried });
            let pos = idx.length - 1;
            while (pos >= 0) { idx[pos]++; if (idx[pos] < cs.length) break; idx[pos] = 0; pos--; }
            if (pos < 0) break;
          }
        }
      }
      self.postMessage({ id: m.id, type: "done", tried });
      return;
    }
  };
})();
