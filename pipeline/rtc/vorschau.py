"""Vorschaubilder aus fertigen Kacheln (zur Kontrolle eines Pipeline-Laufs)."""
from __future__ import annotations

import gzip
import json
import math
import pathlib

from PIL import Image, ImageDraw

AREA_COL = {"wald": (47, 95, 44), "wiese": (136, 180, 92), "acker": (196, 176, 106), "wohngebiet": (127, 174, 95),
            "gewerbe": (163, 158, 147), "militaer": (140, 154, 106), "heide": (142, 143, 92), "gebuesch": (111, 154, 76),
            "wasser": (58, 121, 189), "feuchtgebiet": (111, 154, 108), "parkplatz": (90, 92, 98), "sportplatz": (88, 162, 74),
            "friedhof": (111, 158, 88), "schule": (190, 175, 140), "park": (136, 180, 92), "sand": (217, 198, 154)}
ROAD_COL = {"auto": (230, 150, 60), "L": (240, 200, 90), "dorf": (230, 230, 225), "wohn": (200, 200, 195),
            "spiel": (190, 180, 170), "zufahrt": (170, 170, 165), "feld": (199, 178, 135), "rad": (200, 80, 60),
            "weg": (180, 160, 120), "fuss": (210, 200, 190), "treppe": (150, 150, 150)}
BASE = (106, 166, 79)


def load_tile(root: pathlib.Path, lod: int, ix: int, iy: int):
    p = root / "tiles" / str(lod) / f"{ix}_{iy}.json.gz"
    if not p.exists():
        return None
    with gzip.open(p, "rt", encoding="utf-8") as f:
        return json.load(f)


def render(root: pathlib.Path, lod: int, bbox, m_per_px: float, out: pathlib.Path, max_px=4096):
    man = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    size = man["tile_size_m"][lod]
    sc = man["scale"]
    x0, y0, x1, y1 = bbox
    m_per_px = max(m_per_px, (x1 - x0) / max_px, (y1 - y0) / max_px)
    W, H = int((x1 - x0) / m_per_px) + 1, int((y1 - y0) / m_per_px) + 1
    img = Image.new("RGB", (W, H), BASE)
    d = ImageDraw.Draw(img)

    def P(tile, flat):
        ox, oy = tile["origin"]
        return [((ox + flat[i] / sc - x0) / m_per_px, (y1 - (oy + flat[i + 1] / sc)) / m_per_px) for i in range(0, len(flat), 2)]

    tiles = []
    for ix in range(math.floor(x0 / size), math.floor(x1 / size) + 1):
        for iy in range(math.floor(y0 / size), math.floor(y1 / size) + 1):
            t = load_tile(root, lod, ix, iy)
            if t:
                tiles.append(t)
    for t in tiles:
        for a in t.get("areas", []):
            col = AREA_COL.get(a["k"])
            if not col:
                continue
            ring = P(t, a["p"][0])
            if len(ring) >= 3:
                d.polygon(ring, fill=col)
    for t in tiles:
        for ln in t.get("lines", []):
            pts = P(t, ln["c"])
            if len(pts) >= 2:
                d.line(pts, fill=(75, 139, 208) if ln["k"].startswith("w:") else (90, 90, 90), width=max(1, int(2 / m_per_px)))
    for t in tiles:
        for r in t.get("roads", []):
            m = r["m"]
            pts = P(t, r["c"])
            if len(pts) < 2:
                continue
            w = max(1, int(round(m.get("cw", 2) * 2 / m_per_px)))
            d.line(pts, fill=ROAD_COL.get(m["cls"], (220, 220, 220)), width=w, joint="curve")
            if 3 in (m.get("fac_l"), m.get("fac_r")) and m_per_px < 2:
                d.line(pts, fill=(200, 80, 60), width=1)
    for t in tiles:
        for b in t.get("buildings", []):
            ring = P(t, b["p"])
            if len(ring) >= 3:
                d.polygon(ring, fill=(170, 80, 60), outline=(110, 50, 40))
    for t in tiles:
        for p in t.get("places", []):
            ox, oy = t["origin"]
            X, Y = (ox + p["x"] / sc - x0) / m_per_px, (y1 - (oy + p["y"] / sc)) / m_per_px
            d.rectangle([X - 3, Y - 3, X + 3, Y + 3], fill=(20, 20, 20))
            d.text((X + 6, Y - 6), p["name"], fill=(255, 255, 255))
    img.save(out)
    return out, (W, H), m_per_px


def make_previews(root: pathlib.Path, zentrum_utm=None):
    man = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    bx0, by0, bx1, by1 = man["bbox_utm"]
    outs = []
    # Überblick über das ganze Gebiet
    lod = 1 if (bx1 - bx0) > 8000 else 0
    outs.append(render(root, lod, (bx0, by0, bx1, by1), 10 if lod else 2, root / "vorschau_ueberblick.png"))
    # Detail um das Zentrum
    if zentrum_utm is None:
        zentrum_utm = ((bx0 + bx1) / 2, (by0 + by1) / 2)
    cx, cy = zentrum_utm
    outs.append(render(root, 0, (cx - 1200, cy - 800, cx + 1200, cy + 800), 1, root / "vorschau_detail.png"))
    return outs
