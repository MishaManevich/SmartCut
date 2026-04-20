#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# make-cert.sh — generate a self-signed code-signing certificate for .zxp
#
# This creates a .p12 file that you can feed to ZXPSignCmd. For a commercial
# release you should replace this with a properly-issued cert from a CA that
# Adobe trusts (DigiCert, Sectigo, etc.) — but for early private-beta, a
# self-signed cert is completely fine. Adobe displays an "unverified publisher"
# banner on install but users can still install.
#
# Output: ./signing/smartcutpro.p12   (password: see PASSWORD below or env var)
#
# Usage:
#   ./tools/make-cert.sh
#   CERT_PASSWORD=yourpass ./tools/make-cert.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SIGN_DIR="$ROOT/signing"

mkdir -p "$SIGN_DIR"

PASSWORD="${CERT_PASSWORD:-smartcutpro2026}"
CERT_FILE="$SIGN_DIR/smartcutpro.p12"
ZXPSIGN="$ROOT/tools/bin/ZXPSignCmd"

# Adobe hosts ZXPSignCmd inside the public CEP-Resources repo (not a paid SKU).
# macOS builds ship as a .dmg; older docs pointed at a bare binary URL that 404s.
download_zxpsign() {
  mkdir -p "$ROOT/tools/bin"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    local DMG_URL="https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD/4.1.2/macOS/ZXPSignCmd-64bit.dmg"
    local DMG="$ROOT/tools/bin/ZXPSignCmd-64bit.dmg"
    echo "Downloading ZXPSignCmd DMG from ${DMG_URL} ..."
    curl -fSL "$DMG_URL" -o "$DMG"
    local MNT
    MNT="$(mktemp -d /tmp/smartcut-zxpsign.XXXXXX)"
    hdiutil attach "$DMG" -mountpoint "$MNT" -nobrowse -quiet
    local FOUND
    # DMG ships the binary as "ZXPSignCmd-64bit" (not "ZXPSignCmd").
    FOUND="$(find "$MNT" -maxdepth 1 -type f \( -name 'ZXPSignCmd-64bit' -o -name ZXPSignCmd \) 2>/dev/null | head -1)"
    if [[ -z "$FOUND" || ! -f "$FOUND" ]]; then
      hdiutil detach "$MNT" -quiet || true
      rm -f "$DMG"
      echo "Could not locate ZXPSignCmd inside the DMG."
      exit 1
    fi
    cp "$FOUND" "$ZXPSIGN"
    hdiutil detach "$MNT" -quiet
    rm -f "$DMG"
    chmod +x "$ZXPSIGN"
  elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
    local EXE_URL="https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD/4.1.3/x64/ZXPSignCmd.exe"
    echo "Downloading ZXPSignCmd.exe from ${EXE_URL} ..."
    curl -fSL "$EXE_URL" -o "${ZXPSIGN}.exe"
    ZXPSIGN="${ZXPSIGN}.exe"
  else
    echo "Automatic ZXPSignCmd download is set up for macOS and Windows (Git Bash)."
    echo "Grab a build from: https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD"
    echo "Then place the binary at: $ROOT/tools/bin/ZXPSignCmd"
    exit 1
  fi
}

if [[ ! -x "$ZXPSIGN" && ! -x "${ZXPSIGN}.exe" ]]; then
  download_zxpsign
fi
if [[ -x "${ROOT}/tools/bin/ZXPSignCmd.exe" ]]; then
  ZXPSIGN="${ROOT}/tools/bin/ZXPSignCmd.exe"
fi

if [[ -f "$CERT_FILE" ]]; then
  echo "Certificate already exists at $CERT_FILE"
  echo "Delete it first if you want to regenerate."
  exit 0
fi

echo "Generating self-signed certificate → $CERT_FILE"
# ZXPSignCmd-64bit is an Intel binary; on Apple Silicon it must run under Rosetta.
if [[ "$(uname -m)" == "arm64" && "$OSTYPE" == "darwin"* ]]; then
  if ! arch -x86_64 "$ZXPSIGN" -selfSignedCert \
    US CA "SmartCut" "SmartCut Publisher" "$PASSWORD" "$CERT_FILE" \
    -validityDays 3650; then
    echo ""
    echo "If you saw \"Bad CPU type\" or Rosetta errors, install Rosetta once:"
    echo "  softwareupdate --install-rosetta --agree-to-license"
    echo "Then re-run this script."
    exit 1
  fi
else
  "$ZXPSIGN" -selfSignedCert \
    US CA "SmartCut" "SmartCut Publisher" "$PASSWORD" "$CERT_FILE" \
    -validityDays 3650
fi

echo ""
echo "Certificate created: $CERT_FILE"
echo "Password:           $PASSWORD"
echo ""
echo "Keep both safe — you'll reuse them for every release."
