"""Projektion (WGS84 <-> UTM 32N), Gebietspolygone, Kachel-Rechnung."""
from __future__ import annotations

import json
import math
import pathlib
import subprocess

from pyproj import Transformer
from shapely.geometry import Point, box, mapping, shape
from shapely.ops import transform, unary_union

from . import CRS

_TO_UTM = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
_TO_WGS = Transformer.from_crs(CRS, "EPSG:4326", always_xy=True)


def to_utm(lon, lat):
    """lon/lat (auch Arrays) -> Ost/Nord in Metern."""
    return _TO_UTM.transform(lon, lat)


def to_wgs(e, n):
    return _TO_WGS.transform(e, n)


def geom_to_utm(g):
    return transform(lambda x, y, z=None: _TO_UTM.transform(x, y), g)


def geom_to_wgs(g):
    return transform(lambda x, y, z=None: _TO_WGS.transform(x, y), g)


def region_polygon(region, source_pbf: pathlib.Path | None, workdir: pathlib.Path):
    """Gebietspolygon in UTM (inkl. Puffer). Für typ=alles: None."""
    g = region.gebiet
    typ = region.typ
    if typ == "kreis":
        lat, lon = g["zentrum"]
        e, n = to_utm(lon, lat)
        poly = Point(e, n).buffer(float(g["radius_km"]) * 1000, 128)
    elif typ == "bbox":
        min_lat, min_lon, max_lat, max_lon = g["bbox"]
        poly = geom_to_utm(box(min_lon, min_lat, max_lon, max_lat))
    elif typ == "verwaltung":
        poly = geom_to_utm(admin_boundary(source_pbf, g["name"], g.get("admin_level"), workdir))
    else:
        return None
    if region.rand_m:
        poly = poly.buffer(region.rand_m, 32)
    return poly


def admin_boundary(source_pbf: pathlib.Path, name: str, admin_level, workdir: pathlib.Path):
    """Verwaltungsgrenze (WGS84) per osmium-tool aus der Quelldatei holen."""
    if source_pbf is None:
        raise RuntimeError("Für gebiet.typ=verwaltung wird eine Quelldatei gebraucht")
    workdir.mkdir(parents=True, exist_ok=True)
    flt = workdir / "grenzen.osm.pbf"
    gj = workdir / "grenzen.geojsonseq"
    subprocess.run(["osmium", "tags-filter", "--overwrite", "-o", str(flt), str(source_pbf),
                    "r/boundary=administrative"], check=True)
    subprocess.run(["osmium", "export", "--overwrite", "-f", "geojsonseq", "-o", str(gj), str(flt),
                    "--geometry-types=polygon"], check=True)
    hits = []
    for line in gj.read_text(encoding="utf-8").splitlines():
        line = line.strip().lstrip("\x1e")
        if not line:
            continue
        f = json.loads(line)
        p = f.get("properties", {})
        if p.get("name") != name:
            continue
        if admin_level is not None and str(p.get("admin_level")) != str(admin_level):
            continue
        hits.append(shape(f["geometry"]))
    if not hits:
        raise RuntimeError(f"Verwaltungsgrenze '{name}' (admin_level={admin_level}) nicht in der Quelldatei gefunden")
    return unary_union(hits)


def write_geojson_wgs(poly_utm, path: pathlib.Path):
    g = geom_to_wgs(poly_utm)
    path.write_text(json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {}, "geometry": mapping(g)}]}), encoding="utf-8")


# ---------------------------------------------------------------------------
# Kacheln
#
# Kachelschlüssel = (Stufe, ix, iy) mit ix = floor(Ost / Größe), iy = floor(Nord / Größe).
# Bei 1000 m entspricht das dem amtlichen 1-km-Raster (z. B. 32_475_5752).

def tile_of(e: float, n: float, size: int) -> tuple[int, int]:
    return math.floor(e / size), math.floor(n / size)


def tiles_in_bbox(x0, y0, x1, y1, size, margin=0.0):
    ix0, iy0 = tile_of(x0 - margin, y0 - margin, size)
    ix1, iy1 = tile_of(x1 + margin, y1 + margin, size)
    for iy in range(iy0, iy1 + 1):
        for ix in range(ix0, ix1 + 1):
            yield ix, iy


def tiles_of_line(coords, size, margin=0.0):
    """Alle Kacheln, die eine Linie (Liste von (e, n)) inkl. Rand berührt."""
    out = set()
    for i in range(1, len(coords)):
        (ax, ay), (bx, by) = coords[i - 1], coords[i]
        seg = math.hypot(bx - ax, by - ay)
        steps = max(1, int(seg / (size / 2)))
        for k in range(steps + 1):
            t = k / steps
            x, y = ax + (bx - ax) * t, ay + (by - ay) * t
            for key in tiles_in_bbox(x, y, x, y, size, margin):
                out.add(key)
    if len(coords) == 1:
        out.update(tiles_in_bbox(coords[0][0], coords[0][1], coords[0][0], coords[0][1], size, margin))
    return out


def tile_box(ix, iy, size):
    return box(ix * size, iy * size, (ix + 1) * size, (iy + 1) * size)
