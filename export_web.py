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
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "web", "assets")
CHAR_PX = 512      # character layers, 2x the largest on-screen size
ICON_PX = 192      # closet thumbnails

# slot -> draw order. Bottom garments first, then tops, then the face, then
# anything on the head. The face sits above tops so a high collar can never
# cover it, and below hats so a brim falls over the brow correctly.
SLOTS = {"bottom": 10, "top": 20, "face": 30, "hat": 40}

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
FITS_BOTH = {"bottom", "top", "hat"}

# unlockAt is the number of entries needed before an item can be worn. The
# starter set is all 0 — everything available from day one. The gating still
# works, so later drops can be earned by keeping a streak going.
# name, slot, label, label_zh, unlock, exclusive-to (omitted = both characters)
# Exclusivity is a content choice, not a technical one: any item renders on any
# body. These four were drawn on the boy, so they sit a little narrow on the
# girl, but nothing about them is boy-only.
ITEMS = [
    ("beanie",          "hat",    "Pom-Pom Beanie",     "毛球冷帽",     0),
    ("beret",           "hat",    "Rose Beret",         "玫瑰貝雷帽",     0),
    ("cat_ears",        "hat",    "Cat Ears",           "貓耳髮箍",       0),
    ("bow",             "hat",    "Ribbon Bow",         "緞帶蝴蝶結",     0),
    ("flower_crown",    "hat",    "Flower Crown",       "雛菊花環",       0),
    ("headphones",      "hat",    "Headphones",         "耳機",           0),
    ("star_clips",      "hat",    "Star Clips",         "星星髮夾",       0),
    ("bucket_hat",      "hat",    "Bucket Hat",         "漁夫帽",         0),
    ("straw_hat",       "hat",    "Straw Sun Hat",      "草帽",           0),
    ("hoodie",          "top",    "Cosy Hoodie",        "舒適衛衣",     0),
    ("cardigan",        "top",    "Knit Cardigan",      "針織開衫",       0),
    ("sweater",         "top",    "Striped Sweater",    "條紋毛衣",       0),
    ("sailor",          "top",    "Sailor Blouse",      "水手服上衣",     0),
    ("turtleneck",      "top",    "Turtleneck",         "樽領毛衣",       0),
    ("denim_jacket",    "top",    "Denim Jacket",       "牛仔外套",       0),
    ("skirt_pleated",   "bottom", "Pleated Skirt",      "百褶裙",         0),
    ("skirt_plaid",     "bottom", "Plaid Skirt",        "格仔裙",         0),
    ("skirt_corduroy",  "bottom", "Corduroy Skirt",     "燈芯絨裙",       0),
    ("jeans",           "bottom", "Wide-Leg Jeans",     "闊腳牛仔褲",     0),
    ("joggers",         "bottom", "Joggers",            "束腳運動褲",     0),
    ("denim_shorts",    "bottom", "Denim Shorts",       "牛仔短褲",       0),
    ("male_cap",        "hat",    "Baseball Cap",       "棒球帽", 0),
    ("male_gakuran",    "top",    "Gakuran Jacket",     "學生外套", 0),
    ("male_bomber",     "top",    "Bomber Jacket",      "飛行外套", 0),
    ("male_tie_shirt",  "top",    "Shirt & Tie",        "恤衫領呔", 0),
]

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
        manifest["characters"].append(
            {"id": cid, "label": clabel, "label_zh": clabel_zh, "base": out_name})
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
        manifest["moods"].append(entry)

    for row in ITEMS:
        name, slot, label, label_zh, unlock = row[:5]
        only = row[5] if len(row) > 5 else None
        icon = os.path.join(HERE, "items", "icon_%s.png" % name)
        layers, fits = {}, []
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
        # No art for this character, but bottoms are measured to fit both.
        for cid in live:
            if cid not in fits and not only and slot in FITS_BOTH and "girl" in layers:
                layers[cid] = layers["girl"]
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
            "layer": layers, "fits": sorted(fits),
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
    manifest["build"] = stamp_service_worker()

    with open(os.path.join(OUT, "items.json"), "w") as f:
        json.dump(manifest, f, indent=2)

    print("exported %d items, %d moods" % (len(manifest["items"]), len(manifest["moods"])))
    print("total asset weight: %.0f KB" % (total / 1024))


if __name__ == "__main__":
    main()
