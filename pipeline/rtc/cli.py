"""Kommandozeile: python -m rtc <befehl> <region.yaml> [optionen]

Befehle
  alles      download + ausschnitt + bauen + vorschau
  download   Quelldateien von Geofabrik laden (falls noch nicht da)
  ausschnitt Gebiet aus den Quellen schneiden und filtern (osmium-tool)
  bauen      Kacheln aus dem Ausschnitt (oder --eingabe) erzeugen
  vorschau   PNG-Vorschau aus fertigen Kacheln
  info       Statistik eines fertigen Laufs ausgeben
"""
from __future__ import annotations

import argparse
import os
import json
import pathlib
import shutil
import subprocess
import sys
import time
import urllib.request

from .config import ConfigError, load_region
from .geo import region_polygon, to_utm, write_geojson_wgs


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def need_osmium():
    if not shutil.which("osmium"):
        sys.exit("osmium-tool fehlt. Im Docker-Image ist es dabei; lokal: apt install osmium-tool")


def download(url: str, target: pathlib.Path, neu: bool = False) -> pathlib.Path:
    if target.exists() and not neu:
        log(f"Quelle vorhanden: {target.name} ({target.stat().st_size / 1e6:.0f} MB) – mit --neu neu laden")
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix(target.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "radwegtycoon-pipeline"})
    start = part.stat().st_size if part.exists() else 0
    if start:
        req.add_header("Range", f"bytes={start}-")
    log(f"Lade {url}")
    with urllib.request.urlopen(req) as r, open(part, "ab" if start else "wb") as f:
        total = int(r.headers.get("Content-Length", 0)) + start
        done, last = start, 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if total and done - last > total / 20:
                last = done
                log(f"  {done / 1e6:.0f} / {total / 1e6:.0f} MB")
    part.rename(target)
    return target


def source_paths(region, data: pathlib.Path) -> list[pathlib.Path]:
    out = []
    for q in region.quellen:
        if q.startswith("http"):
            out.append(data / "quellen" / q.rsplit("/", 1)[-1])
        else:
            p = pathlib.Path(q)
            out.append(p if p.is_absolute() else data / "quellen" / p)
    return out


def cmd_download(region, data, args):
    for url, p in zip(region.quellen, source_paths(region, data)):
        if url.startswith("http"):
            download(url, p, args.neu)
        elif not p.exists():
            sys.exit(f"Quelldatei fehlt: {p}")


FILTER = ["nwr/highway", "a/building", "a/landuse", "a/natural", "a/leisure", "a/amenity", "n/amenity", "n/shop",
          "a/shop", "n/place", "w/waterway", "a/water", "w/railway", "n/railway", "r/route=bicycle", "n/barrier",
          "n/tourism", "n/public_transport"]


def cmd_ausschnitt(region, data, args) -> pathlib.Path:
    need_osmium()
    work = data / region.slug
    work.mkdir(parents=True, exist_ok=True)
    srcs = source_paths(region, data)
    for p in srcs:
        if not p.exists():
            sys.exit(f"Quelldatei fehlt: {p} – erst 'download' ausführen")
    if len(srcs) > 1:
        merged = work / "quellen_zusammen.osm.pbf"
        log("Quellen zusammenführen (osmium merge)")
        subprocess.run(["osmium", "merge", "--overwrite", "-o", str(merged)] + [str(p) for p in srcs], check=True)
        src = merged
    else:
        src = srcs[0]
    from .build import osm_timestamp
    stand = osm_timestamp(srcs[0])
    if stand:  # osmium extract/tags-filter übernehmen den Zeitstempel nicht
        (work / "osm_stand.txt").write_text(stand, encoding="utf-8")
        log(f"OSM-Stand der Quelle: {stand}")
    poly = region_polygon(region, src, work)
    cut = work / "gebiet_roh.osm.pbf"
    if poly is not None:
        gj = work / "gebiet.geojson"
        write_geojson_wgs(poly, gj)
        log(f"Gebiet ausschneiden: {poly.area / 1e6:,.0f} km²".replace(",", "."))
        subprocess.run(["osmium", "extract", "--overwrite", "-s", "smart", "-p", str(gj), "-o", str(cut), str(src)], check=True)
    else:
        cut = src
    out = work / "gebiet.osm.pbf"
    log("Auf spielrelevante Daten filtern (osmium tags-filter)")
    subprocess.run(["osmium", "tags-filter", "--overwrite", "-o", str(out), str(cut)] + FILTER, check=True)
    log(f"Ausschnitt fertig: {out} ({out.stat().st_size / 1e6:.1f} MB)")
    return out


def cmd_bauen(region, data, args):
    from .build import build
    from shapely.geometry import shape
    import json as _json
    work = data / region.slug
    src = pathlib.Path(args.eingabe) if args.eingabe else work / "gebiet.osm.pbf"
    if not src.exists():
        sys.exit(f"Eingabe fehlt: {src} – erst 'ausschnitt' ausführen oder --eingabe angeben")
    poly = None
    gj = work / "gebiet.geojson"
    if not args.eingabe and gj.exists():
        from .geo import geom_to_utm
        poly = geom_to_utm(shape(_json.loads(gj.read_text())["features"][0]["geometry"]))
    elif region.typ in ("kreis", "bbox"):
        poly = region_polygon(region, None, work)
    out = work / "karte"
    if out.exists():
        shutil.rmtree(out)
    stand_f = work / "osm_stand.txt"
    stand = stand_f.read_text(encoding="utf-8").strip() if stand_f.exists() and not args.eingabe else None
    build(region, src, out, poly, stand, jobs=args.jobs)
    from .netz import bauen_netz
    bauen_netz(out, jobs=args.jobs)
    return out


def cmd_hoehe(region, data, args):
    from .hoehe import bauen_hoehe
    quelle = args.hoehe or region.hoehe
    if not quelle and not args.dgm:
        log("Höhen: keine Quelle (in der Regionsdatei 'hoehe: dgm1_nrw' setzen) – übersprungen")
        return
    bauen_hoehe(data / region.slug / "karte", data / "quellen", quelle or "eigene", 
                pathlib.Path(args.dgm) if args.dgm else None, jobs=args.jobs)


def cmd_netz(region, data, args):
    from .netz import bauen_netz
    bauen_netz(data / region.slug / "karte", jobs=args.jobs)


def cmd_vorschau(region, data, args):
    from .vorschau import make_previews
    root = data / region.slug / "karte"
    z = None
    if args.zentrum:
        lat, lon = (float(v) for v in args.zentrum.split(","))
        z = to_utm(lon, lat)
    elif region.typ == "kreis":
        lat, lon = region.gebiet["zentrum"]
        z = to_utm(lon, lat)
    for path, (w, h), mpp in make_previews(root, z):
        log(f"Vorschau: {path} ({w}×{h} px, {mpp:.1f} m/px)")


def cmd_info(region, data, args):
    root = data / region.slug / "karte"
    man = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    st = man["statistik"]
    print(f"{man['name']} – OSM-Stand {man.get('osm_stand')}, erstellt {man['erstellt']}")
    print(f"Kacheln: " + ", ".join(f"Stufe {k}: {len(v)}" for k, v in man["tiles"].items()))
    print(f"Größe: {sum(man['tile_bytes'].values()) / 1e6:.1f} MB")
    for k, v in st.items():
        print(f"  {k:32s} {v}")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="rtc", description="Radweg Tycoon – Kartenpipeline")
    ap.add_argument("befehl", choices=["alles", "download", "ausschnitt", "bauen", "netz", "hoehe", "vorschau", "info"])
    ap.add_argument("region", help="Regionsdatei, z. B. regionen/lippe.yaml")
    ap.add_argument("--daten", default="/data", help="Arbeitsordner (Standard: /data)")
    ap.add_argument("--eingabe", help="OSM-Datei direkt verwenden (überspringt download/ausschnitt)")
    ap.add_argument("--zentrum", help="Mitte der Detailvorschau als 'lat,lon'")
    ap.add_argument("--neu", action="store_true", help="Quellen neu herunterladen")
    ap.add_argument("--hoehe", help="Höhenquelle (überschreibt die Regionsdatei), z. B. dgm1_nrw")
    ap.add_argument("--dgm", help="Ordner mit eigenen DGM-GeoTIFFs (statt Download)")
    ap.add_argument("--jobs", type=int, default=min(os.cpu_count() or 1, 16),
                    help="Anzahl paralleler Prozesse (Standard: Kerne, höchstens 16)")
    args = ap.parse_args(argv)
    try:
        region = load_region(args.region)
    except ConfigError as e:
        sys.exit(str(e))
    data = pathlib.Path(args.daten)
    if args.befehl == "download":
        cmd_download(region, data, args)
    elif args.befehl == "ausschnitt":
        cmd_ausschnitt(region, data, args)
    elif args.befehl == "bauen":
        cmd_bauen(region, data, args)
    elif args.befehl == "netz":
        cmd_netz(region, data, args)
    elif args.befehl == "hoehe":
        cmd_hoehe(region, data, args)
    elif args.befehl == "vorschau":
        cmd_vorschau(region, data, args)
    elif args.befehl == "info":
        cmd_info(region, data, args)
    else:
        if not args.eingabe:
            cmd_download(region, data, args)
            cmd_ausschnitt(region, data, args)
        cmd_bauen(region, data, args)
        cmd_hoehe(region, data, args)
        cmd_vorschau(region, data, args)
        cmd_info(region, data, args)


if __name__ == "__main__":
    main()
