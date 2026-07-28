#!/usr/bin/env python3
"""Turn a dressed render into a registered item layer + shop icon.

Usage:
    python3 process_item.py <render.png> <item_name> [master.png] [dark_level]

Expects base_char_master.png alongside it. Writes:
    items/item_<name>.png        registered layer, drops onto the master
    items/icon_<name>.png        cropped standalone icon
    qa/<name>_worn.png           composite on magenta, for eyeballing
    qa/<name>_alone.png          layer on green, shows stray pixels

Every step is deterministic. If a check fails it says so loudly rather
than writing a quietly broken asset.
"""
import sys, os, json
from collections import deque
import numpy as np
from PIL import Image, ImageFilter

CANVAS = 1024
MIN_REGION = 60         # ignore specks; the share test below rejects the rest.
                        # Not larger: a sailor collar broken up by overlapping hair,
                        # or a neckerchief bow, arrives as several sub-500px regions.
DARK = 115              # starting luminance for "this is line art"
DARK_FLOOR = 45         # never go below this looking for a better threshold
DARK_SHARE = 0.30       # line art is a minority of a figure; more than this
                        # means the threshold has swallowed a dark garment.
                        # Measured over 21 renders: normal ones sit at
                        # 0.19-0.26, the navy gakuran at 0.37. Clear gap.
SEED_OVERLAP = 100      # seed pixels a region needs to count as part of the item
UNDER_FILL_PAD = 5      # rows kept below an item's fill, for its own outline
REPAINT = 15            # a pixel differing by more than this counts as repainted
REPAINT_SHARE = 0.25    # and this share of a region must be repainted to be item
                        # Measured across three items that pin this from both sides:
                        #   hoodie  items 98-99%   untouched 0-0.7%
                        #   plaid   items 91-99%   legs 18-20% (a hem clips the leg tops)
                        #   sailor  blouse 37%     untouched 0.3-14.5% (white on white)
                        # A median test passes the first two and drops the sailor blouse;
                        # a mean test keeps the plaid's legs. This threshold clears both.


def flat(a):
    """Composite RGBA (as int array) over white, so alpha differences show up."""
    al = a[..., 3:4] / 255.0
    return a[..., :3] * al + 255 * (1 - al)


def morph(mask, op, r):
    f = ImageFilter.MaxFilter if op == "dilate" else ImageFilter.MinFilter
    im = Image.fromarray((mask * 255).astype("uint8")).filter(f(2 * r + 1))
    return np.array(im) > 127


def components(mask):
    """Label 4-connected regions; returns (labels, [(id, size), ...] biggest first)."""
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    out, cur = [], 0
    ys, xs = np.where(mask)
    for y, x in zip(ys, xs):
        if lab[y, x]:
            continue
        cur += 1
        lab[y, x] = cur
        dq, n = deque([(y, x)]), 0
        while dq:
            cy, cx = dq.popleft()
            n += 1
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not lab[ny, nx]:
                    lab[ny, nx] = cur
                    dq.append((ny, nx))
        out.append((cur, n))
    out.sort(key=lambda kv: -kv[1])
    return lab, out


def outside(mask):
    """Everything reachable from the canvas border without crossing mask."""
    h, w = mask.shape
    free = ~mask
    vis = np.zeros((h, w), bool)
    dq = deque()
    for x in range(w):
        for y in (0, h - 1):
            if free[y, x] and not vis[y, x]:
                vis[y, x] = True
                dq.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if free[y, x] and not vis[y, x]:
                vis[y, x] = True
                dq.append((y, x))
    while dq:
        cy, cx = dq.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = cy + dy, cx + dx
            if 0 <= ny < h and 0 <= nx < w and free[ny, nx] and not vis[ny, nx]:
                vis[ny, nx] = True
                dq.append((ny, nx))
    return vis


def cut_background(render, master, level=242, chroma=12):
    """Drop the white plate the model renders on, and return RGBA.

    Brightness alone can't identify the plate: this palette's lightest pastels
    sit around 240 luminance, so a brightness test floods straight through a
    hat brim. The plate is also *neutral*, while every pastel here carries a
    few levels of chroma, so require both. The tolerance is loose enough to
    survive JPEG, which shifts edge pixels by several levels.

    The outer background is whatever plate is reachable from the canvas edge.
    Plate pockets sealed inside the drawing (between hair and shoulder, say)
    are judged against the master: transparent there means it's a real gap in
    the silhouette, opaque means it's part of the artwork and must be kept.
    """
    a = np.array(render.convert("RGBA")).astype(int)
    rgb = a[..., :3]
    near_white = (rgb.min(axis=2) >= level) & ((rgb.max(axis=2) - rgb.min(axis=2)) <= chroma)

    bg = near_white & outside(~near_white)
    pockets = near_white & ~bg
    plab, pcomps = components(pockets)
    ma = np.array(master.convert("RGBA"))[..., 3]
    dropped = 0
    for cid, n in pcomps:
        if n < 40:
            continue
        reg = plab == cid
        if (ma[reg] <= 10).mean() > 0.8:   # master is empty here too: a real gap
            bg |= reg
            dropped += n
    print("background: %d px outer, %d px sealed pockets" % (int(bg.sum()) - dropped, dropped))

    a[..., 3] = np.where(bg, 0, 255)
    return Image.fromarray(a.astype("uint8"))


def standalone_icon(path, level=242, chroma=12, pad=8):
    """Cut the plate from a lone drawing of an item and crop it to fit.

    No master to diff against here, so the plate is simply whatever white is
    reachable from the canvas edge. Anything sealed inside the drawing — the
    lit inside of a hat's crown, a gap under a brim — stays, since on a lone
    item those are always artwork rather than background.
    """
    im = Image.open(path).convert("RGBA")
    a = np.array(im).astype(int)
    rgb = a[..., :3]
    plate = (rgb.min(axis=2) >= level) & ((rgb.max(axis=2) - rgb.min(axis=2)) <= chroma)
    bg = plate & outside(~plate)
    a[..., 3] = np.where(bg, 0, 255)
    im = Image.fromarray(a.astype("uint8"))
    # Same 1px choke as the worn layers: a colour-threshold cut always leaves a
    # light fringe, which reads as a halo once the icon sits on a tinted card.
    r, g, b, al = im.split()
    im = Image.merge("RGBA", (r, g, b, al.filter(ImageFilter.MinFilter(3))))
    ys, xs = np.where(np.array(im)[..., 3] > 10)
    if not len(ys):
        sys.exit("FAIL: supplied icon %s is blank after cutting its plate." % path)
    return im.crop((max(0, xs.min() - pad), max(0, ys.min() - pad),
                    min(im.width, xs.max() + pad), min(im.height, ys.max() + pad)))


def main(render_path, name, master_name="base_char_master.png", dark_override=None):
    here = os.path.dirname(os.path.abspath(render_path)) or "."
    master_path = os.path.join(here, master_name)
    for d in ("items", "qa"):
        os.makedirs(os.path.join(here, d), exist_ok=True)

    master = Image.open(master_path).convert("RGBA")
    render = Image.open(render_path).convert("RGBA")
    if render.size != master.size:
        sys.exit("FAIL: render is %s, master is %s. Never crop or resize a render."
                 % (render.size, master.size))

    # Models render on an opaque white plate, so cut it ourselves. If the file
    # already carries real transparency it has been cut elsewhere; leave it be.
    if (np.array(render)[..., 3] > 10).mean() > 0.98:
        render = cut_background(render, master)
    else:
        print("background: already transparent, left alone")

    # Cutting on a colour threshold leaves a ~2px light fringe; erode it away.
    # Keep the pre-erosion extent: the garment has to be grown back to it at the
    # end, or the base pokes out from under hems and cuffs by a pixel or two.
    reach = np.array(render)[..., 3] > 10
    r, g, b, al = render.split()
    render = Image.merge("RGBA", (r, g, b, al.filter(ImageFilter.MinFilter(3))))

    M = np.array(master).astype(int)
    T = np.array(render).astype(int)
    h, w = M.shape[:2]
    lum = T[..., :3].mean(axis=2)
    opaque = T[..., 3] > 10

    # --- registration check ---
    # Measured on bands no garment reaches: the lower legs and the head. A hem
    # or sleeve hanging into the band reads as drift when nothing has moved.
    def bbox(arr, y0, y1):
        l = flat(arr).mean(axis=2)
        ys, xs = np.where(l[y0:y1] < 235)
        return xs.min(), xs.max(), ys.min() + y0, ys.max() + y0

    # No single band is safe for every item: trousers cover the legs, a hat
    # fills the head band, a hood touches both. So measure several and trust
    # the smallest. An item disturbs one or two bands; a model that actually
    # moved the figure shifts all of them, and the minimum climbs with it.
    bands = (("head", 100, 300), ("face", 330, 470), ("lower legs", 820, CANVAS))
    drifts = []
    for label, y0, y1 in bands:
        mb, tb = bbox(M, y0, y1), bbox(T, y0, y1)
        drifts.append((max(abs(a - b) for a, b in zip(mb, tb)), label))
    drift, quietest = min(drifts)
    print("registration drift: %s   → %dpx (%s)"
          % ("  ".join("%s %dpx" % (l, d) for d, l in drifts), drift, quietest))
    if drift > 6:
        print("  WARNING: the model moved or redrew the figure. Re-roll this render.")

    diff = np.abs(flat(M) - flat(T)).max(axis=2)

    # Line art is a thin minority of any figure. A fixed threshold assumes the
    # garment is lighter than the outlines, which fails on dark clothing: a navy
    # jacket sits at luminance 75, so DARK=115 labelled 36%% of the figure as
    # "outline" and left no interior to fill. Lower the threshold until the dark
    # share looks like line art again.
    figure = max(1, int(opaque.sum()))
    if dark_override:
        # The share test only knows the threshold is too high, not how far to
        # drop it. A very dark garment with darker shading still reads as line
        # art after the automatic step, so it takes an explicit value.
        dark_level = int(dark_override)
        print("line-art threshold set to %d (explicit)" % dark_level)
    else:
        dark_level = DARK
        while dark_level > DARK_FLOOR and (opaque & (lum < dark_level)).sum() / figure > DARK_SHARE:
            dark_level -= 10
        if dark_level != DARK:
            print("line-art threshold lowered to %d (dark garment)" % dark_level)

    # --- thin accessories take a different route entirely ---
    # Everything below assumes an item encloses fill of its own. Glasses do not:
    # they are a closed ring around base that stays visible through the lens.
    # Run as a garment the contour fill enclosed the whole face, the
    # base-showing-through test then dropped it as unchanged, and 24034px of
    # kept region became a 0px layer.
    #
    # For these the item simply *is* what changed — which is also what makes the
    # lens work, since untouched pixels inside the rim stay out of the layer and
    # the frame floats over whichever expression is beneath. The corollary is
    # that the render must leave the lenses alone: any tint or glare counts as a
    # change and would bake one mood's eyes into the glasses.
    if name in ACCESSORIES:
        mask = opaque & (diff > REPAINT)
        mask = morph(morph(mask, "dilate", 1), "erode", 1) & opaque
        mask = morph(mask, "dilate", 1) & reach
        print("accessory mode: %d px changed" % int(mask.sum()))
    else:
        # --- exact silhouette: fill the item's own closed contour ---
        # The character's own line art also encloses regions (face, hair), so a seed
        # decides which enclosed regions belong to the item. The only reliable seed
        # is pixels the item added *outside* the old silhouette: colour-based seeds
        # leak, because the re-render shifts every outline enough to look "changed".
        seed = morph(opaque & (M[..., 3] <= 10), "dilate", 3)

        dark = opaque & (lum < dark_level)
        sealed = morph(dark, "dilate", 2)
        interior = ~sealed & ~outside(sealed)
        ilab, icomps = components(interior)
        body = np.zeros((h, w), bool)
        kept = []
        for cid, n in icomps:
            if n < MIN_REGION:
                continue
            reg = ilab == cid
            # A region belongs to the item if the item pushed it outside the old
            # silhouette (sleeves, a hat brim), or if its artwork was repainted.
            # Untouched regions barely move at all, so the margin is enormous; a
            # slim garment whose torso stays inside the body outline is caught by
            # the second test alone.
            if (seed & reg).sum() < SEED_OVERLAP and (diff[reg] > REPAINT).mean() < REPAINT_SHARE:
                continue
            body |= reg
            kept.append(n)
        print("enclosed regions kept: %s" % kept)
        if not kept:
            sys.exit("FAIL: found no item regions. Either the render is identical to "
                     "the master, or the item's outline has a gap and leaked.")

        if body.sum() > 0.4 * h * w:
            sys.exit("FAIL: contour fill leaked — the item outline has a gap. "
                     "Patch the gap in the render, or re-roll it.")
        else:
            # 6px is a measured compromise. A thick outline outruns it — the
            # wide-leg jeans' 9px contour, a sun hat's brim edge — and two earlier
            # attempts to reclaim that generally both failed badly: growing through
            # *repainted* pixels crawls the whole figure, since a re-render shifts
            # every base outline enough to qualify (all 23 items inflated, sailor
            # +34%), and growing through *dark* pixels fails the same way because
            # the character's own outline is dark and touches the garment's
            # (sailor +30%). Both tried to tell item art from character art by
            # appearance, which is exactly what cannot be done.
            near = morph(body, "dilate", 6)
            mask = body | (dark & near)

            # Outside the old silhouette there is no character art to confuse it
            # with: anything drawn out there is the new item, whatever it looks
            # like. So take whole connected pieces of it that touch what we already
            # have. This is a statement about geometry rather than appearance,
            # which is why it can be applied safely where the other two could not.
            # The master is dilated first so a render that shifted an outline by a
            # pixel doesn't hand us the character's own edge.
            outer = opaque & ~morph(M[..., 3] > 10, "dilate", 4)
            olab, ocomps = components(outer)
            grabbed = 0
            touching = morph(mask, "dilate", 2)
            for cid, n in ocomps:
                reg = olab == cid
                if (reg & touching).any():
                    mask |= reg
                    grabbed += n
            if grabbed:
                print("outside-silhouette pieces reclaimed: %d px" % grabbed)

            # Dark fill the wall swallowed. `dark` does double duty: it marks
            # line art *and* it is the seal that stops the contour fill leaking.
            # So a part of a garment painted darker than the garment it belongs
            # to — the gakuran's collar at luminance 40 against its own body at
            # 75 — is sealed rather than filled, and only the 6px `near` margin
            # rescues any of it. Lowering the threshold is not the answer: it
            # thins the seal, and at 40 this jacket's fill escaped into the
            # figure and took the whole head with it, 45k px to 155k.
            #
            # What separates that fill from the character's own dark art is not
            # how it looks — that is the test which failed twice before — but
            # what it covers. The hair is dark in the master too; the collar was
            # painted over light skin. So take dark that is *newly* dark and
            # repainted, in whole connected pieces touching what we already
            # have. The master is dilated first so an outline that shifted by a
            # pixel doesn't read as newly dark along its whole length — by the
            # drift actually measured above rather than a fixed guess, since
            # that margin is pure loss: a collar rising under a chin sits within
            # a few pixels of the jaw outline, and at a flat 3px that outline's
            # halo swallowed 89% of it.
            was_dark = flat(M).mean(axis=2) < dark_level
            slack = max(1, min(int(drift), 3))
            fresh = dark & ~morph(was_dark, "dilate", slack) & (diff > REPAINT)
            flab, fcomps = components(fresh)
            regained = 0
            reachable = morph(mask, "dilate", 2)
            for cid, n in fcomps:
                if n < 150:
                    break
                reg = flab == cid
                if (reg & reachable).any():
                    mask |= reg
                    regained += n
            if regained:
                print("dark fill reclaimed from the seal: %d px" % regained)

            mask = morph(morph(mask, "dilate", 2), "erode", 2) & opaque
            mask = morph(mask, "dilate", 2) & reach   # back out to the drawn edge

            # Thin details enclosed by the item's own linework (drawstrings, seams)
            # fall under MIN_REGION and leave pinholes. Fill the small ones; leave
            # big ones alone, since those are real gaps like a collar notch.
            hlab, hcomps = components(~mask & ~outside(mask))
            for cid, n in hcomps:
                if n < 400:
                    mask |= hlab == cid

    # Drop the character showing through. Adding the item's contour drags in
    # whatever it touches: a chunk of hair beside a collar, the neck inside a
    # neckline, a hand below a cuff. Such areas are unchanged from the master,
    # so they read as near-zero difference while real garment pixels don't.
    #
    # Only whole detached pieces are judged here. Leakage *fused* to the
    # garment (the neck inside a collar) is deliberately left alone: measured
    # on real assets, the sailor's blouse over the white camisole differs from
    # the master by a median of 7 while the sweater's neck differs by 9, so the
    # garment we must keep looks *more* like the base than the leak we'd remove.
    # Any threshold that removes one destroys the other. It is harmless when
    # worn — those pixels sit exactly over identical base pixels — and shows up
    # only in the standalone icon, so fix it there rather than here.
    mlab, mcomps = components(mask)
    dropped = []
    for cid, n in mcomps:
        piece = mlab == cid
        med = np.median(diff[piece])
        if med < REPAINT:
            mask &= ~piece
            dropped.append(("piece", n, float(med)))

    if dropped:
        print("removed base showing through: %s"
              % ", ".join("%s %dpx" % (k, n) for k, n, _ in dropped))

    if mask.sum() < 500:
        sys.exit("FAIL: extracted item is only %d px. Check the render." % mask.sum())

    # The icon gets cleanup the worn layer usually doesn't need. Debris fused to
    # the garment — a neck inside a collar, hair beside a shoulder, a stray
    # corner the model drew — is invisible once worn but obvious on a closet
    # card, and can't be identified automatically (see above). icon_cuts.json
    # names those boxes by hand and they erase everything inside, since the
    # debris isn't always base-coloured: draw them tight and check afterwards.
    #
    # "target": "both" also cuts the worn layer. Needed when debris is only
    # hidden by the character it was extracted from: the sailor blouse carries a
    # white chip off its left shoulder that the girl's long hair covers
    # completely and the boy's short hair does not. Default stays "icon",
    # because cutting the worn layer is destructive and shared by both bodies.
    icon_mask = mask.copy()
    cut_layer = False
    cuts_path = os.path.join(here, "icon_cuts.json")
    if os.path.exists(cuts_path):
        with open(cuts_path) as f:
            cuts = json.load(f).get(name, [])
        for cut in cuts:
            x0, y0, x1, y1 = cut["box"]
            mode = cut.get("mode", "identical")
            box = np.zeros((h, w), bool)
            box[y0:y1, x0:x1] = True
            # "identical" erases only what matches the master, so the box can be
            # generous without eating the garment — right for a neck inside a
            # collar. "all" erases everything, needed where the debris is drawn
            # rather than shown through, and must be kept tight.
            gone = icon_mask & box
            if mode == "identical":
                gone &= (diff < REPAINT) & (M[..., 3] > 10)
            elif mode == "lighter":
                # A dark hat over light hair separates by luminance where no
                # rectangle can: the brim is a curve, the hair hangs through it.
                gone &= lum >= cut.get("level", 140)
            elif mode == "under_fill":
                # Keep the item's own silhouette, drop whatever hangs below it.
                # A hat's brim is a curve, so no rectangle can separate it from
                # the hair underneath; this follows the shape column by column.
                # "Solid" means it survives an opening: a cap is a broad shape,
                # loose hair strands are a few pixels wide and disappear.
                solid = morph(morph(icon_mask, "erode", 3), "dilate", 3)
                gone = icon_mask & box & ~solid          # the strands themselves
                for x in range(x0, x1):
                    col = np.where(solid[:, x])[0]
                    if not len(col):
                        continue
                    cut_from = min(h, col.max() + 1 + UNDER_FILL_PAD)
                    gone[cut_from:, x] |= icon_mask[cut_from:, x]
            icon_mask &= ~gone
            where = cut.get("target", "icon")
            if where == "both":
                mask &= ~gone
                cut_layer = True
            print("%s cut %s %s removed %dpx"
                  % (where, mode, cut["box"], int(gone.sum())))

    # Cuts can leave the debris's own outline behind as loose specks; drop any
    # piece that is now disconnected from the item's body.
    ilab, icomps = components(icon_mask)
    if icomps:
        biggest = icomps[0][1]
        for cid, n in icomps[1:]:
            if n < biggest * 0.15:
                icon_mask &= ~(ilab == cid)

    # Written here, after the cuts, so a "both" cut reaches the worn layer. The
    # stranded-speck sweep runs only if such a cut actually fired: applied
    # unconditionally it deleted the flower crown's separate blossoms, which are
    # detached by design and 2706px of a legitimate item.
    if cut_layer:
        llab, lcomps = components(mask)
        if lcomps:
            biggest = lcomps[0][1]
            for cid, n in lcomps[1:]:
                if n < biggest * 0.15:
                    mask &= ~(llab == cid)
    # A hem is where a garment stops, but a render does not stop drawing there:
    # below it the legs and feet get redrawn, close to the master but not equal
    # to it, and those pixels come into the layer. They cost nothing while the
    # feet are bare — they repaint the same feet — but a garment layer sits at
    # z=20 and a shoe at z=5, so redrawn feet cover the shoe underneath. Cutting
    # the layer a few pixels below the hem hands the feet back to the base,
    # where footwear can reach them.
    if name in HEM_TRIM:
        cut = HEM_TRIM[name]
        dropped = int(mask[cut:].sum())
        mask[cut:] = False
        print("hem trim: dropped %d px below y=%d" % (dropped, cut))

    out = T.copy()
    out[..., 3] = np.where(mask, T[..., 3], 0)
    layer = Image.fromarray(out.astype("uint8"))
    layer.save(os.path.join(here, "items", "item_%s.png" % name))

    # A standalone drawing of the garment, if one was supplied beside the
    # render as <render>_icon.png, beats anything derivable from the worn
    # figure. Some items can't produce a clean icon at all: a brim's curve
    # can't be separated from the hair beneath it by any rectangle or
    # threshold, which is why the beanie and the baseball cap both needed
    # hand-placed cuts. A separate drawing has no hair in it to begin with.
    supplied = os.path.splitext(render_path)[0] + "_icon.png"
    if os.path.exists(supplied):
        icon = standalone_icon(supplied)
        print("icon: used supplied %s" % os.path.basename(supplied))
    else:
        icon_rgba = T.copy()
        icon_rgba[..., 3] = np.where(icon_mask, T[..., 3], 0)
        ys, xs = np.where(icon_mask)
        pad = 8
        icon = Image.fromarray(icon_rgba.astype("uint8")).crop(
            (max(0, xs.min() - pad), max(0, ys.min() - pad),
             min(w, xs.max() + pad), min(h, ys.max() + pad)))
    icon.save(os.path.join(here, "items", "icon_%s.png" % name))

    worn = Image.alpha_composite(master, layer)
    Image.alpha_composite(Image.new("RGBA", (w, h), (255, 0, 255, 255)), worn) \
         .save(os.path.join(here, "qa", "%s_worn.png" % name))
    Image.alpha_composite(Image.new("RGBA", (w, h), (20, 120, 60, 255)), layer) \
         .save(os.path.join(here, "qa", "%s_alone.png" % name))

    err = np.abs(flat(np.array(worn).astype(int)) - flat(T)).max(axis=2)
    print("item %d px, icon %s" % (mask.sum(), icon.size))
    print("worn vs render: mean %.2f, >60 on %.3f%% of pixels" %
          (err.mean(), (err > 60).mean() * 100))
    print("check qa/%s_alone.png for stray pixels." % name)


# Items whose line art the self-tuning threshold cannot find on its own, with
# the value that was measured to work. Recorded here because it is not
# recoverable from the output: reprocessing the navy gakuran without it silently
# yields 26863px instead of 44606px — a valid-looking layer missing a third of
# the jacket.
#
# The sailor blouse is the subtler case, and it shipped broken for weeks. Only
# part of it is dark: the navy collar sits at luminance 73 and the red
# neckerchief at 113, both under DARK's 115, so both were read as line art
# rather than fill and 96% of the collar was dropped. The self-tuning loop never
# fires because they are small next to the whole figure — 24.5% of it, under the
# 30% that would trip DARK_SHARE. A garment can therefore be mostly light and
# still need an override; what matters is whether any *fill* falls below the
# threshold, not how dark the garment is overall. 55 sits clear of the real line
# art, whose median is 29.
#
# The navy tie is the same failure a third time: median 59, kept 43%, and the
# figure only 23.2% below the threshold so the loop stays quiet. Three items in,
# the pattern is clear enough to check for rather than wait for: measure what
# share of each render's *coloured* dark area (dark, but too chromatic to be
# ink) survives into the layer. Auditing all 21 that way found these three and
# nothing else — the rest of the low scores are shading that falls on the
# character, such as hair under a brim, and is excluded correctly.
# Long garments, and the row a few pixels below where each one's own fabric
# stops: yukata 897, its male render 890, the sundress's skirt 838. Measured
# from the fabric's own colour rather than guessed, and set low enough to keep
# the hem's outline, which is drawn below the last fabric pixel.
HEM_TRIM = {"yukata": 903, "yukata_male": 896, "sundress": 842}

ACCESSORIES = {"roundglasses"}

DARK_OVERRIDES = {"male_gakuran": 55, "sailor": 55, "male_tie_shirt": 55,
                  # Her navy fill sits at luminance 50, and the automatic step
                  # stops at 65 because the dark share falls below its limit
                  # there — so the fill was still counted as line art and the
                  # trousers came out full of holes. His render is lighter and
                  # the automatic step handles it, hence only hers is listed.
                  "gakuran_pants": 50,
                  # Fourth navy garment, same story, and this one fails loudly
                  # rather than quietly: the automatic step lowers itself to 105,
                  # still above the fill at 93, and the run aborts with no item
                  # regions at all. The gap it has to land in is wide — the real
                  # ink's 95th percentile is 40, the navy's 5th is 63.
                  "skirt_navy": 50,
                  # Darker navy than the skirt's, and the gap is correspondingly
                  # tighter: ink's 95th percentile is 43 against the fabric's 5th
                  # at 59, with a clear trough between them at 50-60. Both bodies
                  # measure the same, so both take the same value. Over 40% of
                  # each figure sits below the default threshold — the automatic
                  # step would fire here, which is exactly why it is pinned.
                  "yukata": 50, "yukata_male": 50}


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4, 5):
        sys.exit(__doc__)
    # 3rd arg: master to extract against, for a second character.
    # 4th arg: line-art luminance, for garments darker than the outlines.
    argv = list(sys.argv[1:5])
    if len(argv) < 4 and argv[1] in DARK_OVERRIDES:
        argv = (argv + [None] * 3)[:3] + [DARK_OVERRIDES[argv[1]]]
        argv[2] = argv[2] or "base_char_master.png"
    main(*argv)
