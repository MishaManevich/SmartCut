# ASO Keyword Research — Peptide Tracker · Stackr

App Store Optimization package for **Peptide Tracker – Stackr** (seller: Stackr / stackrpeptides.com),
prepared after the **v3.0** metadata update was accepted (~June 24–26, 2026).

## Why this exists

The original question was: *"Where do we show up for our keywords now that the new ASO metadata is live?"*

Short answer: **you can't read meaningful ranks yet** — the build was accepted only a few hours ago, and
Apple needs ~3–4 weeks to re-index and stabilize rankings (see `rank-tracking-protocol.md`). There is also
**no API** that returns live per-keyword rank for an app; that data only comes from a paid ASO rank tracker
(which you no longer have) or from manually searching the App Store. So this package does two things:

1. Gives you a **fill-in rank-tracking system** to capture a baseline now and re-read at 72h / 2wk / 4wk.
2. Delivers the **research that the old ASO tool used to give you** — competitor teardown, a scored
   keyword universe, and an optimized, Apple-compliant metadata set for your next release.

## Files

| File | What it is |
|------|-----------|
| `00-where-do-we-rank.md` | Direct answer + exactly how to pull your current ranks with only App Store Connect |
| `rank-tracking-template.csv` | 35 keywords/phrases to track — open in Numbers/Excel/Sheets and fill in |
| `rank-tracking-protocol.md` | The manual + ASC method, plus the 72h / 2wk / 4wk cadence and how to read it |
| `competitor-analysis.md` | Teardown of 8 direct rivals (titles, subtitles, what they target, gaps) + 3 discovered |
| `keyword-research.md` | Full keyword universe (~145 terms) + scored opportunity matrix |
| `metadata-recommendations.md` | Optimized title / subtitle / 100-char keyword field, char-counted & compliance-checked |
| `compliance-and-risk.md` | App Store Guideline 1.4.3 risk + the keyword tokenization fix (important — read this) |

## TL;DR of the strategy

- The niche is **crowded and generically named** (Regimen, PeptideCalc.io, Dosed, Pep, etc.). Head terms
  (`glp1 tracker`, `peptide calculator`, `reconstitution calculator`) are saturated by funded incumbents and
  a wall of free web calculators. **Don't fight those head-on.**
- **Win the long tail**: specific compounds and compounded-dosing terms where competition is thin and intent
  is highest — `retatrutide`, `tirzepatide`/`semaglutide` calculators, the `BPC-157 + TB-500` stack, and
  `trt tracker` as the most winnable medium-volume head.
- Recommended metadata keeps the brand-equity title, adds a keyword-dense subtitle, and spends the full
  ~100-char keyword field on prime, low-difficulty opportunity terms with **zero duplication** across fields.
- **Two corrections** baked in from the adversarial review: compound names are split into separate tokens
  (`bpc,157` not `bpc157`) so they actually match real searches, and there's a dedicated note on the
  Guideline 1.4.3 dosage-calculator risk that governs this whole category.

> ⚠️ This is a research/recommendation package, not a code change. Nothing here is applied to App Store
> Connect automatically — you copy the final metadata into ASC yourself on the next release.
