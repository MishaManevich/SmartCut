#!/usr/bin/env python3
"""
IceHouse panel cut-layout generator.

Generates a technical "cut sheet" (SVG + PNG) for an ice-house of a given
footprint.  The reference is the IceHouse 8' x 8' drawing: the width (the
"8' " side, where the swing door lives) is fixed, while the DEPTH grows.

Each sheet contains three sections, exactly like the reference:

  * Wall Panels        - a top-down "ring" of the four walls.  Every side is
                         built from a 12" corner post + a run of 24" panels +
                         a 12" corner post.  Width is always 96"; the depth
                         side gains one extra 24" panel for every extra 2 ft.
  * Ceiling/Floor      - a 96" x DEPTH sheet split into 24" strips.
  * All Swing Door     - the 96" front wall with a 34" x 76" door and cam-locks.
                         This lives on the fixed 8' wall, so it never changes.

Run:  python3 generate_panels.py
Out:  output/IceHouse_8x{D}.svg  and  .png  for D in 10,12,14,16
"""

import os

# ---- geometry constants (inches) ------------------------------------------
WIDTH = 96            # the fixed "8 ft" side (front wall / door wall)
CORNER = 12           # corner-post length at each end of a wall run
PANEL = 24            # standard wall / floor panel width
BAND = 5              # drawn wall thickness (visual only)
HATCH = 12            # red corner-post square size

DOOR_W, DOOR_H = 34, 76     # door leaf
WALL_FACE_H = 84            # front-wall elevation height (4 + 76 + 4)

SCALE = 2.5           # pixels per inch on the sheet
SHEET_W = 780         # fixed sheet width (px)


# ---- tiny SVG builder ------------------------------------------------------
class SVG:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.parts = []

    def line(self, x1, y1, x2, y2, stroke="#1a1a1a", width=1.0, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(
            f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="{stroke}" stroke-width="{width}"{d}/>')

    def rect(self, x, y, w, h, stroke="#1a1a1a", width=1.0, fill="none"):
        self.parts.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="{width}"/>')

    def text(self, x, y, s, size=13, anchor="middle", weight="normal",
             family="Verdana, Arial, sans-serif", fill="#111"):
        self.parts.append(
            f'<text x="{x:.1f}" y="{y:.1f}" font-family="{family}" '
            f'font-size="{size}" font-weight="{weight}" text-anchor="{anchor}" '
            f'fill="{fill}">{s}</text>')

    def svg(self):
        head = (f'<svg xmlns="http://www.w3.org/2000/svg" '
                f'width="{self.w}" height="{self.h}" '
                f'viewBox="0 0 {self.w} {self.h}">')
        bg = f'<rect width="{self.w}" height="{self.h}" fill="#eef0f1"/>'
        return head + bg + "".join(self.parts) + "</svg>"


# ---- dimension helpers -----------------------------------------------------
ARROW = 5  # arrowhead size (px)


def _arrow(svg, x, y, dx, dy):
    """small filled arrowhead at (x,y) pointing along (dx,dy) unit-ish vector."""
    import math
    ang = math.atan2(dy, dx)
    for off in (0.4, -0.4):
        ax = x - ARROW * math.cos(ang + off)
        ay = y - ARROW * math.sin(ang + off)
        svg.line(x, y, ax, ay, width=1.0)


def dim_h(svg, x1, x2, y, label, size=12, tick=5):
    """horizontal dimension line between x1..x2 at height y."""
    svg.line(x1, y, x2, y, width=0.9)
    _arrow(svg, x1, y, 1, 0)
    _arrow(svg, x2, y, -1, 0)
    # short extension ticks
    svg.line(x1, y - tick, x1, y + tick, width=0.7)
    svg.line(x2, y - tick, x2, y + tick, width=0.7)
    svg.text((x1 + x2) / 2, y - 4, label, size=size)


def dim_v(svg, y1, y2, x, label, size=12, tick=5, side="left"):
    """vertical dimension line between y1..y2 at x."""
    svg.line(x, y1, x, y2, width=0.9)
    _arrow(svg, x, y1, 0, 1)
    _arrow(svg, x, y2, 0, -1)
    svg.line(x - tick, y1, x + tick, y1, width=0.7)
    svg.line(x - tick, y2, x + tick, y2, width=0.7)
    tx = x - 5 if side == "left" else x + 5
    anchor = "end" if side == "left" else "start"
    svg.text(tx, (y1 + y2) / 2 + size * 0.35, label, size=size, anchor=anchor)


def run_segments(length):
    """split a wall run of `length` into [12, 24, 24, ..., 12]."""
    n = (length - 2 * CORNER) // PANEL
    return [CORNER] + [PANEL] * n + [CORNER]


# ---- sections --------------------------------------------------------------
def draw_wall_ring(svg, ox, oy, depth):
    """Top-down ring of the four walls at offset (ox,oy)."""
    s = SCALE
    W, D = WIDTH, depth
    Wp, Dp = W * s, D * s

    # outer + inner band rectangles
    svg.rect(ox, oy, Wp, Dp, width=1.4)
    svg.rect(ox + BAND * s, oy + BAND * s, Wp - 2 * BAND * s, Dp - 2 * BAND * s,
             width=0.8)

    # red hatched corner posts (12x12)
    for cx, cy in ((0, 0), (W - HATCH, 0), (0, D - HATCH), (W - HATCH, D - HATCH)):
        x0, y0, hp = ox + cx * s, oy + cy * s, HATCH * s
        svg.rect(x0, y0, hp, hp, stroke="#cc2222", width=1.0)
        for k in range(1, 6):
            t = k / 6 * hp
            svg.line(x0, y0 + t, x0 + t, y0, stroke="#cc2222", width=0.6)
            svg.line(x0 + hp - t, y0 + hp, x0 + hp, y0 + hp - t,
                     stroke="#cc2222", width=0.6)

    # panel seam ticks across the band, top & bottom (width run) and sides (depth run)
    def seams(positions, horizontal):
        acc = 0
        for seg in positions[:-1]:
            acc += seg
            if horizontal:
                x = ox + acc * s
                svg.line(x, oy, x, oy + BAND * s, width=0.7)
                svg.line(x, oy + Dp - BAND * s, x, oy + Dp, width=0.7)
            else:
                y = oy + acc * s
                svg.line(ox, y, ox + BAND * s, y, width=0.7)
                svg.line(ox + Wp - BAND * s, y, ox + Wp, y, width=0.7)

    wsegs = run_segments(W)
    dsegs = run_segments(D)
    seams(wsegs, horizontal=True)
    seams(dsegs, horizontal=False)

    # ---- dimensions ----
    # top run (96") : overall + per-segment
    dim_h(svg, ox, ox + Wp, oy - 34, f'{W}"')
    acc = 0
    for seg in wsegs:
        dim_h(svg, ox + acc * s, ox + (acc + seg) * s, oy - 14, f'{seg}"', size=10, tick=4)
        acc += seg
    # left run (depth) : overall + per-segment
    dim_v(svg, oy, oy + Dp, ox - 48, f'{D}"')
    acc = 0
    for seg in dsegs:
        dim_v(svg, oy + acc * s, oy + (acc + seg) * s, ox - 14, f'{seg}"',
              size=10, tick=4)
        acc += seg
    # right run per-segment (mirror, like reference)
    acc = 0
    for seg in dsegs:
        dim_v(svg, oy + acc * s, oy + (acc + seg) * s, ox + Wp + 14, f'{seg}"',
              size=10, tick=4, side="right")
        acc += seg

    # door opening on the bottom edge (front wall)
    door_x0 = ox + ((W - DOOR_W) / 2) * s
    dim_h(svg, door_x0, door_x0 + DOOR_W * s, oy + Dp + 16, f'{DOOR_W}"',
          size=10, tick=4)
    # the swing leaf (angled line)
    svg.line(door_x0, oy + Dp, door_x0 + 40 * s * 0.0 + 38, oy + Dp + 20,
             stroke="#1a1a1a", width=1.2)


def draw_ceiling(svg, ox, oy, depth):
    """96 x depth sheet split into 24" strips."""
    s = SCALE
    Wp, Dp = WIDTH * s, depth * s
    inset = 2 * s
    svg.rect(ox, oy, Wp, Dp, width=1.4)
    svg.rect(ox + inset, oy + inset, Wp - 2 * inset, Dp - 2 * inset, width=0.8)

    n = depth // PANEL
    for i in range(1, n):
        y = oy + i * PANEL * s
        svg.line(ox + inset, y, ox + Wp - inset, y, width=0.8)
    # 24" label inside each strip, left column
    for i in range(n):
        yc = oy + (i + 0.5) * PANEL * s + 4
        svg.text(ox + inset + 22, yc, f'{PANEL}"', size=11)

    dim_h(svg, ox, ox + Wp, oy - 16, f'{WIDTH}"')
    dim_v(svg, oy, oy + Dp, ox + Wp + 30, f'{depth}"', side="right")


def draw_door(svg, ox, oy):
    """Front-wall elevation with swing door + cam-locks (constant)."""
    s = SCALE
    Wp, Hp = WIDTH * s, WALL_FACE_H * s
    svg.rect(ox, oy, Wp, Hp, width=1.4)
    # top header (4") and bottom sill (4")
    svg.line(ox, oy + 4 * s, ox + Wp, oy + 4 * s, width=0.8)
    svg.line(ox, oy + Hp - 4 * s, ox + Wp, oy + Hp - 4 * s, width=0.8)
    # vertical wall-panel seams
    for x in (24, 48, 72):
        svg.line(ox + x * s, oy + 4 * s, ox + x * s, oy + Hp - 4 * s, width=0.7)

    # door leaf 34 x 76, left-of-centre like the reference
    dx0 = ox + 14 * s
    svg.rect(dx0, oy + 4 * s, DOOR_W * s, DOOR_H * s, stroke="#1a1a1a", width=1.2)

    # cam-lock markers (blue) on the latch side + label
    for fy in (0.22, 0.5, 0.78):
        cy = oy + 4 * s + fy * DOOR_H * s
        svg.rect(dx0 + DOOR_W * s - 3, cy - 4, 6, 8, stroke="#2b5fb3",
                 width=1.0, fill="#2b5fb3")
        svg.rect(ox + Wp - 18, cy - 4, 6, 8, stroke="#2b5fb3",
                 width=1.0, fill="#2b5fb3")
    svg.text(ox + Wp + 18, oy + Hp / 2 + 4, "CAM-LOCK", size=11, anchor="start",
             fill="#2b5fb3")

    # dimensions
    dim_h(svg, dx0, dx0 + DOOR_W * s, oy + 4 * s + 18, f'{DOOR_W}"', size=10, tick=4)
    dim_v(svg, oy + 4 * s, oy + Hp - 4 * s, ox - 16, '82"', side="left")
    dim_v(svg, oy + 4 * s, oy + 4 * s + DOOR_H * s, dx0 - 8, f'{DOOR_H}"',
          size=10, side="left")
    svg.text(ox - 16, oy + 2 * s + 4, '4"', size=10, anchor="end")
    svg.text(ox - 16, oy + Hp - 2 * s + 4, '4"', size=10, anchor="end")


# ---- sheet assembly --------------------------------------------------------
def build_sheet(depth):
    s = SCALE
    top_h = depth * s

    # column offsets
    wall_x = 95
    ceil_x = 470
    top_y = 190

    door_y = top_y + top_h + 70
    sheet_h = door_y + WALL_FACE_H * s + 70

    svg = SVG(SHEET_W, sheet_h)

    # title
    svg.text(SHEET_W / 2, 50, f"IceHouse 8' x {depth // 12}'", size=30,
             weight="bold")
    svg.line(60, 64, SHEET_W - 60, 64, width=0.8)

    # section headers
    svg.text(wall_x, 120, "Wall Panels", size=20, anchor="start", weight="bold")
    svg.text(ceil_x, 120, "Ceiling/Floor Panels", size=18, anchor="start",
             weight="bold")
    svg.text(SHEET_W / 2, 145, f"(footprint width fixed at 8' / 96\" — depth = {depth // 12}')",
             size=12, fill="#666")

    draw_wall_ring(svg, wall_x, top_y, depth)
    draw_ceiling(svg, ceil_x, top_y, depth)

    svg.text(wall_x, door_y - 24, "All Swing Door", size=18, anchor="start",
             weight="bold")
    draw_door(svg, wall_x + 30, door_y)

    # footprint note
    sqft = (8 * (depth // 12))
    svg.text(SHEET_W - 60, sheet_h - 22,
             f"Footprint 8' x {depth // 12}'  ({sqft} sq ft)  |  walls in 24\" panels",
             size=11, anchor="end", fill="#555")
    return svg.svg()


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, "output")
    os.makedirs(out, exist_ok=True)

    try:
        import cairosvg
        have_png = True
    except ImportError:
        have_png = False
        print("cairosvg not installed -> SVG only (no PNG previews)")

    for depth in (120, 144, 168, 192):     # 10', 12', 14', 16'
        name = f"IceHouse_8x{depth // 12}"
        svg_text = build_sheet(depth)
        svg_path = os.path.join(out, name + ".svg")
        with open(svg_path, "w") as f:
            f.write(svg_text)
        print("wrote", svg_path)
        if have_png:
            png_path = os.path.join(out, name + ".png")
            cairosvg.svg2png(bytestring=svg_text.encode(), write_to=png_path,
                             scale=2.0, background_color="white")
            print("wrote", png_path)


if __name__ == "__main__":
    main()
