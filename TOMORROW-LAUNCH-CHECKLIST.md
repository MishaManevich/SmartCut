# Tomorrow — SmartCut QA + notarization

Use this in order. Check boxes as you go.

---

## Part A — Tool works (extension QA in Premiere)

**Setup:** Latest panel installed (`install-dev.sh` from `main` **or** the current `1.0.2` zip). Fully **quit Premiere (⌘Q)** between installs if you swap builds.

### Core flow

- [ ] **Window → Extensions → SmartCut** opens without errors.
- [ ] **Activate** with a real or test license (or already active).
- [ ] **Scope** shows the right sequence / clip name when you select **one** clip.
- [ ] **Analyze & Preview** completes (no stuck spinner; regions list appears).
- [ ] **Apply cuts** on a **duplicate sequence** or after **snapshot** — timeline updates; **⌘Z** restores if needed.

### Multi-track (the bug we fixed)

- [ ] Stack **V1/A1**, **V2/A2** (and optionally **V3/A3**) with short clips.
- [ ] Select **only the V2** clip → analyze → cuts land on **V2 + A2**, **not** A1.
- [ ] Repeat for **V3** if you have three stacks.

### Edge cases (quick)

- [ ] **Wrong machine / deactivate** still makes sense (About → Deactivate) if you test that.
- [ ] **About** → **Check for updates** shows a message in the modal (not “nothing happens”).
- [ ] If server > installed version: **Install update** banner appears (or after manual check).

### Optional stress

- [ ] Long clip (~5+ min) — analyze doesn’t crash; apply doesn’t leave huge gaps.
- [ ] **Remove retakes** toggle on/off — behavior matches expectation.

**If anything fails:** note **Premiere version**, **steps**, and **screenshot** → fix or ship as known issue.

---

## Part B — Notarized DMG (paying strangers / Gatekeeper)

**Why:** macOS blocks or scares users on unsigned / unnotarized installers. Dev `install-dev.sh` does **not** replace this.

**Prereqs (once):**

- [ ] **Apple Developer Program** ($99/yr) — **Developer ID Application** certificate in Keychain.
- [ ] `tools/macos-signing.env` exists (copy from `macos-signing.env.example`) with **`MAC_CODESIGN_IDENTITY`** = full string from:
  ```bash
  security find-identity -v -p codesigning
  ```
- [ ] **Notary:** `./tools/setup-macos-notary.sh` and **`MAC_NOTARY_KEYCHAIN_PROFILE`** in `macos-signing.env` (see **`RELEASE.md`** § Gatekeeper).

**Build:**

- [ ] From `smartcut-pro`: `./tools/build-zxp.sh` (version matches `package.json` / `manifest`).
- [ ] `./tools/build-mac-dmg.sh` — completes **without** notary errors; DMG in **`dist/`**.

**Verify:**

- [ ] Open DMG on a **clean test Mac** (or VM): double-click **Install SmartCut** — no Gatekeeper block, or only standard “Open” once.
- [ ] After install: **SmartCut Updater.app** in **/Applications** (or **~/Applications**).
- [ ] Upload **`SmartCutPro-<ver>-mac.dmg`** (and **`.zip`** for updater) to **R2**; bump **`__release__`** + **`wrangler.toml`** if you ship a new version (see **`RELEASE.md`** “Commercial launch”).

---

## Part C — Already green (quick confirm)

- [ ] Stripe **webhook** endpoint **Active**, recent deliveries **Succeeded** (your screenshot: 4 succeeded, 0 failed — good).
- [ ] **`https://trysmartcut.com`** loads; hero shows **v1.0.2** (hard refresh / incognito).

---

## Done when

- [ ] Part A passes for your “must not break” scenarios.
- [ ] Part B DMG installs cleanly for someone who didn’t build from source.
- [ ] You’re comfortable telling a stranger to download from **trysmartcut.com** / email link.

**After that:** you’re in “ship and support” mode — not blocked on more code unless QA finds issues.
