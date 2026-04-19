#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-zxp.sh — package SmartCut as a signed .zxp installer
#
# Produces:
#   dist/SmartCutPro-<version>.zxp    — installer users double-click
#
# What it bundles:
#   CSXS/            (manifest.xml etc)
#   client/          (panel HTML/JS/CSS, transformers bundle, model, lib)
#   host/            (ExtendScript)
#   bin/whisper/     (whisper-cli + dylibs + ggml model)
#   models/          (Whisper + embedding models)
#
# What it excludes (dev-only):
#   node_modules/
#   tools/
#   signing/
#   dist/
#   package*.json
#   .git*
#   install-dev.sh
#
# Usage:
#   ./tools/build-zxp.sh                 # uses signing/smartcutpro.p12
#   ./tools/build-zxp.sh 1.2.0           # override version
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BIN_DIR="$ROOT/tools/bin"
ZXPSIGN="$BIN_DIR/ZXPSignCmd"
SIGN_DIR="$ROOT/signing"
CERT_FILE="$SIGN_DIR/smartcutpro.p12"
PASSWORD="${CERT_PASSWORD:-smartcutpro2026}"
STAGE_DIR="$ROOT/.build-stage"
DIST_DIR="$ROOT/dist"

VERSION="${1:-$(node -p "require('$ROOT/package.json').version")}"

if [[ ! -x "$ZXPSIGN" ]]; then
  echo "ZXPSignCmd not found — run ./tools/make-cert.sh first."
  exit 1
fi

if [[ ! -f "$CERT_FILE" ]]; then
  echo "Certificate not found at $CERT_FILE"
  echo "Run ./tools/make-cert.sh first."
  exit 1
fi

# Sync version into manifest.xml so install reflects the right version.
echo "Stamping manifest with version $VERSION…"
/usr/bin/sed -i.bak -E "s/(ExtensionBundleVersion=\")[^\"]+(\")/\1$VERSION\2/" "$ROOT/CSXS/manifest.xml"
/usr/bin/sed -i.bak -E "s/(<Extension Id=\"com\.smartcutpro\.panel\" Version=\")[^\"]+(\")/\1$VERSION\2/" "$ROOT/CSXS/manifest.xml"
rm -f "$ROOT/CSXS/manifest.xml.bak"

# Stage the clean bundle.
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

echo "Staging files…"
rsync -a \
  --exclude 'node_modules/' \
  --exclude 'tools/' \
  --exclude 'signing/' \
  --exclude 'dist/' \
  --exclude '.build-stage/' \
  --exclude 'package.json' \
  --exclude 'package-lock.json' \
  --exclude '.git*' \
  --exclude 'install-dev.sh' \
  --exclude '.DS_Store' \
  --exclude '*.log' \
  --exclude 'README.md' \
  "$ROOT/" "$STAGE_DIR/"

# Sanity: required entries present.
for req in CSXS/manifest.xml client/index.html host/SmartCutHost.jsx; do
  if [[ ! -e "$STAGE_DIR/$req" ]]; then
    echo "Missing required file in stage: $req"
    exit 1
  fi
done

mkdir -p "$DIST_DIR"
OUT_ZXP="$DIST_DIR/SmartCutPro-$VERSION.zxp"
rm -f "$OUT_ZXP"

echo "Signing → $OUT_ZXP"
"$ZXPSIGN" -sign "$STAGE_DIR" "$OUT_ZXP" "$CERT_FILE" "$PASSWORD" \
  -tsa https://timestamp.digicert.com/

rm -rf "$STAGE_DIR"

SIZE_MB=$(du -m "$OUT_ZXP" | awk '{print $1}')
echo ""
echo "Built $OUT_ZXP  (${SIZE_MB}MB)"
echo ""
echo "Distribute this .zxp to users. They can install it with:"
echo "  1. Adobe's free 'Anastasiy's Extension Manager' (recommended)"
echo "  2. Or ZXPInstaller (https://zxpinstaller.com)"
