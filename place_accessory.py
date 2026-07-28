#!/usr/bin/env python3
"""Register a standalone drawing of a face accessory onto the master canvas.

Usage:
    python3 place_accessory.py <drawing.png> <item_name>

Writes items/item_<name>.png (registered layer) and items/icon_<name>.png.

Why this exists rather than process_item.py
-------------------------------------------
Glasses drawn *on the character* cannot be extracted safely. The lens has to
come out empty so the frame floats over whichever expression is underneath,
but a render only yields an empty lens if the model left the lens pixels
untouched — and it does not. Asked for clear lenses with no glare, it still
laid a sheen across them, changing 75% of the lens area by more than the
repaint threshold. The extractor cannot tell that wash from the frame, so it
kept it, and the neutral mood's eyes were baked into the glass: every other
expression then showed 一般 eyes behind the lenses.

A standalone drawing has no eyes in it to capture. So take the drawing as the
truth and place it, instead of trying to recover it from a contaminated render.
Placement is exact rather than eyeballed: the two lens interiors are found as
enclosed white regions, and the similarity transform that maps their centres
onto the character's eyes is solved from those two point pairs.

The eye anchors are measured, not guessed — the centroid of eye ink across all
ten faces (five moods x two characters) sits within 8px horizontally and 16px
vertically, so one placement serves every expression and both bodies.
"""
import sys, os
import numpy as np
from PIL import Image, ImageFilter
from process_item import outside, components

# Centre of each eye, not the centroid of its ink. The first attempt used the
# ink centroid and sat the glasses ~13px high, because the brow and the heavy
# upper lash line drag that centroid up above the eye itself. These come from
# the vertical extent of eye ink in a window clear of the hair (girl 394, boy
# 388) and the horizontal extent mirrored about the figure's centre at x=512.
# Both anchors share a y so the placement is level: the couple of pixels of
# difference the two eyes measure is noise, and honouring it tilts the frame.
EYE_L = (428.0, 391.0)
EYE_R = (596.0, 391.0)
CANVAS = 1024
PLATE_LEVEL, PLATE_CHROMA = 242, 12


def cut_plate(path):
    """Drawing -> RGBA with the background AND the lens interiors transparent."""
    a = np.array(Image.open(path).convert("RGB")).astype(int)
    plate = (a.min(axis=2) >= PLATE_LEVEL) & ((a.max(axis=2) - a.min(axis=2)) <= PLATE_CHROMA)
    bg = plate & outside(~plate)
    enclosed = plate & ~bg          # white sealed inside the drawing = the lenses
    lab, comps = components(enclosed)

    lenses = [(cid, n) for cid, n in comps if n > 200]
    if len(lenses) < 2:
        sys.exit("FAIL: found %d enclosed regions, need 2 lenses to register by. "
                 "Is the frame drawn as closed rings?" % len(lenses))

    centres = []
    for cid, _ in lenses[:2]:
        ys, xs = np.nonzero(lab == cid)
        centres.append((xs.mean(), ys.mean()))
    centres.sort()

    rgba = np.dstack([a, np.where(bg | enclosed, 0, 255)]).astype("uint8")
    return Image.fromarray(rgba), centres


def similarity(src, dst):
    """Scale+rotation+translation taking the two src points onto the two dst."""
    (x1, y1), (x2, y2) = src
    (u1, v1), (u2, v2) = dst
    sdx, sdy = x2 - x1, y2 - y1
    ddx, ddy = u2 - u1, v2 - v1
    den = sdx * sdx + sdy * sdy
    a = (ddx * sdx + ddy * sdy) / den        # s*cos
    b = (ddy * sdx - ddx * sdy) / den        # s*sin
    return a, b, u1 - (a * x1 - b * y1), v1 - (b * x1 + a * y1)


def main(path, name):
    here = os.path.dirname(os.path.abspath(path)) or "."
    for d in ("items", "qa"):
        os.makedirs(os.path.join(here, d), exist_ok=True)

    art, centres = cut_plate(path)
    print("lens centres in the drawing: (%.0f, %.0f) and (%.0f, %.0f)"
          % (centres[0][0], centres[0][1], centres[1][0], centres[1][1]))

    a, b, tx, ty = similarity(centres, [EYE_L, EYE_R])
    scale = (a * a + b * b) ** 0.5
    print("placing: scale %.3f, rotation %.1f deg" % (scale, np.degrees(np.arctan2(b, a))))

    # PIL maps output->input, so invert the transform.
    det = a * a + b * b
    ia, ib = a / det, b / det
    inv = (ia, ib, -(ia * tx + ib * ty), -ib, ia, -(-ib * tx + ia * ty))
    placed = art.transform((CANVAS, CANVAS), Image.AFFINE, inv, resample=Image.BICUBIC)

    # 1px choke: resampling a hard alpha edge leaves a translucent fringe that
    # reads as a halo once the frame sits over skin.
    r, g, bl, al = placed.split()
    placed = Image.merge("RGBA", (r, g, bl, al.filter(ImageFilter.MinFilter(3))))
    placed.save(os.path.join(here, "items", "item_%s.png" % name))

    arr = np.array(placed)
    ys, xs = np.nonzero(arr[..., 3] > 40)
    print("registered layer: %d px, bbox x %d-%d y %d-%d"
          % (len(ys), xs.min(), xs.max(), ys.min(), ys.max()))

    pad = 8
    ia_, ja_ = np.nonzero(np.array(art)[..., 3] > 40)
    art.crop((max(0, ja_.min() - pad), max(0, ia_.min() - pad),
              min(art.width, ja_.max() + pad), min(art.height, ia_.min() + pad)
              if False else min(art.height, ia_.max() + pad))) \
       .save(os.path.join(here, "items", "icon_%s.png" % name))

    master = Image.open(os.path.join(here, "base_char_master.png")).convert("RGBA")
    Image.alpha_composite(master, placed).save(os.path.join(here, "qa", "%s_worn.png" % name))
    print("check qa/%s_worn.png" % name)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
