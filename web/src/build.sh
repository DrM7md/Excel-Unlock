#!/usr/bin/env bash
set -e
PROJ="D:/04_ Work & Projects/05_ Development/04_ Desktop Development/Excel"
cd "$(dirname "$0")"

# Build the builtin wordlist as a JS array
node -e "const fs=require('fs');const w=fs.readFileSync(process.argv[1],'utf8').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);fs.writeFileSync('wordlist.js','var BUILTIN='+JSON.stringify(w)+';')" "$PROJ/src-tauri/src/wordlist.txt"

OUT="$PROJ/web/Excel Unlock.html"
mkdir -p "$PROJ/web"
{
  cat <<'HEAD'
<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Excel Unlock</title>
<style>
HEAD
  cat web-styles.css
  echo '</style></head><body>'
  cat body.html
  echo '<script>'; cat node_modules/jszip/dist/jszip.min.js; echo ''; echo '</script>'
  echo '<script>'; cat node_modules/cfb/dist/cfb.min.js; echo ''; echo '</script>'
  echo '<script>'; cat core.js; echo '</script>'
  echo '<script>'; cat wordlist.js; echo '</script>'
  echo '<script type="text/worker" id="workerSrc">'
  cat node_modules/aes-js/index.js; echo ';'
  cat node_modules/js-sha512/build/sha512.min.js; echo ';'
  cat node_modules/js-sha1/build/sha1.min.js; echo ';'
  cat worker-glue.js
  echo '</script>'
  echo '<script>'; cat app.js; echo '</script>'
  echo '</body></html>'
} > "$OUT"
echo "built: $OUT ($(wc -c < "$OUT") bytes)"
