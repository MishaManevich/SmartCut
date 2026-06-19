#!/usr/bin/env python3
"""IceHouse 12x12 — grow BOTH width and depth of the original 8x8 by splicing.

Depth: insert 2 clean 24" rows.  Width: band-based column inserts (so text rows
are only padded, never sliced).  Then relabel the six overall 96" dims -> 144",
move the ceiling header over the shifted ceiling, and restamp the title.
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

SRC = "/root/.claude/uploads/77153544-0260-5ebf-8ec7-570947311b1b/6de9aecb-8x8_Box.png"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
FONT = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
BG = (236, 234, 234)
BGA = np.array(BG, np.uint8)
INK = (30, 30, 30)


def f(sz):
    return ImageFont.truetype(FONT, sz)


def build():
    a0 = np.array(Image.open(SRC).convert("RGB"))
    ceil_hdr = a0[208:268, 548:940].copy()          # crop header before edits

    # ---------- depth splice (+2 rows) ----------
    a = np.vstack([a0[:453], np.tile(a0[379:453], (2, 1, 1)), a0[453:]])

    # ---------- width splice (band based) ----------
    Wt = a.shape[1] + 296

    def pad(b):
        if b.shape[1] < Wt:
            b = np.hstack([b, np.tile(BGA, (b.shape[0], Wt - b.shape[1], 1))])
        return b

    def ins(b, x, sx0, sx1, m=2):
        return np.hstack([b[:, :x], np.tile(b[:, sx0:sx1], (1, m, 1)), b[:, x:]])

    RC0, RC1, D0, D1 = 276, 860, 905, 1291
    rc = ins(ins(a[RC0:RC1], 391, 317, 391), 982, 908, 982)
    dd = ins(a[D0:D1], 391, 317, 391)
    out = np.vstack([pad(a[0:RC0]), pad(rc), pad(a[RC1:D0]), pad(dd), pad(a[D1:])])

    im = Image.fromarray(out)
    d = ImageDraw.Draw(im)

    def relabel(box, text, anchor, pos, size=31, vline=None):
        d.rectangle(box, fill=BG)
        if vline:
            d.line(vline, fill=INK, width=2)
            bb = d.textbbox(pos, text, font=f(size), anchor=anchor)
            d.rectangle([bb[0] - 2, bb[1] - 1, bb[2] + 2, bb[3] + 1], fill=BG)
        d.text(pos, text, font=f(size), fill=INK, anchor=anchor)

    D = '144"'
    relabel([260, 266, 300, 289], D, "mm", (355, 277))                    # ring-top
    relabel([14, 618, 84, 654], D, "rm", (80, 564))                       # ring-left
    relabel([851, 285, 890, 309], D, "mm", (949, 297))                    # ceiling-top
    relabel([1176, 626, 1218, 662], D, "mm", (1197, 570),                 # ceiling-right
            vline=[(1197, 545), (1197, 596)])
    relabel([261, 945, 299, 965], D, "mm", (355, 955))                    # door-top

    # move ceiling header over the shifted ceiling (new centre x~949)
    d.rectangle([548, 206, 942, 270], fill=BG)
    im.paste(Image.fromarray(ceil_hdr), (949 - ceil_hdr.shape[1] // 2, 208))

    # title -> 12'x 12'
    d.rectangle([596, 56, 846, 136], fill=BG)
    d.text((610, 97), "12'x 12'", font=f(74), fill=INK, anchor="lm")
    return im


def main():
    os.makedirs(OUT, exist_ok=True)
    im = build()
    im.save(os.path.join(OUT, "IceHouse_12x12.png"))
    im.save(os.path.join(OUT, "IceHouse_12x12.pdf"), "PDF", resolution=150)
    print("wrote 12x12", im.size)


if __name__ == "__main__":
    main()
