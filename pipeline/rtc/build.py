"""OSM-Datei (.osm.pbf / .osm) -> Spielkacheln.

Zwei Durchläufe mit pyosmium:
  1. Knotenreferenzen der Straßen zählen -> Kreuzungsknoten; Radrouten sammeln.
  2. Straßen an Kreuzungen in Kanten zerlegen, Flächen/Gebäude/POIs einlesen,
     alles in UTM umrechnen und auf Kacheln verteilen.
"""
from __future__ import annotations

import collections
import datetime as dt
import json
import shutil
import subprocess
import math
import pathlib
import time
from array import array

import numpy as np
import osmium
import shapely
from shapely import wkb
from shapely.geometry import Point, Polygon
from shapely.prepared import prep

from . import __version__, CRS
from .geo import tile_of, tiles_in_bbox, tiles_of_line, to_utm, to_wgs
from .model import (HIGHWAYS, OVERVIEW_AREAS, PLACE_RANK, area_kind, node_flag, poi_kind, road_model)
from .sink import TileSink, enc, finalize

ROUTE_NETWORK = {"icn": "international", "ncn": "national", "rcn": "regional", "lcn": "lokal"}


def zahl(v):
    """Zahl mit deutschem Tausenderpunkt."""
    return f"{v:,}".replace(",", ".")


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def _utm_geom(g):
    return shapely.transform(g, lambda a: np.column_stack(to_utm(a[:, 0], a[:, 1])))


# ---------------------------------------------------------------------------
class Pass1(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.refs = array("q")
        self.ends = array("q")
        self.routes: dict[int, list[dict]] = collections.defaultdict(list)
        self.ways = 0

    def way(self, w):
        hw = w.tags.get("highway")
        if hw not in HIGHWAYS or w.tags.get("area") == "yes":
            return
        nodes = w.nodes
        if len(nodes) < 2:
            return
        self.ways += 1
        self.refs.extend(n.ref for n in nodes)
        self.ends.append(nodes[0].ref)
        self.ends.append(nodes[len(nodes) - 1].ref)

    def relation(self, r):
        if r.tags.get("type") != "route" or r.tags.get("route") != "bicycle":
            return
        info = {"name": r.tags.get("name") or r.tags.get("ref") or "Radroute",
                "net": ROUTE_NETWORK.get(r.tags.get("network", ""), r.tags.get("network", ""))}
        for m in r.members:
            if m.type == "w":
                self.routes[m.ref].append(info)

    def junctions(self) -> set[int]:
        if not self.refs:
            return set()
        ids, counts = np.unique(np.frombuffer(self.refs, dtype=np.int64), return_counts=True)
        j = set(ids[counts >= 2].tolist())
        j.update(np.frombuffer(self.ends, dtype=np.int64).tolist())
        return j


# ---------------------------------------------------------------------------
class Pass2(osmium.SimpleHandler):
    def __init__(self, sink: TileSink, junctions: set[int], routes, area_filter=None, part=0, parts=1, lon_range=None):
        super().__init__()
        self.sink = sink
        # Aufteilung auf Prozesse:
        #  - lon_range=(von, bis, letzter): Streifen-Modus, zuständig für Objekte mit Startpunkt im Streifen
        #  - sonst: ID-Modus, zuständig für Objekte mit id % parts == part
        self.part, self.parts = part, parts
        self.lon_range = lon_range
        self.signals = 0
        self.S0, self.S1, self.S2 = sink.sizes
        self.junctions = junctions
        self.routes = routes
        self.flags: dict[int, str] = {}
        self.inside = area_filter  # vorbereitetes Gebietspolygon (UTM) oder None
        self.wkb = osmium.geom.WKBFactory()
        self.stats = collections.Counter()
        self.km = collections.defaultdict(float)
        self.places = []
        self.bbox = [math.inf, math.inf, -math.inf, -math.inf]
        self.seen = collections.Counter()  # Fortschritt
        self.t_start = self.t_last = time.time()

    def _tick(self, what):
        self.seen[what] += 1
        if self.part != 0 or self.seen[what] % 2000:
            return
        now = time.time()
        if now - self.t_last < 15:
            return
        self.t_last = now
        s = self.seen
        teil = f"Teil 1 von {self.parts}: " if self.parts > 1 else ""
        log(f"  … {teil}{zahl(s['knoten'])} Knoten, {zahl(s['wege'])} Wege, {zahl(s['flaechen'])} Flächen/Gebäude "
            f"gelesen ({now - self.t_start:.0f} s)")

    # -- Zuständigkeit -------------------------------------------------------
    def _own_lon(self, lon) -> bool:
        lo, hi, last = self.lon_range
        return lo <= lon < hi or (last and lon >= hi) or (self.part == 0 and lon < lo)

    def _own_node(self, n) -> bool:
        if self.lon_range:
            return self._own_lon(n.location.lon)
        return n.id % self.parts == self.part

    def _own_way(self, w) -> bool:
        if self.lon_range:
            for nd in w.nodes:
                if nd.location.valid():
                    return self._own_lon(nd.location.lon)
            return False
        return w.id % self.parts == self.part

    def _own_area(self, a) -> bool:
        if self.lon_range:
            for ring in a.outer_rings():
                for nd in ring:
                    return self._own_lon(nd.lon)
            return False
        return a.orig_id() % self.parts == self.part

    # -- Hilfen ----------------------------------------------------------
    def _grow(self, x0, y0, x1, y1):
        b = self.bbox
        b[0], b[1], b[2], b[3] = min(b[0], x0), min(b[1], y0), max(b[2], x1), max(b[3], y1)

    def _in(self, e, n) -> bool:
        return self.inside is None or self.inside.contains(Point(e, n))

    def _add(self, lod, ix, iy, sec, obj_fn):
        ox, oy = self.sink.origin(lod, ix, iy)
        self.sink.add(lod, ix, iy, sec, obj_fn(ox, oy))

    # -- Knoten ------------------------------------------------------------
    def node(self, n):
        self._tick("knoten")
        tags = n.tags
        if not len(tags):
            return
        f = node_flag(tags)
        if f:
            self.flags[n.id] = f
        if not self._own_node(n):
            return
        if f == "traffic_signals":
            self.signals += 1
        place = tags.get("place")
        name = tags.get("name")
        if place in PLACE_RANK and name:
            e, nn = to_utm(n.location.lon, n.location.lat)
            if not self._in(e, nn):
                return
            rank = PLACE_RANK[place]
            pop = tags.get("population")
            rec = {"name": name, "typ": place, "rang": rank}
            if pop and pop.isdigit():
                rec["ew"] = int(pop)
            self.places.append({**rec, "e": round(e, 1), "n": round(nn, 1)})
            for lod, size, maxrank in ((0, self.S0, 6), (1, self.S1, 4), (2, self.S2, 2)):
                if rank > maxrank:
                    continue
                ix, iy = tile_of(e, nn, size)
                self._add(lod, ix, iy, "places", lambda ox, oy: {**rec, "x": enc([(e, nn)], ox, oy)[0], "y": enc([(e, nn)], ox, oy)[1]})
            return
        k = poi_kind(tags)
        if k:
            e, nn = to_utm(n.location.lon, n.location.lat)
            if self._in(e, nn):
                self._poi(k, tags, e, nn)

    def _poi(self, k, tags, e, nn):
        rec = {"k": k}
        if tags.get("name"):
            rec["name"] = tags.get("name")
        ix, iy = tile_of(e, nn, self.S0)
        self._add(0, ix, iy, "pois", lambda ox, oy: {**rec, "x": enc([(e, nn)], ox, oy)[0], "y": enc([(e, nn)], ox, oy)[1]})
        self.stats["pois"] += 1

    # -- Wege --------------------------------------------------------------
    def way(self, w):
        self._tick("wege")
        if not self._own_way(w):
            return
        tags = w.tags
        hw = tags.get("highway")
        if hw in HIGHWAYS and tags.get("area") != "yes":
            self._road(w, dict(tags))
            return
        ww, rw = tags.get("waterway"), tags.get("railway")
        if ww in ("river", "stream", "canal", "ditch", "drain") or rw in ("rail", "light_rail", "tram", "abandoned", "disused", "narrow_gauge"):
            self._line(w, "w:" + ww if ww else "r:" + rw, tags.get("name"))

    def _coords(self, w):
        lons, lats, ids = [], [], []
        for n in w.nodes:
            if not n.location.valid():
                continue
            lons.append(n.location.lon)
            lats.append(n.location.lat)
            ids.append(n.ref)
        if len(ids) < 2:
            return None, None
        e, nn = to_utm(np.array(lons), np.array(lats))
        return ids, list(zip(e.tolist(), nn.tolist()))

    def _line(self, w, kind, name):
        ids, c = self._coords(w)
        if not c:
            return
        rec = {"k": kind}
        if name:
            rec["name"] = name
        for ix, iy in tiles_of_line(c, self.S0, 5):
            self._add(0, ix, iy, "lines", lambda ox, oy: {**rec, "c": enc(c, ox, oy)})
        if kind in ("w:river", "w:canal", "r:rail"):
            s = shapely.simplify(shapely.LineString(c), 10).coords[:]
            for ix, iy in tiles_of_line(s, self.S1):
                self._add(1, ix, iy, "lines", lambda ox, oy: {**rec, "c": enc(s, ox, oy)})

    def _road(self, w, tags):
        m = road_model(w.id, tags)
        if m is None:
            return
        ids, c = self._coords(w)
        if not c:
            return
        if self.routes.get(w.id):
            m["routes"] = sorted({r["name"] for r in self.routes[w.id]})
        cls = m["cls"]
        # an Kreuzungen in Kanten teilen
        cuts = [0] + [i for i in range(1, len(ids) - 1) if ids[i] in self.junctions] + [len(ids) - 1]
        seen = collections.Counter()
        half = m["cw"] + max(m.get("sw_l", 0), m.get("sw_r", 0)) + (2.1 if 3 in (m.get("fac_l"), m.get("fac_r")) else 0)
        for k in range(1, len(cuts)):
            i0, i1 = cuts[k - 1], cuts[k]
            seg = c[i0:i1 + 1]
            a, b = ids[i0], ids[i1]
            eid = f"w{w.id}_{a}_{b}"
            seen[eid] += 1
            if seen[eid] > 1:
                eid += f"_{seen[eid]}"
            length = sum(math.hypot(seg[j][0] - seg[j - 1][0], seg[j][1] - seg[j - 1][1]) for j in range(1, len(seg)))
            mid = seg[len(seg) // 2]
            own = tile_of(mid[0], mid[1], self.S0)
            # unterwegs liegende Merkmale (Zebrastreifen, Ampeln mitten im Abschnitt, Poller)
            extra = [(ids[j], c[j]) for j in range(i0 + 1, i1) if ids[j] in self.flags]
            rec_base = {"id": eid, "w": w.id, "a": a, "b": b, "len": round(length, 1), "m": m}
            for ix, iy in tiles_of_line(seg, self.S0, half + 15):
                o = (ix, iy) == own
                self._add(0, ix, iy, "roads", lambda ox, oy: {**rec_base, "c": enc(seg, ox, oy), **({"own": 1} if o else {})})
            for nid, (ne, nn) in ((a, seg[0]), (b, seg[-1])) + tuple(extra):
                ix, iy = tile_of(ne, nn, self.S0)
                rec = {"id": nid}
                if nid in self.flags:
                    rec["f"] = self.flags[nid]
                if nid not in (a, b):
                    rec["on"] = eid
                self._add(0, ix, iy, "nodes", lambda ox, oy: {**rec, "x": enc([(ne, nn)], ox, oy)[0], "y": enc([(ne, nn)], ox, oy)[1]})
            # Überblick
            if cls in ("auto", "L", "dorf"):
                lm = {k2: m[k2] for k2 in ("cls", "name", "ref", "ms", "cw", "oneway") if k2 in m}
                s1 = shapely.simplify(shapely.LineString(seg), 3).coords[:]
                for ix, iy in tiles_of_line(s1, self.S1, 10):
                    self._add(1, ix, iy, "roads", lambda ox, oy: {"id": eid, "c": enc(s1, ox, oy), "m": lm})
                if cls in ("auto", "L"):
                    s2 = shapely.simplify(shapely.LineString(seg), 20).coords[:]
                    for ix, iy in tiles_of_line(s2, self.S2, 50):
                        self._add(2, ix, iy, "roads", lambda ox, oy: {"id": eid, "c": enc(s2, ox, oy), "m": lm})
            # Statistik
            self._stat_road(m, length, seg)
        xs = [p[0] for p in c]
        ys = [p[1] for p in c]
        self._grow(min(xs), min(ys), max(xs), max(ys))

    def _stat_road(self, m, length, seg):
        if self.inside is not None and not self.inside.contains(Point(seg[len(seg) // 2])):
            return
        km = length / 1000
        cls = m["cls"]
        self.km["klasse:" + cls] += km
        self.stats["kanten"] += 1
        if cls in ("L", "dorf", "wohn", "spiel"):
            self.km["strassen"] += km
            fac = max(m.get("fac_l", 0), m.get("fac_r", 0))
            label = {3: "hochbord", 2: "radstreifen", 1: "schutzstreifen"}.get(fac)
            if m.get("bike") == 2:
                label = "radweg_daneben"
            if m.get("frs"):
                label = "fahrradstrasse"
            self.km["radinfra:" + (label or "mischverkehr")] += km
            if m.get("ms", 50) <= 30:
                self.km["tempo30"] += km
        if cls == "rad":
            self.km["radwege_eigen"] += km
        if m.get("bike") != 0 and cls not in ("auto",):
            surf = m.get("tsurf") if max(m.get("fac_l", 0), m.get("fac_r", 0)) == 3 else m.get("surf")
            self.km["belag:" + surf] += km
            self.km["_zustand_sum"] += km * (m.get("tcond") or m.get("cond", 50))
            self.km["_zustand_km"] += km

    # -- Flächen -----------------------------------------------------------
    def area(self, a):
        self._tick("flaechen")
        if not self._own_area(a):
            return
        tags = a.tags
        kind = area_kind(tags)
        poi = poi_kind(tags) if tags.get("name") else None
        if not kind and not poi:
            return
        if tags.get("highway") and not tags.get("building") and tags.get("area") != "yes":
            return
        try:
            g = _utm_geom(wkb.loads(self.wkb.create_multipolygon(a), hex=True))
        except Exception:
            self.stats["flaeche_fehler"] += 1
            return
        if g.is_empty:
            return
        if poi and kind != ("area", "wasser"):
            c = g.representative_point()
            if self._in(c.x, c.y):
                self._poi(poi, tags, c.x, c.y)
        if not kind:
            return
        typ, val = kind
        x0, y0, x1, y1 = g.bounds
        if typ == "building":
            c = g.centroid
            if not self._in(c.x, c.y):
                return
            ix, iy = tile_of(c.x, c.y, self.S0)
            for poly in getattr(g, "geoms", [g]):
                ring = shapely.simplify(poly.exterior, 0.2).coords[:]
                rec = {"t": val}
                lv = tags.get("building:levels")
                if lv and lv.replace(".", "", 1).isdigit():
                    rec["lv"] = float(lv)
                if tags.get("name"):
                    rec["name"] = tags.get("name")
                self._add(0, ix, iy, "buildings", lambda ox, oy: {**rec, "p": enc(ring, ox, oy)})
            self.stats["gebaeude"] += 1
            return
        # Flächen werden an den Kachelgrenzen zugeschnitten
        self.stats["flaechen"] += 1
        self._clip_area(0, self.S0, g, val, 0.4)
        area_m2 = g.area
        if val in OVERVIEW_AREAS and area_m2 > 4000:
            self._clip_area(1, self.S1, shapely.simplify(g, 6), val, 0)
        if val in OVERVIEW_AREAS and area_m2 > 60000:
            self._clip_area(2, self.S2, shapely.simplify(g, 30), val, 0)

    def _clip_area(self, lod, size, g, kind, simp):
        x0, y0, x1, y1 = g.bounds
        for ix, iy in tiles_in_bbox(x0, y0, x1, y1, size):
            part = shapely.clip_by_rect(g, ix * size, iy * size, (ix + 1) * size, (iy + 1) * size)
            if part.is_empty:
                continue
            if simp:
                part = shapely.simplify(part, simp)
            for poly in getattr(part, "geoms", [part]):
                if not isinstance(poly, Polygon) or poly.is_empty or poly.area < 1:
                    continue
                rings = [poly.exterior.coords[:]] + [r.coords[:] for r in poly.interiors if Polygon(r).area > 4]
                self._add(lod, ix, iy, "areas", lambda ox, oy: {"k": kind, "p": [enc(r, ox, oy) for r in rings]})


# ---------------------------------------------------------------------------
def osm_timestamp(path: pathlib.Path) -> str | None:
    try:
        r = osmium.io.Reader(str(path), osmium.osm.osm_entity_bits.NOTHING)
        h = r.header()
        ts = h.get("osmosis_replication_timestamp") or h.get("timestamp")
        r.close()
        return ts or None
    except Exception:
        return None


# Gemeinsamer Zustand für die Arbeitsprozesse (wird per fork geteilt, nicht kopiert)
_SHARED: dict = {}


def _pass2_part(part: int) -> dict:
    sh = _SHARED
    sink = TileSink(sh["outdir"], sh["sizes"], part)
    strip = sh["strips"][part] if sh.get("strips") else None
    p2 = Pass2(sink, sh["junctions"], sh["routes"], sh["inside"], part, sh["parts"],
               lon_range=strip[1:] if strip else None)
    p2.apply_file(strip[0] if strip else sh["src"], locations=True, idx="flex_mem")
    sink.flush()
    return {"stats": dict(p2.stats), "km": dict(p2.km), "places": p2.places, "bbox": p2.bbox,
            "ampeln": p2.signals}


def _lon_range(src: pathlib.Path):
    """Kleinste und größte Länge aller Knoten (langsam, nur für Tests)."""
    lons = []

    class H(osmium.SimpleHandler):
        def node(self, n):
            lons.append(n.location.lon)
    H().apply_file(str(src))
    return min(lons), max(lons)


def data_bbox(src: pathlib.Path):
    """(min_lon, min_lat, max_lon, max_lat) der Daten per osmium fileinfo."""
    out = subprocess.run(["osmium", "fileinfo", "-e", "-g", "data.bbox", str(src)],
                         check=True, capture_output=True, text=True).stdout
    vals = [float(v) for v in out.strip().strip("()").split(",")]
    return tuple(vals)


def make_strips(src: pathlib.Path, workdir: pathlib.Path, n: int):
    """Datei in n Nord-Süd-Streifen gleicher Breite schneiden (ein Lesedurchgang, osmium extract -c).
    Mit der Strategie 'smart' enthält jeder Streifen alle Wege und Flächen, die ihn berühren, vollständig."""
    x0, y0, x1, y1 = data_bbox(src)
    workdir.mkdir(parents=True, exist_ok=True)
    w = (x1 - x0) / n
    extracts, strips = [], []
    for k in range(n):
        lo, hi = x0 + k * w, x0 + (k + 1) * w
        name = f"streifen_{k:03d}.osm.pbf"
        extracts.append({"output": name, "bbox": [lo, y0 - 0.001, hi if k < n - 1 else x1 + 0.001, y1 + 0.001]})
        strips.append((str(workdir / name), lo, hi, k == n - 1))
    cfg = workdir / "streifen.json"
    cfg.write_text(json.dumps({"directory": str(workdir), "extracts": extracts}), encoding="utf-8")
    subprocess.run(["osmium", "extract", "--overwrite", "-s", "smart", "-c", str(cfg), str(src)],
                   check=True, capture_output=True)
    return strips


def build(region, src: pathlib.Path, outdir: pathlib.Path, poly_utm=None, osm_stand: str | None = None,
          jobs: int = 1, strip_mode: str = "auto") -> dict:
    t0 = time.time()
    outdir.mkdir(parents=True, exist_ok=True)
    log(f"Durchlauf 1: Kreuzungen und Radrouten zählen ({src.name})")
    p1 = Pass1()
    p1.apply_file(str(src), locations=False)
    junctions = p1.junctions()
    n_routes = len({r["name"] for lst in p1.routes.values() for r in lst})
    log(f"  {zahl(p1.ways)} Straßen/Wege, {zahl(len(junctions))} Kreuzungs- und Endknoten, {n_routes} Radrouten")
    del p1.refs, p1.ends

    jobs = max(1, int(jobs))
    strips = None
    if jobs > 1 and strip_mode != "aus":
        if strip_mode == "test":  # nur für Tests: jeder "Streifen" ist die ganze Datei
            x0, x1 = _lon_range(src)
            n = jobs * 3
            strips = [(str(src), x0 + k * (x1 - x0) / n, x0 + (k + 1) * (x1 - x0) / n, k == n - 1) for k in range(n)]
        elif shutil.which("osmium") and src.name.endswith(".pbf"):
            n = min(jobs * 4, 256)
            log(f"In {n} Streifen schneiden (osmium extract)")
            ts = time.time()
            strips = make_strips(src, outdir / "_streifen", n)
            log(f"  fertig in {time.time() - ts:.0f} s")
    parts_n = len(strips) if strips else jobs
    _SHARED.update(outdir=outdir, sizes=tuple(region.kachel_m), junctions=junctions, routes=dict(p1.routes),
                   inside=prep(poly_utm) if poly_utm is not None else None, parts=parts_n, src=str(src), strips=strips)
    modus = f"{parts_n} Streifen" if strips else f"{parts_n} Teile"
    log(f"Durchlauf 2: Straßen, Flächen, Gebäude und Orte in Kacheln schreiben ({jobs} Prozesse, {modus})")
    t2 = time.time()
    if jobs > 1:
        import multiprocessing as mp
        with mp.get_context("fork").Pool(jobs) as pool:
            parts = pool.map(_pass2_part, range(parts_n), chunksize=1)
    else:
        parts = [_pass2_part(0)]
    if strips and strip_mode != "test":
        shutil.rmtree(outdir / "_streifen", ignore_errors=True)
    stats_c, km_c, places = collections.Counter(), collections.defaultdict(float), []
    bbox = [math.inf, math.inf, -math.inf, -math.inf]
    ampeln = 0
    for p in parts:
        stats_c.update(p["stats"])
        for k, v in p["km"].items():
            km_c[k] += v
        places.extend(p["places"])
        b = p["bbox"]
        bbox = [min(bbox[0], b[0]), min(bbox[1], b[1]), max(bbox[2], b[2]), max(bbox[3], b[3])]
        ampeln += p["ampeln"]
    log(f"  {zahl(stats_c['kanten'])} Straßenkanten, {zahl(stats_c['gebaeude'])} Gebäude, "
        f"{zahl(stats_c['flaechen'])} Flächen, {zahl(stats_c['pois'])} Ziele ({time.time() - t2:.0f} s)")

    if poly_utm is not None:
        bx0, by0, bx1, by1 = poly_utm.bounds
    else:
        bx0, by0, bx1, by1 = bbox
    lon0, lat0 = to_wgs(bx0, by0)
    lon1, lat1 = to_wgs(bx1, by1)
    km = dict(km_c)
    zs, zk = km.pop("_zustand_sum", 0), km.pop("_zustand_km", 0)
    stats = {k: round(v, 2) for k, v in sorted(km.items())}
    stats["zustand_rad_mittel"] = round(zs / zk, 1) if zk else None
    stats.update({k: v for k, v in sorted(stats_c.items())})
    stats["ampeln"] = ampeln
    manifest = {
        "name": region.name, "slug": region.slug,
        "generator": f"radwegtycoon-pipeline {__version__}",
        "erstellt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "osm_stand": osm_stand or osm_timestamp(src), "quelle": src.name,
        "bbox_utm": [round(v, 1) for v in (bx0, by0, bx1, by1)],
        "bbox_wgs84": [round(lat0, 6), round(lon0, 6), round(lat1, 6), round(lon1, 6)],
        "gebiet_utm": [[round(x, 1), round(y, 1)] for x, y in
                       (poly_utm.simplify(50).exterior.coords if poly_utm is not None and poly_utm.geom_type == "Polygon" else [])],
        "orte": sorted(places, key=lambda p: (p["rang"], p["name"])),
        "statistik": stats,
        "lizenz": "Kartendaten © OpenStreetMap-Mitwirkende, ODbL 1.0 – https://www.openstreetmap.org/copyright",
    }
    log("Kacheln zusammenbauen")
    t3 = time.time()
    manifest = finalize(outdir, tuple(region.kachel_m), manifest, jobs)
    n_tiles = {k: len(v) for k, v in manifest["tiles"].items()}
    log(f"  fertig in {time.time() - t3:.0f} s")
    log(f"Fertig in {time.time() - t0:.0f} s: Kacheln je Stufe {n_tiles}, "
        f"{sum(manifest['tile_bytes'].values()) / 1e6:.1f} MB")
    return manifest
