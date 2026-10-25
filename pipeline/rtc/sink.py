"""Kachelspeicher: sammelt Objekte je Kachel, lagert große Mengen auf die Platte aus
und schreibt am Ende eine gzip-JSON-Datei pro Kachel.

Koordinaten in den Kacheln sind ganze Dezimeter relativ zur Kachelecke unten links
(Ost/Nord, Nord zeigt nach oben). Das hält die Dateien klein und genau genug.
"""
from __future__ import annotations

import collections
import gzip
import json
import os
import pathlib
import shutil
import time

from . import CRS, FORMAT_VERSION, MODEL_VERSION

SCALE = 10  # 1 Einheit = 0,1 m
SECTIONS = ("areas", "roads", "lines", "buildings", "nodes", "pois", "places")


def enc(coords, ox, oy):
    """[(e, n), ...] -> flache Liste ganzer Dezimeter relativ zu (ox, oy)."""
    out = []
    for e, n in coords:
        out.append(int(round((e - ox) * SCALE)))
        out.append(int(round((n - oy) * SCALE)))
    return out


class TileSink:
    """Sammelt Objekte eines Arbeitsprozesses. Jeder Prozess hat einen eigenen Unterordner in _tmp;
    beim Zusammenbau werden die Teile aller Prozesse je Kachel zusammengeführt."""

    def __init__(self, outdir: pathlib.Path, sizes: tuple[int, ...], part: int = 0, flush_at: int = 250_000):
        self.outdir = pathlib.Path(outdir)
        self.tmp = self.outdir / "_tmp" / str(part)
        if self.tmp.exists():
            shutil.rmtree(self.tmp)
        self.tmp.mkdir(parents=True)
        self.sizes = sizes
        self.buf: dict[tuple, list[str]] = collections.defaultdict(list)
        self.count = 0
        self.flush_at = flush_at

    def origin(self, lod, ix, iy):
        s = self.sizes[lod]
        return ix * s, iy * s

    def add(self, lod: int, ix: int, iy: int, section: str, obj: dict):
        self.buf[(lod, ix, iy, section)].append(json.dumps(obj, separators=(",", ":"), ensure_ascii=False))
        self.count += 1
        if self.count >= self.flush_at:
            self.flush()

    def flush(self):
        for (lod, ix, iy, sec), lines in self.buf.items():
            with open(self.tmp / f"{lod}_{ix}_{iy}_{sec}.ndjson", "a", encoding="utf-8") as f:
                f.write("\n".join(lines))
                f.write("\n")
        self.buf.clear()
        self.count = 0


def _build_tile(job):
    """Eine Kachel aus den Teilen aller Prozesse bauen und schreiben. Läuft im Prozesspool."""
    outdir, sizes, (lod, ix, iy), files = job
    s = sizes[lod]
    ox, oy = ix * s, iy * s
    tile = {"v": FORMAT_VERSION, "m": MODEL_VERSION, "lod": lod, "ix": ix, "iy": iy,
            "size": s, "origin": [ox, oy], "scale": SCALE}
    for sec in SECTIONS:
        items = []
        for p in files.get(sec, ()):
            with open(p, encoding="utf-8") as f:
                items.extend(json.loads(l) for l in f if l.strip())
        if not items:
            continue
        if sec == "nodes":  # Graph-Knoten können mehrfach kommen
            seen = {}
            for it in items:
                prev = seen.get(it["id"])
                if prev is None or (it.get("f") and not prev.get("f")):
                    seen[it["id"]] = {**(prev or {}), **it}
            items = sorted(seen.values(), key=lambda n: n["id"])
        elif sec == "roads":
            items.sort(key=lambda r: (ROAD_ORDER.get(r["m"]["cls"], 0), r["id"]))
        elif sec == "areas":  # feste Reihenfolge, egal wie die Prozesse aufgeteilt waren
            items.sort(key=lambda a: (AREA_ORDER.get(a["k"], 5), a["p"][0][:4], len(a["p"][0])))
        elif sec == "buildings":
            items.sort(key=lambda b: b["p"][:4])
        else:
            items.sort(key=lambda o: json.dumps(o, sort_keys=True))
        tile[sec] = items
    d = pathlib.Path(outdir) / "tiles" / str(lod)
    d.mkdir(parents=True, exist_ok=True)
    fn = d / f"{ix}_{iy}.json.gz"
    data = json.dumps(tile, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    with gzip.open(fn, "wb", compresslevel=6) as f:
        f.write(data)
    return lod, ix, iy, fn.stat().st_size


def finalize(outdir: pathlib.Path, sizes: tuple[int, ...], manifest: dict, jobs: int = 1) -> dict:
    """Alle Teil-Ordner in _tmp einsammeln, Kacheln (parallel) bauen, Manifest schreiben."""
    outdir = pathlib.Path(outdir)
    tmp = outdir / "_tmp"
    groups: dict[tuple, dict[str, list[str]]] = collections.defaultdict(lambda: collections.defaultdict(list))
    for part in sorted(tmp.iterdir()):
        for p in part.iterdir():
            lod, ix, iy, sec = p.stem.split("_", 3)
            groups[(int(lod), int(ix), int(iy))][sec].append(str(p))
    for files in groups.values():  # feste Reihenfolge -> gleiche Ausgabe bei jedem Lauf
        for lst in files.values():
            lst.sort()
    work = [(str(outdir), tuple(sizes), k, dict(v)) for k, v in sorted(groups.items())]
    tiles = {str(l): [] for l in range(len(sizes))}
    sizes_bytes = collections.Counter()
    t_last = time.time()

    def collect(results):
        nonlocal t_last
        for i, (lod, ix, iy, nbytes) in enumerate(results, 1):
            tiles[str(lod)].append([ix, iy])
            sizes_bytes[lod] += nbytes
            if time.time() - t_last > 15:
                t_last = time.time()
                print(f"[{time.strftime('%H:%M:%S')}]   … Kachel {i:,} von {len(work):,}".replace(",", "."), flush=True)

    if jobs > 1 and len(work) > 1:
        import multiprocessing as mp
        with mp.get_context("fork").Pool(jobs) as pool:
            collect(pool.imap_unordered(_build_tile, work, chunksize=4))
    else:
        collect(map(_build_tile, work))
    for v in tiles.values():
        v.sort()
    shutil.rmtree(tmp)
    manifest.update({
        "format": FORMAT_VERSION, "model": MODEL_VERSION, "crs": CRS, "scale": SCALE,
        "tile_size_m": list(sizes), "tiles": tiles,
        "tile_bytes": {str(k): v for k, v in sorted(sizes_bytes.items())},
    })
    (outdir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    return manifest


ROAD_ORDER = {"treppe": 0, "fuss": 1, "weg": 2, "feld": 3, "rad": 4, "zufahrt": 5, "spiel": 6, "wohn": 7,
              "dorf": 8, "L": 9, "auto": 10}
AREA_ORDER = {"militaer": 0, "acker": 1, "wiese": 1, "wohngebiet": 1, "gewerbe": 1, "hof": 1, "friedhof": 2,
              "kleingarten": 2, "obstwiese": 2, "wald": 2, "heide": 2, "gebuesch": 2, "feuchtgebiet": 2,
              "sand": 2, "fels": 2, "abbau": 2, "brache": 2, "baustelle": 2, "bahn": 2, "park": 3, "garten": 3,
              "schule": 3, "parkplatz": 4, "sportanlage": 4, "sportplatz": 5, "spielplatz": 5, "laufbahn": 5,
              "wasser": 6}


def disk_usage(path: pathlib.Path) -> int:
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            total += os.path.getsize(os.path.join(root, f))
    return total
