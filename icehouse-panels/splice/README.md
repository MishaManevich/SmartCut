# IceHouse cut-sheets — 1:1 splice from the original 8×8

These are the **true 1:1** sheets: they reuse the **original 8×8 drawing's own
pixels** and only grow the depth. The door, latches, corner posts, panel
labels, and dimension arrows are the original artwork, untouched.

## How it works

The wall ring and the ceiling are periodic in **24"** (= 74 px in the source
image). Inserting whole 24"-tall bands preserves both periodic patterns
exactly, so adding depth is just tiling the original panels:

| Sheet | Depth | Panels added | Wall side run    | Ceiling strips |
|-------|-------|--------------|------------------|----------------|
| 8×10  | 120"  | +1           | 12 + 24×4 + 12   | 5              |
| 8×12  | 144"  | +2           | 12 + 24×5 + 12   | 6              |
| 8×14  | 168"  | +3           | 12 + 24×6 + 12   | 7              |
| 8×16  | 192"  | +4           | 12 + 24×7 + 12   | 8              |

The only redrawn pixels are the **three numbers that change**: the two overall
depth dimensions (`96"` → `120/144/168/192"`) and the title's depth foot-mark
(`8'` → `10/12/14/16'`). These are restamped in **Liberation Sans**, which
matches the drawing's lettering (and supplies the `0` that the original drawing
never contained). Everything else — including the front door view with all its
hardware — is the literal original.

## Usage

```bash
python3 build.py
```

Outputs in `out/`:

- `IceHouse_8x{10,12,14,16}.png` — preview
- `IceHouse_8x{10,12,14,16}.pdf` — per-size PDF
- `IceHouse_8x10-12-14-16.pdf` — combined multi-page PDF (for printing/sending)

## Notes / limits

- Resolution is the **source image's** resolution (~3 px per real inch). Great
  on screen / PDF; for large-format printing the original CAD/vector file would
  be crisper.
- `SRC` at the top of `build.py` points at the original 8×8 PNG. Swap in a
  higher-resolution copy of the same drawing and rerun for a sharper result —
  no other changes needed (the panel period auto-scales only if the layout
  matches; for a different-resolution scan, update `P`, `BAND_Y0`, and the
  label boxes).
