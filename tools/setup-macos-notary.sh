#!/usr/bin/env bash
# One-time: save Apple notarization credentials in the Keychain for notarytool.
#
# Prerequisites:
#   • Paid Apple Developer Program membership
#   • An app-specific password: https://appleid.apple.com → Sign-In and Security → App-Specific Passwords
#
# Usage:
#   ./tools/setup-macos-notary.sh              # profile name: smartcut-notary
#   ./tools/setup-macos-notary.sh my-profile
#
# Then set MAC_NOTARY_KEYCHAIN_PROFILE in tools/macos-signing.env to the same name.

set -euo pipefail

PROFILE="${1:-smartcut-notary}"

echo "Notary keychain profile: $PROFILE"
echo "Create an app-specific password at https://appleid.apple.com (App-Specific Passwords)."
echo ""
read -r -p "Apple ID (email): " APPLE_ID
read -r -p "Team ID (10 characters, from developer.apple.com → Membership): " TEAM_ID
read -r -s -p "App-specific password (not your Apple ID password): " APP_PW
echo ""

xcrun notarytool store-credentials "$PROFILE" \
  --apple-id "$APPLE_ID" \
  --team-id "$TEAM_ID" \
  --password "$APP_PW"

echo ""
echo "Done. Add to tools/macos-signing.env:"
echo "  MAC_NOTARY_KEYCHAIN_PROFILE=\"$PROFILE\""
