# IceHouse Panel Cut-Sheets

Parametric generator for IceHouse panel cut-layout sheets, modeled on the
reference **IceHouse 8' x 8'** drawing.

The **width is fixed at 8' (96")** — that's the side the swing door sits on —
while the **depth grows**. As depth increases, only two things change:

| Section            | What changes with depth                                       |
|--------------------|---------------------------------------------------------------|
| **Wall Panels**    | The two depth-side walls gain one extra 24" panel per +2 ft.  |
| **Ceiling/Floor**  | One extra 24" strip per +2 ft (`#strips = depth / 24`).       |
| **All Swing Door** | Unchanged — it lives on the fixed 96" front wall.             |

Every wall run is built as `12" corner post + N × 24" panels + 12" corner post`:

| Footprint | Depth | Depth-side run         | Floor strips | Sq ft |
|-----------|-------|------------------------|--------------|-------|
| 8' × 8'   | 96"   | 12 + 24×3 + 12         | 4            | 64    |
| 8' × 10'  | 120"  | 12 + 24×4 + 12         | 5            | 80    |
| 8' × 12'  | 144"  | 12 + 24×5 + 12         | 6            | 96    |
| 8' × 14'  | 168"  | 12 + 24×6 + 12         | 7            | 112   |
| 8' × 16'  | 192"  | 12 + 24×7 + 12         | 8            | 128   |

## Usage

```bash
pip install cairosvg          # optional, only needed for PNG previews
python3 generate_panels.py
```

Outputs land in `output/`:

- `IceHouse_8x10`, `8x12`, `8x14`, `8x16` — each as **`.svg`** (vector, the
  source of truth for printing/cutting) and **`.png`** (preview).

The SVG generation is pure Python with no dependencies; `cairosvg` is only used
to rasterize the PNG previews. To add another size, just call
`build_sheet(depth_in_inches)` — e.g. `build_sheet(216)` for an 8' × 18'.

## Notes

These are schematic cut-layouts that carry the same dimensions and panel
breakdown as the reference drawing (corner posts, 24" panels, 34"×76" door,
cam-lock positions). They're meant as a clear, editable, code-driven
alternative to hand-drawn images — tweak a constant and regenerate the whole
set.
