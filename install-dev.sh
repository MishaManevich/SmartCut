#!/usr/bin/env bash
#
# SmartCut — dev installer
# Copies the extension into the CEP extensions folder and enables unsigned
# extensions for every CSXS version Premiere might load.
#
# Usage:
#   ./install-dev.sh          # copy + enable unsigned + open log
#   ./install-dev.sh --clean  # remove the installed extension first
#
set -euo pipefail

SRC_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
EXT_ID="com.smartcutpro.panel"
DEST_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/$EXT_ID"
LOG_FILE="$HOME/Library/Application Support/SmartCutPro/debug.log"

log() { printf "\033[36m▸\033[0m %s\n" "$*"; }

if [[ "${1:-}" == "--clean" ]]; then
  log "Removing existing install at $DEST_DIR"
  rm -rf "$DEST_DIR"
fi

log "Enabling unsigned CEP extensions (CSXS 9–12)"
for v in 9 10 11 12; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1 || true
  defaults write "com.adobe.CSXS.$v" LogLevel 6 || true
done

# Ensure the transformers.js bundle + ORT WASM + embedding model have been
# built. If any is missing, re-run the build tooling (requires `npm install`
# to have been run once). This keeps dev installs self-healing.
BUNDLE="$SRC_DIR/client/lib/transformers.bundle.js"
WASM="$SRC_DIR/bin/ort-wasm/ort-wasm-simd-threaded.jsep.wasm"
MODEL="$SRC_DIR/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx"
if [[ ! -f "$BUNDLE" || ! -f "$WASM" ]]; then
  if [[ -d "$SRC_DIR/node_modules" ]]; then
    log "Building transformers.js bundle + ORT WASM (first run)"
    ( cd "$SRC_DIR" && node tools/build-embedder.js )
  else
    log "WARNING: transformers.bundle.js missing and node_modules not present."
    log "Run:  cd \"$SRC_DIR\" && npm install && npm run build:embedder && npm run fetch:model"
  fi
fi
if [[ ! -f "$MODEL" ]]; then
  if [[ -d "$SRC_DIR/node_modules" ]]; then
    log "Fetching MiniLM-L6-v2 embedding model (~23MB, one-time)"
    ( cd "$SRC_DIR" && node tools/fetch-model.js )
  fi
fi

# Whisper model is 141MB — exceeds GitHub's per-file limit, so it's
# fetched from HuggingFace on first install instead of being committed.
WHISPER_MODEL="$SRC_DIR/models/ggml-base.en.bin"
WHISPER_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
if [[ ! -f "$WHISPER_MODEL" ]]; then
  log "Fetching whisper model ggml-base.en.bin (~141MB, one-time)"
  mkdir -p "$SRC_DIR/models"
  if command -v curl >/dev/null 2>&1; then
    curl -L --fail --progress-bar "$WHISPER_URL" -o "$WHISPER_MODEL" || {
      log "ERROR: failed to download whisper model."
      log "Manual fetch:  curl -L $WHISPER_URL -o $WHISPER_MODEL"
      exit 1
    }
  else
    log "ERROR: curl not found. Please install curl or download manually:"
    log "  $WHISPER_URL"
    log "  -> save as: $WHISPER_MODEL"
    exit 1
  fi
fi

log "Copying extension → $DEST_DIR"
mkdir -p "$DEST_DIR"
# Sync source — excludes installer / node_modules / git metadata / dev tooling
rsync -a --delete \
  --exclude ".git" \
  --exclude "install-dev.sh" \
  --exclude "README.md" \
  --exclude "node_modules" \
  --exclude "package.json" \
  --exclude "package-lock.json" \
  --exclude "tools" \
  --exclude "signing" \
  --exclude "dist" \
  --exclude ".build-stage" \
  "$SRC_DIR/" "$DEST_DIR/"

# Make whisper binaries executable and strip Gatekeeper quarantine (dev only)
WDIR_MAC="$DEST_DIR/bin/whisper/macos-arm64"
if [[ -d "$WDIR_MAC" ]]; then
  log "Setting exec perms on whisper binaries"
  chmod 755 "$WDIR_MAC/whisper-cli" 2>/dev/null || true
  chmod 755 "$WDIR_MAC"/*.dylib 2>/dev/null || true
  chmod 755 "$WDIR_MAC"/*.so 2>/dev/null || true
  xattr -dr com.apple.quarantine "$WDIR_MAC" 2>/dev/null || true
fi

log "Done."
log "Next steps:"
log "  1. Fully quit Premiere Pro (Cmd+Q)"
log "  2. Relaunch Premiere Pro"
log "  3. Window → Extensions → SmartCut"
log ""
log "Host logs will be written to: $LOG_FILE"
log "Panel devtools: open Chrome → http://localhost:8088"
