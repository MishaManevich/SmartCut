#!/usr/bin/env python3
"""
1:1 IceHouse cut-sheet generator by SPLICING the original 8x8 drawing.

Method: the wall ring and the ceiling are periodic in 24" (= 74 px in the
source).  Inserting whole 24"-tall bands preserves both periodic patterns,
so the original pixels (door, latches, corners, panel labels, dimension
arrows) are reused verbatim; only the depth grows.  The few numeric labels
that change (the two overall depth dimensions + the title's depth number)
are restamped in Liberation Sans, which matches the drawing's lettering.
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

SRC = "/root/.claude/uploads/77153544-0260-5ebf-8ec7-570947311b1b/6de9aecb-8x8_Box.png"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
FONT = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"

BG = (236, 234, 234)
INK = (30, 30, 30)

P = 74                      # one 24" period, in source px
BAND_Y0 = 379              # top of a clean wall panel / ceiling strip band
ARROW_RL_X = 114           # ring-left depth arrow line x  (text is left of it)
ARROW_CR_X = 901           # ceiling-right depth arrow line x (text sits on it)


def font(sz):
    return ImageFont.truetype(FONT, sz)


def make(feet):
    n = (feet - 8) // 2          # panels to add
    depth = feet * 12
    im = Image.open(SRC).convert("RGB")
    d = ImageDraw.Draw(im)

    # --- erase the two old overall depth labels (before splicing) ---
    d.rectangle([18, 472, 81, 504], fill=BG)               # ring-left "96"
    d.rectangle([876, 476, 928, 510], fill=BG)             # ceiling-right "96"
    d.line([(ARROW_CR_X, 476), (ARROW_CR_X, 510)], fill=INK, width=2)  # heal arrow

    # --- title depth number (second "8'") ---
    d.rectangle([756, 58, 838, 134], fill=BG)
    d.text((760, 97), f"{feet}'", font=font(74), fill=INK, anchor="lm")

    # --- splice: insert n clean 24" bands ---
    a = np.array(im)
    band = a[BAND_Y0:BAND_Y0 + P, :, :]
    cut = BAND_Y0 + P
    out = Image.fromarray(np.vstack([a[:cut], np.tile(band, (n, 1, 1)), a[cut:]]))

    # --- stamp new depth numbers at the new vertical centre of the ring ---
    d2 = ImageDraw.Draw(out)
    yc = 490 + n * (P // 2)                       # new ring/ceiling mid-height
    d2.text((78, yc), f'{depth}"', font=font(29), fill=INK, anchor="rm")   # ring-left
    txt = f'{depth}"'
    bb = d2.textbbox((ARROW_CR_X, yc), txt, font=font(31), anchor="mm")
    d2.rectangle([bb[0] - 2, bb[1] - 1, bb[2] + 2, bb[3] + 1], fill=BG)
    d2.text((ARROW_CR_X, yc), txt, font=font(31), fill=INK, anchor="mm")
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    pages = []
    for feet in (10, 12, 14, 16):
        img = make(feet)
        base = os.path.join(OUT, f"IceHouse_8x{feet}")
        img.save(base + ".png")
        img.save(base + ".pdf", "PDF", resolution=150)
        pages.append(img)
        print("wrote", base + ".png / .pdf", img.size)
    # combined multi-page PDF for printing / sending
    combo = os.path.join(OUT, "IceHouse_8x10-12-14-16.pdf")
    pages[0].save(combo, "PDF", resolution=150, save_all=True,
                  append_images=pages[1:])
    print("wrote", combo)


if __name__ == "__main__":
    main()
