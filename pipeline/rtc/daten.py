"""Echte Daten zur Karte: Einwohner (Zensus 2022), Unfälle (Unfallatlas), gezählter Kfz-Verkehr (Straßen.NRW).

Alle Quellen sind offen (Datenlizenz Deutschland – Namensnennung 2.0) und werden in `/data/quellen/` zwischengespeichert:
- Zensus 2022, Bevölkerung im 100-m-Gitter (ETRS89-LAEA, EPSG:3035) – Statistisches Bundesamt
- Unfallatlas, Unfallorte mit Personenschaden je Jahr (EPSG:25832) – Statistische Ämter des Bundes und der Länder
- Verkehrswerte (DTV je Abschnitt der Bundes-, Landes- und Kreisstraßen in NRW) – Landesbetrieb Straßenbau NRW

Der Schritt ändert `netz.json.gz` an Ort und Stelle (andere Spalten wie Steigungen bleiben erhalten):
- Zellen: Einwohner aus dem Zensus statt aus Gebäuden geschätzt (`ew_quelle`), neue Zellen wo nötig
- Kanten: `unf_rad`, `unf_rad_schwer` (Radunfälle im Zeitraum), `dtv`, `dtv_sv` (Kfz bzw. Schwerverkehr je Tag)
und schreibt `unfaelle.json.gz` (Punkte mit Merkmalen, für die Unfälle-Ebene im Spiel).
"""
from __future__ import annotations

import collections
import csv
import datetime
import gzip
import io
import json
import math
import pathlib
import urllib.request
import zipfile

from .build import log

ZENSUS_URL = "https://www.destatis.de/static/DE/zensus/gitterdaten/Zensus2022_Bevoelkerungszahl.zip"
UNFALL_URL = "https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/Unfallorte{jahr}_EPSG25832_CSV.zip"
# NRW ist erst ab 2019 im Unfallatlas; frühere Jahre enthielten nur Nachbarländer (z. B. Niedersachsen).
# Damit alle Teile des Gebiets denselben Zeitraum haben, beginnen wir 2019.
UNFALL_JAHRE = range(2019, datetime.date.today().year + 1)  # vorhandene Jahre werden genommen, fehlende übersprungen
VERKEHRSWERTE_URL = "https://www.opengeodata.nrw.de/produkte/transport_verkehr/strassennetz/Verkehrswerte_EPSG25832_Shape.zip"

QUELLEN = {
    "zensus": "Zensus 2022 © Statistisches Bundesamt (Destatis), dl-de/by-2-0",
    "unfaelle": "Unfallatlas © Statistische Ämter des Bundes und der Länder, dl-de/by-2-0",
    "verkehrswerte": "Verkehrswerte © Landesbetrieb Straßenbau NRW, dl-de/by-2-0",
}


# ---------------------------------------------------------------- Hilfen
def tsd(v) -> str:
    return f"{v:,}".replace(",", ".")


def hole(url: str, ziel: pathlib.Path, pflicht: bool = True) -> pathlib.Path | None:
    if ziel.exists():
        return ziel
    ziel.parent.mkdir(parents=True, exist_ok=True)
    try:
        log(f"Daten: lade {url.rsplit('/', 1)[-1]}")
        with urllib.request.urlopen(url, timeout=300) as r:
            tmp = ziel.with_suffix(ziel.suffix + ".part")
            tmp.write_bytes(r.read())
            tmp.rename(ziel)
        return ziel
    except Exception as e:  # noqa: BLE001 – fehlende Jahre sind normal
        if pflicht:
            raise
        log(f"Daten: {url.rsplit('/', 1)[-1]} nicht verfügbar ({e.__class__.__name__})")
        return None


def _tabelle_aus_zip(z: zipfile.ZipFile, muster: str) -> bytes | None:
    """Erste Tabelle im ZIP: .csv bevorzugt, sonst .txt (ältere Jahrgänge), auch in einem inneren ZIP."""
    namen = [n for n in z.namelist() if not n.endswith("/") and muster.lower() in n.lower()]
    for endung in (".csv", ".txt"):
        passend = sorted(n for n in namen if n.lower().endswith(endung))
        if passend:
            return z.read(passend[0])
    for n in sorted(n for n in z.namelist() if n.lower().endswith(".zip")):
        with zipfile.ZipFile(io.BytesIO(z.read(n))) as innen:
            if (roh := _tabelle_aus_zip(innen, muster)) is not None:
                return roh
    return None


def csv_aus_zip(pfad: pathlib.Path, muster: str = ""):
    """Zeilen (dict) der ersten passenden Tabelle im ZIP; Trennzeichen und Kodierung werden erkannt."""
    with zipfile.ZipFile(pfad) as z:
        roh = _tabelle_aus_zip(z, muster)
        if roh is None:
            raise ValueError(f"keine Tabelle (.csv/.txt) in {pfad.name}: {', '.join(z.namelist()[:6])}")
    for kod in ("utf-8-sig", "cp1252"):
        try:
            text = roh.decode(kod)
            break
        except UnicodeDecodeError:
            continue
    kopf = text.split("\n", 1)[0]
    trenner = ";" if kopf.count(";") >= kopf.count(",") else ","
    return csv.DictReader(io.StringIO(text), delimiter=trenner)


def zahl(v) -> float | None:
    if v is None:
        return None
    v = str(v).strip().replace("–", "").replace("–", "")
    if not v or v in ("-", "."):
        return None
    if "," in v and "." in v:
        v = v.replace(".", "").replace(",", ".")
    else:
        v = v.replace(",", ".")
    try:
        return float(v)
    except ValueError:
        return None


def feld(zeile: dict, *namen):
    """Spalte unabhängig von Groß-/Kleinschreibung und Jahrgangs-Varianten."""
    low = {k.lower().strip(): v for k, v in zeile.items() if k}
    for n in namen:
        if n.lower() in low:
            return low[n.lower()]
    return None


class Gitter:
    """Räumlicher Index für Liniensegmente (Kanten oder Verkehrswerte-Abschnitte)."""

    def __init__(self, zelle: float = 50.0):
        self.z = zelle
        self.zellen: dict[tuple[int, int], list] = collections.defaultdict(list)

    def linie(self, schluessel, coords):
        for (x0, y0), (x1, y1) in zip(coords, coords[1:]):
            l = math.hypot(x1 - x0, y1 - y0)
            k = max(1, int(l // (self.z / 2)))
            seen = set()
            for i in range(k + 1):
                x, y = x0 + (x1 - x0) * i / k, y0 + (y1 - y0) * i / k
                c = (int(x // self.z), int(y // self.z))
                if c not in seen:
                    seen.add(c)
                    self.zellen[c].append((schluessel, x0, y0, x1, y1))

    def naechste(self, x, y, maxd):
        """-> {schluessel: (abstand, richtung)} der Segmente bis maxd."""
        out = {}
        cx, cy = int(x // self.z), int(y // self.z)
        r = int(maxd // self.z) + 1
        for i in range(cx - r, cx + r + 1):
            for j in range(cy - r, cy + r + 1):
                for s, x0, y0, x1, y1 in self.zellen.get((i, j), ()):
                    dx, dy = x1 - x0, y1 - y0
                    l2 = dx * dx + dy * dy or 1e-9
                    t = max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / l2))
                    d = math.hypot(x0 + dx * t - x, y0 + dy * t - y)
                    if d <= maxd and (s not in out or d < out[s][0]):
                        out[s] = (d, math.atan2(dy, dx))
        return out


def kanten_aus_kacheln(karte: pathlib.Path, man: dict) -> dict[str, dict]:
    """Kanten-ID -> {c: UTM-Koordinaten, cls, ref} aus den eigenen Kanten der Detailkacheln."""
    out = {}
    for ix, iy in man["tiles"]["0"]:
        t = json.loads(gzip.decompress((karte / "tiles" / "0" / f"{ix}_{iy}.json.gz").read_bytes()))
        ox, oy = t["origin"]
        sc = t.get("scale", 10)
        for r in t.get("roads", []):
            if r.get("own"):
                c = r["c"]
                out[r["id"]] = {"c": [(ox + c[i] / sc, oy + c[i + 1] / sc) for i in range(0, len(c), 2)],
                                "cls": r["m"].get("cls"), "ref": r["m"].get("ref")}
    return out


def punkt_bei(coords, f):
    ls = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(coords, coords[1:])]
    ziel, acc = sum(ls) * f, 0.0
    for (a, b), l in zip(zip(coords, coords[1:]), ls):
        if acc + l >= ziel and l > 0:
            t = (ziel - acc) / l
            return a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, math.atan2(b[1] - a[1], b[0] - a[0])
        acc += l
    a, b = coords[-2], coords[-1]
    return b[0], b[1], math.atan2(b[1] - a[1], b[0] - a[0])


# ---------------------------------------------------------------- Zensus
def zensus_zellen(zip_pfad: pathlib.Path, bbox_utm, rand: float = 600.0) -> dict[tuple[int, int], float]:
    """Einwohner je 100-m-Zelle im Gebiet -> {(Ost, Nord) der Zellmitte in UTM: Einwohner}."""
    from pyproj import Transformer
    zu_utm = Transformer.from_crs("EPSG:3035", "EPSG:25832", always_xy=True)
    zu_laea = Transformer.from_crs("EPSG:25832", "EPSG:3035", always_xy=True)
    x0, y0, x1, y1 = bbox_utm
    ecken = [zu_laea.transform(x, y) for x in (x0 - rand, x1 + rand) for y in (y0 - rand, y1 + rand)]
    lx0, lx1 = min(e[0] for e in ecken), max(e[0] for e in ecken)
    ly0, ly1 = min(e[1] for e in ecken), max(e[1] for e in ecken)
    out = {}
    n = 0
    for z in csv_aus_zip(zip_pfad, "100m"):
        x, y = zahl(feld(z, "x_mp_100m", "x_mp")), zahl(feld(z, "y_mp_100m", "y_mp"))
        if x is None or y is None or not (lx0 <= x <= lx1 and ly0 <= y <= ly1):
            continue
        ew = zahl(feld(z, "Einwohner", "einwohner", "Insgesamt_Bevoelkerung")) or 0.0
        e, nn = zu_utm.transform(x, y)
        if x0 - rand <= e <= x1 + rand and y0 - rand <= nn <= y1 + rand and ew > 0:
            out[(e, nn)] = ew
            n += ew
    log(f"Daten: Zensus – {tsd(len(out))} bewohnte 100-m-Zellen, {tsd(round(n))} Einwohner im Gebiet")
    return out


def zensus_in_netz(netz: dict, zellen100: dict, E0: float, N0: float):
    """Einwohner der Zonen (500 m) durch Zensuswerte ersetzen; fehlende bewohnte Zellen als neue Zonen anlegen."""
    zm = netz["zelle_m"]
    Z = netz["zonen"]
    summe = collections.Counter()
    for (e, n), ew in zellen100.items():
        summe[(int(e // zm), int(n // zm))] += ew
    idx = {}
    for i, (x, y) in enumerate(zip(Z["x"], Z["y"])):
        idx[(int((x + E0) // zm), int((N0 - y) // zm))] = i
    # Knoten, die fürs Rad nutzbar sind, für neue Zonen
    K, kn = netz["kanten"], netz["knoten"]
    kl = netz["klassen"]
    nutzbar = set()
    for a, b, c, bk in zip(K["a"], K["b"], K["cls"], K["bike"]):
        if kl[c] not in ("auto", "treppe") and bk != 0:
            nutzbar.update((a, b))
    G = 250.0
    gitter = collections.defaultdict(list)
    for i in nutzbar:
        gitter[(int(kn["x"][i] // G), int(kn["y"][i] // G))].append(i)

    def naechster(x, y):
        gx, gy = int(x // G), int(y // G)
        for r in range(9):
            best, bd = -1, 1e18
            for i in range(gx - r, gx + r + 1):
                for j in range(gy - r, gy + r + 1):
                    if max(abs(i - gx), abs(j - gy)) != r:
                        continue
                    for k in gitter.get((i, j), ()):
                        d = (kn["x"][k] - x) ** 2 + (kn["y"][k] - y) ** 2
                        if d < bd:
                            bd, best = d, k
            if best >= 0:
                return best, math.sqrt(bd)
        return -1, 0.0

    neu = 0
    for i in range(len(Z["x"])):
        Z["ew"][i] = 0.0
    for (zx, zy), ew in sorted(summe.items()):
        i = idx.get((zx, zy))
        if i is None:
            x, y = (zx + .5) * zm - E0, N0 - (zy + .5) * zm
            k, d = naechster(x, y)
            if k < 0:
                continue
            for f in Z:
                if f not in ("x", "y", "knoten", "anbindung"):
                    Z[f].append(0.0)
            Z["x"].append(round(x)); Z["y"].append(round(y)); Z["knoten"].append(k); Z["anbindung"].append(round(d))
            i = len(Z["x"]) - 1
            neu += 1
        Z["ew"][i] = round(ew, 1)
    netz["ew_quelle"] = "zensus2022"
    return neu


# ---------------------------------------------------------------- Unfälle
def unfaelle(zips: list[pathlib.Path], bbox_utm, rand: float = 200.0) -> list[dict]:
    x0, y0, x1, y1 = bbox_utm
    out = []
    for p in zips:
        # ein unlesbarer Jahrgang (anderes Format, defekter Download) soll nicht den ganzen Schritt abbrechen
        try:
            zeilen = list(csv_aus_zip(p))
        except (ValueError, zipfile.BadZipFile, OSError) as e:
            log(f"Daten: {p.name} übersprungen ({e})")
            if isinstance(e, zipfile.BadZipFile):
                p.unlink(missing_ok=True)  # beim nächsten Lauf neu laden
            continue
        if zeilen and feld(zeilen[0], "LINREFX") is None:
            log(f"Daten: {p.name} übersprungen (keine Spalte LINREFX; Spalten: {', '.join(list(zeilen[0])[:12])})")
            continue
        vorher = len(out)
        for z in zeilen:
            x, y = zahl(feld(z, "LINREFX")), zahl(feld(z, "LINREFY"))
            if x is None or y is None or not (x0 - rand <= x <= x1 + rand and y0 - rand <= y <= y1 + rand):
                continue
            g = lambda *n: int(zahl(feld(z, *n)) or 0)  # noqa: E731
            out.append({"e": round(x, 1), "n": round(y, 1), "jahr": g("UJAHR"), "monat": g("UMONAT"), "stunde": g("USTUNDE"),
                        "wtag": g("UWOCHENTAG"), "kat": g("UKATEGORIE"), "art": g("UART"), "typ": g("UTYP1"),
                        "licht": g("ULICHTVERH", "LICHT"), "rad": g("IstRad"), "pkw": g("IstPKW"), "fuss": g("IstFuss"),
                        "krad": g("IstKrad"), "gkfz": g("IstGkfz"), "sonst": g("IstSonstige"),
                        "nass": g("USTRZUSTAND", "IstStrasse", "STRZUSTAND")})
        log(f"Daten: {p.name}: {tsd(len(out) - vorher)} Unfälle im Gebiet")
    out.sort(key=lambda u: (u["jahr"], u["e"], u["n"]))
    return out


# ---------------------------------------------------------------- Verkehrswerte
def verkehrswerte(zip_pfad: pathlib.Path, bbox_utm, rand: float = 500.0) -> list[dict]:
    import shapefile
    x0, y0, x1, y1 = bbox_utm
    out = []
    with zipfile.ZipFile(zip_pfad) as z:
        shp = next(n for n in z.namelist() if n.lower().endswith(".shp"))
        basis = shp[:-4]
        teile = {s: io.BytesIO(z.read(basis + s)) for s in (".shp", ".shx", ".dbf") if basis + s in z.namelist()}
    r = shapefile.Reader(shp=teile[".shp"], shx=teile.get(".shx"), dbf=teile[".dbf"], encoding="cp1252")
    namen = [f[0] for f in r.fields[1:]]
    for sr in r.iterShapeRecords():
        bb = sr.shape.bbox
        if bb[2] < x0 - rand or bb[0] > x1 + rand or bb[3] < y0 - rand or bb[1] > y1 + rand:
            continue
        a = dict(zip(namen, sr.record))
        dtv = zahl(a.get("DTVKFZA"))
        if not dtv:
            continue
        pts = sr.shape.points
        teile_idx = list(sr.shape.parts) + [len(pts)]
        for s, e in zip(teile_idx, teile_idx[1:]):
            if e - s >= 2:
                out.append({"c": [tuple(p) for p in pts[s:e]], "dtv": dtv, "sv": zahl(a.get("DTVSVA")) or 0,
                            "kl": str(a.get("STRKL") or "").strip(), "nr": str(a.get("STRNR") or "").strip().lstrip("0")})
    return out


def ref_passt(ref, kl, nr) -> bool:
    if not ref or not nr:
        return False
    r = ref.replace(" ", "").upper()
    return any(t == f"{kl}{nr}".upper() for t in r.split(";"))


# ---------------------------------------------------------------- Hauptschritt
def bauen_daten(karte: pathlib.Path, quellen: pathlib.Path, was=("zensus", "unfaelle", "verkehrswerte"),
                dateien: dict | None = None) -> dict:
    """dateien: eigene Dateien statt Download (Tests/Offline): {'zensus': zip, 'unfaelle': [zips], 'verkehrswerte': zip}."""
    dateien = dateien or {}
    man_f = karte / "manifest.json"
    man = json.loads(man_f.read_text(encoding="utf-8"))
    E0, N0 = man["bbox_utm"][0], man["bbox_utm"][3]
    bbox = man["bbox_utm"]
    netz_f = karte / "netz.json.gz"
    if not netz_f.exists():
        raise SystemExit("Daten: netz.json.gz fehlt – erst 'bauen' oder 'netz' ausführen")
    netz = json.loads(gzip.decompress(netz_f.read_bytes()))
    K = netz["kanten"]
    nE = len(K["id"])
    info = man.get("daten", {})
    kanten = None

    if "zensus" in was:
        z = dateien.get("zensus") or hole(ZENSUS_URL, quellen / "zensus" / "Zensus2022_Bevoelkerungszahl.zip", pflicht=False)
        if z:
            zellen = zensus_zellen(pathlib.Path(z), bbox)
            neu = zensus_in_netz(netz, zellen, E0, N0)
            ew = sum(netz["zonen"]["ew"])
            man["statistik"]["einwohner_zensus"] = round(ew)
            info["zensus"] = {"quelle": QUELLEN["zensus"], "einwohner": round(ew), "neue_zellen": neu}
            log(f"Daten: Einwohner aus Zensus übernommen ({tsd(round(ew))}, {neu} neue Zellen)")

    if "unfaelle" in was or "verkehrswerte" in was:
        kanten = kanten_aus_kacheln(karte, man)
        gitter = Gitter(50)
        for i, eid in enumerate(K["id"]):
            k = kanten.get(eid)
            if k:
                gitter.linie(i, k["c"])

    if "unfaelle" in was:
        zips = dateien.get("unfaelle")
        if zips is None:
            zips = [p for j in UNFALL_JAHRE
                    if (p := hole(UNFALL_URL.format(jahr=j), quellen / "unfallatlas" / f"Unfallorte{j}_EPSG25832_CSV.zip", pflicht=False))]
        liste = unfaelle([pathlib.Path(p) for p in zips], bbox)
        kl = netz["klassen"]
        rad, schwer = [0] * nE, [0] * nE
        punkte = collections.defaultdict(list)
        for u in liste:
            nah = gitter.naechste(u["e"], u["n"], 30)
            # Radunfall: bevorzugt Kanten, auf denen Räder fahren dürfen
            best = min(nah.items(), key=lambda kv: kv[1][0] + (15 if u["rad"] and K["bike"][kv[0]] == 0 else 0), default=None)
            ki = best[0] if best else -1
            if ki >= 0 and u["rad"]:
                rad[ki] += 1
                if u["kat"] in (1, 2):
                    schwer[ki] += 1
            for f, v in (("x", round(u["e"] - E0, 1)), ("y", round(N0 - u["n"], 1)), ("kante", ki)):
                punkte[f].append(v)
            for f in ("jahr", "monat", "stunde", "wtag", "kat", "art", "typ", "licht", "rad", "pkw", "fuss", "krad", "gkfz", "sonst", "nass"):
                punkte[f].append(u[f])
        K["unf_rad"], K["unf_rad_schwer"] = rad, schwer
        jahre = sorted({u["jahr"] for u in liste})
        (karte / "unfaelle.json.gz").write_bytes(gzip.compress(json.dumps(
            {"quelle": QUELLEN["unfaelle"], "jahre": jahre, "punkte": dict(punkte)}, separators=(",", ":")).encode(), 6, mtime=0))
        info["unfaelle"] = {"quelle": QUELLEN["unfaelle"], "datei": "unfaelle.json.gz", "jahre": jahre, "anzahl": len(liste),
                            "rad": sum(u["rad"] for u in liste), "rad_schwer": sum(1 for u in liste if u["rad"] and u["kat"] in (1, 2))}
        man["statistik"]["radunfaelle"] = info["unfaelle"]["rad"]
        log(f"Daten: {len(liste)} Unfälle ({info['unfaelle']['rad']} mit Rad) aus {len(jahre)} Jahren {jahre[:1]}–{jahre[-1:]}")

    if "verkehrswerte" in was:
        vz = dateien.get("verkehrswerte") or hole(VERKEHRSWERTE_URL, quellen / "strassen_nrw" / "Verkehrswerte_EPSG25832_Shape.zip", pflicht=False)
        dtv, sv = [-1] * nE, [-1] * nE
        treffer = 0
        if vz:
            vw = verkehrswerte(pathlib.Path(vz), bbox)
            vg = Gitter(50)
            for i, v in enumerate(vw):
                vg.linie(i, v["c"])
            kl = netz["klassen"]
            for i, eid in enumerate(K["id"]):
                k = kanten.get(eid)
                if not k or k["cls"] not in ("auto", "L", "dorf", "wohn", "zufahrt"):
                    continue
                stimmen = collections.Counter()
                for f in (.2, .5, .8):
                    x, y, w = punkt_bei(k["c"], f)
                    for vi, (d, wv) in vg.naechste(x, y, 22).items():
                        dw = abs((w - wv + math.pi / 2) % math.pi - math.pi / 2)  # Richtung ohne Vorzeichen
                        if dw < math.radians(30):
                            stimmen[vi] += 1 + (1 if ref_passt(k["ref"], vw[vi]["kl"], vw[vi]["nr"]) else 0) - d / 40
                if stimmen:
                    vi, s = stimmen.most_common(1)[0]
                    if s >= 1.5:
                        dtv[i], sv[i] = round(vw[vi]["dtv"]), round(vw[vi]["sv"])
                        treffer += 1
            info["verkehrswerte"] = {"quelle": QUELLEN["verkehrswerte"], "abschnitte": len(vw), "kanten": treffer}
            log(f"Daten: Verkehrswerte – {len(vw)} Abschnitte, {treffer} Kanten mit gezähltem Kfz-Verkehr")
        K["dtv"], K["dtv_sv"] = dtv, sv

    netz_f.write_bytes(gzip.compress(json.dumps(netz, separators=(",", ":"), ensure_ascii=False).encode(), 6, mtime=0))
    man["netz"]["bytes"] = netz_f.stat().st_size
    man["netz"]["zonen"] = len(netz["zonen"]["x"])
    man["daten"] = info
    man_f.write_text(json.dumps(man, ensure_ascii=False, indent=1), encoding="utf-8")
    return info
