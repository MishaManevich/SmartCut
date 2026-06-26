# Rank-Tracking Protocol

A repeatable system to capture where **Peptide Tracker – Stackr** ranks, using only the App Store app + App
Store Connect (no paid tool required). Pair this with `rank-tracking-template.csv`.

## The cadence

| Checkpoint | Date (fill in) | What to do | What it tells you |
|---|---|---|---|
| **Baseline** | _today_ | Manual check, 10 `primary` terms | Starting point. Expect gaps — indexing isn't done. |
| **+72 hours** | ____ | Re-check the 10 `primary` terms | Indexing should be catching up; first movement. |
| **+2 weeks** | ____ | All 35 terms + ASC Search Terms | First *real* signal. |
| **+4 weeks** | ____ | All 35 terms | **Rankings are stable — judge the v3.0 ASO here.** |
| **Monthly after** | ____ | All 35 terms | Ongoing monitoring; iterate metadata if needed. |

> Each new build resets Apple's indexing clock. **Don't change metadata between checkpoints**, and hold 4–6
> weeks between metadata changes.

## Method 1 — Manual App Store check (ground truth)

1. iPhone → **App Store app** (NOT Safari — the web index is a different algorithm).
2. Search tab → type the exact keyword from the CSV.
3. Scroll until you find **Peptide Tracker – Stackr**. Record the position number.
   - **Ignore "Ad" results** — those are paid placements, not organic rank.
   - Top 3 = excellent · Top 10 = page 1 · 11–30 = ranking but buried · >30 or absent = effectively not ranking.
4. Write the number (or `NR` for not ranking) into the CSV cell for that checkpoint.
5. Note anything useful in the `notes` column (e.g., "behind Regimen + 2 ads," "new competitor above us").

**Tip:** do the whole list in one sitting on the same device/region for consistency. Personalization slightly
affects results — if you want a cleaner read, sign out of the App Store or use a second device.

## Method 2 — App Store Connect "Search Terms" (demand, not rank)

ASC → **App Analytics → Peptide Tracker → Metrics → filter `Source = App Store Search` → Search Terms.**

- Shows which terms actually drive **impressions and downloads** (more important than rank).
- Lags 1–2 days; mostly empty right after release. Most useful at the +2wk and +4wk checkpoints.
- Cross-reference with the CSV: a term with high impressions but poor manual rank = a conversion or rank
  opportunity worth pushing.

## Method 3 — ASO rank tracker (if you regain access)

Load the `primary` + `secondary` terms into AppFigures / AppTweak / Sensor Tower for automatic daily ranks.
This replaces the manual grind. Until then, Method 1 is authoritative.

## How to read the results

- **Compound long-tails first.** Your prime bets (`retatrutide`, `bpc 157`, `tb 500`, `ipamorelin`,
  `tirzepatide calculator`) should be the *first* places you crack the top 10 — they're low-difficulty. If
  these aren't ranking by +4wk, the keyword field isn't being indexed as expected (check the tokenization note
  in `compliance-and-risk.md`).
- **Heads are slow and contested.** Don't expect top ranks on `glp1 tracker` / `peptide calculator` — those are
  saturated. Presence in the top ~30 is a fine result there.
- **`trt tracker`** is your bellwether winnable head — watch it closely.
- **If `bpc 157` won't rank** under the split-token keyword field, switch to the concatenated form (`bpc157`)
  next cycle and compare. That's the one real experiment baked into this plan.

## After the 4-week read

If terms underperform, ship the next metadata iteration from `metadata-recommendations.md` (e.g., swap in
Keyword Field Option B/C, or promote Title Option 2 to test `trt tracker` in the title). Re-baseline and repeat.
