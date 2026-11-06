(function () {
  "use strict";
  const el = (s) => document.querySelector(s);
  const selected = { excel: null, vba: null, crypto: null };
  const ACCEPT = { excel: [".xlsx", ".xlsm"], vba: [".xlsm", ".xlsb", ".xls"], crypto: [".xlsx", ".xlsm"] };
  const CHARSETS = {
    digits: "0123456789".split(""),
    lower: "abcdefghijklmnopqrstuvwxyz".split(""),
    lower_digits: "abcdefghijklmnopqrstuvwxyz0123456789".split(""),
    alnum: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".split(""),
  };

  // ---------- icons ----------
  const SUN = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>';
  const IC = {
    ok: '<svg class="r-ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    warn: '<svg class="r-ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
    err: '<svg class="r-ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
  };

  // ---------- theme ----------
  const root = document.documentElement, themeToggle = el("#themeToggle");
  function applyTheme(t) { root.setAttribute("data-theme", t); themeToggle.innerHTML = t === "dark" ? MOON : SUN; try { localStorage.setItem("theme", t); } catch (_) {} }
  applyTheme((() => { try { return localStorage.getItem("theme") || "dark"; } catch (_) { return "dark"; } })());
  themeToggle.addEventListener("click", () => applyTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark"));

  // ---------- tabs ----------
  let activeTool = "excel";
  const tabs = document.querySelectorAll(".tab"), panels = document.querySelectorAll(".panel");
  tabs.forEach((tab) => tab.addEventListener("click", () => {
    activeTool = tab.dataset.tab;
    tabs.forEach((t) => t.classList.toggle("active", t === tab));
    panels.forEach((p) => p.classList.toggle("active", p.dataset.tool === activeTool));
  }));

  // ---------- file helpers ----------
  const fileInput = el("#fileInput");
  let pickTool = null;
  fileInput.addEventListener("change", () => { if (fileInput.files[0] && pickTool) setFile(pickTool, fileInput.files[0]); fileInput.value = ""; });
  function browse(tool) { pickTool = tool; fileInput.setAttribute("accept", ACCEPT[tool].join(",")); fileInput.click(); }

  function setFile(tool, file) {
    selected[tool] = file;
    const zone = el(`.dropzone[data-tool="${tool}"]`);
    const empty = zone.querySelector(".dz-empty"), box = zone.querySelector(".dz-file");
    const runBtn = el(`.run-btn[data-tool="${tool}"]`);
    if (file) { zone.querySelector(".dz-filename").textContent = file.name; empty.hidden = true; box.hidden = false; if (runBtn) runBtn.disabled = false; }
    else { empty.hidden = false; box.hidden = true; if (runBtn) runBtn.disabled = true; }
    const res = el(`.result[data-tool="${tool}"]`); res.className = "result"; res.innerHTML = "";
    if (tool === "crypto") updateCrypto();
  }

  function showResult(tool, kind, title, body, extra) {
    const res = el(`.result[data-tool="${tool}"]`);
    res.className = `result show ${kind}`;
    let html = `${IC[kind]}<div><div class="r-title">${title}</div><div>${body}</div>`;
    if (extra) html += `<span class="path">${extra}</span>`;
    res.innerHTML = html + "</div>";
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function outName(name, suffix) { const i = name.lastIndexOf("."); return i < 0 ? name + suffix : name.slice(0, i) + suffix + name.slice(i); }
  function download(data, name) {
    const blob = new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  // ---------- dropzones ----------
  document.querySelectorAll(".dropzone").forEach((zone) => {
    const tool = zone.dataset.tool;
    zone.addEventListener("click", (e) => { if (e.target.closest(".clear-btn")) return; browse(tool); });
    zone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); browse(tool); } });
    zone.querySelector(".clear-btn").addEventListener("click", (e) => { e.stopPropagation(); setFile(tool, null); });
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag-active"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-active"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault(); zone.classList.remove("drag-active");
      const f = e.dataTransfer.files[0]; if (f) setFile(tool, f);
    });
  });

  // ---------- Excel / VBA run ----------
  async function runTool(tool) {
    const file = selected[tool]; if (!file) return;
    const btn = el(`.run-btn[data-tool="${tool}"]`); const label = btn.textContent;
    btn.disabled = true; btn.classList.add("busy"); btn.textContent = "Working…";
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      if (tool === "excel") {
        const r = await ExcelWeb.removeExcelProtection(buf);
        const name = outName(file.name, "_unlocked");
        download(r.data, name);
        if (r.count > 0) showResult(tool, "ok", "Success", `Removed ${r.count} protection element${r.count === 1 ? "" : "s"}. Downloaded:`, name);
        else showResult(tool, "warn", "Nothing to remove", "No sheet/workbook protection was found. A copy was still downloaded.", name);
      } else {
        let r;
        try { r = await ExcelWeb.removeVbaPassword(buf); }
        catch (err) { if (String(err.message).includes("NO_VBA")) { showResult(tool, "err", "Failed", "No VBA project was found inside this file."); return; } throw err; }
        const name = outName(file.name, "_vba_unlocked");
        download(r.data, name);
        if (r.changed) showResult(tool, "ok", "Success", "VBA project unlocked. Downloaded:", name);
        else showResult(tool, "warn", "Nothing to remove", "No VBA password was found. A copy was still downloaded.", name);
      }
    } catch (e) { showResult(tool, "err", "Error", escapeHtml(String(e.message || e))); }
    finally { btn.classList.remove("busy"); btn.textContent = label; btn.disabled = !selected[tool]; }
  }
  document.querySelectorAll(".run-btn[data-tool]").forEach((b) => b.addEventListener("click", () => runTool(b.dataset.tool)));

  // ---------- Open-password recovery ----------
  const pwInput = el("#pwInput"), tryBtn = el("#tryBtn"), crackBtn = el("#crackBtn"), cancelBtn = el("#cancelBtn");
  const wordlistBtn = el("#wordlistBtn"), wordlistName = el("#wordlistName"), optBuiltin = el("#optBuiltin");
  const bruteCharset = el("#bruteCharset"), bruteMax = el("#bruteMax"), powerSel = el("#power");
  const progress = el("#progress"), progressText = el("#progressText");
  let wordlistText = "", cracking = false, workers = [], cancelled = false, phaseEnd = null;

  const workerSrc = document.getElementById("workerSrc").textContent;
  const workerURL = URL.createObjectURL(new Blob([workerSrc], { type: "application/javascript" }));
  const newWorker = () => new Worker(workerURL);
  function workerCount(power) {
    const cores = navigator.hardwareConcurrency || 4;
    if (power === "saver") return Math.max(1, Math.floor(cores / 2));
    if (power === "max") return Math.max(1, cores - 1);
    return Math.max(1, Math.floor((cores * 3) / 4));
  }

  function updateCrypto() {
    const has = !!selected.crypto;
    pwInput.disabled = !has; tryBtn.disabled = !has || !pwInput.value.trim();
    wordlistBtn.disabled = !has; crackBtn.disabled = !has || cracking;
  }
  pwInput.addEventListener("input", updateCrypto);
  pwInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !tryBtn.disabled) tryKnown(); });

  function smallInfo(info) { return { ekSalt: info.ekSalt, ekHash: info.ekHash, keyBytes: info.keyBytes, spin: info.spin, vIn: info.vIn, vVal: info.vVal }; }

  async function parseSelected() {
    const buf = new Uint8Array(await selected.crypto.arrayBuffer());
    let info;
    try { info = ExcelWeb.parseAgile(buf); }
    catch (e) { if (String(e.message).includes("NOT_AGILE")) { showResult("crypto", "err", "Unsupported", "This file uses an older encryption format that isn't supported."); return null; } throw e; }
    if (!info) { showResult("crypto", "err", "Not encrypted", "This file isn't encrypted with an open-password. Use the other tabs for sheet/VBA passwords."); return null; }
    return info;
  }

  function decryptWith(info, password) {
    return new Promise((resolve) => {
      const w = newWorker();
      w.onmessage = (ev) => { if (ev.data.type === "plain") { resolve(ev.data.data); w.terminate(); } };
      w.postMessage({ id: 0, cmd: "decrypt", info, password });
    });
  }

  async function tryKnown() {
    const info = await parseSelected(); if (!info) return;
    const pw = pwInput.value;
    tryBtn.disabled = true; const label = tryBtn.textContent; tryBtn.textContent = "…";
    const small = smallInfo(info);
    const ok = await new Promise((resolve) => {
      const w = newWorker();
      w.onmessage = (ev) => { const d = ev.data; if (d.type === "found") { resolve(true); w.terminate(); } else if (d.type === "done") { resolve(false); w.terminate(); } };
      w.postMessage({ id: 0, cmd: "verify", info: small, passwords: [pw] });
    });
    if (ok) { const plain = await decryptWith(info, pw); const name = outName(selected.crypto.name, "_decrypted"); download(plain, name); showResult("crypto", "ok", "Password correct!", `Decrypted copy downloaded:`, name); }
    else showResult("crypto", "warn", "Incorrect password", "That password didn't work. Try again or use automatic recovery below.");
    tryBtn.textContent = label; updateCrypto();
  }
  tryBtn.addEventListener("click", tryKnown);

  wordlistBtn.addEventListener("click", () => {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".txt";
    inp.addEventListener("change", async () => { const f = inp.files[0]; if (f) { wordlistText = await f.text(); wordlistName.textContent = f.name; } });
    inp.click();
  });

  function cryptoBusy(on) {
    cracking = on; crackBtn.hidden = on; cancelBtn.hidden = !on; progress.hidden = !on;
    pwInput.disabled = on || !selected.crypto; tryBtn.disabled = on || !pwInput.value.trim();
    wordlistBtn.disabled = on || !selected.crypto;
    if (on) progressText.textContent = "Starting…";
  }
  function showProgress(tried, cores) { progressText.textContent = `Tried ${tried} passwords… · ${cores} cores`; }

  function splitChunks(arr, n) {
    const out = Array.from({ length: n }, () => []);
    arr.forEach((v, i) => out[i % n].push(v));
    return out.filter((c) => c.length);
  }

  // run one phase across workers; resolve with found password or null
  function runPhase(buildMsg, count, small, base, cores) {
    return new Promise((resolve) => {
      workers = []; let done = 0, found = null, settled = false; const tries = new Array(count).fill(0);
      const sum = () => base + tries.reduce((a, b) => a + b, 0);
      const finish = () => { if (settled) return; settled = true; phaseEnd = null; workers.forEach((x) => x.terminate()); resolve({ found, tried: sum() }); };
      phaseEnd = finish; // allow cancel to resolve this phase
      for (let i = 0; i < count; i++) {
        const w = newWorker(); workers.push(w);
        w.onmessage = (ev) => {
          const d = ev.data;
          if (d.type === "progress") { tries[i] = d.tried; showProgress(sum(), cores); }
          else if (d.type === "found") { found = d.password; finish(); }
          else if (d.type === "done") { tries[i] = d.tried; done++; showProgress(sum(), cores); if (done === count) finish(); }
        };
        w.postMessage(buildMsg(i, small));
      }
    });
  }

  async function startCrack() {
    if (!optBuiltin.checked && !wordlistText && !bruteCharset.value) { showResult("crypto", "warn", "Nothing selected", "Choose at least one recovery method."); return; }
    const info = await parseSelected(); if (!info) return;
    const small = smallInfo(info);
    cancelled = false; cryptoBusy(true); el('.result[data-tool="crypto"]').className = "result";
    const cores = workerCount(powerSel.value);
    let found = null, base = 0;

    try {
      // phase 1: dictionary
      if (optBuiltin.checked || wordlistText) {
        const list = [];
        if (optBuiltin.checked) list.push.apply(list, BUILTIN);
        if (wordlistText) list.push.apply(list, wordlistText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
        const chunks = splitChunks(list, cores);
        const r = await runPhase((i) => ({ id: i, cmd: "verify", info: small, passwords: chunks[i] }), chunks.length, small, base, cores);
        found = r.found; base = r.tried;
      }
      // phase 2: brute
      if (!found && !cancelled && bruteCharset.value) {
        const cs = CHARSETS[bruteCharset.value]; const maxLen = +bruteMax.value;
        const groups = splitChunks(cs, Math.min(cores, cs.length));
        const r = await runPhase((i) => ({ id: i, cmd: "brute", info: small, charset: cs, maxLen: maxLen, firstChars: groups[i] }), groups.length, small, base, cores);
        found = r.found; base = r.tried;
      }

      if (found) { const plain = await decryptWith(info, found); const name = outName(selected.crypto.name, "_decrypted"); download(plain, name); showResult("crypto", "ok", "Password found!", `The password is <b>${escapeHtml(found)}</b>. Decrypted copy downloaded:`, name); }
      else if (cancelled) showResult("crypto", "warn", "Cancelled", `Stopped after ${base} attempts.`);
      else showResult("crypto", "warn", "Not found", `Tried ${base} passwords without success. Try a wordlist or a longer brute-force.`);
    } catch (e) { showResult("crypto", "err", "Error", escapeHtml(String(e.message || e))); }
    finally { cryptoBusy(false); updateCrypto(); }
  }
  crackBtn.addEventListener("click", startCrack);
  cancelBtn.addEventListener("click", () => { cancelled = true; progressText.textContent = "Cancelling…"; if (phaseEnd) phaseEnd(); else workers.forEach((w) => w.terminate()); });
})();
