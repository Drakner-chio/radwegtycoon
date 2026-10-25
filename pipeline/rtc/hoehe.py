"""Höhen (Topographie) für die Karte: Geländemodell -> Höhenraster je Kachel + Steigungen je Kante.

Quelle in NRW: Digitales Geländemodell DGM1 von Geobasis NRW (1 m, GeoTIFF, 1-km-Kacheln
`dgm1_32_<Ost-km>_<Nord-km>_1_nw_<Jahr>.tif`, UTM 32N – dasselbe 1-km-Raster wie unsere Kacheln).
Eine Liste der Dateien liefert das Download-Verzeichnis selbst (XML).

Ausgabe in `karte/`:
- `hoehe/0/<ix>_<iy>.bin.gz`: 100 × 100 Zellen à 10 m (Zellmitten), Int16 in Dezimetern, Zeilen von
  Nord nach Süd; fehlende Werte = -32768.
- `hoehe/1/<ix>_<iy>.bin.gz`: Überblick (8 km, 100 × 100 Zellen à 80 m), aus Stufe 0 gemittelt.
- `netz.json.gz` bekommt je Kante `auf`, `ab` (Höhenmeter in Zeichenrichtung a -> b, dm) und `steil`
  (größte Steigung über 30 m in Promille).
- `manifest.json`: Eintrag `hoehe` (Raster, Kachellisten, Quelle, min/max).
"""
from __future__ import annotations

import concurrent.futures as cf
import gzip
import json
import math
import pathlib
import re
import urllib.request

import numpy as np

from .build import log

DGM1_NRW = "https://www.opengeodata.nrw.de/produkte/geobasis/hm/dgm1_tiff/dgm1_tiff/"
DATEI_RE = re.compile(r"dgm1_32_(\d{3})_(\d{4})_1_nw_(\d{4})\.tif")
FEHLT = -32768
ZELLEN = 100          # je Kachel und Achse
QUELLEN_TEXT = {"dgm1_nrw": "Geobasis NRW, DGM1 (dl-de/zero-2.0)"}


# ---------------------------------------------------------------- Download
def dgm_liste(cache: pathlib.Path) -> dict[tuple[int, int], str]:
    """(Ost-km, Nord-km) -> Dateiname (jüngstes Jahr). Liste wird zwischengespeichert."""
    f = cache / "dgm1_liste.xml"
    if not f.exists():
        log("Höhen: lade Dateiliste von Geobasis NRW")
        with urllib.request.urlopen(DGM1_NRW, timeout=120) as r:
            f.write_bytes(r.read())
    out: dict[tuple[int, int], tuple[int, str]] = {}
    for m in DATEI_RE.finditer(f.read_text(encoding="utf-8", errors="replace")):
        k = (int(m.group(1)), int(m.group(2)))
        jahr = int(m.group(3))
        if k not in out or out[k][0] < jahr:
            out[k] = (jahr, m.group(0))
    return {k: v[1] for k, v in out.items()}


def lade_dgm(kacheln, ordner: pathlib.Path, jobs: int = 8) -> dict[tuple[int, int], pathlib.Path]:
    ordner.mkdir(parents=True, exist_ok=True)
    liste = dgm_liste(ordner)
    noetig = {k: liste[k] for k in kacheln if k in liste}
    fehlt = [k for k in kacheln if k not in liste]
    if fehlt:
        log(f"Höhen: {len(fehlt)} Kacheln liegen außerhalb von NRW (ohne Höhen)")
    pfade = {k: ordner / n for k, n in noetig.items()}
    offen = [(k, n) for k, n in noetig.items() if not (ordner / n).exists()]
    log(f"Höhen: {len(noetig)} DGM-Kacheln nötig, {len(offen)} noch herunterzuladen")

    def hole(kn):
        k, n = kn
        tmp = ordner / (n + ".part")
        with urllib.request.urlopen(DGM1_NRW + n, timeout=300) as r:
            tmp.write_bytes(r.read())
        tmp.rename(ordner / n)
        return n

    fertig = 0
    with cf.ThreadPoolExecutor(max(1, jobs)) as ex:
        for _ in ex.map(hole, offen):
            fertig += 1
            if fertig % 50 == 0:
                log(f"Höhen: {fertig}/{len(offen)} geladen")
    return pfade


# ---------------------------------------------------------------- Lesen und Rastern
def lies_dgm(pfad: pathlib.Path):
    """-> (Höhen float32 [zeilen, spalten], Ost links, Nord oben, Pixelgröße)."""
    import tifffile
    with tifffile.TiffFile(pfad) as t:
        p = t.pages[0]
        a = p.asarray().astype(np.float32)
        tags = p.tags
        sx, sy = tags["ModelPixelScaleTag"].value[:2]
        tp = tags["ModelTiepointTag"].value
        e0, n0 = tp[3] - tp[0] * sx, tp[4] + tp[1] * sy
        nd = tags.get("GDAL_NODATA")
        if nd is not None:
            try:
                a[a == float(str(nd.value).strip("\x00"))] = np.nan
            except ValueError:
                pass
    a[(a < -500) | (a > 5000)] = np.nan
    return a, e0, n0, sx


def raster_kachel(pfad: pathlib.Path, ix: int, iy: int, T: float = 1000.0) -> np.ndarray:
    """10-m-Zellmittel (100 × 100, Nord oben) für die Kachel ix/iy aus einer DGM-Datei."""
    a, e0, n0, px = lies_dgm(pfad)
    z = T / ZELLEN
    out = np.full((ZELLEN, ZELLEN), np.nan, np.float32)
    k = int(round(z / px))
    # Pixelfenster der Kachel (DGM-Kacheln decken sich normalerweise genau mit unseren)
    c0 = int(round((ix * T - e0) / px))
    r0 = int(round((n0 - (iy + 1) * T) / px))
    n = ZELLEN * k
    sub = np.full((n, n), np.nan, np.float32)
    rr0, cc0 = max(0, r0), max(0, c0)
    rr1, cc1 = min(a.shape[0], r0 + n), min(a.shape[1], c0 + n)
    if rr1 > rr0 and cc1 > cc0:
        sub[rr0 - r0:rr1 - r0, cc0 - c0:cc1 - c0] = a[rr0:rr1, cc0:cc1]
    with np.errstate(invalid="ignore"):
        blk = sub.reshape(ZELLEN, k, ZELLEN, k)
        cnt = np.sum(~np.isnan(blk), axis=(1, 3))
        s = np.nansum(blk, axis=(1, 3))
        out = np.where(cnt > 0, s / np.maximum(cnt, 1), np.nan).astype(np.float32)
    return out


def fuelle(g: np.ndarray) -> np.ndarray:
    """Einzelne Lücken mit dem Mittel der Nachbarn füllen (mehrere Durchläufe)."""
    import warnings
    g = g.copy()
    for _ in range(12):
        m = np.isnan(g)
        if not m.any() or m.all():
            break
        p = np.pad(g, 1, constant_values=np.nan)
        nb = np.stack([p[:-2, 1:-1], p[2:, 1:-1], p[1:-1, :-2], p[1:-1, 2:]])
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            mean = np.nanmean(nb, axis=0)
        g[m] = mean[m]
    return g


def schreibe(g: np.ndarray, pfad: pathlib.Path):
    pfad.parent.mkdir(parents=True, exist_ok=True)
    v = np.where(np.isnan(g), FEHLT, np.round(g * 10)).astype("<i2")
    pfad.write_bytes(gzip.compress(v.tobytes(), 6, mtime=0))


# ---------------------------------------------------------------- Höhenfunktion für Kanten
class Gelaende:
    """Bilinear interpolierte Höhe (UTM) über die 10-m-Zellmitten aller Kacheln."""

    def __init__(self, gitter: dict[tuple[int, int], np.ndarray], T: float = 1000.0):
        self.g, self.T, self.z = gitter, T, T / ZELLEN

    def zelle(self, cx: int, cy: int) -> float:
        # cx, cy: globale Zellindizes (Ost, Nord von Süden gezählt)
        n = ZELLEN
        k = self.g.get((cx // n, cy // n))
        if k is None:
            return math.nan
        return float(k[n - 1 - (cy % n), cx % n])

    def __call__(self, e: float, nn: float) -> float:
        fx, fy = e / self.z - .5, nn / self.z - .5
        x0, y0 = math.floor(fx), math.floor(fy)
        tx, ty = fx - x0, fy - y0
        v = [self.zelle(x0, y0), self.zelle(x0 + 1, y0), self.zelle(x0, y0 + 1), self.zelle(x0 + 1, y0 + 1)]
        w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty]
        s = sum(wi for vi, wi in zip(v, w) if not math.isnan(vi))
        if s <= 0:
            return math.nan
        return sum(vi * wi for vi, wi in zip(v, w) if not math.isnan(vi)) / s


def profil(coords, h: Gelaende, schritt: float = 10.0):
    """Höhenmeter auf/ab (a -> b) und größte Steigung über 30 m (Promille) entlang einer Polylinie."""
    pts = []
    for (e0, n0), (e1, n1) in zip(coords, coords[1:]):
        l = math.hypot(e1 - e0, n1 - n0)
        k = max(1, int(l // schritt))
        for i in range(k):
            pts.append((e0 + (e1 - e0) * i / k, n0 + (n1 - n0) * i / k))
    pts.append(coords[-1])
    z = [h(e, n) for e, n in pts]
    if all(math.isnan(v) for v in z):
        return None
    # Lücken überbrücken
    last = next(v for v in z if not math.isnan(v))
    for i, v in enumerate(z):
        if math.isnan(v):
            z[i] = last
        else:
            last = v
    s = [0.0]
    for (e0, n0), (e1, n1) in zip(pts, pts[1:]):
        s.append(s[-1] + math.hypot(e1 - e0, n1 - n0))
    auf = sum(max(0.0, b - a) for a, b in zip(z, z[1:]))
    ab = sum(max(0.0, a - b) for a, b in zip(z, z[1:]))
    steil = 0.0
    j = 0
    for i in range(len(z)):
        while j < len(z) - 1 and s[j] - s[i] < 30:
            j += 1
        d = s[j] - s[i]
        if d >= 15:
            steil = max(steil, abs(z[j] - z[i]) / d)
    return auf, ab, steil


# ---------------------------------------------------------------- Hauptschritt
def bauen_hoehe(karte: pathlib.Path, quellordner: pathlib.Path, quelle: str = "dgm1_nrw",
                dgm_ordner: pathlib.Path | None = None, jobs: int = 8) -> dict | None:
    man_f = karte / "manifest.json"
    man = json.loads(man_f.read_text(encoding="utf-8"))
    T0, T1 = man["tile_size_m"][0], man["tile_size_m"][1]
    if T0 != 1000:
        log("Höhen: nur für 1-km-Detailkacheln umgesetzt – übersprungen")
        return None
    kacheln = [tuple(k) for k in man["tiles"]["0"]]
    if dgm_ordner:  # eigene Dateien (Tests, Offline)
        pfade = {}
        for p in pathlib.Path(dgm_ordner).glob("*.tif"):
            m = DATEI_RE.search(p.name)
            if m:
                pfade[(int(m.group(1)), int(m.group(2)))] = p
        pfade = {k: v for k, v in pfade.items() if k in set(kacheln)}
    else:
        pfade = lade_dgm(kacheln, quellordner / "dgm1", jobs)
    log(f"Höhen: rastere {len(pfade)} Kacheln auf 10 m")
    gitter: dict[tuple[int, int], np.ndarray] = {}
    with cf.ProcessPoolExecutor(max(1, jobs)) as ex:
        futs = {ex.submit(raster_kachel, p, k[0], k[1]): k for k, p in pfade.items()}
        for f in cf.as_completed(futs):
            g = f.result()
            if not np.isnan(g).all():
                gitter[futs[f]] = fuelle(g)
    if not gitter:
        log("Höhen: keine Daten gefunden")
        return None
    aus = karte / "hoehe"
    for (ix, iy), g in gitter.items():
        schreibe(g, aus / "0" / f"{ix}_{iy}.bin.gz")
    # Überblick: 8 km, 80-m-Zellen
    f1 = T1 // T0
    stufe1 = []
    for (jx, jy) in sorted({(ix // f1, iy // f1) for ix, iy in gitter}):
        big = np.full((ZELLEN * f1, ZELLEN * f1), np.nan, np.float32)
        for dx in range(f1):
            for dy in range(f1):
                g = gitter.get((jx * f1 + dx, jy * f1 + dy))
                if g is not None:
                    r = (f1 - 1 - dy) * ZELLEN
                    big[r:r + ZELLEN, dx * ZELLEN:(dx + 1) * ZELLEN] = g
        k = big.shape[0] // ZELLEN
        with np.errstate(invalid="ignore"):
            blk = big.reshape(ZELLEN, k, ZELLEN, k)
            cnt = np.sum(~np.isnan(blk), axis=(1, 3))
            g1 = np.where(cnt > 0, np.nansum(blk, axis=(1, 3)) / np.maximum(cnt, 1), np.nan)
        schreibe(g1, aus / "1" / f"{jx}_{jy}.bin.gz")
        stufe1.append([jx, jy])
    werte = np.concatenate([g[~np.isnan(g)] for g in gitter.values()])
    # Steigungen je Kante ins Verkehrsnetz
    netz_f = karte / "netz.json.gz"
    n_kanten = 0
    if netz_f.exists():
        netz = json.loads(gzip.decompress(netz_f.read_bytes()))
        h = Gelaende(gitter, T0)
        geo = _kanten_geometrie(karte, man)
        K = netz["kanten"]
        auf, ab, steil = [], [], []
        for eid in K["id"]:
            c = geo.get(eid)
            p = profil(c, h) if c and len(c) >= 2 else None
            if p is None:
                auf.append(-1); ab.append(-1); steil.append(-1)
            else:
                auf.append(round(p[0] * 10)); ab.append(round(p[1] * 10)); steil.append(round(p[2] * 1000))
                n_kanten += 1
        K["auf"], K["ab"], K["steil"] = auf, ab, steil
        netz_f.write_bytes(gzip.compress(json.dumps(netz, separators=(",", ":"), ensure_ascii=False).encode(), 6, mtime=0))
        man["netz"]["bytes"] = netz_f.stat().st_size
    man["hoehe"] = {"quelle": QUELLEN_TEXT.get(quelle, quelle), "zellen": ZELLEN, "raster_m": [T0 / ZELLEN, T1 / ZELLEN],
                    "tiles": {"0": sorted([list(k) for k in gitter]), "1": stufe1},
                    "min": round(float(werte.min()), 1), "max": round(float(werte.max()), 1), "fehlt": FEHLT}
    man["statistik"]["hoehe_min"] = man["hoehe"]["min"]
    man["statistik"]["hoehe_max"] = man["hoehe"]["max"]
    man_f.write_text(json.dumps(man, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"Höhen: {len(gitter)} Kacheln, {man['hoehe']['min']:.0f}–{man['hoehe']['max']:.0f} m, "
        f"Steigungen für {n_kanten} Kanten")
    return man["hoehe"]


def _kanten_geometrie(karte: pathlib.Path, man: dict) -> dict[str, list]:
    """Kanten-ID -> UTM-Koordinaten aus den eigenen Kanten der Detailkacheln."""
    out = {}
    for ix, iy in man["tiles"]["0"]:
        t = json.loads(gzip.decompress((karte / "tiles" / "0" / f"{ix}_{iy}.json.gz").read_bytes()))
        ox, oy = t["origin"]
        sc = t.get("scale", 10)
        for r in t.get("roads", []):
            if r.get("own"):
                c = r["c"]
                out[r["id"]] = [(ox + c[i] / sc, oy + c[i + 1] / sc) for i in range(0, len(c), 2)]
    return out
