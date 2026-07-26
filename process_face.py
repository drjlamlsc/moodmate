#!/usr/bin/env python3
"""Turn an expression render into a face patch layer.

Usage:
    python3 process_face.py <expression_render.jpeg> <mood_name>

Expressions can't be extracted the way garments are: a face edit never crosses
the body outline and isn't enclosed by its own contour. It doesn't need to be.
Everything outside the face is identical to the master, so a soft-edged patch
of the changed area drops on top invisibly — no silhouette required.

Writes:
    faces/face_<mood>.png    full-canvas layer, stacks over the master
    qa/face_<mood>_worn.png  composite on magenta
    qa/face_<mood>_patch.png the patch on green, showing its extent
"""
import sys, os
import numpy as np
from PIL import Image, ImageFilter

CANVAS = 1024
CHANGE = 30      # per-channel difference that counts as repainted
PAD = 28         # margin around the changed area, landing the edge on flat skin
FEATHER = 10     # alpha ramp, hides the slightly thinner lines of a re-render

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from process_item import flat, morph, cut_background


def main(render_path, mood, master_name="base_char_master.png"):
    here = os.path.dirname(os.path.abspath(render_path)) or "."
    for d in ("faces", "qa"):
        os.makedirs(os.path.join(here, d), exist_ok=True)

    master = Image.open(os.path.join(here, master_name)).convert("RGBA")
    render = Image.open(render_path).convert("RGBA")
    if render.size != master.size:
        sys.exit("FAIL: render is %s, master is %s." % (render.size, master.size))
    if (np.array(render)[..., 3] > 10).mean() > 0.98:
        render = cut_background(render, master)

    M = np.array(master).astype(int)
    T = np.array(render).astype(int)
    h, w = M.shape[:2]

    # Registration: the hair crown and the lower legs are untouched by a face edit.
    def bbox(a, y0, y1):
        l = flat(a).mean(axis=2)
        ys, xs = np.where(l[y0:y1] < 235)
        return xs.min(), xs.max(), ys.min() + y0, ys.max() + y0
    drift = 0
    for label, (y0, y1) in (("hair crown", (100, 300)), ("lower legs", (820, CANVAS))):
        d = max(abs(a - b) for a, b in zip(bbox(M, y0, y1), bbox(T, y0, y1)))
        drift = max(drift, d)
        print("registration drift (%s): %dpx" % (label, d))
    if drift > 6:
        sys.exit("FAIL: the model moved or redrew the figure. Re-roll this render.")

    diff = np.abs(flat(M) - flat(T)).max(axis=2)
    changed = morph(morph(diff > CHANGE, "erode", 2), "dilate", 2)
    if changed.sum() < 200:
        sys.exit("FAIL: nothing changed. Is this the same image as the master?")

    ys, xs = np.where(changed)
    x0, x1 = max(0, xs.min() - PAD), min(w, xs.max() + PAD)
    y0, y1 = max(0, ys.min() - PAD), min(h, ys.max() + PAD)
    print("changed area: x%d-%d y%d-%d -> patch %dx%d"
          % (xs.min(), xs.max(), ys.min(), ys.max(), x1 - x0, y1 - y0))
    if (y1 - y0) > 0.6 * h or (x1 - x0) > 0.8 * w:
        print("  WARNING: the change covers most of the figure. The model probably "
              "repainted more than the face — check qa/face_%s_patch.png." % mood)

    alpha = np.zeros((h, w), float)
    alpha[y0:y1, x0:x1] = 255.0
    patch = Image.fromarray(alpha.astype("uint8")).filter(ImageFilter.GaussianBlur(FEATHER))
    alpha = np.array(patch).astype(int)

    out = T.copy()
    out[..., 3] = np.minimum(T[..., 3], alpha)
    layer = Image.fromarray(out.astype("uint8"))
    layer.save(os.path.join(here, "faces", "face_%s.png" % mood))

    worn = Image.alpha_composite(master, layer)
    Image.alpha_composite(Image.new("RGBA", (w, h), (255, 0, 255, 255)), worn) \
         .save(os.path.join(here, "qa", "face_%s_worn.png" % mood))
    Image.alpha_composite(Image.new("RGBA", (w, h), (20, 120, 60, 255)), layer) \
         .save(os.path.join(here, "qa", "face_%s_patch.png" % mood))

    err = np.abs(flat(np.array(worn).astype(int)) - flat(T)).max(axis=2)
    print("worn vs render: mean %.2f, >60 on %.3f%% of pixels" %
          (err.mean(), (err > 60).mean() * 100))


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    # Third argument is the master to diff against, for a second character.
    main(*sys.argv[1:4])
