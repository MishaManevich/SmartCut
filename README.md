# SmartCut — Premiere Pro Extension (CEP)

Automatic silence removal and bad-take detection for Adobe Premiere Pro, running entirely **offline** (no cloud, no API costs).

This repo is the **CEP panel + ExtendScript host** that live inside Premiere Pro. The Electron installer that ships this panel as a signed `.dmg` lives in `../installer-source/smartcut-installer/`.

---

## Layout

```
smartcut-pro/
├── CSXS/manifest.xml                  # CEP 11 extension manifest (Premiere 24.0+)
├── client/
│   ├── index.html                     # Panel UI
│   ├── main.js                        # Panel logic
│   ├── styles.css                     # Dark theme
│   ├── icons/                         # Panel icons
│   └── lib/
│       ├── CSInterface.js             # Adobe CEP bridge (async-correct)
│       ├── AudioAnalyzer.js           # Web Audio decoder + silence + WAV writer
│       ├── Transcriber.js             # Spawns bundled whisper.cpp
│       └── BadTakeDetector.js         # Restart phrases + dup sentences + fillers
├── host/SmartCutHost.jsx              # ExtendScript host (razor + ripple delete)
├── bin/whisper/macos-arm64/           # Bundled whisper-cli + dylibs (~4 MB)
│   ├── whisper-cli
│   ├── libwhisper.1.dylib
│   ├── libggml.0.dylib  libggml-base.0.dylib
│   ├── libggml-blas.so  libggml-metal.so
│   ├── libggml-cpu-apple_m{1,2_m3,4}.so
│   └── libomp.dylib
├── models/
│   └── ggml-base.en.bin               # Whisper model (142 MB, English, base)
├── .debug                             # Dev-mode remote devtools (port 8088)
└── install-dev.sh                     # One-shot dev installer
```

---

## Quick start (development)

### Prerequisites

- macOS
- Adobe Premiere Pro **24.0+** (tested on 26.0.2)
- No Node install required — CEP already bundles a Node runtime inside its CEF panel

### 1. Install the panel

```bash
cd smartcut-pro
./install-dev.sh
```

This:

1. Enables unsigned extensions for CSXS 9–12 (`PlayerDebugMode=1`).
2. Mirrors this folder into `~/Library/Application Support/Adobe/CEP/extensions/com.smartcutpro.panel/`.
3. Bumps CEP log level so errors surface in `~/Library/Logs/CSXS/`.

Quit and relaunch Premiere Pro, then open **Window → Extensions → SmartCut**.

### 2. Debug the panel

- Chrome devtools for the panel UI: open Chrome at **http://localhost:8088**
- ExtendScript host logs: `~/Desktop/SmartCutPro_debug.log`
- CEP runtime logs: `~/Library/Logs/CSXS/CEPHtmlEngine*.log`

Toggle `DEV_MODE = true` in `client/main.js` to re-expose the **Debug Tools** panel (Test Cut + Diagnostics buttons).

### 3. Re-install after a change

```bash
./install-dev.sh            # rsync-style incremental copy
./install-dev.sh --clean    # nuke the installed copy first
```

After editing `SmartCutHost.jsx` you must close + reopen the panel (the host script is cached per panel load).

---

## Architecture

### Data flow

```
Premiere Pro sequence
        │
        ▼
┌──────────────────────────────┐
│ SmartCutHost.jsx             │ getSourceMediaPaths(trackIdx)
│  ExtendScript inside Premiere│ → absolute file path + in/out points
└──────────────────────────────┘
        │
        ▼
┌──────────────────────────────┐
│ AudioAnalyzer.js             │ Node fs.readFileSync
│  Chromium CEP panel          │ → ArrayBuffer
│                              │ → AudioContext.decodeAudioData()
│                              │ → Float32Array mono mix
│                              │ → RMS energy profile
│                              │ → silence regions + auto-threshold
└──────────────────────────────┘
        │ JSON
        ▼
┌──────────────────────────────┐
│ main.js                      │ displays results, toggles regions
└──────────────────────────────┘
        │ csInterface.evalScript("applyCuts(...)")
        ▼
┌──────────────────────────────┐
│ SmartCutHost.jsx             │ 1. setPlayerPosition(ticks)
│                              │ 2. qeSeq.CTI.timecode  ← key fix
│                              │ 3. qeTrack.razor(tc)   ← for every cut time
│                              │ 4. clip.remove(true,true) for matching clips
│                              │ 5. sequence.linkSelection() to re-link
└──────────────────────────────┘
```

### What changed in v8 (vs the v7 handoff)

| Bug | Fix |
|---|---|
| #1 "Failed to decode WAV" on MOV/MP4 | `AudioAnalyzer` now uses `AudioContext.decodeAudioData()`. Handles WAV/MP3/AAC/M4A and most MOV containers with AAC audio. Raw-WAV parser kept as last-resort fallback. |
| #2 Auto-threshold never ran | Unblocked by #1 fix — histogram detection now runs on every decoded source. |
| #3 Only the first ~10 s was analyzed | The analyzer now walks every sample in the returned `AudioBuffer` (mono downmix, full length). |
| #4 Razor cuts silently no-op on v26 | Host now uses CleanCut's `setPlayerPosition(ticks.toString())` + `qeSeq.CTI.timecode` pattern. This avoids the `Time.getFormatted()` timecode-format mismatch that caused the v7 razors to fail. Removal walks clips end→start and matches by time bounds; orphan audio clips on extra A-tracks are cleaned up; surviving V/A pairs are re-linked. |

### What changed in v8.2

- Removed `_refineEdges()` step in the analyzer — it was pushing silence boundaries **outward** into surrounding speech, clipping sentence ends.
- **Asymmetric padding** in the host cutter: leading-edge padding (= 1.5× `paddingMs`) protects word tails with soft fricatives ("s", "f", "th"), while trailing-edge padding (= 0.6× `paddingMs`) keeps cuts tight. No UI changes — derived from the single `paddingMs` slider.
- Host log writes now fall back to `~/Library/Application Support/SmartCutPro/debug.log` (Desktop was blocked by Premiere's sandbox on some setups).
- Preset defaults bumped: Short Form `minSilence 300ms, padding 120ms`; Podcast `minSilence 600ms, padding 160ms`.

### What's new in v9

- **Bundled `whisper.cpp`**, fully offline. No API keys, no accounts.
  - Model: `ggml-base.en.bin` (142 MB, English, base-size) — good-enough for bad-take detection at ~15× realtime on Apple Silicon.
  - Binary: `whisper-cli` + all ggml backend plugins (BLAS, Metal, CPU M1/M2/M3/M4, OpenMP). Dylibs relocated to `@rpath` and ad-hoc re-signed. The hardcoded Homebrew `libexec` lookup in `libggml.0.dylib` is patched to null so `GGML_BACKEND_PATH` is the single source of truth.
  - Everything installs under `bin/whisper/<platform>/` and `models/` — no system dependencies, no brew, no Xcode.
- **"Smart Cut with AI" toggle** in the panel. When on:
  1. Decodes the clip (same path as silence analysis)
  2. Writes a 16 kHz mono 16-bit PCM WAV to `os.tmpdir()`
  3. Spawns `whisper-cli` via Node's `child_process.spawn` (non-blocking, streams progress)
  4. Parses the JSON transcript for word-level timestamps
  5. `BadTakeDetector` flags restart phrases, duplicate sentences (bigram Dice ≥ 0.80), and filler runs
  6. Merges bad-take regions with silence regions; both render in the Results list.
- **Restart phrase dictionary**: "sorry, let me try", "take two", "one more time", "actually…", "scratch that", etc.
- **Duplicate sentence detection**: if sentence A's normalized text is ≥80% similar to a later sentence B within 30 seconds, A is marked for removal.
- **Filler runs**: ≥3 consecutive filler tokens ("um", "uh", "like", "you know") with no real-word between.

### What's still TODO (post-launch)

- **Windows support**: the codebase is portable; need to build the Windows whisper binary (`whisper-cli.exe`) and bundle under `bin/whisper/win-x64/`.
- **Intel Mac support**: build x86_64 whisper-cli and drop under `bin/whisper/macos-x64/`.
- **Proper code signing**: macOS Gatekeeper needs the binary signed with a Developer ID before the ZXP ships to customers. The installer currently strips the quarantine attribute in dev.
- **Paddle wire-up**: license key is currently validated locally by format match.
- **Landing page + license server**: draft in `../installer-source/smartcut-installer/`.

---

## API surface exposed by the host script

| Function | Returns | Purpose |
|---|---|---|
| `getActiveSequenceInfo()` | `{ name, duration, framerate, videoTrackCount, audioTrackCount }` | Header card |
| `getTrackInfo()` | `{ tracks: [{ index, name, clipCount }] }` | Track dropdown |
| `getSourceMediaPaths(idx?)` | `{ paths: [{ path, clipName, start, end, inPoint, outPoint, ... }] }` | Feeds the analyzer |
| `getAudioClipInfo()` | `{ clips: [...] }` | Fallback/estimation |
| `applyCuts(jsonPayload)` | `{ success, cutsApplied, method, clipCountBefore/After, razorErrors, removeErrors, log }` | The main cut engine |
| `testCut()` | `{ success, clipName, razorTimecode, clipCountAfterRazor, log }` | One-cut smoke test |
| `runDiagnostics()` | `{ premiereVersion, qeAvailable, ctiTimecodeAvailable, ... }` | Env probe |
| `setPlayheadPosition(sec)` | `{ success, position }` | Seek |
| `undoLastAction()` | `{ success, method }` | QE undo |

Cut payload schema:

```js
{
  regions: [ { startSeconds: 2.1, endSeconds: 3.4, type: "silence" }, ... ],
  paddingMs:       50,
  crossfadeMs:     0,
  videoTrackIndex: 0,
  relink:          true
}
```

Times are in **sequence seconds** — `main.js` converts source-time regions to sequence-time using `clip.start − clip.inPoint` before dispatching.

---

## Troubleshooting

**Panel loads but says “CEP host bridge unavailable”**  
CSInterface.js didn’t initialize. Happens when the panel is opened in a normal browser instead of Premiere. Open it from Window → Extensions.

**Razor phase runs but `clipCountAfterRazor === clipCountBefore`**  
The Timeline panel doesn’t have focus. Click on the timeline once, then re-run. The error message from `applyCuts()` will tell you this explicitly.

**`Audio decode failed: … (codec/container not supported)`**  
Your source is in a codec Chromium can’t decode natively (most commonly ProRes or DNxHD). Transcode to H.264 MP4, then re-link the clip in Premiere. Next feature pass bundles a small ffmpeg binary to auto-transcode silently.

**Cut count is right but the wrong clip was removed**  
Your source has multiple clips sharing the same bounds. File an issue with the `--- Host Log ---` contents from the diagnostics panel; I’ll tighten the matcher.

---

## Ship checklist before first release

- [ ] Flip `DEV_MODE = false` in `main.js` (already the default).
- [ ] Bump `ExtensionBundleVersion` in `CSXS/manifest.xml` and `client/main.js` presets if they changed.
- [ ] Run **Test Cut** on a fresh project → must return `SUCCESS`.
- [ ] Run full analyze+apply on a 3-minute MOV → should cut 5–15 silences without complaints.
- [ ] Verify `autoThreshold` populates the noise-floor info card.
- [ ] Deploy the license worker (see `tools/license-worker/README.md` and `PADDLE-SETUP.md`).
- [ ] Update `client/lib/License.js → BACKEND_BASE` and `PRICING_URL`.
- [ ] Create Paddle products + prices for monthly / annual / lifetime.
- [ ] Build and sign the `.zxp` (`npm run build:zxp`) and upload to R2.
- [ ] POST to `/admin/release` to publish the version.

---

## Licensing, payments, and secured updates

SmartCut ships with a small Cloudflare Worker that:

- Listens for **Paddle** webhooks so license keys land in KV automatically at checkout, renewal, cancel, and refund.
- Emails the license key to the buyer via Resend right after purchase.
- Verifies `POST /verify` calls from the panel (machine-bound activation with a cap).
- Hands the panel a short-lived **signed download URL** for the latest `.zxp` via `POST /download-url` — license-gated, so unpaid users can never grab the installer.
- Mints one-click **Paddle Customer Portal** sessions via `POST /portal-url` so "Manage subscription" in the panel opens straight into the user's account.

Paddle acts as the **Merchant of Record**, which means Paddle (not us) is the legal seller to the customer. They handle global sales-tax / VAT compliance, fraud screening, and chargebacks. In exchange for a ~5% + $0.50 per-transaction fee, we get zero tax paperwork and immunity from the chargeback churn that killed our previous Stripe account.

Pricing (launch):

| Plan     | Price           |
|----------|-----------------|
| Monthly  | $29.99/mo       |
| Annual   | $199/year       |
| Lifetime | $49 one-time    |

Full setup (KV, R2, Paddle Dashboard, webhooks, customer portal) is in [`tools/license-worker/PADDLE-SETUP.md`](tools/license-worker/PADDLE-SETUP.md).

### Why a Worker and not Paddle-direct

Hitting Paddle directly from the panel would leak the download URL and make payment-provider swaps painful. The Worker gives us:

1. **Gated downloads** — only active licenses get a signed URL to the `.zxp`.
2. **Provider portability** — swap Paddle for anything else by replacing one handler, no CEP re-release.
3. **One place** for activation caps, offline grace, deactivate flow, refund handling, comp grants.
