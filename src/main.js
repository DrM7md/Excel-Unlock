const { invoke } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;

const selected = { excel: null, vba: null, crypto: null };
const EXTS = {
  excel: ["xlsx", "xlsm"],
  vba: ["xlsm", "xlsb", "xls"],
  crypto: ["xlsx", "xlsm"],
};
const CMD = { excel: "remove_excel_protection", vba: "remove_vba_password" };

// ---------- Icons ----------
const SUN = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>';
const IC = {
  ok: '<svg class="r-ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  warn: '<svg class="r-ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  err: '<svg class="r-ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
};

// ---------- Theme ----------
const root = document.documentElement;
const themeToggle = document.getElementById("themeToggle");
function applyTheme(theme) {
  root.setAttribute("data-theme", theme);
  themeToggle.innerHTML = theme === "dark" ? MOON : SUN;
  try { localStorage.setItem("theme", theme); } catch (_) {}
}
applyTheme((() => { try { return localStorage.getItem("theme") || "dark"; } catch (_) { return "dark"; } })());
themeToggle.addEventListener("click", () =>
  applyTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark")
);

// ---------- Tabs ----------
let activeTool = "excel";
const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel");
tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    activeTool = tab.dataset.tab;
    tabs.forEach((t) => t.classList.toggle("active", t === tab));
    panels.forEach((p) => p.classList.toggle("active", p.dataset.tool === activeTool));
  });
});

// ---------- Helpers ----------
const baseName = (p) => p.split(/[\\/]/).pop();
const el = (sel) => document.querySelector(sel);

function setFile(tool, path) {
  selected[tool] = path;
  const zone = el(`.dropzone[data-tool="${tool}"]`);
  const empty = zone.querySelector(".dz-empty");
  const fileBox = zone.querySelector(".dz-file");
  const runBtn = el(`.run-btn[data-tool="${tool}"]`);

  if (path) {
    zone.querySelector(".dz-filename").textContent = baseName(path);
    empty.hidden = true;
    fileBox.hidden = false;
    if (runBtn) runBtn.disabled = false;
  } else {
    empty.hidden = false;
    fileBox.hidden = true;
    if (runBtn) runBtn.disabled = true;
  }
  const res = el(`.result[data-tool="${tool}"]`);
  res.className = "result";
  res.innerHTML = "";
  if (tool === "crypto") updateCrypto();
}

function showResult(tool, kind, title, body, path) {
  const res = el(`.result[data-tool="${tool}"]`);
  res.className = `result show ${kind}`;
  let html = `${IC[kind]}<div><div class="r-title">${title}</div><div>${body}</div>`;
  if (path) html += `<span class="path">${path}</span>`;
  html += `</div>`;
  res.innerHTML = html;
}

const ERRORS = {
  NOT_XLSX: "This isn't an .xlsx/.xlsm file. Legacy binary .xls sheet protection isn't supported.",
  NO_VBA: "No VBA project was found inside this file.",
  UNSUPPORTED: "This file type isn't supported for VBA unlocking.",
};
function describeError(code) {
  return ERRORS[code] || ERRORS[code.split(":")[0]] || code;
}

// ---------- File picker ----------
async function pickFile(tool) {
  try {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Excel files", extensions: EXTS[tool] }],
    });
    if (typeof path === "string") setFile(tool, path);
  } catch (e) {
    showResult(tool, "err", "Error", String(e));
  }
}

// Click-to-browse on the whole dropzone; clear button; keyboard.
document.querySelectorAll(".dropzone").forEach((zone) => {
  const tool = zone.dataset.tool;
  zone.addEventListener("click", (e) => {
    if (e.target.closest(".clear-btn")) return;
    pickFile(tool);
  });
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickFile(tool); }
  });
  zone.querySelector(".clear-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    setFile(tool, null);
  });
});

// ---------- Run ----------
async function run(tool) {
  const path = selected[tool];
  if (!path) return;
  const runBtn = el(`.run-btn[data-tool="${tool}"]`);
  const label = runBtn.textContent;
  runBtn.disabled = true;
  runBtn.classList.add("busy");
  runBtn.textContent = "Working…";
  try {
    const r = await invoke(CMD[tool], { path });
    if (r.error) {
      showResult(tool, "err", "Failed", describeError(r.error));
    } else if (!r.changed) {
      showResult(tool, "warn", "Nothing to remove",
        tool === "excel"
          ? "No sheet/workbook protection was found. A copy was still saved."
          : "No VBA password was found. A copy was still saved.",
        r.output_path);
    } else {
      showResult(tool, "ok", "Success",
        tool === "excel"
          ? `Removed ${r.count} protection element${r.count === 1 ? "" : "s"}. Unlocked copy saved:`
          : "VBA project unlocked. Saved copy:",
        r.output_path);
    }
  } catch (e) {
    showResult(tool, "err", "Error", String(e));
  } finally {
    runBtn.classList.remove("busy");
    runBtn.textContent = label;
    runBtn.disabled = !selected[tool];
  }
}
document.querySelectorAll(".run-btn").forEach((btn) =>
  btn.addEventListener("click", () => run(btn.dataset.tool))
);

// ---------- Open-password recovery (crypto card) ----------
const pwInput = document.getElementById("pwInput");
const tryBtn = document.getElementById("tryBtn");
const crackBtn = document.getElementById("crackBtn");
const cancelBtn = document.getElementById("cancelBtn");
const wordlistBtn = document.getElementById("wordlistBtn");
const wordlistName = document.getElementById("wordlistName");
const optBuiltin = document.getElementById("optBuiltin");
const bruteCharset = document.getElementById("bruteCharset");
const bruteMax = document.getElementById("bruteMax");
const progress = document.getElementById("progress");
const progressText = document.getElementById("progressText");
let wordlistPath = "";
let cracking = false;

function updateCrypto() {
  const has = !!selected.crypto;
  pwInput.disabled = !has;
  tryBtn.disabled = !has || !pwInput.value.trim();
  wordlistBtn.disabled = !has;
  crackBtn.disabled = !has || cracking;
}

pwInput.addEventListener("input", updateCrypto);
pwInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !tryBtn.disabled) tryKnown();
});

async function tryKnown() {
  const path = selected.crypto;
  const password = pwInput.value;
  if (!path || !password.trim()) return;
  tryBtn.disabled = true;
  const label = tryBtn.textContent;
  tryBtn.textContent = "…";
  try {
    const r = await invoke("try_password", { path, password });
    handleCryptoResult(r, false);
  } catch (e) {
    showResult("crypto", "err", "Error", String(e));
  } finally {
    tryBtn.textContent = label;
    updateCrypto();
  }
}
tryBtn.addEventListener("click", tryKnown);

wordlistBtn.addEventListener("click", async () => {
  try {
    const p = await open({ multiple: false, directory: false });
    if (typeof p === "string") {
      wordlistPath = p;
      wordlistName.textContent = baseName(p);
      wordlistName.classList.remove("muted");
    }
  } catch (_) {}
});

function cryptoBusy(on) {
  cracking = on;
  crackBtn.hidden = on;
  cancelBtn.hidden = !on;
  progress.hidden = !on;
  pwInput.disabled = on || !selected.crypto;
  tryBtn.disabled = on || !pwInput.value.trim();
  wordlistBtn.disabled = on || !selected.crypto;
  if (on) progressText.textContent = "Starting…";
}

async function startCrack() {
  const path = selected.crypto;
  if (!path) return;
  if (!optBuiltin.checked && !wordlistPath && !bruteCharset.value) {
    showResult("crypto", "warn", "Nothing selected", "Choose at least one recovery method.");
    return;
  }
  cryptoBusy(true);
  el('.result[data-tool="crypto"]').className = "result";
  try {
    const r = await invoke("crack_password", {
      path,
      useBuiltin: optBuiltin.checked,
      wordlistPath: wordlistPath,
      bruteCharset: bruteCharset.value,
      bruteMax: bruteCharset.value ? parseInt(bruteMax.value, 10) : 0,
      power: document.getElementById("power").value,
    });
    handleCryptoResult(r, true);
  } catch (e) {
    showResult("crypto", "err", "Error", String(e));
  } finally {
    cryptoBusy(false);
    updateCrypto();
  }
}
crackBtn.addEventListener("click", startCrack);
cancelBtn.addEventListener("click", () => {
  invoke("cancel_crack");
  progressText.textContent = "Cancelling…";
});

const CRYPTO_ERRORS = {
  NOT_ENCRYPTED: "This file isn't encrypted with an open-password. Use the other tools for sheet/VBA passwords.",
  NOT_AGILE: "This file uses an older encryption format that isn't supported.",
};

function handleCryptoResult(r, fromCrack) {
  if (r.error) {
    const msg = CRYPTO_ERRORS[r.error] || CRYPTO_ERRORS[r.error.split(":")[0]] || r.error;
    showResult("crypto", "err", "Failed", msg);
    return;
  }
  if (r.found) {
    showResult(
      "crypto",
      "ok",
      "Password found!",
      `The password is <b>${escapeHtml(r.password)}</b>. Decrypted copy saved:`,
      r.output_path
    );
    return;
  }
  // not found
  if (r.reason === "wrong") {
    showResult("crypto", "warn", "Incorrect password", "That password didn't work. Try again or use automatic recovery below.");
  } else if (r.reason === "cancelled") {
    showResult("crypto", "warn", "Cancelled", `Stopped after ${r.tried} attempt${r.tried === 1 ? "" : "s"}.`);
  } else {
    showResult("crypto", "warn", "Not found", `Tried ${r.tried} password${r.tried === 1 ? "" : "s"} without success. Try adding a wordlist or a longer brute-force.`);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// progress events
if (window.__TAURI__.event) {
  window.__TAURI__.event.listen("crack-progress", (e) => {
    if (!cracking) return;
    const p = e.payload || {};
    const cores = p.threads ? ` · ${p.threads} cores` : "";
    progressText.textContent = `Tried ${p.tried} passwords…${cores}`;
  });
}

// ---------- Drag & drop ----------
// With tabs, only one tool is visible, so a dropped file always goes to the active tab.
if (window.__TAURI__.event) {
  const { listen } = window.__TAURI__.event;
  const activeZone = () => el(`.panel.active .dropzone`);

  listen("tauri://drag-over", () => {
    const z = activeZone();
    if (z) z.classList.add("drag-active");
  });
  listen("tauri://drag-leave", () => {
    const z = activeZone();
    if (z) z.classList.remove("drag-active");
  });
  listen("tauri://drag-drop", (e) => {
    const z = activeZone();
    if (z) z.classList.remove("drag-active");
    const paths = e.payload && e.payload.paths;
    if (paths && paths.length) setFile(activeTool, paths[0]);
  });
}
