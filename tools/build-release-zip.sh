#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-release-zip.sh — package SmartCut as an in-place update zip
#
# Produces:
#   dist/SmartCutPro-<version>-mac.zip
#
# What it bundles (same tree SmartCut Updater.app rsyncs into CEP):
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
#   META-INF/ (zxp signing metadata — not useful for in-place updates)
#
# Usage:
#   ./tools/build-release-zip.sh           # version from package.json
#   ./tools/build-release-zip.sh 1.2.0
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
STAGE_DIR="$ROOT/.release-zip-stage"
DIST_DIR="$ROOT/dist"

VERSION="${1:-$(node -p "require('$ROOT/package.json').version")}"

echo "Stamping manifest with version ${VERSION} ..."
/usr/bin/sed -i.bak -E "s/(ExtensionBundleVersion=\")[^\"]+(\")/\1$VERSION\2/" "$ROOT/CSXS/manifest.xml"
/usr/bin/sed -i.bak -E "s/(<Extension Id=\"com\.smartcutpro\.panel\" Version=\")[^\"]+(\")/\1$VERSION\2/" "$ROOT/CSXS/manifest.xml"
rm -f "$ROOT/CSXS/manifest.xml.bak"

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

echo "Staging files ..."
rsync -a \
  --exclude 'node_modules/' \
  --exclude 'tools/' \
  --exclude 'signing/' \
  --exclude 'dist/' \
  --exclude 'dist-updater/' \
  --exclude '.release-zip-stage/' \
  --exclude '.build-stage/' \
  --exclude 'package.json' \
  --exclude 'package-lock.json' \
  --exclude '.git*' \
  --exclude 'install-dev.sh' \
  --exclude '.DS_Store' \
  --exclude '*.log' \
  --exclude 'README.md' \
  --exclude 'RELEASE.md' \
  --exclude 'META-INF/' \
  "$ROOT/" "$STAGE_DIR/"

for req in CSXS/manifest.xml client/index.html host/SmartCutHost.jsx; do
  if [[ ! -e "$STAGE_DIR/$req" ]]; then
    echo "Missing required file in stage: $req"
    exit 1
  fi
done

mkdir -p "$DIST_DIR"
OUT_ZIP="$DIST_DIR/SmartCutPro-$VERSION-mac.zip"
rm -f "$OUT_ZIP"

echo "Zipping → $OUT_ZIP"
# -r recursive, -X strip extra file attributes, -9 max compression.
# Note: we zip the *contents* of STAGE_DIR so the archive has CSXS/, client/,
# … at its root (no wrapping folder). SmartCut Updater.app rsyncs the
# extracted tree into the CEP extensions folder exactly as-is.
( cd "$STAGE_DIR" && /usr/bin/zip -rqX9 "$OUT_ZIP" . )

rm -rf "$STAGE_DIR"

SIZE_MB=$(du -m "$OUT_ZIP" | awk '{print $1}')
echo ""
echo "Built $OUT_ZIP  (${SIZE_MB}MB)"
echo "Upload to R2 as: SmartCutPro-${VERSION}-mac.zip"
