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

if [[ -f "$CERT_FILE" ]]; then
  echo "Certificate already exists at $CERT_FILE"
  echo "Delete it first if you want to regenerate."
  exit 0
fi

download_zxpsign() {
  mkdir -p "$ROOT/tools/bin"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    URL="https://github.com/Adobe-CEP/CEP-Resources/raw/master/ZXPSignCMD/4.1.1/osx/ZXPSignCmd-64bit"
  else
    URL="https://github.com/Adobe-CEP/CEP-Resources/raw/master/ZXPSignCMD/4.1.1/linux/64-bit/ZXPSignCmd"
  fi
  echo "Downloading ZXPSignCmd from $URL…"
  curl -fSL "$URL" -o "$ZXPSIGN"
  chmod +x "$ZXPSIGN"
}

if [[ ! -x "$ZXPSIGN" ]]; then
  download_zxpsign
fi

echo "Generating self-signed certificate → $CERT_FILE"
"$ZXPSIGN" -selfSignedCert \
  US CA "SmartCut" "SmartCut Publisher" "$PASSWORD" "$CERT_FILE" \
  -validityDays 3650

echo ""
echo "Certificate created: $CERT_FILE"
echo "Password:           $PASSWORD"
echo ""
echo "Keep both safe — you'll reuse them for every release."
