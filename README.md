# Excel Unlock

A small tool for **personal use** — recovering access to *your own* Excel files when
you've forgotten the password. Maroon theme, dark/light toggle. Comes in two forms:

- **Desktop app** (Rust + Tauri) — see below.
- **Web app** — a single offline HTML file (`web/Excel Unlock.html`) that runs entirely in
  your browser; files never leave your device. Also hosted via GitHub Pages:
  **https://DrM7md.github.io/Excel-Unlock/**

## What it does

### 1. Excel Password Remover
Removes **sheet** and **workbook-structure** protection from `.xlsx` / `.xlsm` files.
These protections are stored as a removable `<sheetProtection>` / `<workbookProtection>`
tag inside the file — the app simply deletes the tag. No password is cracked.

> Note: this is the *protect sheet / protect structure* password, **not** the
> "encrypt with password" (file-open) password. The open password uses real AES
> encryption and cannot be removed without the password.

### 2. VBA Password Remover
Unlocks the **VBA project** in `.xlsm` / `.xlsb` / `.xls` files. The VBA password is only a
protection flag (`DPB`) inside the embedded `vbaProject.bin`; the app neutralizes it so
Excel drops the lock. Open the file, press Alt+F11 — the project is accessible.

### 3. Open Password Recovery  (`.xlsx` / `.xlsm`)
For files encrypted with **"Encrypt with Password"** (a password is required just to open
the file). This is **real AES-256 encryption** (ECMA-376 Agile) — it cannot be bypassed or
removed. The only way in is to find the password, so this tool:

1. **Type it** — if you remember the password, it decrypts instantly and saves a plain copy.
2. **Common passwords** — tries a built-in list of ~250 common passwords.
3. **Wordlist** — tries every line of a text file you supply.
4. **Brute force** — tries all short combinations of a chosen character set (digits, letters…).

Because Office uses 100,000 hash rounds per guess, brute force is only realistic for very
short, simple passwords. A strong password is effectively unbreakable — that's by design.
Progress is shown live and can be cancelled. On success a decrypted copy
(`name_decrypted.xlsx`) is saved. **Use the optimized release build for recovery — it is
dozens of times faster than the debug build.**

In every case a **new copy** is written next to the original (`name_unlocked.xlsx`,
`name_vba_unlocked.xlsm`, `name_decrypted.xlsx`). Your source file is never modified.

## Run (development)

```bash
cd src-tauri
cargo tauri dev
```

## Build a standalone app

```bash
cd src-tauri
cargo tauri build
```

The installer / `.exe` appears under `src-tauri/target/release/bundle/`.

## Project layout

```
src/                 Frontend (HTML/CSS/JS, no build step)
src-tauri/src/
  lib.rs             Tauri commands (read file, write unlocked copy)
  excel.rs           Sheet/workbook protection removal
  vba.rs             VBA project password removal
  util.rs            ZIP + byte helpers
src-tauri/examples/check.rs   CLI test harness + VBA self-test
```

## Notes
- For your own files only.
- Legacy binary `.xls` *sheet* protection is not supported (BIFF format); VBA unlocking
  works for `.xls`.
