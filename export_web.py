#!/usr/bin/env python3
"""Export the 1024px masters as web-ready assets plus a manifest.

Usage:
    python3 export_web.py

Reads base_char_master.png, faces/face_*.png and items/item_*.png, writes
web/assets/*.png at display resolution along with web/assets/items.json.

The masters stay 1024px because that is the registration canvas every asset
was extracted against. The app never needs that: the character renders at a
few hundred CSS pixels, so shipping 1024px costs load time for nothing.
Layers are downscaled together, by the same factor, so they stay aligned.
"""
import json, os, shutil, hashlib, re
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "web", "assets")
CHAR_PX = 512      # character layers, 2x the largest on-screen size
ICON_PX = 192      # closet thumbnails

# slot -> draw order. Bottom garments first, then tops, then the face, then
# anything on the head. The face sits above tops so a high collar can never
# cover it, and below hats so a brim falls over the brow correctly.
# face_acc sits above the expression so a frame draws over the eyes, and
# below hats so a brim still falls in front of it.
# Shoes sit below bottoms, not above: a long trouser leg falls over the top of
# a shoe, and drawing the shoe over the hem would put the foot outside the
# trouser. Skirts and shorts end well above the ankle, so nothing is lost.
SLOTS = {"shoes": 5, "bottom": 10, "top": 20, "face": 30, "face_acc": 35, "hat": 40}

# Two characters, same canvas and registration. Each item may have art per
# character; where it doesn't, see FITS_BOTH below.
CHARACTERS = [
    ("girl", "Girl", "女生", "base_char_master.png",      "base.png",      ""),
    ("boy",  "Boy",  "男生", "base_char_male_master.png", "base_male.png", "male_"),
]

# Every shared item is offered to every character. Where a character has no art
# of its own, it borrows the other's: bottoms fit properly (the two bodies were
# measured to share a hip line), while tops and hats are drawn to a specific
# body and hairline, so a borrowed one sits a little wide and may show a gap
# where the original character's hair used to be. Add per-character art —
# item_<name>_male.png — and it takes over automatically, no config change.
FITS_BOTH = {"bottom", "top", "hat", "face_acc"}

# unlockAt is the number of entries needed before an item can be worn. The
# starter set is all 0 — everything available from day one. The gating still
# works, so later drops can be earned by keeping a streak going.
# name, slot, label, label_zh, unlock, exclusive-to (omitted = both characters)
# Exclusivity is a content choice, not a technical one: any item renders on any
# body. The male_-prefixed items are named after the body they were drawn on,
# not a restriction: they sit a little narrow on the girl, but she can wear
# them. Only the sundress is actually exclusive.
#
# The order below is the order the closet shows, one slot at a time, and it was
# arranged by hand rather than by name or by date added — so a new item belongs
# where it looks right among its neighbours, not simply at the end.
ITEMS = [
    ("hoodie",          "top",    "Cosy Hoodie",        "舒適衛衣",       0),
    ("cardigan",        "top",    "Knit Cardigan",      "針織開衫",       0),
    ("sweater",         "top",    "Striped Sweater",    "條紋毛衣",       0),
    ("turtleneck",      "top",    "Turtleneck",         "樽領毛衣",       0),
    ("denim_jacket",    "top",    "Denim Jacket",       "牛仔外套",       0),
    ("male_bomber",     "top",    "Bomber Jacket",      "飛行外套",       0),
    ("sailor",          "top",    "Sailor Blouse",      "水手服上衣",     0),
    ("male_tie_shirt",  "top",    "Shirt & Tie",        "恤衫領呔",       0),
    ("male_gakuran",    "top",    "Gakuran Jacket",     "學生外套",       0),
    ("croptop",         "top",    "Crop Tee",           "短版T恤",        0),
    ("sundress",        "top",    "Sunflower Sundress", "向日葵洋裝",     0, "girl"),
    ("skirt_pleated",   "bottom", "Pleated Skirt",      "百褶裙",         0),
    ("skirt_plaid",     "bottom", "Plaid Skirt",        "格仔裙",         0),
    ("joggers",         "bottom", "Joggers",            "束腳運動褲",     0),
    ("denim_shorts",    "bottom", "Denim Shorts",       "牛仔短褲",       0),
    ("jeans",           "bottom", "Wide-Leg Jeans",     "闊腳牛仔褲",     0),
    ("chino_shorts",    "bottom", "Chino Shorts",       "卡其短褲",       0),
    ("skirt_corduroy",  "bottom", "Corduroy Skirt",     "燈芯絨裙",       0),
    ("cargo_pants",     "bottom", "Cargo Pants",        "工裝褲",         0),
    ("gakuran_pants",   "bottom", "Uniform Trousers",   "學生褲",         0),
    ("pyjama_pants",    "bottom", "Pyjama Pants",       "睡褲",           0),
    ("roundglasses",    "face_acc", "Round Glasses",    "圓框眼鏡",       0),
    ("squareglasses",   "face_acc", "Square Glasses",   "方框眼鏡",       0),
    ("heartglasses",    "face_acc", "Heart Glasses",    "心形眼鏡",       0),
    ("sunglasses",      "face_acc", "Sunglasses",       "太陽眼鏡",       0),
    ("beanie",          "hat",    "Pom-Pom Beanie",     "毛球冷帽",       0),
    ("beret",           "hat",    "Rose Beret",         "玫瑰貝雷帽",     0),
    ("male_cap",        "hat",    "Baseball Cap",       "棒球帽",         0),
    ("flower_crown",    "hat",    "Flower Crown",       "雛菊花環",       0),
    ("star_clips",      "hat",    "Star Clips",         "星星髮夾",       0),
    ("bucket_hat",      "hat",    "Bucket Hat",         "漁夫帽",         0),
    ("straw_hat",       "hat",    "Straw Sun Hat",      "草帽",           0),
    ("headphones",      "hat",    "Headphones",         "耳機",           0),
    ("bow",             "hat",    "Ribbon Bow",         "緞帶蝴蝶結",     0),
    ("cat_ears",        "hat",    "Cat Ears",           "貓耳髮箍",       0),
]

# A dress is one garment covering both halves of the body, but there is no dress
# slot: it lives in `top` so it composites over anything in `bottom`. Listed
# here, it also suppresses the bottom entirely — otherwise trouser legs run out
# below the hem. The closet greys that section out while one is worn.
COVERS_BOTTOM = {"sundress"}

MOODS = [
    # key      label     face layer (None = master's own face)  colour   zh
    ("awful",  "Awful",  "face_awful",  "#e0574f", "好差"),   # red
    ("bad",    "Bad",    "face_bad",    "#ee8b3c", "唔好"),   # orange
    ("meh",    "Meh",    None,          "#d9b02c", "一般"),   # yellow, darkened
                                                              # so it still reads
                                                              # on white
    ("good",   "Good",   "face_good",   "#8ab534", "唔錯"),   # lime
    ("rad",    "Rad",    "face_happy",  "#3ea56a", "超正"),   # green
]


def save(img, path, px):
    im = img.copy()
    im.thumbnail((px, px), Image.LANCZOS)
    im.save(path, optimize=True)
    return im.size


# Luminance cuts splitting the hair into shadow / main bulk / highlight, which
# is how it is drawn. Measured from the masters: each character's histogram has
# three tight spikes with empty gaps between them, so these sit in the gaps and
# nothing lands on a boundary. Re-measure if the base art is ever redrawn.
#   girl  shadow 145-165   bulk 205-220   highlight 240-255
#   boy   shadow 120-145   bulk 175-190   highlight 220-240
HAIR_BANDS = {"girl": [185, 232], "boy": [160, 205]}


def write_hair_mask(mask, art_path, out_path):
    """Resize a 1024px hair mask to match the exported art, and close the fringe.

    The art is resampled to CHAR_PX with LANCZOS, which overshoots *lighter*
    beside a dark line — pixels next to the hair's outlines come out at 204-232
    against the hair's own 211. Those pixels do not exist in the master, so a
    mask derived from it cannot cover them, and they survive recolouring as a
    dotted white seam tracing every line. (Deriving the mask from the 512 art
    instead is worse: the seal costs proportionally more at that size and the
    mask comes out smaller.)

    So grow the mask by a pixel here, at the size it will be used, and take
    away anything as dark as line art. That covers the overshoot and leaves the
    linework black — measured at zero ink pixels painted, with the fringe down
    by about two thirds.
    """
    from process_item import morph
    m = np.array(mask.resize((CHAR_PX, CHAR_PX), Image.NEAREST)) >= 128
    art = np.array(Image.open(art_path).convert("RGBA")).astype(int)
    solid = art[..., 3] > 10
    lum = art[..., :3].mean(axis=2)
    m = morph(m, "dilate", 1) & solid & (lum >= 110)
    Image.fromarray(np.where(m, 255, 0).astype("uint8"), "L").save(out_path, optimize=True)
    return os.path.getsize(out_path)


def face_hair_mask(path):
    """Hair mask for a mood's face layer, which redraws the bangs over the eyes.

    Those bangs are painted in the base's hair colour and sit *above* the
    recoloured base, so without this they stay lavender and read as a stripe of
    the old colour across the recoloured head — which is exactly what showed up
    on the boy's temple.

    Per pixel rather than by region, because hair_mask's approach cannot work
    here: a face layer is a few sparse strokes on transparency, so nothing is
    sealed and it found 2% of the hair. The same green-suppression test is
    safe applied directly, since a face layer holds no garment that might be
    violet in its own right; a close afterwards recovers the pixels along the
    strand edges where the tone washes out.
    """
    a = np.array(Image.open(path).convert("RGBA")).astype(int)
    rgb, alpha = a[..., :3], a[..., 3] > 10
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    from process_item import morph
    m = alpha & ((b - g) >= 15) & ((r - g) >= 5)
    m = morph(morph(m, "dilate", 3), "erode", 3) & alpha
    return Image.fromarray(np.where(m, 255, 0).astype("uint8"), "L")


def item_hair_mask(item_path, master_paths, min_px=1500):
    """Hair mask for a garment layer that redraws hair, or None if it doesn't.

    A wide-brimmed hat is drawn with the hair falling in front of it, so those
    strands live in the hat's layer and sit above the recoloured base — the
    straw hat put the original lavender back on a black-haired character.

    The colour test alone cannot be used here, because several garments are
    lavender in their own right and must not follow the hair: the beanie, the
    pleated skirt, the cat ears. What separates them is that redrawn hair is
    *the same pixels in the same places* as the base, while a lavender hat is
    the hat's own shape and shading. Measured against the girl's base:

        straw hat    32916 px of seed in 7 pieces up to 10737   redraws hair
        cap           6702 px in 3 pieces                       redraws hair
        bucket hat    4677 px in 2 pieces                       redraws hair
        beanie         491 px in 1 piece                        its own colour
        cat ears / bow / crown / clips: no piece over 400px      its own colour
    """
    from process_item import components
    a = np.array(Image.open(item_path).convert("RGBA")).astype(int)
    rgb, alpha = a[..., :3], a[..., 3] > 10
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    violet = alpha & ((b - g) >= 15) & ((r - g) >= 5)

    # Matching the base pixel for pixel proves hair, but only in bulk. A
    # lavender hat over lavender hair matches here and there by chance, and
    # those hits are dust: the beanie's 994 matches come in 787 pieces none
    # bigger than 10px, while the straw hat's arrive in 7 pieces up to 10737.
    # Dilating the dust is what speckled red through the beanie's knit.
    #
    # Tried against every master, keeping the strongest, because the art may
    # not have been drawn on the character wearing it: the cap comes from the
    # boy, so on the girl it matched nothing, no hair was found in it, and the
    # strands it draws kept the old colour. Scored on the seed rather than on
    # matches overall, which is not the same thing — by matches overall the
    # beanie prefers the boy, and picks up a single spurious 491px piece.
    seed = np.zeros(alpha.shape, bool)
    for mp in master_paths:
        m0 = np.array(Image.open(mp).convert("RGBA")).astype(int)
        if m0.shape != a.shape:
            continue
        same = np.abs(rgb - m0[..., :3]).max(axis=2) <= 10
        here = np.zeros(alpha.shape, bool)
        slab, scomps = components(violet & same)
        for cid, n in scomps:
            if n < 400:
                break
            here |= slab == cid
        if here.sum() > seed.sum():
            seed = here
    if seed.sum() < min_px:
        return None

    # Then take the whole violet shape each seed sits in, because the match
    # test is also too strict on its own: hair shaded under a brim differs from
    # the base and failed it, leaving a band of the original colour across the
    # forehead. Growing to the connected shape picks that up while leaving the
    # straw hat's lavender ribbon alone — a separate component, no seed in it,
    # and bluer than hair (235 against 217).
    m = np.zeros(alpha.shape, bool)
    vlab, vcomps = components(violet)
    for cid, n in vcomps:
        reg = vlab == cid
        if (reg & seed).sum() >= 100:
            m |= reg
    return Image.fromarray(np.where(m, 255, 0).astype("uint8"), "L")


def hair_mask(master_path, dark=110):
    """White where the character's hair is, black elsewhere.

    Regions sealed inside the figure's own line art are kept when their median
    colour suppresses green, which is what makes a violet violet. Everything
    the mask must reject sits on one side of that line or the other, measured
    on both masters as blue-minus-green:

        hair       36 (boy)  19 (girl)     kept
        eyes        9                      rejected
        camisole    6 (boy)  10-12 (girl)  rejected
        skin       -7                      rejected

    Simpler tests were tried and are wrong in ways that show. "More blue than
    red" also passes the near-neutral camisole. Nearest-of-two-reference-colours
    passes the eyes, which are a greyed mauve much closer to hair than to skin —
    and painting the eyes is very obvious. There is deliberately no "above the
    neck" rule: it did exclude the camisole, but it also cut the hair tips that
    fall past the shoulders, which is what left a lavender patch on the boy's
    nape after everything else was recoloured.

    Regions rather than pixels, because a per-pixel test drops the highlights,
    where red and blue meet, and the mask comes out moth-eaten. The per-pixel
    test is then unioned in anyway, to catch strands the regions cannot: the
    wedge of fringe between the brows is not sealed off from the forehead, so
    it belongs to the big face region and was rejected wholesale with it,
    leaving one pale bit of the old colour on the 一般 face — the only mood that
    draws no face layer of its own over it. The two rules are complementary:
    regions get the highlights, pixels get the strays.
    """
    from process_item import components, morph, outside
    a = np.array(Image.open(master_path).convert("RGBA")).astype(int)
    rgb, alpha = a[..., :3], a[..., 3] > 10
    ink = alpha & (rgb.mean(axis=2) < dark)
    sealed = morph(ink, "dilate", 2)
    interior = (~sealed) & ~outside(sealed) & alpha
    lab, comps = components(interior)
    m = np.zeros(alpha.shape, bool)
    for cid, n in comps:
        if n < 60:                       # small enough to keep a stray tip
            continue
        reg = lab == cid
        r, g, b = np.median(rgb[reg], axis=0)
        if (b - g) >= 15 and (r - g) >= 5:
            m |= reg
    # Same test per pixel, for hair the regions missed.
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    m |= alpha & ((b - g) >= 15) & ((r - g) >= 5)
    # Grow back over the line art that sealed the regions, then trim one pixel
    # so the mask stops short of the outline rather than eating into it.
    m = morph(morph(m, "dilate", 2), "erode", 1) & alpha
    return Image.fromarray(np.where(m, 255, 0).astype("uint8"), "L")


def stamp_service_worker():
    """Key the service worker's cache to the content it will cache.

    The image rule in sw.js is cache-first, and item art is replaced under an
    unchanged filename every time a render is improved — item_jeans.png has
    been three different drawings. With a fixed cache name nothing ever
    invalidates that, so anyone who has opened the app keeps the old art
    indefinitely, while a fresh visitor sees the new one. Hashing the built
    assets means the cache name moves whenever any of them does, and the
    activate handler already deletes every cache but the current one.
    """
    sw = os.path.join(HERE, "web", "sw.js")
    h = hashlib.sha1()
    for root, _, files in sorted(os.walk(OUT)):
        for f in sorted(files):
            with open(os.path.join(root, f), "rb") as fh:
                h.update(f.encode())
                h.update(fh.read())
    for shell in ("index.html", "app.js", "i18n.js", "styles.css"):
        p = os.path.join(HERE, "web", shell)
        if os.path.exists(p):
            with open(p, "rb") as fh:
                h.update(fh.read())
    build = h.hexdigest()[:10]

    if os.path.exists(sw):
        with open(sw) as f:
            src = f.read()
        new = re.sub(r'const CACHE = "moodmate-[^"]*";',
                     'const CACHE = "moodmate-%s";' % build, src)
        if new != src:
            with open(sw, "w") as f:
                f.write(new)

    # The shell needs stamping too. Asset URLs are versioned from the manifest,
    # but styles.css and app.js are referenced by index.html, and a stale copy
    # of those arrives through the browser's HTTP cache without the service
    # worker being involved at all — which is how new markup can end up styled
    # by an old stylesheet.
    idx = os.path.join(HERE, "web", "index.html")
    if os.path.exists(idx):
        with open(idx) as f:
            src = f.read()
        new = re.sub(r'((?:href|src)="(?:styles\.css|app\.js|i18n\.js))(?:\?v=[^"]*)?"',
                     lambda m: '%s?v=%s"' % (m.group(1), build), src)
        if new != src:
            with open(idx, "w") as f:
                f.write(new)

    print("build stamp: %s" % build)
    return build


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = {"canvas": CHAR_PX, "slots": SLOTS,
                "characters": [], "items": [], "moods": []}
    total = 0

    base = None
    for cid, clabel, clabel_zh, master, out_name, prefix in CHARACTERS:
        src = os.path.join(HERE, master)
        if not os.path.exists(src):
            print("  missing %s, skipping character %s" % (master, cid))
            continue
        img = Image.open(src).convert("RGBA")
        if base is None:
            base = img
        save(img, os.path.join(OUT, out_name), CHAR_PX)
        total += os.path.getsize(os.path.join(OUT, out_name))

        # One mask per character, not one image per hair colour: the app repaints
        # the base on a canvas at runtime. Nearest-neighbour on the way down —
        # a smooth resample would leave half-lit edge pixels that recolour into
        # a fringe of the wrong shade against the line art.
        mask_name = out_name.replace(".png", "_hair.png")
        total += write_hair_mask(hair_mask(src), os.path.join(OUT, out_name),
                                 os.path.join(OUT, mask_name))

        manifest["characters"].append(
            {"id": cid, "label": clabel, "label_zh": clabel_zh, "base": out_name,
             "hairMask": mask_name, "hairBands": HAIR_BANDS[cid]})
    live = {c["id"] for c in manifest["characters"]}

    for key, label, layer, colour, label_zh in MOODS:
        entry = {"key": key, "label": label, "label_zh": label_zh,
                 "layer": {}, "color": colour}
        if layer:
            for cid, _, _, _, _, prefix in CHARACTERS:
                if cid not in live:
                    continue
                fname = layer.replace("face_", "face_" + prefix)
                src = os.path.join(HERE, "faces", "%s.png" % fname)
                if not os.path.exists(src):
                    print("  missing faces/%s.png" % fname)
                    continue
                save(Image.open(src).convert("RGBA"), os.path.join(OUT, "%s.png" % fname), CHAR_PX)
                total += os.path.getsize(os.path.join(OUT, "%s.png" % fname))
                entry["layer"][cid] = "%s.png" % fname

                # The bangs this layer redraws have to follow the hair colour
                # too, or they stay the original lavender on top of it.
                fmask = "%s_hair.png" % fname
                total += write_hair_mask(face_hair_mask(src),
                                         os.path.join(OUT, "%s.png" % fname),
                                         os.path.join(OUT, fmask))
                entry.setdefault("hairMask", {})[cid] = fmask
        manifest["moods"].append(entry)

    for row in ITEMS:
        name, slot, label, label_zh, unlock = row[:5]
        only = row[5] if len(row) > 5 else None
        icon = os.path.join(HERE, "items", "icon_%s.png" % name)
        layers, fits, hairmasks = {}, [], {}
        for cid, _, _, _, _, prefix in CHARACTERS:
            if cid not in live or (only and only != cid):
                continue
            # An item exclusive to a character is stored under its own name;
            # a shared item may have a per-character variant, e.g. hoodie_male.
            for candidate in ((name,) if only else (name if cid == "girl" else name + "_" + prefix.rstrip("_"),)):
                src = os.path.join(HERE, "items", "item_%s.png" % candidate)
                if os.path.exists(src):
                    save(Image.open(src).convert("RGBA"),
                         os.path.join(OUT, "item_%s.png" % candidate), CHAR_PX)
                    total += os.path.getsize(os.path.join(OUT, "item_%s.png" % candidate))
                    layers[cid] = "item_%s.png" % candidate
                    fits.append(cid)

                    # A hat drawn with hair falling over it carries those
                    # strands in its own layer; they must follow the colour too.
                    imask = item_hair_mask(
                        src, [os.path.join(HERE, c[3]) for c in CHARACTERS])
                    if imask is not None:
                        iname = "item_%s_hair.png" % candidate
                        total += write_hair_mask(
                            imask, os.path.join(OUT, "item_%s.png" % candidate),
                            os.path.join(OUT, iname))
                        hairmasks[cid] = iname
        # No art for this character, but bottoms are measured to fit both.
        for cid in live:
            if cid not in fits and not only and slot in FITS_BOTH and "girl" in layers:
                layers[cid] = layers["girl"]
                if "girl" in hairmasks:
                    hairmasks[cid] = hairmasks["girl"]
                fits.append(cid)
        if not layers:
            print("  missing art for %s, skipping" % name)
            continue
        if not os.path.exists(icon):
            print("  missing icon for %s, skipping" % name)
            continue
        save(Image.open(icon).convert("RGBA"), os.path.join(OUT, "icon_%s.png" % name), ICON_PX)
        total += os.path.getsize(os.path.join(OUT, "icon_%s.png" % name))
        manifest["items"].append({
            "id": name, "slot": slot, "label": label, "label_zh": label_zh,
            "unlockAt": unlock, "icon": "icon_%s.png" % name,
            "layer": layers, "fits": sorted(fits), "hairMask": hairmasks,
            **({"coversBottom": True} if name in COVERS_BOTTOM else {}),
        })

    # App icons: the character's head on a pastel plate. Home-screen icons are
    # square and opaque, so the transparent full-body render can't be reused.
    head = Image.alpha_composite(base, Image.open(
        os.path.join(HERE, "faces", "face_happy.png")).convert("RGBA")).crop((240, 100, 790, 560))
    for px in (192, 512):
        plate = Image.new("RGBA", (px, px), (245, 238, 250, 255))
        h = head.copy()
        h.thumbnail((int(px * 0.86), int(px * 0.86)), Image.LANCZOS)
        plate.paste(h, ((px - h.width) // 2, (px - h.height) // 2), h)
        plate.convert("RGB").save(os.path.join(OUT, "appicon-%d.png" % px), optimize=True)

    # Written before the manifest so the stamp can go into it: the app appends
    # it to every asset URL, which is what defeats the browser's HTTP cache.
    # The service worker's own cache name uses the same value.
    # A hair mask is only written when a layer turns out to redraw hair, so a
    # layer that stops qualifying leaves its old mask behind — unreferenced but
    # still shipped, and liable to be picked up again by a later change.
    keep = {c.get("hairMask") for c in manifest["characters"]}
    for entry in manifest["moods"] + manifest["items"]:
        keep |= set((entry.get("hairMask") or {}).values())
    for f in os.listdir(OUT):
        if f.endswith("_hair.png") and f not in keep:
            os.remove(os.path.join(OUT, f))
            print("  dropped stale mask %s" % f)

    manifest["build"] = stamp_service_worker()

    with open(os.path.join(OUT, "items.json"), "w") as f:
        json.dump(manifest, f, indent=2)

    print("exported %d items, %d moods" % (len(manifest["items"]), len(manifest["moods"])))
    print("total asset weight: %.0f KB" % (total / 1024))


if __name__ == "__main__":
    main()
