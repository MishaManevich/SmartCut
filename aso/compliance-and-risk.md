# Compliance & Risk — read before changing metadata

Two issues surfaced in adversarial review that matter more than any single keyword choice.

## 1. The keyword tokenization fix (do this — it's a free win)

**Apple indexes an alphanumeric string as a single token.** So `bpc157` is stored as one token and will **not**
reliably match how people actually search — `bpc 157` or `bpc-157` (two tokens). The original draft spent ~5 of
11 keyword slots on concatenated forms (`bpc157`, `tb500`, `cjc1295`) that risk being *policy-visible but
search-invisible* — the worst outcome.

**Fix:** split them into separate comma tokens — `bpc,157,tb,500` — so Apple can cross-combine `bpc`+`157` →
`bpc 157`. Bonus: the numerals `157`/`500` are reusable and it's more character-efficient. The recommended
keyword field already uses the split form.

**Caveat:** this is the best-supported approach, but Apple's tokenizer behavior isn't publicly documented and
shifts. **Test both forms** — track `bpc 157` rank under the split-token field; if it doesn't rank within ~3–4
weeks, try the concatenated form next cycle. (This is exactly what the rank-tracking CSV is for.)

## 2. App Store Guideline 1.4.3 — the category-defining risk

> **Guideline 1.4.3:** *Apps that encourage… or facilitate… consumption of… controlled substances… are not
> permitted. Drug dosage calculators must come from the drug manufacturer, a hospital, university, health
> insurance company, pharmacy, or be approved by a government agency.*

A **reconstitution / dose calculator for injectable peptides** sits squarely in the line of fire of this rule,
and most of the "prime opportunity" compounds (retatrutide, BPC-157, TB-500, ipamorelin, CJC-1295, melanotan)
are **not FDA-approved** — they're research chemicals / gray-market. An app that schedules dosing, reminds
injections, and calculates units for non-approved injectables is exposable under 1.4.3, 1.4.1 (physical harm),
and 5.1.1 (health-data) scrutiny.

**This is not hypothetical** — but note: **your v3.0 already passed review and is live,** so you're currently on
the right side of it. The risk is in *re-opening* review with metadata that increases salience to the reviewer.
The metadata recommendations *lead the subtitle with "GLP-1 Calculator,"* which raises the calculator function's
visibility — manage that deliberately.

### How surviving competitors stay compliant (copy this)
- Frame the app as a **log / journal / tracker first, calculator second.**
- Add **"for educational / informational / tracking purposes only — not medical advice"** disclaimers in-app
  and in the description.
- Keep **screenshots and description focused on tracking & logging — never dosing instructions.**
- In **App Review notes**, state the educational/tracking positioning and cite approved precedent
  (PepCalc, Dosed, Peptide Tracker Calculator are all live).

### Elevated-risk keywords (use deliberately, with the framing above)
- `steroid`, `steroid tracker` — PED/bodybuilding framing; **highest** rejection risk. Keep out of metadata
  until base-listing compliance is proven.
- `testosterone` — controlled-substance-adjacent; elevated scrutiny.
- `melanotan` / `melanotan 2` — associated with unregulated tanning injections and regulatory warnings; a
  needless flag for marginal volume. Recommend **leaving out.**
- Generic injectable-drug names (`semaglutide`, `tirzepatide`, `retatrutide`) — not trademarks, so they pass
  the brand rule, but they carry inherent medical-claim review risk. Pair with tracking-not-dosing framing.

### Hard "do not use" (trademarks → metadata rejection)
`ozempic`, `wegovy`, `mounjaro`, `zepbound`, `rybelsus`, `trulicity`, and any competitor app name
(Regimen, Dosed, Pep, PepCalc). Pursue via Apple Search Ads only.

## 3. Privacy / health-data posture (5.1.1)

The app logs injectable medical data. Apple review will likely ask about data handling. Make sure your privacy
nutrition labels and policy clearly state how logged health data is stored (on-device / iCloud) and that it's
not sold/shared. Several competitors lean on "all data local / no account" as both a compliance and a marketing
point — consider matching it.

## Compliance verdict on the recommended set

**Pass with cautions.** Recommended trio (Title 1 + Subtitle 1 + Keyword Field A):
- ✅ Title 24/30, subtitle 26/30, keyword field 98/100 — all within limits
- ✅ No wasted spaces, no plurals, no `app`/brand/category filler
- ✅ No competitor app names, no drug trademarks
- ✅ No duplication across title / subtitle / keyword field
- ⚠️ Contains generic drug names + a calculator-forward subtitle → keep tracking/educational framing tight
- ⚠️ If you switch to Subtitle "Reconstitution & Dose Calc," remove `reconstitution` from the keyword field
