# Metadata Recommendations — Peptide Tracker · Stackr

For your **next** App Store release (hold the current v3.0 metadata stable ~4–6 weeks first so rankings can
stabilize and you can attribute results). All character counts below were computed exactly and validated:
no wasted spaces, no duplication across fields, no banned terms.

## ✅ Recommended set (ship this)

| Field | Value | Chars |
|---|---|---|
| **Title** | `Peptide Tracker - Stackr` | **24 / 30** |
| **Subtitle** | `GLP-1 Calculator & TRT Log` | **26 / 30** |
| **Keyword field** | `reconstitution,semaglutide,tirzepatide,retatrutide,bpc,157,tb,500,ipamorelin,syringe,reminder,vial` | **98 / 100** |

### Why this trio
- **Title** keeps your v3.0 brand equity and secures the #1 head term `peptide tracker` in the highest-weight field.
- **Subtitle** packs four high-value heads you *can't* fit in the title — `glp-1`, `calculator`, `trt`, `log` —
  which Apple cross-combines into `glp-1 calculator`, `trt tracker`, `trt log`, `peptide calculator`, `dose/injection log`, etc.
- **Keyword field** is spent entirely on **prime, low-difficulty opportunity terms**: the differentiator
  `reconstitution`, three GLP-1 generics (incl. the prime **retatrutide**), three under-owned peptides
  (`bpc`+`157`, `tb`+`500`, `ipamorelin`), plus practical supports `syringe`, `reminder`, `vial`.
- **Zero duplication.** None of `peptide, tracker, stackr, glp, 1, calculator, trt, log` are repeated in the
  keyword field — they're already indexed via title+subtitle, so repeating them would waste characters.

### What this lets you rank for (via Apple's cross-field combination)
`peptide tracker` · `peptide calculator` · `glp-1 calculator` · `glp-1 tracker` · `trt tracker` · `trt log` ·
`reconstitution calculator` · `semaglutide calculator/tracker` · `tirzepatide calculator/tracker` ·
`retatrutide` · `bpc 157` · `tb 500` · `ipamorelin` · `syringe calculator` · `dose/injection reminder` · `vial tracker`

> ⚠️ **Important — read `compliance-and-risk.md` before shipping.** Compound names are split into separate
> tokens (`bpc,157` not `bpc157`) on purpose: Apple indexes `bpc157` as one token and it would **not** match
> the way people actually search (`bpc 157`). Splitting lets the numerals also be reused (`157`/`500` can
> combine), which matches real queries and is more character-efficient.

## Alternative keyword fields (swap based on priority)

| Option | Value | Chars | Use when |
|---|---|---|---|
| **A — Recommended** | `reconstitution,semaglutide,tirzepatide,retatrutide,bpc,157,tb,500,ipamorelin,syringe,reminder,vial` | 98 | Default. Calculator/peptide-led. |
| **B — TRT-reinforced** | `semaglutide,tirzepatide,retatrutide,bpc,157,tb,500,ipamorelin,testosterone,hcg,syringe,reminder,vial` | 100 | TRT is your bigger revenue lever. Adds `testosterone` + `hcg` (TRT companion); drops `reconstitution` (rely on subtitle for it). |
| **C — Beginner lay-synonyms** | `semaglutide,tirzepatide,retatrutide,bpc,157,tb,500,ipamorelin,mixing,dosage,syringe,reminder,vial` | 97 | You want higher-volume beginner entry points. Adds `mixing` + `dosage` (terms newbies search instead of "reconstitution"). |

## Title & subtitle alternatives

**Titles** (≤30):
- `Peptide Tracker - Stackr` — **24**, recommended. Safest; owns the #1 head term + brand.
- `Peptide & TRT Tracker:Stackr` — **28**. Puts a *second* winnable head (`trt tracker`, rated prime) into the
  strongest field. The adversarial reviewer argues this is actually the stronger bet — **worth A/B considering.**
  If you use it, free the subtitle to lead with GLP-1 + calculator.
- `Stackr: Peptide & GLP-1 Log` — **27**. Leads with brand but drops the exact `peptide tracker` phrase (your
  most valuable head term). Weakest.

**Subtitles** (≤30):
- `GLP-1 Calculator & TRT Log` — **26**, recommended (pairs with Title 1).
- `Reconstitution & Dose Calc` — captures the niche's money phrase `reconstitution calculator` as a *contiguous*
  phrase. ⚠️ If you use this, **remove `reconstitution` from the keyword field** to avoid duplication.
- `GLP-1, TRT & Dose Calculator` — **28**. Forms `dose calculator` / `glp-1 calculator` / `trt`; pairs with Title 2.

## Screenshot captions (free ranking real estate)

Since ~June 2025 Apple OCR-indexes screenshot caption text — and it's the **one place duplication is rewarded**.
Reinforce your hardest-to-rank, highest-value terms in legible top/bottom captions:
`retatrutide` · `tirzepatide` · `reconstitution calculator` · `injection site rotation` · `titration schedule`.
(Treat this as a bonus, not a substitute for in-field placement — its ranking weight is real but modest.)

## Apple Search Ads (the sanctioned route for brand terms)

You can't put `ozempic / wegovy / mounjaro / zepbound` in metadata (trademarks). If you want that traffic, bid
on them via **Apple Search Ads** — but note ASA also restricts some competitor-trademark bidding, and running
ads to a calculator app in this category can draw ad-account review (see `compliance-and-risk.md`).

## Rollout discipline

1. **Don't ship this immediately.** Let v3.0 stabilize ~4–6 weeks; capture baseline ranks first (`rank-tracking-protocol.md`).
2. **Stage for attribution if you can.** Changing title + subtitle + keyword field all at once then waiting a
   month leaves you unable to tell *which* change moved ranks. Consider shipping title/subtitle one cycle and
   the keyword field the next.
3. **Hold 4–6 weeks between metadata changes** — each new build resets Apple's indexing clock.
