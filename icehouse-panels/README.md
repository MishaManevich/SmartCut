# IceHouse Panel Cut-Sheets

Parametric generator for IceHouse panel cut-layout sheets, modeled on the
reference **IceHouse 8' x 8'** drawing (a freeze-camera / ice-house panel kit).

The **width is fixed at 8' (96")** — that's the side the swing door sits on —
while the **depth grows**. Every sheet keeps all three reference views, drawn at
the same horizontal scale so they line up:

| View                          | What it shows                                                                 |
|-------------------------------|-------------------------------------------------------------------------------|
| **Wall Panels** (top view)    | Plan ring of the four walls. Each wall = `12" corner + N×24" panels + 12" corner`. The four corners are **L-shaped cam-lock posts** (hatched red). The front (bottom) wall carries the door bay `12 + 48 + 24 + 12`. |
| **Ceiling/Floor**             | The `96" × DEPTH` deck split into `24"` strips.                               |
| **All Swing Door** (front view)| Elevation of the 96" front wall, drawn **directly below the plan and left-aligned**, so the 34" door lines up under the door bay above it. |

### What changes with depth vs. what stays fixed

Only the depth-direction grows, so only two things change:

- **Wall Panels** — the two depth-side walls gain one extra `24"` panel per +2 ft.
- **Ceiling/Floor** — one extra `24"` strip per +2 ft (`#strips = depth / 24`).

The **front wall and its swing door never change** (they're on the fixed 96"
side), so every door detail is preserved at every size:

- door **centered** in the 48" bay → opening at `19"–53"`, `34" × 76"`
- two **hinges/cam-locks** on the door's left jamb + a **handle** mid-height on the latch side (red)
- **cam-locks on the outer left & right wall edges** (blue) with the `CAM-LOCK` callout
- `4"` top rail, `82"` body, `4"` sill

| Footprint | Depth | Depth-side run   | Floor strips | Sq ft |
|-----------|-------|------------------|--------------|-------|
| 8' × 8'   | 96"   | 12 + 24×3 + 12   | 4            | 64    |
| 8' × 10'  | 120"  | 12 + 24×4 + 12   | 5            | 80    |
| 8' × 12'  | 144"  | 12 + 24×5 + 12   | 6            | 96    |
| 8' × 14'  | 168"  | 12 + 24×6 + 12   | 7            | 112   |
| 8' × 16'  | 192"  | 12 + 24×7 + 12   | 8            | 128   |

## Usage

```bash
pip install cairosvg          # optional, only needed for the PNG previews
python3 generate_panels.py
```

Outputs land in `output/` as `IceHouse_8x{10,12,14,16}` — each a **`.svg`**
(vector source of truth for printing/cutting) and a **`.png`** preview.

To add a size, call `build_sheet(depth_in_inches)` — e.g. `build_sheet(216)`
for 8' × 18'. SVG generation is pure Python; `cairosvg` only rasterizes previews.

## Notes

The hardware positions (hinges, handle, cam-locks) and panel breakdown were
measured directly off the original 8'×8' drawing so the scaled sheets stay
faithful — change a constant and regenerate the whole set.
