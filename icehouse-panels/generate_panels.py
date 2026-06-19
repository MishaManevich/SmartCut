#!/usr/bin/env python3
"""
IceHouse panel cut-sheet generator.

Modeled on the reference IceHouse 8' x 8' drawing.  The WIDTH (the "8 ft"
front-wall side, where the swing door lives) is fixed at 96"; only the DEPTH
grows.  Each sheet has three views that all share the same horizontal scale so
the front-view door lines up under the plan-view front wall:

  * Wall Panels   - TOP / PLAN view: a ring of the four walls.  Each wall runs
                    12" corner-post + N x 24" panels + 12" corner-post.  The
                    four corners are L-shaped posts (hatched red).  The front
                    (bottom) wall carries the door bay: 12 + 48 + 24 + 12.
  * Ceiling/Floor - the 96" x DEPTH deck, split into 24" strips.
  * All Swing Door- FRONT / ELEVATION view of the 96" front wall, drawn
                    directly BELOW the plan and left-aligned so the 34" door
                    opening lines up with the door bay in the plan above it.

Because the door is on the fixed 96" wall, the front view is identical for
every depth.

Run:  python3 generate_panels.py   ->  output/IceHouse_8x{10,12,14,16}.svg/.png
"""

import math
import os

# ---- geometry (inches) -----------------------------------------------------
WIDTH = 96            # fixed 8 ft front-wall side
CORNER = 12           # corner-post run length on each wall
PANEL = 24            # standard wall / deck panel
T = 4                 # drawn wall thickness (plan band / corner-post arm)

# front (door) wall plan layout, left->right: corner, door-bay, panel, corner
DOOR_BAY = 48
FRONT_SEGS = [CORNER, DOOR_BAY, PANEL, CORNER]   # sums to 96
DOOR_W = 34           # door opening / leaf width
DOOR_OFF = (DOOR_BAY - DOOR_W) // 2   # door centered in the bay -> 7
# => opening spans [CORNER+DOOR_OFF, ...+DOOR_W] = [19, 53] (centered in bay)

# front elevation
EL_TOP = 4            # top rail
EL_BODY = 82          # rough-opening zone
EL_BOT = 4            # bottom rail / sill
EL_H = EL_TOP + EL_BODY + EL_BOT      # 90
DOOR_H = 76           # door leaf height

SCALE = 2.4           # px per inch
SHEET_W = 820


# ---- minimal SVG builder ---------------------------------------------------
class SVG:
    def __init__(self, w, h):
        self.w, self.h, self.parts, self._n = w, h, [], 0

    def line(self, x1, y1, x2, y2, stroke="#1a1a1a", width=1.0, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" '
                           f'y2="{y2:.1f}" stroke="{stroke}" stroke-width="{width}"{d}/>')

    def rect(self, x, y, w, h, stroke="#1a1a1a", width=1.0, fill="none"):
        self.parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" '
                           f'height="{h:.1f}" fill="{fill}" stroke="{stroke}" '
                           f'stroke-width="{width}"/>')

    def rrect(self, x, y, w, h, rx=3, stroke="#1a1a1a", width=1.0, fill="none"):
        self.parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" '
                           f'height="{h:.1f}" rx="{rx:.1f}" ry="{rx:.1f}" '
                           f'fill="{fill}" stroke="{stroke}" stroke-width="{width}"/>')

    def poly(self, pts, stroke="#1a1a1a", width=1.0, fill="none"):
        p = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
        self.parts.append(f'<polygon points="{p}" fill="{fill}" stroke="{stroke}" '
                          f'stroke-width="{width}"/>')

    def circle(self, cx, cy, r, stroke="#1a1a1a", width=1.0, fill="none"):
        self.parts.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" '
                          f'fill="{fill}" stroke="{stroke}" stroke-width="{width}"/>')

    def text(self, x, y, s, size=13, anchor="middle", weight="normal",
             fill="#111"):
        self.parts.append(f'<text x="{x:.1f}" y="{y:.1f}" '
                          f'font-family="Verdana, Arial, sans-serif" '
                          f'font-size="{size}" font-weight="{weight}" '
                          f'text-anchor="{anchor}" fill="{fill}">{s}</text>')

    def hatch(self, x, y, w, h, color="#cc2222", gap=5):
        """diagonal-line hatched rectangle (clipped)."""
        self._n += 1
        cid = f"h{self._n}"
        self.parts.append(f'<clipPath id="{cid}"><rect x="{x:.1f}" y="{y:.1f}" '
                          f'width="{w:.1f}" height="{h:.1f}"/></clipPath>')
        self.parts.append(f'<g clip-path="url(#{cid})">')
        i = 0
        start = x - h
        while start + i * gap <= x + w:
            x0 = start + i * gap
            self.parts.append(f'<line x1="{x0:.1f}" y1="{y:.1f}" '
                              f'x2="{x0 + h:.1f}" y2="{y + h:.1f}" '
                              f'stroke="{color}" stroke-width="0.6"/>')
            i += 1
        self.parts.append("</g>")
        self.rect(x, y, w, h, stroke=color, width=0.8)

    def svg(self):
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" '
                f'height="{self.h}" viewBox="0 0 {self.w} {self.h}">'
                f'<rect width="{self.w}" height="{self.h}" fill="#eef0f1"/>'
                + "".join(self.parts) + "</svg>")


# ---- dimension helpers -----------------------------------------------------
def _arrow(svg, x, y, dx, dy):
    ang = math.atan2(dy, dx)
    for off in (0.4, -0.4):
        svg.line(x, y, x - 5 * math.cos(ang + off), y - 5 * math.sin(ang + off),
                 width=0.9)


def dim_h(svg, x1, x2, y, label, size=11, tick=4):
    svg.line(x1, y, x2, y, width=0.8)
    _arrow(svg, x1, y, 1, 0); _arrow(svg, x2, y, -1, 0)
    svg.line(x1, y - tick, x1, y + tick, width=0.6)
    svg.line(x2, y - tick, x2, y + tick, width=0.6)
    svg.text((x1 + x2) / 2, y - 4, label, size=size)


def dim_v(svg, y1, y2, x, label, size=11, tick=4, side="left"):
    svg.line(x, y1, x, y2, width=0.8)
    _arrow(svg, x, y1, 0, 1); _arrow(svg, x, y2, 0, -1)
    svg.line(x - tick, y1, x + tick, y1, width=0.6)
    svg.line(x - tick, y2, x + tick, y2, width=0.6)
    tx = x - 5 if side == "left" else x + 5
    svg.text(tx, (y1 + y2) / 2 + size * 0.35, label, size=size,
             anchor="end" if side == "left" else "start")


def side_segs(depth):
    """depth-side wall run: 12 + 24*n + 12."""
    n = (depth - 2 * CORNER) // PANEL
    return [CORNER] + [PANEL] * n + [CORNER]


# ---- PLAN view (wall ring) -------------------------------------------------
def draw_plan(svg, ox, oy, depth):
    s = SCALE
    W, D = WIDTH, depth
    Wp, Dp = W * s, D * s
    tp = T * s

    # wall band: outer + inner rectangle
    svg.rect(ox, oy, Wp, Dp, width=1.4)
    svg.rect(ox + tp, oy + tp, Wp - 2 * tp, Dp - 2 * tp, width=0.8)

    top_segs = [CORNER, PANEL, PANEL, PANEL, CORNER]      # back wall
    bot_segs = FRONT_SEGS                                  # front (door) wall
    sd_segs = side_segs(D)

    # panel seam ticks across the band
    def seam_h(segs, y_top):
        acc = 0
        for seg in segs[:-1]:
            acc += seg
            x = ox + acc * s
            svg.line(x, y_top, x, y_top + tp, width=0.6)

    def seam_v(segs, x_left):
        acc = 0
        for seg in segs[:-1]:
            acc += seg
            y = oy + acc * s
            svg.line(x_left, y, x_left + tp, y, width=0.6)

    seam_h(top_segs, oy)
    seam_h(bot_segs, oy + Dp - tp)
    seam_v(sd_segs, ox)
    seam_v(sd_segs, ox + Wp - tp)

    # L-shaped hatched corner posts (two band-thick arms, open interior)
    def corner(cx, cy, sx, sy):
        # horizontal arm (CORNER long, T thick) + vertical arm (T thick, CORNER long)
        hx = cx if sx > 0 else cx - CORNER * s
        hy = cy if sy > 0 else cy - tp
        svg.hatch(hx, hy, CORNER * s, tp)
        vx = cx if sx > 0 else cx - tp
        vy = cy if sy > 0 else cy - CORNER * s
        svg.hatch(vx, vy, tp, CORNER * s)

    corner(ox, oy, 1, 1)                       # top-left
    corner(ox + Wp, oy, -1, 1)                 # top-right
    corner(ox, oy + Dp, 1, -1)                 # bottom-left
    corner(ox + Wp, oy + Dp, -1, -1)           # bottom-right

    # ---- door opening on the front (bottom) wall ----
    op0 = (CORNER + DOOR_OFF)                   # 14"
    op1 = op0 + DOOR_W                          # 48"
    # break the inner band line across the opening + draw jambs
    ix0, ix1 = ox + op0 * s, ox + op1 * s
    iy = oy + Dp - tp
    svg.rect(ix0, iy, (op1 - op0) * s, tp, fill="#eef0f1", stroke="none")
    svg.line(ix0, iy, ix0, oy + Dp, width=0.9)
    svg.line(ix1, iy, ix1, oy + Dp, width=0.9)
    # swing leaf: thin slab hinged at left jamb, swung out (downward) ~22deg
    th = math.radians(22)
    ux, uy = math.cos(th), math.sin(th)
    px, py = -uy, ux
    hxp, hyp = ix0, oy + Dp
    L, wlf = DOOR_W * s, 2.5 * s
    svg.poly([(hxp, hyp),
              (hxp + L * ux, hyp + L * uy),
              (hxp + L * ux + wlf * px, hyp + L * uy + wlf * py),
              (hxp + wlf * px, hyp + wlf * py)], width=1.0, fill="#ffffff")

    # ---- dimensions ----
    # back wall (top): overall + segments
    dim_h(svg, ox, ox + Wp, oy - 34, f'{W}"', size=12)
    acc = 0
    for seg in top_segs:
        dim_h(svg, ox + acc * s, ox + (acc + seg) * s, oy - 14, f'{seg}"')
        acc += seg
    # depth side: overall (far left) + segments both sides
    dim_v(svg, oy, oy + Dp, ox - 48, f'{D}"', size=12)
    acc = 0
    for seg in sd_segs:
        dim_v(svg, oy + acc * s, oy + (acc + seg) * s, ox - 16, f'{seg}"')
        dim_v(svg, oy + acc * s, oy + (acc + seg) * s, ox + Wp + 16, f'{seg}"',
              side="right")
        acc += seg
    # front wall (bottom): segment chain below + door opening above the band
    acc = 0
    for seg in bot_segs:
        dim_h(svg, ox + acc * s, ox + (acc + seg) * s, oy + Dp + 52, f'{seg}"')
        acc += seg
    dim_h(svg, ix0, ix1, oy + Dp - tp - 10, f'{DOOR_W}"')   # 34" opening
    return op0, op1     # door opening x-range (inches), for elevation alignment


# ---- Ceiling / floor deck --------------------------------------------------
def draw_deck(svg, ox, oy, depth):
    s = SCALE
    Wp, Dp = WIDTH * s, depth * s
    inset = 2 * s
    svg.rect(ox, oy, Wp, Dp, width=1.4)
    svg.rect(ox + inset, oy + inset, Wp - 2 * inset, Dp - 2 * inset, width=0.8)
    n = depth // PANEL
    for i in range(1, n):
        y = oy + i * PANEL * s
        svg.line(ox + inset, y, ox + Wp - inset, y, width=0.8)
    for i in range(n):
        svg.text(ox + inset + 22, oy + (i + 0.5) * PANEL * s + 4, f'{PANEL}"', size=11)
    dim_h(svg, ox, ox + Wp, oy - 16, f'{WIDTH}"', size=12)
    dim_v(svg, oy, oy + Dp, ox + Wp + 30, f'{depth}"', size=12, side="right")


# ---- FRONT elevation (aligned under the plan) ------------------------------
WALL_LOCK_Y = (19, 67)    # blue cam-locks on the outer left & right wall edges
RED = "#e02222"
PANE = "#ffffff"          # hardware body fill


def hw_camlock(svg, cx, cy, s, color=RED):
    """vertical rounded cam-lock pill with a center slot."""
    w, h = 2.6 * s, 6.6 * s
    svg.rrect(cx - w / 2, cy - h / 2, w, h, rx=w / 2, stroke=color, width=1.3, fill=PANE)
    svg.line(cx - w * 0.32, cy, cx + w * 0.32, cy, stroke=color, width=0.8)


def hw_drawlatch(svg, jx, cy, s):
    """draw-latch: vertical plate at jamb (jx) + horizontal lever extending right."""
    pw, ph = 2.8 * s, 7.6 * s
    svg.rrect(jx - pw * 0.55, cy - ph / 2, pw, ph, rx=0.9 * s, stroke=RED, width=1.3,
              fill=PANE)
    lw, lh = 9.4 * s, 3.8 * s
    svg.rrect(jx + 0.6 * s, cy - lh / 2, lw, lh, rx=lh / 2, stroke=RED, width=1.3,
              fill=PANE)
    svg.circle(jx + 1.3 * s, cy, 1.0 * s, stroke=RED, width=1.0, fill=PANE)


def hw_handle(svg, cx, cy, s):
    """compression handle: left shaft + rounded body with a round cam/knob."""
    svg.line(cx - 11 * s, cy, cx - 2.5 * s, cy, stroke=RED, width=1.5)
    bw, bh = 7.5 * s, 4.4 * s
    svg.rrect(cx - bw / 2, cy - bh / 2, bw, bh, rx=1.1 * s, stroke=RED, width=1.3,
              fill=PANE)
    svg.line(cx - bw / 2, cy, cx + bw / 2, cy, stroke=RED, width=0.7)
    svg.circle(cx + bw * 0.18, cy, 1.7 * s, stroke=RED, width=1.3, fill=PANE)


def draw_elevation(svg, ox, oy, op0, op1):
    """ox = plan's ox, same SCALE -> door lines up under the plan door bay."""
    s = SCALE
    Wp, Hp = WIDTH * s, EL_H * s

    def yabs(inch):
        return oy + inch * s

    svg.rect(ox, oy, Wp, Hp, width=1.4)
    railtop, railbot = yabs(EL_TOP), yabs(EL_TOP + EL_BODY)
    svg.line(ox, railtop, ox + Wp, railtop, width=0.8)            # top rail
    svg.line(ox, railbot, ox + Wp, railbot, width=0.8)            # sill
    # structural wall-panel seams (match plan front wall: 12, 60, 84)
    acc = 0
    for seg in FRONT_SEGS[:-1]:
        acc += seg
        x = ox + acc * s
        svg.line(x, railtop, x, railbot, width=0.7)

    # door leaf: same x as the plan opening, centered in the 82" body, 76" tall
    dx0, dx1 = ox + op0 * s, ox + op1 * s
    dtop, dbot = yabs(7), yabs(83)
    svg.rect(dx0, dtop, dx1 - dx0, DOOR_H * s, width=1.2)
    svg.line((dx0 + dx1) / 2, dtop, (dx0 + dx1) / 2, dbot, width=0.4,
             stroke="#bbb")                                        # leaf reveal

    # ---- door hardware (red), drawn to match the original latches ----
    hw_camlock(svg, ox + 47 * s, yabs(10.6), s)        # top cam-lock
    hw_drawlatch(svg, dx0, yabs(19.8), s)              # upper draw-latch (left jamb)
    hw_drawlatch(svg, dx0, yabs(77.7), s)              # lower draw-latch (left jamb)
    hw_handle(svg, ox + 50 * s, yabs(47.5), s)         # latch handle (right side)

    # ---- wall cam-locks (blue) on the outer left & right edges
    for cy in WALL_LOCK_Y:
        hw_camlock(svg, ox, yabs(cy), s, color="#2b5fb3")
        hw_camlock(svg, ox + Wp, yabs(cy), s, color="#2b5fb3")
    # CAM-LOCK callout pointing at the right-edge cam-locks
    lx, ly = ox + Wp + 66, yabs((WALL_LOCK_Y[0] + WALL_LOCK_Y[1]) / 2)
    for cy in WALL_LOCK_Y:
        svg.line(ox + Wp + 4, yabs(cy), lx, ly, stroke="#2b5fb3", width=0.7)
    svg.text(lx + 4, ly + 4, "CAM-LOCK", size=11, anchor="start", fill="#2b5fb3")

    # dimensions: 96" on top; 34" and 76" INSIDE the door like the original
    dim_h(svg, ox, ox + Wp, oy - 14, f'{WIDTH}"', size=12)
    dim_h(svg, dx0, dx1, yabs(15.5), f'{DOOR_W}"')
    dim_v(svg, dtop, dbot, ox + 32 * s, f'{DOOR_H}"', side="left")
    dim_v(svg, railtop, railbot, ox - 30, f'{EL_BODY}"', side="left")
    svg.text(ox - 30, railtop - EL_TOP * s / 2 + 4, f'{EL_TOP}"', size=10, anchor="end")
    svg.text(ox - 30, railbot + EL_BOT * s / 2 + 4, f'{EL_BOT}"', size=10, anchor="end")


# ---- sheet -----------------------------------------------------------------
def build_sheet(depth):
    s = SCALE
    plan_x = 110
    deck_x = 500
    top_y = 215
    plan_bottom = top_y + depth * s

    elev_y = plan_bottom + 130
    sheet_h = elev_y + EL_H * s + 60

    svg = SVG(SHEET_W, sheet_h)
    ft = depth // 12

    svg.text(SHEET_W / 2, 52, f"IceHouse 8' x {ft}'", size=30, weight="bold")
    svg.line(60, 66, SHEET_W - 60, 66, width=0.8)
    svg.text(SHEET_W / 2, 90,
             f"width fixed at 8' (96\") — depth {ft}' ({depth}\")",
             size=12, fill="#666")

    svg.text(plan_x, 150, "Wall Panels", size=20, anchor="start", weight="bold")
    svg.text(plan_x + 96 * s / 2, 168, "(top view)", size=11, fill="#666")
    svg.text(deck_x, 150, "Ceiling/Floor Panels", size=18, anchor="start",
             weight="bold")

    op0, op1 = draw_plan(svg, plan_x, top_y, depth)
    draw_deck(svg, deck_x, top_y, depth)

    svg.text(plan_x, elev_y - 44, "All Swing Door", size=18, anchor="start",
             weight="bold")
    svg.text(plan_x + 96 * s / 2, elev_y - 30, "(front view — aligned below)",
             size=11, fill="#666")
    draw_elevation(svg, plan_x, elev_y, op0, op1)

    sqft = 8 * ft
    svg.text(SHEET_W - 60, sheet_h - 20,
             f"Footprint 8' x {ft}' ({sqft} sq ft) | walls in 24\" panels, "
             f"12\" corner posts", size=11, anchor="end", fill="#555")
    return svg.svg()


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, "output")
    os.makedirs(out, exist_ok=True)
    try:
        import cairosvg
        png = True
    except ImportError:
        png = False
        print("cairosvg missing -> SVG only")

    for depth in (120, 144, 168, 192):
        name = f"IceHouse_8x{depth // 12}"
        svg_text = build_sheet(depth)
        with open(os.path.join(out, name + ".svg"), "w") as f:
            f.write(svg_text)
        print("wrote", name + ".svg")
        if png:
            cairosvg.svg2png(bytestring=svg_text.encode(),
                             write_to=os.path.join(out, name + ".png"),
                             scale=2.0, background_color="white")
            print("wrote", name + ".png")


if __name__ == "__main__":
    main()
