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
regions sealed inside the drawing's own keyline, and the similarity transform
that maps their centres onto the character's eyes is solved from those two
point pairs. Finding them by keyline rather than by whiteness is what lets a
tinted pair register too — sunglasses need the same two anchors, and are the
one style where the lens must stay opaque.

The eye anchors are measured, not guessed — the centroid of eye ink across all
ten faces (five moods x two characters) sits within 8px horizontally and 16px
vertically, so one placement serves every expression and both bodies.
"""
import sys, os
import numpy as np
from PIL import Image, ImageFilter
from process_item import outside, components, morph

# Centre of each eye, not the centroid of its ink. The first attempt used the
# ink centroid and sat the glasses ~13px high, because the brow and the heavy
# upper lash line drag that centroid up above the eye itself. These come from
# the vertical extent of eye ink in a window clear of the hair (girl 394, boy
# 388) and the horizontal extent mirrored about the figure's centre at x=512.
# Both anchors share a y so the placement is level: the couple of pixels of
# difference the two eyes measure is noise, and honouring it tilts the frame.
EYE_L = (428.0, 391.0)
EYE_R = (596.0, 391.0)

# Shifts the whole frame after the anchors are solved, for the part no
# measurement settles: the eyes are geometrically centred but the face reads
# slightly turned, so a frame centred on them looks a touch right of where it
# belongs. Tuned by eye, kept separate from the measured anchors above so the
# two never get confused.
NUDGE = (-9.0, 2.0)
CANVAS = 1024
PLATE_LEVEL, PLATE_CHROMA = 242, 12
INK_LEVEL = 110        # the drawing's own keyline, used as the wall


def cut_plate(path):
    """Drawing -> RGBA with the background, and any *clear* lens, transparent.

    Lenses are found as regions sealed inside the drawing's own dark keyline,
    not as white areas. Looking for white would only ever find clear lenses,
    and sunglasses are exactly the case where the lens must stay opaque — the
    frame still has to be registered by the same two anchors.

    Which pair is the lenses is decided by shape, not size: a chunky frame can
    enclose more area than the glass it holds. The lenses are the two regions
    that are alike in area, level with each other and well apart, which no
    other pair of regions in a pair of spectacles is.
    """
    a = np.array(Image.open(path).convert("RGB")).astype(int)
    lum = a.mean(axis=2)
    chroma = a.max(axis=2) - a.min(axis=2)
    plate = (a.min(axis=2) >= PLATE_LEVEL) & (chroma <= PLATE_CHROMA)
    bg = plate & outside(~plate)

    ink = (~bg) & (lum < INK_LEVEL)
    interior = ~morph(ink, "dilate", 2)
    interior &= ~outside(morph(ink, "dilate", 2))
    lab, comps = components(interior)

    cands = []
    for cid, n in comps[:10]:
        if n < 200:
            break
        ys, xs = np.nonzero(lab == cid)
        cands.append({"cid": cid, "n": n, "x": xs.mean(), "y": ys.mean(),
                      "lum": float(np.median(lum[lab == cid]))})

    best, pair = None, None
    for i in range(len(cands)):
        for j in range(i + 1, len(cands)):
            p, q = cands[i], cands[j]
            if abs(p["y"] - q["y"]) > 25 or abs(p["x"] - q["x"]) < 100:
                continue
            ratio = min(p["n"], q["n"]) / max(p["n"], q["n"])
            if ratio < 0.7:
                continue
            score = (p["n"] + q["n"]) * ratio
            if best is None or score > best:
                best, pair = score, (p, q)

    if pair is None:
        sys.exit("FAIL: could not find two lens regions to register by. The rim "
                 "must fully enclose each lens — half-rim and rimless frames "
                 "have no enclosed region, and a gap lets it leak to the edge.")

    centres = sorted([(p["x"], p["y"]) for p in pair])

    # Clear glass drops out so the eyes show through; a tinted lens stays.
    #
    # Detection and clearing need different regions. The keyline interior above
    # is eroded 2px by the dilation that seals the walls, so clearing it would
    # leave a white ring inside each rim — measured at ~500px per pair. Clear
    # the white area itself instead, picked as the plate region that overlaps
    # the detected lens, which runs right up to the frame.
    wlab, wcomps = components(plate & ~bg)
    clear = np.zeros(lum.shape, bool)
    for p in pair:
        if p["lum"] < PLATE_LEVEL:
            print("lens is tinted (median luminance %.0f), keeping it opaque" % p["lum"])
            continue
        here = lab == p["cid"]
        for cid, _ in wcomps:
            if (wlab == cid)[here].any():
                clear |= wlab == cid
                break

    rgba = np.dstack([a, np.where(bg | clear, 0, 255)]).astype("uint8")
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

    dst = [(EYE_L[0] + NUDGE[0], EYE_L[1] + NUDGE[1]),
           (EYE_R[0] + NUDGE[0], EYE_R[1] + NUDGE[1])]
    a, b, tx, ty = similarity(centres, dst)
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
