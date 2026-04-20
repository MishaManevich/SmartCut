#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-updater-app.sh — build "SmartCut Updater.app"
#
# A tiny notarizable helper app that lives in /Applications. The CEP panel
# launches it with the user's license key + machineId when a new version is
# available. The updater:
#
#   1. Fetches /latest-version from the license worker.
#   2. Compares against the installed manifest.xml ExtensionBundleVersion.
#   3. If newer, asks the user (osascript dialog) whether to update.
#   4. Calls /download-url (license-gated, machine-bound) for a signed URL.
#   5. Downloads the payload (prefers zip, falls back to zxp / dmg).
#   6. Installs directly into the CEP extensions folder.
#   7. Prompts the user to restart Premiere Pro.
#
# This script emits a signed .app bundle at:
#   dist-updater/SmartCut Updater.app
#
# Usage (from repo root):
#   ./tools/updater-app/build-updater-app.sh [VERSION]
#
# Intended to be invoked by build-mac-dmg.sh so the helper app ends up inside
# the customer-facing installer DMG.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

if [[ -f "$ROOT/tools/macos-signing.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/tools/macos-signing.env"
  set +a
fi

VERSION="${1:-$(node -p "require('$ROOT/package.json').version")}"
OUT_DIR="${OUT_DIR:-$ROOT/dist-updater}"
APP_NAME="SmartCut Updater.app"
APP="$OUT_DIR/$APP_NAME"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
mkdir -p "$APP/Contents/Resources"

# ─── Payload script ─────────────────────────────────────────────────────────
# The whole updater lives in this shell script. It's intentionally
# dependency-free (uses plutil for JSON, curl for HTTP, unzip for payloads)
# so it works on any modern macOS without Xcode CLT / python.
cat > "$APP/Contents/MacOS/smartcut-updater" << 'UPDATER'
#!/bin/bash
set -euo pipefail

# ─── Config ─────────────────────────────────────────────────────────────────
BACKEND_BASE="https://smartcut-license.patient-dust-4377.workers.dev"
EXT_ID="com.smartcutpro.panel"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/$EXT_ID"
CONFIG_DIR="$HOME/Library/Application Support/SmartCut"
CONFIG_FILE="$CONFIG_DIR/updater.json"
LOG_FILE="$CONFIG_DIR/updater.log"

mkdir -p "$CONFIG_DIR"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >> "$LOG_FILE"; }

LICENSE_KEY=""
MACHINE_ID=""
AUTO=0
FORCE=0

# ─── Arg parsing ────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --licenseKey)  LICENSE_KEY="$2"; shift 2 ;;
    --machineId)   MACHINE_ID="$2";  shift 2 ;;
    --backend)     BACKEND_BASE="$2"; shift 2 ;;
    --auto)        AUTO=1; shift ;;
    --force)       FORCE=1; shift ;;
    --checkAndInstall) shift ;;
    *) shift ;;
  esac
done

# Persist new credentials (so the user can relaunch from /Applications later).
if [[ -n "$LICENSE_KEY" && -n "$MACHINE_ID" ]]; then
  umask 077
  printf '{"licenseKey":"%s","machineId":"%s","backend":"%s"}\n' \
    "$LICENSE_KEY" "$MACHINE_ID" "$BACKEND_BASE" > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE" 2>/dev/null || true
elif [[ -f "$CONFIG_FILE" ]]; then
  LICENSE_KEY=$(/usr/bin/plutil -extract licenseKey raw -o - "$CONFIG_FILE" 2>/dev/null || echo "")
  MACHINE_ID=$(/usr/bin/plutil -extract machineId raw -o - "$CONFIG_FILE" 2>/dev/null || echo "")
  BACKEND_BASE=$(/usr/bin/plutil -extract backend raw -o - "$CONFIG_FILE" 2>/dev/null || echo "$BACKEND_BASE")
fi

# ─── UI helpers (osascript) ─────────────────────────────────────────────────
escape_applescript() {
  # Escape \ and " for safe use inside an AppleScript double-quoted string.
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

dialog_info() {
  local msg
  msg=$(escape_applescript "$1")
  /usr/bin/osascript -e "display dialog \"$msg\" buttons {\"OK\"} default button \"OK\" with title \"SmartCut Updater\" with icon note" >/dev/null 2>&1 || true
}

dialog_error() {
  local msg
  msg=$(escape_applescript "$1")
  /usr/bin/osascript -e "display dialog \"$msg\" buttons {\"OK\"} default button \"OK\" with title \"SmartCut Updater\" with icon stop" >/dev/null 2>&1 || true
}

dialog_confirm() {
  # Returns 0 if user chose the Confirm button (second), 1 otherwise.
  local msg cancel ok
  msg=$(escape_applescript "$1")
  cancel=$(escape_applescript "${2:-Later}")
  ok=$(escape_applescript "${3:-Update}")
  local result
  if ! result=$(/usr/bin/osascript <<APPLESCRIPT 2>/dev/null
try
  tell application "System Events"
    activate
    set theButton to button returned of (display dialog "$msg" buttons {"$cancel", "$ok"} default button "$ok" cancel button "$cancel" with title "SmartCut Updater" with icon note)
  end tell
  return theButton
on error
  return "CANCEL"
end try
APPLESCRIPT
  ); then
    return 1
  fi
  [[ "$result" == "$ok" ]]
}

die() {
  log "FAIL: $*"
  dialog_error "$1"
  exit 1
}

# ─── JSON helpers (plutil — always on macOS) ────────────────────────────────
json_get() {
  # Usage: json_get <keypath> <json-string>
  local key="$1" json="$2"
  printf '%s' "$json" | /usr/bin/plutil -extract "$key" raw -o - - 2>/dev/null || true
}

# ─── Currently-installed version ────────────────────────────────────────────
current_version() {
  if [[ -f "$DEST/CSXS/manifest.xml" ]]; then
    grep -oE 'ExtensionBundleVersion="[^"]+"' "$DEST/CSXS/manifest.xml" \
      | head -1 \
      | sed -E 's/.*="([^"]+)"/\1/'
  else
    printf '0.0.0'
  fi
}

# ─── Simple semver compare: returns 0 if $1 > $2 ────────────────────────────
semver_gt() {
  local a="$1" b="$2"
  IFS='.' read -r a1 a2 a3 <<< "$a"
  IFS='.' read -r b1 b2 b3 <<< "$b"
  a1=${a1:-0}; a2=${a2:-0}; a3=${a3:-0}
  b1=${b1:-0}; b2=${b2:-0}; b3=${b3:-0}
  if (( 10#$a1 != 10#$b1 )); then (( 10#$a1 > 10#$b1 )); return; fi
  if (( 10#$a2 != 10#$b2 )); then (( 10#$a2 > 10#$b2 )); return; fi
  (( 10#$a3 > 10#$b3 ))
}

# ─── Main flow ──────────────────────────────────────────────────────────────
log "Updater started (auto=$AUTO force=$FORCE)"

CURRENT="$(current_version)"
log "Current version: $CURRENT"

LATEST_JSON=$(curl -fsSL --max-time 15 "$BACKEND_BASE/latest-version" 2>>"$LOG_FILE" || echo "")
LATEST=$(json_get "version" "$LATEST_JSON")
NOTES=$(json_get "notes"   "$LATEST_JSON")

if [[ -z "$LATEST" ]]; then
  die "Could not reach the update server. Check your internet and try again."
fi
log "Latest version: $LATEST"

if [[ "$FORCE" -eq 0 ]]; then
  if ! semver_gt "$LATEST" "$CURRENT"; then
    if [[ "$AUTO" -eq 0 ]]; then
      dialog_info "SmartCut is up to date ($CURRENT)."
    fi
    log "No update needed."
    exit 0
  fi
fi

# Confirm with user.
MSG="A new version of SmartCut is available.

    New:        $LATEST
    Installed:  $CURRENT

The panel will be updated. You'll need to restart Premiere Pro after it finishes."

if [[ -n "$NOTES" ]]; then
  NOTES_TRIM=$(printf '%s' "$NOTES" | head -c 400)
  MSG="$MSG

Release notes:
$NOTES_TRIM"
fi

if ! dialog_confirm "$MSG" "Later" "Update"; then
  log "User declined update."
  exit 0
fi

# ─── License gate ───────────────────────────────────────────────────────────
if [[ -z "$LICENSE_KEY" || -z "$MACHINE_ID" ]]; then
  die "No license found on this Mac. Open the SmartCut panel in Premiere Pro and enter your license key, then try again."
fi

# ─── Request signed download URL ────────────────────────────────────────────
RESP=$(curl -fsSL --max-time 30 -X POST "$BACKEND_BASE/download-url" \
  -H "Content-Type: application/json" \
  -d "{\"licenseKey\":\"$LICENSE_KEY\",\"machineId\":\"$MACHINE_ID\",\"platform\":\"mac\"}" \
  2>>"$LOG_FILE" || echo '{"ok":false,"message":"Network error."}')

OK=$(json_get "ok"       "$RESP")
URL=$(json_get "url"     "$RESP")
FILE_NAME=$(json_get "fileName" "$RESP")
SERVER_VERSION=$(json_get "version"  "$RESP")
MSG_ERR=$(json_get "message" "$RESP")

if [[ "$OK" != "true" || -z "$URL" ]]; then
  die "${MSG_ERR:-Could not get the update package. Your license may be inactive.}"
fi

[[ -z "$FILE_NAME" ]] && FILE_NAME="SmartCutPro-${SERVER_VERSION:-$LATEST}-mac.zip"

log "Downloading $FILE_NAME"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
OUT="$TMP/$FILE_NAME"

if ! curl -fL --max-time 600 --progress-bar -o "$OUT" "$URL" 2>>"$LOG_FILE"; then
  die "Download failed. Try again in a moment."
fi

# ─── Install payload ────────────────────────────────────────────────────────
install_from_folder() {
  local src="$1"
  # The payload may or may not have the CSXS folder at its top. Detect and
  # pick the right source folder so we always end up copying a tree whose
  # root contains CSXS/manifest.xml.
  local root="$src"
  if [[ ! -f "$root/CSXS/manifest.xml" ]]; then
    local inner
    inner=$(find "$src" -maxdepth 2 -type d -name CSXS | head -1)
    if [[ -n "$inner" ]]; then root="$(dirname "$inner")"; fi
  fi
  if [[ ! -f "$root/CSXS/manifest.xml" ]]; then
    die "Update package is malformed (missing manifest)."
  fi
  mkdir -p "$(dirname "$DEST")"
  rm -rf "$DEST"
  mkdir -p "$DEST"
  /usr/bin/rsync -a --exclude 'META-INF/' --exclude '.debug' "$root/" "$DEST/"
  /usr/bin/xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
  if [[ -d "$DEST/bin/whisper" ]]; then
    /usr/bin/find "$DEST/bin/whisper" -type f \
      \( -name 'whisper-cli' -o -name '*.dylib' -o -name '*.so' \) \
      -exec chmod 755 {} \; 2>/dev/null || true
  fi
}

lower_name=$(printf '%s' "$FILE_NAME" | tr '[:upper:]' '[:lower:]')

case "$lower_name" in
  *.zip|*.zxp)
    WORK="$TMP/unpacked"
    mkdir -p "$WORK"
    if ! /usr/bin/unzip -q "$OUT" -d "$WORK" 2>>"$LOG_FILE"; then
      die "Could not unpack the update. Try again or email support@trysmartcut.com."
    fi
    install_from_folder "$WORK"
    ;;
  *.dmg)
    MOUNT_POINT="/tmp/SmartCutUpdate.$$"
    mkdir -p "$MOUNT_POINT"
    if ! /usr/bin/hdiutil attach "$OUT" -nobrowse -readonly -mountpoint "$MOUNT_POINT" >/dev/null 2>>"$LOG_FILE"; then
      die "Could not mount the update image."
    fi
    INNER_APP=$(/bin/ls -d "$MOUNT_POINT"/*.app 2>/dev/null | head -1 || true)
    if [[ -z "$INNER_APP" || ! -d "$INNER_APP/Contents/Resources/SmartCutExtension" ]]; then
      /usr/bin/hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 || true
      die "Update image is missing the extension payload."
    fi
    install_from_folder "$INNER_APP/Contents/Resources/SmartCutExtension"
    /usr/bin/hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 || true
    ;;
  *)
    die "Unknown update format: $FILE_NAME"
    ;;
esac

log "Install complete at $DEST"

dialog_info "SmartCut has been updated to $LATEST.

Quit Premiere Pro completely (⌘Q) and reopen it to finish the update."

exit 0
UPDATER

chmod +x "$APP/Contents/MacOS/smartcut-updater"

# ─── Info.plist ─────────────────────────────────────────────────────────────
cat > "$APP/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>smartcut-updater</string>
  <key>CFBundleIdentifier</key>
  <string>com.smartcutpro.updater</string>
  <key>CFBundleName</key>
  <string>SmartCut Updater</string>
  <key>CFBundleDisplayName</key>
  <string>SmartCut Updater</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>LSUIElement</key>
  <false/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

# ─── Entitlements (osascript + network) ─────────────────────────────────────
ENTITLEMENTS="$OUT_DIR/entitlements-updater.plist"
cat > "$ENTITLEMENTS" << 'EPLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- smartcut-updater uses osascript for user dialogs and curl for
       license-gated HTTPS downloads. -->
  <key>com.apple.security.automation.apple-events</key>
  <true/>
</dict>
</plist>
EPLIST

# ─── Codesign / notarize (when signing env is set) ──────────────────────────
if [[ -n "${MAC_CODESIGN_IDENTITY:-}" ]]; then
  echo "Signing SmartCut Updater.app with Developer ID..."
  /usr/bin/codesign --force --sign "$MAC_CODESIGN_IDENTITY" --timestamp --options runtime \
    --entitlements "$ENTITLEMENTS" \
    "$APP/Contents/MacOS/smartcut-updater"
  /usr/bin/codesign --force --sign "$MAC_CODESIGN_IDENTITY" --timestamp --options runtime \
    "$APP"
  /usr/bin/codesign --verify --verbose=2 "$APP" || {
    echo "codesign verify failed for updater app."
    exit 1
  }
else
  echo "MAC_CODESIGN_IDENTITY not set — ad-hoc signing updater app only."
  /usr/bin/codesign -s - --force --deep "$APP" 2>/dev/null || true
fi

echo "Built $APP"
