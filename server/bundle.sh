#!/bin/sh
# Assembles what runs on the OpenClaw machine into the folder given as $1 (default: ./dist-server).
set -e
cd "$(dirname "$0")/.."
OUT="${1:-dist-server}"
mkdir -p "$OUT"
cp server/service.mjs server/report-pdf.mjs "$OUT"/
cp lib/seal.js "$OUT/seal.mjs"
cat > "$OUT/package.json" <<'JSON'
{ "name": "cleaning-report-service", "private": true, "type": "module", "dependencies": { "pdf-lib": "^1.17.1" } }
JSON
echo "bundle written to $OUT"
