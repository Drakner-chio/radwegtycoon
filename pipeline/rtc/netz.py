"""Verkehrsnetz und Verkehrszellen für das Verkehrsmodell (Ebene 1).

Liest die fertigen Detailkacheln (Stufe 0) und schreibt `karte/netz.json.gz`:
- Graph: Knoten (Kreuzungen/Enden) und Kanten mit den routing-relevanten Feldern des Spielmodells,
  spaltenweise gespeichert (kompakt, im Browser schnell in Typed Arrays umzuwandeln).
- Zellen (Raster, Standard 500 m): geschätzte Einwohner aus Wohngebäuden, Arbeitsplätze aus
  Gewerbegebäuden und Ziele (Schulen, Läden, Versorgung, Freizeit, Bahnhöfe) aus den POIs,
  jeweils an den nächsten mit dem Rad erreichbaren Knoten gehängt.

Alle Schätzungen sind deterministisch (keine Zufallszahlen) und stehen unter `schaetzung` in der Datei.
"""
from __future__ import annotations

import collections
import gzip
import json
import math
import multiprocessing as mp
import pathlib

from .build import log

FORMAT_NETZ = 2  # 2: knoten.id/ampel, Kante round
ZELLE_M = 500

# Gebäudearten -> Wohnen / Arbeit. "yes" (unbekannt) wird nach Grundfläche aufgeteilt.
WOHNEN = {"house", "residential", "apartments", "detached", "semidetached_house", "terrace", "farm",
          "bungalow", "dormitory", "semi", "villa", "cabin"}
ARBEIT = {"commercial", "industrial", "retail", "office", "warehouse", "manufacture", "supermarket",
          "school", "hospital", "public", "civic", "government", "university", "college", "kindergarten",
          "hotel", "farm_auxiliary", "service"}
STOCKWERKE = {"apartments": 3.0, "house": 1.6, "detached": 1.6, "semidetached_house": 1.6, "terrace": 1.8,
              "residential": 2.0, "farm": 1.5, "bungalow": 1.0, "dormitory": 3.0}
M2_JE_EW = 45.0       # Wohnfläche je Einwohner (inkl. Leerstand grob)
NUTZ = 0.75           # Anteil Wohnfläche an Brutto-Grundfläche
M2_JE_JOB = {"warehouse": 150.0, "industrial": 90.0, "manufacture": 90.0}
M2_JE_JOB_STD = 45.0

POI_GRUPPE = {
    "schule": {"amenity:school", "amenity:kindergarten", "amenity:university", "amenity:college"},
    "versorgung": {"amenity:doctors", "amenity:hospital", "amenity:dentist", "amenity:pharmacy", "amenity:bank",
                   "amenity:post_office", "amenity:townhall", "amenity:library", "amenity:community_centre"},
    "bahnhof": {"railway:station", "railway:halt", "public_transport:station", "amenity:bus_station"},
}
FREIZEIT_PREFIX = ("leisure:", "tourism:")
FREIZEIT = {"amenity:restaurant", "amenity:cafe", "amenity:fast_food", "amenity:theatre", "amenity:cinema",
            "amenity:place_of_worship"}

KANTEN_FELDER = ("ms", "bike", "car", "fac_l", "fac_r", "frs", "cond", "tcond", "oneway", "round")


def _flaeche(p, sc):
    """Shoelace auf Kachelkoordinaten (Dezimeter) -> m²."""
    n = len(p) // 2
    s = 0.0
    for i in range(n):
        j = (i + 1) % n
        s += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1]
    return abs(s) / 2 / (sc * sc)


def _gebaeude(b, sc):
    """-> (einwohner, arbeitsplätze) für ein Gebäude."""
    t = b.get("t", "yes")
    a = _flaeche(b["p"], sc)
    if a < 25:  # Garagen, Schuppen
        return 0.0, 0.0
    lv = b.get("lv")
    if t in WOHNEN or (t == "yes" and a <= 350):
        st = lv or STOCKWERKE.get(t, 1.5)
        f = 1.0 if t in WOHNEN else 0.7  # "yes": nicht jedes kleine Gebäude ist ein Wohnhaus
        return a * st * NUTZ / M2_JE_EW * f, 0.0
    if t in ARBEIT or t == "yes":
        st = lv or 1.5
        return 0.0, a * st / M2_JE_JOB.get(t, M2_JE_JOB_STD)
    return 0.0, 0.0


def _kachel(path):
    t = json.loads(gzip.decompress(pathlib.Path(path).read_bytes()))
    ox, oy = t["origin"]
    sc = t.get("scale", 10)
    kanten = []
    for r in t.get("roads", []):
        if not r.get("own"):
            continue
        c = r["c"]
        m = r["m"]
        kanten.append((r["id"], r["a"], r["b"], r["len"],
                       (ox + c[0] / sc, oy + c[1] / sc), (ox + c[-2] / sc, oy + c[-1] / sc),
                       {k: m[k] for k in ("cls", "surf", "tsurf", *KANTEN_FELDER) if k in m}))
    zellen = collections.defaultdict(lambda: collections.Counter())
    for b in t.get("buildings", []):
        p = b["p"]
        n = len(p) // 2
        cx = ox + sum(p[0::2]) / n / sc
        cy = oy + sum(p[1::2]) / n / sc
        ew, job = _gebaeude(b, sc)
        if ew or job:
            z = zellen[(int(cx // ZELLE_M), int(cy // ZELLE_M))]
            z["ew"] += ew
            z["arbeit"] += job
    for p in t.get("pois", []):
        k = p["k"]
        x, y = ox + p["x"] / sc, oy + p["y"] / sc
        z = zellen[(int(x // ZELLE_M), int(y // ZELLE_M))]
        for g, ks in POI_GRUPPE.items():
            if k in ks:
                z[g] += 1
                break
        else:
            if k.startswith("shop:") or k == "amenity:marketplace":
                z["einkauf"] += 1
            elif k.startswith(FREIZEIT_PREFIX) or k in FREIZEIT:
                z["freizeit"] += 1
    ampeln = [n["id"] for n in t.get("nodes", []) if n.get("f") == "traffic_signals" and not n.get("on")]
    return kanten, {k: dict(v) for k, v in zellen.items()}, ampeln


def bauen_netz(karte: pathlib.Path, jobs: int = 1) -> dict:
    man_f = karte / "manifest.json"
    man = json.loads(man_f.read_text(encoding="utf-8"))
    E0, N0 = man["bbox_utm"][0], man["bbox_utm"][3]
    pfade = [str(karte / "tiles" / "0" / f"{ix}_{iy}.json.gz") for ix, iy in man["tiles"]["0"]]
    log(f"Verkehrsnetz: lese {len(pfade)} Detailkacheln")
    if jobs > 1 and len(pfade) > 8:
        with mp.get_context("fork").Pool(jobs) as pool:
            teile = pool.map(_kachel, pfade, chunksize=8)
    else:
        teile = [_kachel(p) for p in pfade]

    # Kanten sammeln (eigene Kanten sind eindeutig), deterministisch sortiert
    alle = sorted((k for kk, _, _ in teile for k in kk), key=lambda k: k[0])
    ampeln = {a for _, _, aa in teile for a in aa}
    knoten_idx: dict[int, int] = {}
    kx, ky = [], []

    def knoten(osm, xy):
        i = knoten_idx.get(osm)
        if i is None:
            i = knoten_idx[osm] = len(kx)
            kx.append(round(xy[0] - E0, 1))
            ky.append(round(N0 - xy[1], 1))
        return i

    klassen, belaege = [], []
    kl_i, be_i = {}, {}

    def idx(tab, lst, v):
        if v is None:
            return -1
        if v not in tab:
            tab[v] = len(lst)
            lst.append(v)
        return tab[v]

    K = collections.defaultdict(list)
    for eid, a, b, ln, pa, pb, m in alle:
        K["id"].append(eid)
        K["a"].append(knoten(a, pa))
        K["b"].append(knoten(b, pb))
        K["len"].append(round(ln, 1))
        K["cls"].append(idx(kl_i, klassen, m.get("cls")))
        K["surf"].append(idx(be_i, belaege, m.get("surf")))
        K["tsurf"].append(idx(be_i, belaege, m.get("tsurf")))
        for f in KANTEN_FELDER:
            v = m.get(f)
            K[f].append(-1 if v is None else (round(v) if isinstance(v, float) else int(v)))

    knoten_ids = [0] * len(kx)
    for osm, i in knoten_idx.items():
        knoten_ids[i] = osm

    # Zellen zusammenführen
    zellen = collections.defaultdict(collections.Counter)
    for _, zz, _ in teile:
        for k, v in zz.items():
            zellen[k].update(v)

    # Zellen an den nächsten fürs Rad nutzbaren Knoten hängen (Raster-Suche)
    nutzbar = set()
    i_auto = kl_i.get("auto")
    i_treppe = kl_i.get("treppe")
    for a, b, c, bk in zip(K["a"], K["b"], K["cls"], K["bike"]):
        if c not in (i_auto, i_treppe) and bk != 0:
            nutzbar.add(a)
            nutzbar.add(b)
    G = 250.0
    gitter = collections.defaultdict(list)
    for i in nutzbar:
        gitter[(int(kx[i] // G), int(ky[i] // G))].append(i)

    def naechster(x, y):
        gx, gy = int(x // G), int(y // G)
        for r in range(0, 9):
            best, bd = -1, 1e18
            for ix in range(gx - r, gx + r + 1):
                for iy in range(gy - r, gy + r + 1):
                    if max(abs(ix - gx), abs(iy - gy)) != r:
                        continue
                    for i in gitter.get((ix, iy), ()):
                        d = (kx[i] - x) ** 2 + (ky[i] - y) ** 2
                        if d < bd:
                            bd, best = d, i
            if best >= 0 and math.sqrt(bd) <= (r + 1) * G:
                return best, math.sqrt(bd)
        return -1, 0.0

    Z = collections.defaultdict(list)
    gruppen = ("ew", "arbeit", "einkauf", "schule", "versorgung", "freizeit", "bahnhof")
    ew_sum = 0.0
    for (zx, zy) in sorted(zellen):
        v = zellen[(zx, zy)]
        if v.get("ew", 0) < 5 and sum(v.get(g, 0) for g in gruppen[1:]) < 1:
            continue
        x = (zx + 0.5) * ZELLE_M - E0
        y = N0 - (zy + 0.5) * ZELLE_M
        k, d = naechster(x, y)
        if k < 0:
            continue
        Z["x"].append(round(x))
        Z["y"].append(round(y))
        Z["knoten"].append(k)
        Z["anbindung"].append(round(d))
        for g in gruppen:
            Z[g].append(round(v.get(g, 0), 1))
        ew_sum += v.get("ew", 0)

    netz = {
        "format": FORMAT_NETZ, "zelle_m": ZELLE_M, "bbox_utm": man["bbox_utm"],
        "klassen": klassen, "belaege": belaege,
        "knoten": {"x": kx, "y": ky, "id": knoten_ids, "ampel": [1 if i in ampeln else 0 for i in knoten_ids]},
        "kanten": dict(K),
        "zonen": dict(Z),
        "schaetzung": {"m2_je_ew": M2_JE_EW, "nutzanteil": NUTZ, "m2_je_job": M2_JE_JOB_STD,
                       "hinweis": "Einwohner und Arbeitsplätze aus Gebäudegrundflächen geschätzt"},
    }
    raw = json.dumps(netz, separators=(",", ":"), ensure_ascii=False).encode()
    out = karte / "netz.json.gz"
    out.write_bytes(gzip.compress(raw, 6, mtime=0))
    man["netz"] = {"datei": "netz.json.gz", "bytes": out.stat().st_size, "format": FORMAT_NETZ,
                   "knoten": len(kx), "kanten": len(K["id"]), "zonen": len(Z["x"])}
    man["statistik"]["einwohner_geschaetzt"] = round(ew_sum)
    man_f.write_text(json.dumps(man, ensure_ascii=False, indent=1), encoding="utf-8")
    z = lambda v: f"{v:,}".replace(",", ".")
    log(f"Verkehrsnetz: {z(len(kx))} Knoten, {z(len(K['id']))} Kanten, {z(len(Z['x']))} Zellen, "
        f"~{z(round(ew_sum))} Einwohner geschätzt, {out.stat().st_size / 1e6:.1f} MB")
    return man["netz"]
