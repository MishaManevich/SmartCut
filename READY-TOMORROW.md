# Ready tomorrow — one-page checklist

Tick top to bottom. Details: `TOMORROW-LAUNCH-CHECKLIST.md`, `RELEASE.md`, `smartcut-landing/GO-LIVE-STRIPE.md`.

---

## Product (SmartCut in Premiere)

- [ ] Quit Premiere **⌘Q**, open fresh → **Window → Extensions → SmartCut** loads.
- [ ] **Analyze & Preview** on **one** clip → regions appear, no hang.
- [ ] **Apply** on a **copy** of the sequence (or after snapshot) → cuts look right; **⌘Z** works.
- [ ] **Stack test:** V1/A1 + V2/A2 (+ V3/A3 if you can) → select **V2** only → cuts hit **V2 + A2**, not A1.
- [ ] **About** → **Check for updates** → message shows **in the modal** (not blank).
- [ ] (Optional) Toggle **Remove retakes** — still sane.

---

## Ship artifact (strangers’ Macs)

- [ ] **`macos-signing.env`** set (Developer ID + notary profile per `RELEASE.md`).
- [ ] `./tools/build-zxp.sh` then `./tools/build-mac-dmg.sh` → **DMG** in `dist/`.
- [ ] Install DMG on a **second Mac** or clean user: **no scary Gatekeeper** block (or only normal “Open”).
- [ ] **Upload** `SmartCutPro-<ver>-mac.dmg` + **`-mac.zip`** to R2; bump **`wrangler.toml`** + **`__release__`** KV if version changed (`RELEASE.md` § Commercial).

---

## Money & site (quick)

- [ ] Stripe **Live** — payment you care about shows; **Webhooks** → **Succeeded** on recent deliveries.
- [ ] **`https://trysmartcut.com`** — loads; hero **v1.0.2** (hard refresh / incognito).
- [ ] **`support@trysmartcut.com`** — you can receive mail (launch week).

---

## Done = ready

- [ ] You’d be okay pointing a **paying stranger** at **trysmartcut.com** + DMG link after the boxes above.

**If something fails:** fix or document as **known issue** before big spend.
