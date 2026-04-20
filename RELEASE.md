# Shipping SmartCut to paying customers

## Is `.zxp` what AutoCut and others use?

**Under the hood, yes** — the shippable artifact is still a **signed `.zxp`** (Adobe’s CEP package). **SmartCut’s buyer-facing path** wraps that in a **macOS `.dmg`** with **Install SmartCut.app**: double-click the app, files land in the CEP extensions folder — no ZXP Installer, no “no application to open this file.” Windows (when shipped) can stay **`.zxp`** + ZXP Installer / Exchange.

Your **development** flow (`install-dev.sh` + **Window → Extensions → SmartCut**) is correct for *you*: it copies unsigned files and turns on debug mode. **Customers do not use that path** — they need a **signed package** you produce per release.

## Release checklist (minimal)

1. **Bump version** in `package.json` and `CSXS/manifest.xml` (or pass a version to `build-zxp.sh`).
2. **Build the embedder / assets** if needed: `npm run build:embedder` (see `README.md`).
3. **Create signing cert (once):**  
   `./tools/make-cert.sh`  
   - Downloads Adobe’s **ZXPSignCmd** from the public [CEP-Resources](https://github.com/Adobe-CEP/CEP-Resources) repo (not a paid Adobe product).  
   - On **Apple Silicon**, ZXPSignCmd is Intel-only: install **Rosetta** if macOS prompts, or run: `softwareupdate --install-rosetta --agree-to-license` (one time).
4. **Package:**
   `./tools/build-zxp.sh`
   Output: `dist/SmartCutPro-<version>.zxp`
   Then **buyer-friendly macOS disk image:**
   `./tools/build-mac-dmg.sh`
   Outputs:
   - `dist/SmartCutPro-<version>-mac.dmg` — first-install artifact. Embeds both the `.zxp` and `SmartCut Updater.app` inside **Install SmartCut.app**.
   - `dist/SmartCutPro-<version>-mac.zip` — in-place update payload consumed by **SmartCut Updater.app** after the customer already has SmartCut installed. Much smaller UX (no DMG mount, no restart prompt from Finder — just a progress dialog).
5. **Upload to R2** (so email, `/thanks`, and the in-panel updater all work). The worker prefers the **zip** payload for signed `/download-url` responses and falls back to the DMG / `.zxp`. Use `--remote` so Wrangler 4 targets production R2 (without it, the upload goes to the local dev bucket only):

   ```bash
   # From tools/license-worker
   pnpm wrangler r2 object put smartcut-releases/SmartCutPro-1.0.0-mac.zip --file ../../dist/SmartCutPro-1.0.0-mac.zip --remote
   pnpm wrangler r2 object put smartcut-releases/SmartCutPro-1.0.0-mac.dmg --file ../../dist/SmartCutPro-1.0.0-mac.dmg --remote
   ```

   Optional `.zxp` fallback (legacy / marketplace distribution):

   ```bash
   pnpm wrangler r2 object put smartcut-releases/SmartCutPro-1.0.0.zxp --file ../../dist/SmartCutPro-1.0.0.zxp --remote
   ```

   Match names to `LATEST_VERSION` in `license-worker/wrangler.toml` and `pickReleaseFile()` in `license-worker/src/index.js`: **email and `/thanks` links** (`/get-install`) prefer **`SmartCutPro-<version>-mac.dmg`** first so buyers never get the raw `.zip` bundle; the **in-panel updater** (`POST /download-url`) still prefers **`.zip`** for speed.

6. **Gatekeeper (Install SmartCut.app):** Apple’s **Developer ID Application** + **notarization** (different from the Adobe `.p12` used for `.zxp`). One-time setup:
   - Xcode → Settings → Accounts → your team → Manage Certificates → **+** → **Developer ID Application** (requires [Apple Developer Program](https://developer.apple.com/programs/), $99/yr).
   - `security find-identity -v -p codesigning` — copy the full `Developer ID Application: … (TEAMID)` line.
   - `cp tools/macos-signing.env.example tools/macos-signing.env` and set `MAC_CODESIGN_IDENTITY` (and optionally `MAC_NOTARY_KEYCHAIN_PROFILE` after `./tools/setup-macos-notary.sh`).
   - `./tools/build-mac-dmg.sh` will sign **Install SmartCut.app**, then notarize + staple the **DMG** when the notary profile is set.
7. **Adobe / CEP `.zxp` cert (later):** replace the self-signed `.p12` with a cert Adobe trusts if you need stricter enterprise installs; early sales often keep self-signed ZXP + notarized DMG wrapper.

8. **macOS-only launch:** `license-worker/wrangler.toml` sets `SHIPPING_MACOS_ONLY = "1"`. The worker blocks Windows downloads, and the marketing site copy matches. Set to `"0"` when a Windows `.zxp` is in R2.

**Build notes**

- **Apple Silicon:** ZXPSignCmd is Intel-only; install Rosetta once (`softwareupdate --install-rosetta --agree-to-license`), then `make-cert.sh` / `build-zxp.sh` use `arch -x86_64` automatically.
- **Timestamp server:** if `DigiCert`’s TSA is unreachable, `build-zxp.sh` falls back to signing **without** `-tsa` (normal for self-signed test builds).

## What you’re doing today vs what buyers need

| | You (dev) | Paying customer |
|---|-----------|-----------------|
| Install | `./install-dev.sh` → Extensions menu | macOS: open `.dmg` → **Install SmartCut**; Win: `.zxp` |
| Updates | Re-run `install-dev.sh` | **SmartCut Updater.app** (installed to `/Applications` by the DMG) downloads the signed `.zip` payload and swaps the extension folder in place. Falls back to a browser `.dmg` download if the helper app isn't installed. |
| Code changes | Edit repo, reinstall | Must ship a new build |

Ship **`SmartCutPro-<version>-mac.zip`** *and* **`SmartCutPro-<version>-mac.dmg`** to R2. The worker serves the zip to in-app update requests and the DMG to email links / first-install flows. Leave the `.zxp` as a legacy fallback.
