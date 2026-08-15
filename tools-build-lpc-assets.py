#!/usr/bin/env python3
"""
Builds the Chem World avatar atlas from LPC spritesheets.

Instead of a hand-picked list, this walks every sheet definition in the repo
and keeps the ones that are (a) permissively licensed and (b) actually present
for our body type. New LPC assets are picked up automatically on re-run.

Design notes
------------
* One body ("teen"), so there is no male/female split in the app.
* Each layer keeps its own LPC zPos and becomes its own frame, so hair that
  falls behind the shoulders sorts under the body instead of over it.
* Only the front-facing (down) idle frame is extracted.
* Only assets offering CC0 or OGA-BY 3.0: attribution only, no share-alike.

Tuning: SLOT_MAP decides which LPC type_names become wardrobe slots, and
COLORS decides how many palette variants each material generates. Widening
either one is the way to grow the catalog.
"""
import json, os, glob, re
from PIL import Image

REPO = "/home/claude/lpc"
SHEETS = os.path.join(REPO, "spritesheets")
DEFS = os.path.join(REPO, "sheet_definitions")
PALETTES = os.path.join(REPO, "palette_definitions")
OUT = "/home/claude/out"

CELL = 64
DOWN_ROW = 2
ATLAS_COLS = 48
BODY = "teen"
MAX_ATLAS_PX = 8192          # browsers choke on textures past this

os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------- palettes

_pal_cache = {}

def palette(material, name="ulpc"):
    key = (material, name)
    if key not in _pal_cache:
        p = os.path.join(PALETTES, material, f"{material}_{name}.json")
        with open(p) as f:
            _pal_cache[key] = json.load(f)
    return _pal_cache[key]

def palette_base(material):
    with open(os.path.join(PALETTES, material, f"meta_{material}.json")) as f:
        return json.load(f)["base"]

def hex_rgb(h):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))

_map_cache = {}

def recolor_map(material, target):
    key = (material, target)
    if key not in _map_cache:
        ramps = palette(material)
        src, dst = ramps[palette_base(material)], ramps[target]
        n = min(len(src), len(dst))
        _map_cache[key] = {hex_rgb(src[i]): hex_rgb(dst[i]) for i in range(n)}
    return _map_cache[key]

def apply_map(img, m):
    if not m:
        return img
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a and (r, g, b) in m:
                nr, ng, nb = m[(r, g, b)]
                px[x, y] = (nr, ng, nb, a)
    return img

# How many variants each material contributes. Order matters: the first entry
# is the default the app dresses new characters in.
COLORS = {
    "hair": ["dark_brown", "black", "light_brown", "blonde", "ginger",
             "platinum", "gray", "rose", "pink", "purple", "blue", "green"],
    "cloth": ["white", "blue", "navy", "teal", "green", "yellow", "orange",
              "red", "pink", "lavender", "purple", "brown", "gray", "black"],
    "metal": ["silver", "gold", "brass", "bronze"],
    "body":  ["light", "amber", "bronze", "brown"],
    "eye":   ["blue", "green", "brown", "gray", "purple"],
    "wood":  ["oak", "walnut", "maple", "mahogany"],
}

def variants(material):
    if not material:
        return [("", "")]
    have = palette(material)
    return [(c, c) for c in COLORS.get(material, list(have)) if c in have]

SKINS = ["light", "amber", "bronze", "brown"]
EYES = ["blue", "green", "brown", "gray", "purple"]

# ---------------------------------------------------------------- sources

def license_of(d):
    ls = {l for c in d.get("credits", []) for l in c.get("licenses", [])}
    for pref in ("CC0", "OGA-BY 3.0", "OGA-BY 3.0+"):
        if pref in ls:
            return pref
    for l in ls:
        if "OGA-BY" in l:
            return l
    return None

def layers_of(d):
    ls = [(v.get("zPos", 100), v) for k, v in d.items() if k.startswith("layer_")]
    return sorted(ls, key=lambda x: x[0])

# Weapons and shields only ship a "male" (or universal) folder; they are held
# props, so the body-type difference does not show.
def pick_folder(layer):
    return (layer.get(BODY) or layer.get("male") or layer.get("universal")
            or layer.get("thin") or layer.get("female"))

def resolve(folder):
    if not folder:
        return (None, None)
    base = os.path.join(SHEETS, folder)
    for anim in ("idle", "walk", "universal", "spellcast", "thrust", "slash"):
        f = os.path.join(base, anim + ".png")
        if os.path.exists(f):
            return ("sheet", f)
        d = os.path.join(base, anim)
        if os.path.isdir(d):
            return ("dir", d)
    # Some props keep a single sheet named after the item itself.
    if os.path.isdir(base):
        pngs = sorted(f for f in os.listdir(base) if f.endswith(".png"))
        if pngs:
            return ("sheet", os.path.join(base, pngs[0]))
    return (None, None)

def usable(d):
    ls = layers_of(d)
    return bool(ls) and all(resolve(pick_folder(l))[0] for _z, l in ls)

def crop_down(img, col=0):
    """Frame `col` of the south-facing row."""
    if img.width < (col + 1) * CELL:
        col = 0
    x = col * CELL
    return img.crop((x, DOWN_ROW * CELL, x + CELL, (DOWN_ROW + 1) * CELL))

def material_of(d):
    r = d.get("recolors")
    if not r:
        return None
    if "material" in r:
        return r["material"]
    for v in r.values():
        if isinstance(v, dict) and "material" in v:
            return v["material"]
    return None

def dir_colors(d):
    """Pre-coloured assets ship a directory of finished sheets."""
    for _z, layer in layers_of(d):
        kind, src = resolve(pick_folder(layer))
        if kind == "dir":
            return sorted(f[:-4] for f in os.listdir(src)
                          if f.endswith(".png") and not f.startswith("_"))
    return None

def layer_image(layer, cmap, dircolor, col=0):
    kind, src = resolve(pick_folder(layer))
    if kind is None:
        return None
    if kind == "dir":
        p = os.path.join(src, f"{dircolor}.png")
        if not os.path.exists(p):
            return None
        return crop_down(Image.open(p).convert("RGBA"), col)
    return apply_map(crop_down(Image.open(src).convert("RGBA"), col), cmap)

# The second idle frame only exists on sheets named idle.png. Anything else
# (older per-colour directories, walk-only props) reuses frame 0, so it stays
# still rather than borrowing a mismatched pose.
def has_idle_pair(layer):
    kind, src = resolve(pick_folder(layer))
    return kind == "sheet" and src.endswith("idle.png")

def layer_pair(layer, cmap, dircolor):
    a = layer_image(layer, cmap, dircolor, 0)
    if a is None:
        return None, None
    b = layer_image(layer, cmap, dircolor, 1) if has_idle_pair(layer) else a
    return a, (b if b is not None else a)

# ---------------------------------------------------------------- slots

# LPC type_name -> (our slot, korean label, price). Everything not listed is
# skipped, which is how weapons/shields/wounds stay out of the wardrobe.
SLOT_MAP = {
    "hair":        ("hair", "헤어", 120),
    "ponytail":    ("hair", "헤어", 130),
    "updo":        ("hair", "헤어", 130),
    "hairextl":    ("hairext", "헤어 장식", 90),
    "hairextr":    ("hairext", "헤어 장식", 90),
    "hairtie":     ("hairext", "헤어 장식", 80),

    "clothes":     ("torso", "상의", 180),
    "sleeves":     ("sleeves", "소매", 90),
    "jacket":      ("outer", "아우터", 220),
    "apron":       ("outer", "아우터", 150),
    "overalls":    ("torso", "상의", 200),
    "chainmail":   ("torso", "상의", 240),
    "armour":      ("torso", "상의", 260),
    "bandages":    ("torso", "상의", 90),

    "legs":        ("legs", "하의", 140),
    "socks":       ("socks", "양말", 60),
    "shoes":       ("feet", "신발", 100),
    "shoes_toe":   ("feet", "신발", 110),

    "hat":         ("hat", "모자", 160),
    "headcover":   ("hat", "모자", 140),
    "bandana":     ("hat", "모자", 120),
    "visor":       ("hat", "모자", 180),
    "hat_trim":    ("hattrim", "모자 장식", 70),
    "hat_accessory": ("hattrim", "모자 장식", 80),
    "hat_overlay": ("hattrim", "모자 장식", 80),

    "facial_eyes": ("eyewear", "안경", 130),
    "facial_mask": ("eyewear", "안경", 150),
    "earrings":    ("earring", "귀걸이", 100),
    "earring_left": ("earring", "귀걸이", 90),
    "earring_right": ("earring", "귀걸이", 90),
    "necklace":    ("neck", "목걸이", 140),
    "neck":        ("neck", "목걸이", 130),
    "charm":       ("charm", "펜던트", 110),
    "belt":        ("belt", "벨트", 90),
    "sash":        ("belt", "벨트", 100),
    "sash_tie":    ("belt", "벨트", 90),

    "ears":        ("ears", "귀", 150),
    "furry_ears":  ("ears", "귀", 160),
    "horns":       ("ears", "귀", 170),
    "fins":        ("ears", "귀", 160),
    "tail":        ("tail", "꼬리", 200),
    "wings":       ("wings", "날개", 320),
    "eyebrows":    ("brow", "눈썹", 60),
    "nose":        ("nose", "코", 60),
    "wrinkles":    ("face_extra", "얼굴 표현", 60),

    # battle gear
    "weapon":        ("weapon", "무기", 300),
    "weapon_magic_crystal": ("weapon", "무기", 320),
    "ammo":          ("weapon", "무기", 150),
    "shield":        ("shield", "방패", 280),
    "shield_trim":   ("shieldtrim", "방패 장식", 90),
    "shield_pattern": ("shieldtrim", "방패 장식", 90),
    "shield_paint":  ("shieldtrim", "방패 장식", 90),
    "quiver":        ("back", "등 장비", 180),
    "bauldron":      ("back", "등 장비", 160),
    "cape":          ("back", "등 장비", 260),
}

SLOT_ORDER = [
    ("hair", "헤어"), ("hairext", "헤어 장식"), ("torso", "상의"),
    ("sleeves", "소매"), ("outer", "아우터"), ("legs", "하의"),
    ("socks", "양말"), ("feet", "신발"), ("hat", "모자"),
    ("hattrim", "모자 장식"), ("eyewear", "안경"), ("earring", "귀걸이"),
    ("neck", "목걸이"), ("charm", "펜던트"), ("belt", "벨트"),
    ("brow", "눈썹"), ("nose", "코"), ("face_extra", "얼굴 표현"),
    ("ears", "귀"), ("tail", "꼬리"), ("wings", "날개"),
    ("weapon", "무기"), ("shield", "방패"), ("shieldtrim", "방패 장식"),
    ("back", "등 장비"),
]

def clean_name(raw):
    n = re.sub(r"\s+", " ", (raw or "").strip())
    return n or "아이템"

# ---------------------------------------------------------------- build

frames, frames_b, items, credits_used = [], [], [], {}
_frame_index = {}

def add_frame(img, img_b=None):
    """Store the idle pair. Dedupe on frame A; frame B rides along at the
    same index so both atlases share one set of coordinates."""
    if img_b is None:
        img_b = img
    key = img.tobytes() + b"|" + img_b.tobytes()
    if key in _frame_index:
        return _frame_index[key]
    frames.append(img)
    frames_b.append(img_b)
    _frame_index[key] = len(frames) - 1
    return len(frames) - 1

def note(path, d):
    lic = license_of(d)
    credits_used[path] = {
        "name": d.get("name"),
        "authors": sorted({a for c in d.get("credits", []) for a in c.get("authors", [])}),
        "license": lic,
        "urls": sorted({u for c in d.get("credits", []) for u in c.get("urls", [])}),
    }
    return lic

def build_item(path, d, slot, label_slot, cost):
    base_id = os.path.basename(path).replace(".json", "")
    name = clean_name(d.get("name"))
    mat = material_of(d)
    dcols = dir_colors(d)

    if slot == "shieldtrim":
        combos = [(k, n, recolor_map(mat, k) if (mat and k) else None)
                  for k, n in variants(mat)[:2]]
    elif dcols:
        # Pre-coloured: keep a sensible subset in a stable order.
        order = COLORS.get("cloth", [])
        picked = [c for c in order if c in dcols] or dcols[:8]
        combos = [(c, c, None) for c in picked[:12]]
    else:
        combos = [(k, n, recolor_map(mat, k) if (mat and k) else None)
                  for k, n in variants(mat)]

    made = 0
    for ckey, cname, cmap in combos:
        stack = []
        for z, layer in layers_of(d):
            img, img_b = layer_pair(layer, cmap, ckey if dcols else None)
            if img is None or img.getbbox() is None:
                continue
            stack.append({"z": z, "f": add_frame(img, img_b)})
        if not stack:
            continue
        items.append({
            "id": f"{base_id}.{ckey}" if ckey else base_id,
            "slot": slot,
            "name": f"{name} · {cname}" if cname else name,
            "cost": cost,
            "layers": stack,
        })
        made += 1
    return made

def read(path):
    with open(os.path.join(DEFS, path)) as f:
        return json.load(f)

# --- base body and faces -----------------------------------------------

print("bodies...")
bd = read("body/body.json"); note("body/body.json", bd)
bz, blayer = layers_of(bd)[0]
for skin in SKINS:
    img, img_b = layer_pair(blayer, recolor_map("body", skin), None)
    items.append({"id": f"body.{skin}", "slot": "_body", "name": skin,
                  "layers": [{"z": bz, "f": add_frame(img, img_b)}]})

print("faces...")
# Elderly / gaunt heads read as odd for a student avatar, so keep the four
# neutral ones and label them without gender.
FACE_KEEP = ["heads_human_female", "heads_human_male",
             "heads_human_female_small", "heads_human_male_small"]
FACE_DEFS = [os.path.join(DEFS, "head/heads/human", k + ".json") for k in FACE_KEEP]
faces = []
for fp in FACE_DEFS:
    rel = os.path.relpath(fp, DEFS)
    d = read(rel)
    if not license_of(d) or not usable(d):
        continue
    note(rel, d)
    key = os.path.basename(rel).replace(".json", "")
    hz, hlayer = layers_of(d)[0]
    faces.append({"key": key, "name": f"얼굴형 {len(faces) + 1}"})
    for skin in SKINS:
        for eye in EYES:
            m = dict(recolor_map("body", skin))
            m.update(recolor_map("eye", eye))
            img, img_b = layer_pair(hlayer, m, None)
            items.append({"id": f"face.{key}.{skin}.{eye}", "slot": "_face",
                          "face": key, "skin": skin, "eye": eye, "name": key,
                          "layers": [{"z": hz, "f": add_frame(img, img_b)}]})

# --- everything else ----------------------------------------------------

print("scanning wardrobe...")
skipped = {}
for fp in sorted(glob.glob(os.path.join(DEFS, "**/*.json"), recursive=True)):
    rel = os.path.relpath(fp, DEFS)
    if os.path.basename(rel).startswith("meta_"):
        continue
    if rel.startswith(("body/", "head/heads/")):
        continue
    d = read(rel)
    tn = d.get("type_name")
    if tn not in SLOT_MAP:
        skipped[tn] = skipped.get(tn, 0) + 1
        continue
    if not license_of(d):
        continue
    if not usable(d):
        continue
    slot, _label, cost = SLOT_MAP[tn]
    note(rel, d)
    build_item(rel, d, slot, _label, cost)

# ---------------------------------------------------------------- pack

rows = (len(frames) + ATLAS_COLS - 1) // ATLAS_COLS
assert rows * CELL <= MAX_ATLAS_PX, f"atlas too tall: {rows * CELL}px"

def pack(imgs, name):
    at = Image.new("RGBA", (ATLAS_COLS * CELL, rows * CELL))
    for i, im in enumerate(imgs):
        at.paste(im, ((i % ATLAS_COLS) * CELL, (i // ATLAS_COLS) * CELL))
    at.save(os.path.join(OUT, name), optimize=True)
    return at

atlas = pack(frames, "avatar-atlas.png")

# Idle animation is off. The second frame is still collected above, so
# flipping this to True is all that is needed to ship it again.
EMIT_SECOND_FRAME = False
moved = 0
if EMIT_SECOND_FRAME:
    moved = sum(1 for a, b in zip(frames, frames_b) if a.tobytes() != b.tobytes())
    if moved:
        pack(frames_b, "avatar-atlas-b.png")
    print(f"animated frames: {moved}/{len(frames)}")

wear = [i for i in items if not i["slot"].startswith("_")]
used_slots = {i["slot"] for i in wear}
slots = [[k, v] for k, v in SLOT_ORDER if k in used_slots]

with open(os.path.join(OUT, "avatar-manifest.json"), "w") as f:
    json.dump({
        "cell": CELL, "cols": ATLAS_COLS, "rows": rows,
        "skins": [{"key": k, "name": k} for k in SKINS],
        "eyes": [{"key": k, "name": k} for k in EYES],
        "faces": faces,
        "slots": slots,
        "animated": bool(moved),
        "items": items,
    }, f, ensure_ascii=False, separators=(",", ":"))

with open(os.path.join(OUT, "avatar-credits.json"), "w") as f:
    json.dump(sorted(credits_used.values(), key=lambda c: c["name"] or ""),
              f, ensure_ascii=False, indent=1)

print(f"\nframes {len(frames)} (deduped)  atlas {atlas.size}  wearable {len(wear)}")
print("by slot:")
for k, label in slots:
    print(f"   {label:10s} {sum(1 for i in wear if i['slot'] == k)}")
print("licenses:", sorted({c["license"] for c in credits_used.values()}))
print("authors:", len({a for c in credits_used.values() for a in c["authors"]}))
top = sorted(skipped.items(), key=lambda x: -x[1])[:8]
print("skipped type_names:", top)
