#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-mac-dmg.sh — user-facing macOS installer (DMG + .app, no ZXP UX)
#
# Requires a signed ZXP from ./tools/build-zxp.sh first:
#   ./tools/build-zxp.sh
#   ./tools/build-mac-dmg.sh
#
# Output:
#   dist/SmartCutPro-<version>-mac.dmg
#
# The DMG contains "Install SmartCut.app". The signed .zxp is unpacked *into*
# the app bundle (not shipped as a .zxp) so Apple Notary can validate Mach-O
# binaries inside whisper-cli — then the installer rsyncs that payload into CEP.
#
# Usage:
#   ./tools/build-mac-dmg.sh           # version from package.json
#   ./tools/build-mac-dmg.sh 1.2.0
#
# Developer ID + notarization (optional, recommended for customers):
#   1. Xcode → Settings → Accounts → manage certificates →
#      + → Developer ID Application (needs Apple Developer Program).
#   2. cp tools/macos-signing.env.example tools/macos-signing.env
#      Set MAC_CODESIGN_IDENTITY to the exact "Developer ID Application: …" string
#      from: security find-identity -v -p codesigning
#   3. ./tools/setup-macos-notary.sh   # stores notary credentials in Keychain
#   4. Put MAC_NOTARY_KEYCHAIN_PROFILE in macos-signing.env
#   5. Re-run this script — it signs the .app, builds the DMG, submits to Apple,
#      and staples the ticket when MAC_NOTARY_KEYCHAIN_PROFILE is set.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

if [[ -f "$HERE/macos-signing.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$HERE/macos-signing.env"
  set +a
fi
DIST_DIR="$ROOT/dist"
VERSION="${1:-$(node -p "require('$ROOT/package.json').version")}"
ZXP="$DIST_DIR/SmartCutPro-$VERSION.zxp"
APP_NAME="Install SmartCut.app"
VOLNAME="SmartCut Pro ${VERSION}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script must run on macOS."
  exit 1
fi

if [[ ! -f "$ZXP" ]]; then
  echo "Missing $ZXP — run ./tools/build-zxp.sh first."
  exit 1
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

APP="$STAGE/$APP_NAME"
mkdir -p "$APP/Contents/MacOS"
mkdir -p "$APP/Contents/Resources"

EXT_PAYLOAD="$APP/Contents/Resources/SmartCutExtension"
rm -rf "$EXT_PAYLOAD"
mkdir -p "$EXT_PAYLOAD"
unzip -q "$ZXP" -d "$EXT_PAYLOAD"
rm -rf "$EXT_PAYLOAD/META-INF" "$EXT_PAYLOAD/.debug" 2>/dev/null || true

# Apple Notary scans every Mach-O inside the DMG, including whisper dylibs.
# They must be Developer ID + hardened runtime + secure timestamp.
sign_extension_mach_o() {
  local root="$1"
  [[ -n "${MAC_CODESIGN_IDENTITY:-}" ]] || return 0
  echo "Signing Mach-O binaries in SmartCutExtension (required for notarization)…"
  local f
  while IFS= read -r -d '' f; do
    if file "$f" 2>/dev/null | grep -q "Mach-O"; then
      codesign --force --sign "$MAC_CODESIGN_IDENTITY" --timestamp --options runtime "$f"
    fi
  done < <(find "$root" -type f -print0)
}

sign_extension_mach_o "$EXT_PAYLOAD"

# Build SmartCut Updater.app (for seamless post-install updates) and ship it
# inside the DMG alongside the main installer app. The installer script
# below copies it into /Applications on first install.
UPDATER_APP_NAME="SmartCut Updater.app"
UPDATER_OUT="$STAGE/.updater-build"
mkdir -p "$UPDATER_OUT"
echo "Building $UPDATER_APP_NAME …"
OUT_DIR="$UPDATER_OUT" "$HERE/updater-app/build-updater-app.sh" "$VERSION"

STAGED_UPDATER_APP="$UPDATER_OUT/$UPDATER_APP_NAME"
if [[ ! -d "$STAGED_UPDATER_APP" ]]; then
  echo "Updater app failed to build at $STAGED_UPDATER_APP"
  exit 1
fi

# Also sign the updater app's internals alongside the main installer (the
# updater-app script already signs it, but Mach-O binaries inside it need
# to have consistent signatures before the DMG's notarization scan).
mkdir -p "$APP/Contents/Resources/SmartCutUpdater"
/usr/bin/ditto "$STAGED_UPDATER_APP" "$APP/Contents/Resources/SmartCutUpdater/$UPDATER_APP_NAME"

cat > "$APP/Contents/MacOS/install-smartcut" << 'INSTALLER'
#!/bin/bash
set -euo pipefail
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
RES="$SELF_DIR/../Resources"

die_msg() {
  osascript -e "display dialog \"$1\" buttons {\"OK\"} default button \"OK\" with icon stop" 2>/dev/null || echo "$1"
  exit 1
}

PAYLOAD="$RES/SmartCutExtension"
TMP=""
if [[ -d "$PAYLOAD" ]]; then
  SRC="$PAYLOAD"
else
  ZXP=$(ls "$RES"/SmartCutPro-*.zxp 2>/dev/null | head -1 || true)
  if [[ -z "${ZXP:-}" ]] || [[ ! -f "$ZXP" ]]; then
    die_msg "Installer is incomplete (missing package). Download again from your purchase email or trysmartcut.com/thanks."
  fi
  TMP=$(mktemp -d)
  trap 'rm -rf "${TMP:-}"' EXIT
  unzip -q "$ZXP" -d "$TMP" || die_msg "Could not unpack SmartCut. Try downloading again or email support@trysmartcut.com."
  SRC="$TMP"
fi

EXT_ID="com.smartcutpro.panel"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/$EXT_ID"

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
mkdir -p "$DEST"

rsync -a --exclude 'META-INF/' --exclude '.debug' "$SRC/" "$DEST/"

if [[ -d "$DEST/bin/whisper" ]]; then
  find "$DEST/bin/whisper" -type f \( -name 'whisper-cli' -o -name '*.dylib' -o -name '*.so' \) -exec chmod 755 {} \; 2>/dev/null || true
fi
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

# Install / upgrade SmartCut Updater.app into /Applications. Users can also
# launch it manually from Launchpad; the panel spawns it on "Update".
# Falls back to ~/Applications if /Applications isn't writable.
UPDATER_SRC="$RES/SmartCutUpdater/SmartCut Updater.app"
UPDATER_DST_SYSTEM="/Applications/SmartCut Updater.app"
UPDATER_DST_USER="$HOME/Applications/SmartCut Updater.app"
if [[ -d "$UPDATER_SRC" ]]; then
  if /usr/bin/ditto "$UPDATER_SRC" "$UPDATER_DST_SYSTEM" 2>/dev/null; then
    :
  else
    mkdir -p "$HOME/Applications"
    /usr/bin/ditto "$UPDATER_SRC" "$UPDATER_DST_USER" || true
  fi
  xattr -dr com.apple.quarantine "$UPDATER_DST_SYSTEM" 2>/dev/null || true
  xattr -dr com.apple.quarantine "$UPDATER_DST_USER"   2>/dev/null || true
fi

osascript -e 'display dialog "SmartCut is installed.

Quit Premiere Pro completely (⌘Q), reopen it, then choose Window → Extensions → SmartCut.

Enter your license key in the panel to activate. SmartCut Updater has also been installed to /Applications so future updates happen in-app." buttons {"OK"} default button "OK" with title "SmartCut"'
INSTALLER

chmod +x "$APP/Contents/MacOS/install-smartcut"

cat > "$APP/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>install-smartcut</string>
  <key>CFBundleIdentifier</key>
  <string>com.smartcutpro.installer</string>
  <key>CFBundleName</key>
  <string>Install SmartCut</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
</dict>
</plist>
PLIST

cat > "$STAGE/Read Me.txt" << README
SmartCut Pro ${VERSION}

1. Double-click "${APP_NAME}".
2. Click OK when the installer finishes.
3. Quit Premiere Pro fully (⌘Q), reopen, then Window → Extensions → SmartCut.
4. Paste your license key and click Activate.

Questions? support@trysmartcut.com
README

sign_installer_app() {
  local app="$1"
  if ! command -v codesign >/dev/null 2>&1; then
    echo "codesign not found (need Xcode CLI tools)."
    exit 1
  fi
  if [[ -n "${MAC_CODESIGN_IDENTITY:-}" ]]; then
    echo "Signing Install SmartCut.app with Developer ID…"
    codesign --force --sign "$MAC_CODESIGN_IDENTITY" --timestamp --options runtime \
      --entitlements "$HERE/entitlements-installer.plist" \
      "$app/Contents/MacOS/install-smartcut"
    codesign --force --sign "$MAC_CODESIGN_IDENTITY" --timestamp --options runtime \
      "$app"
    codesign --verify --verbose=2 "$app" || {
      echo "codesign verify failed."
      exit 1
    }
  else
    echo "MAC_CODESIGN_IDENTITY not set (no tools/macos-signing.env?) — ad-hoc sign only."
    echo "Customers may need Right-click → Open. See tools/macos-signing.env.example"
    codesign -s - --force --deep "$app" 2>/dev/null || true
  fi
}

sign_installer_app "$APP"

mkdir -p "$DIST_DIR"
DMG="$DIST_DIR/SmartCutPro-${VERSION}-mac.dmg"
rm -f "$DMG"

hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE" -ov -format UDZO -imagekey zlib-level=9 "$DMG"

if [[ -n "${MAC_NOTARY_KEYCHAIN_PROFILE:-}" && -n "${MAC_CODESIGN_IDENTITY:-}" ]]; then
  echo "Submitting DMG to Apple for notarization (keychain profile: $MAC_NOTARY_KEYCHAIN_PROFILE)…"
  if ! xcrun notarytool submit "$DMG" --keychain-profile "$MAC_NOTARY_KEYCHAIN_PROFILE" --wait; then
    echo "Notarization failed. Get the submission id from the output above, then:"
    echo "  xcrun notarytool log <submission-id> --keychain-profile \"$MAC_NOTARY_KEYCHAIN_PROFILE\""
    exit 1
  fi
  echo "Stapling notarization ticket…"
  xcrun stapler staple "$DMG"
  echo "Notarization complete."
elif [[ -n "${MAC_NOTARY_KEYCHAIN_PROFILE:-}" && -z "${MAC_CODESIGN_IDENTITY:-}" ]]; then
  echo "MAC_NOTARY_KEYCHAIN_PROFILE is set but MAC_CODESIGN_IDENTITY is missing — skipping notarization."
elif [[ -z "${MAC_NOTARY_KEYCHAIN_PROFILE:-}" ]]; then
  echo "MAC_NOTARY_KEYCHAIN_PROFILE not set — skipping notarization (Gatekeeper may still warn)."
  echo "Run ./tools/setup-macos-notary.sh once, then set the profile in macos-signing.env"
fi

SIZE_MB=$(du -m "$DMG" | awk '{print $1}')
echo ""
echo "Built $DMG  (${SIZE_MB}MB)"
echo "Upload to R2 as: SmartCutPro-${VERSION}-mac.dmg"
echo ""
