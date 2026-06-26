# Where Do We Rank Right Now?

## The honest answer

You updated the metadata **a few hours ago**. Three things are true at once:

1. **It's too early to read anything.** Apple typically begins re-indexing a new keyword field within a few
   days, but rankings don't *stabilize* for **~3–4 weeks** (commonly cited 14–25 days). New builds also get a
   short launch boost in the first ~7 days that then fades to the "true" level. **Anything you read today is
   noise** — treat it as a baseline, not a verdict.

2. **There is no live rank API.** App Store Connect never shows literal keyword rank positions — only
   impressions, downloads, and (with a filter) search-term *demand*. True per-keyword rank only comes from a
   paid ASO tracker (AppTweak, Sensor Tower, AppFigures, AppTweak, ASOMobile) — the kind of tool you used
   before. Without it, the only 100%-accurate "now" rank is **searching the App Store app by hand.**

3. **Web ≠ in-app.** Don't check ranks on apps.apple.com in Safari — the web index is a *different algorithm*
   from in-app App Store search and will mislead you. Always check in the **App Store app on your iPhone.**

## How to get your current ranks with ONLY App Store Connect

### Method 1 — Manual spot-check (the accurate one, ~10 min)

On your iPhone, in the **App Store app** (not Safari):

1. Search tab → type the keyword.
2. Scroll until you see **Peptide Tracker – Stackr**. Count the position (ignore anything marked **Ad** — that's paid, not organic).
3. Record it in `rank-tracking-template.csv`. Top 10 ≈ "page 1." Past ~30 you're effectively not ranking.
4. Repeat for the 35 terms in the template (start with the 10 `primary` ones).

If you're missing from a term today, that's almost certainly **"not indexed yet,"** not "the metadata failed."

### Method 2 — App Store Connect "Search Terms" (your own demand data)

ASC → **App Analytics → Peptide Tracker → Metrics → add filter `Source = App Store Search` → Search Terms.**

This won't give a rank number, but it shows which terms actually drive **impressions and downloads** — which
matters more than rank. Note it lags 1–2 days, so right after release it'll be mostly empty for the new terms.
Re-check it at the 2-week mark.

### Method 3 — Re-subscribe to a rank tracker (if/when you can)

If you regain access to an ASO tool, load the `primary` + `secondary` terms from the tracking template and let
it pull daily ranks automatically. **AppFigures** is the cheapest credible option; **AppTweak / Sensor Tower**
are the pro tier. Until then, Method 1 is your ground truth.

## What to actually do this week

| When | Action |
|------|--------|
| **Today** | Run Method 1 for the 10 `primary` terms → record as **baseline** in the CSV. Expect gaps. |
| **+72 hours** | Re-run the same 10. This is the first read where indexing should be catching up. |
| **+2 weeks** | Re-run all 35 + check ASC Search Terms (Method 2). First *real* signal. |
| **+4 weeks** | Re-run all 35. Rankings are now stable — **this is the number you judge the v3.0 ASO on.** |
| **After 4 wk** | If terms underperform, ship the next metadata iteration from `metadata-recommendations.md`. Hold 4–6 wks between changes. |

> Don't change metadata again before the 4-week mark — every new build resets the indexing clock and you lose
> the ability to attribute what worked.
