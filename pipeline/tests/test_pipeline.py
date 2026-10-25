"""Tests mit einer winzigen, selbst gebauten OSM-Datei (kein Netz nötig)."""
import gzip
import json
import pathlib

import pytest

from rtc.build import build
from rtc.config import Region
from rtc.model import road_model

# Kleines Kreuz an einem erfundenen Ort: Nord-Süd-Straße (Hauptstraße mit Hochbord-Radweg)
# und Ost-West-Wohnstraße, die sich im Knoten 3 kreuzen. Dazu ein Gebäude, ein Wald,
# ein Radweg und eine Ampel.
OSM = """<?xml version='1.0' encoding='UTF-8'?>
<osm version="0.6" generator="test">
 <bounds minlat="51.200" minlon="9.220" maxlat="51.220" maxlon="9.250"/>
 <node id="1" lat="51.205" lon="9.235"/>
 <node id="2" lat="51.208" lon="9.235"/>
 <node id="3" lat="51.210" lon="9.235"><tag k="highway" v="traffic_signals"/></node>
 <node id="4" lat="51.212" lon="9.235"/>
 <node id="5" lat="51.215" lon="9.235"/>
 <node id="6" lat="51.210" lon="9.225"/>
 <node id="7" lat="51.210" lon="9.245"/>
 <node id="10" lat="51.2110" lon="9.2360"/>
 <node id="11" lat="51.2110" lon="9.2362"/>
 <node id="12" lat="51.2112" lon="9.2362"/>
 <node id="13" lat="51.2112" lon="9.2360"/>
 <node id="20" lat="51.201" lon="9.221"/>
 <node id="21" lat="51.201" lon="9.229"/>
 <node id="22" lat="51.204" lon="9.229"/>
 <node id="23" lat="51.204" lon="9.221"/>
 <node id="30" lat="51.215" lon="9.245"/>
 <node id="40" lat="51.2105" lon="9.2365"><tag k="shop" v="bakery"/><tag k="name" v="Bäckerei Test"/></node>
 <node id="50" lat="51.2095" lon="9.2340"><tag k="place" v="village"/><tag k="name" v="Teststadt"/></node>
 <way id="100"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="5"/>
  <tag k="highway" v="secondary"/><tag k="name" v="Hauptstraße"/><tag k="maxspeed" v="50"/>
  <tag k="cycleway" v="track"/><tag k="cycleway:both:surface" v="paving_stones"/><tag k="sidewalk" v="both"/></way>
 <way id="101"><nd ref="6"/><nd ref="3"/><nd ref="7"/>
  <tag k="highway" v="residential"/><tag k="name" v="Lindenweg"/><tag k="surface" v="sett"/><tag k="smoothness" v="bad"/></way>
 <way id="102"><nd ref="7"/><nd ref="30"/><tag k="highway" v="cycleway"/><tag k="surface" v="asphalt"/></way>
 <way id="200"><nd ref="10"/><nd ref="11"/><nd ref="12"/><nd ref="13"/><nd ref="10"/><tag k="building" v="house"/></way>
 <way id="300"><nd ref="20"/><nd ref="21"/><nd ref="22"/><nd ref="23"/><nd ref="20"/><tag k="landuse" v="forest"/></way>
</osm>
"""


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    d = tmp_path_factory.mktemp("rtc")
    src = d / "test.osm"
    src.write_text(OSM, encoding="utf-8")
    region = Region(name="Test", slug="test", quellen=[], gebiet={"typ": "alles"}, rand_m=0)
    man = build(region, src, d / "karte")
    return d / "karte", man


def tiles(root: pathlib.Path, lod=0):
    out = []
    for p in sorted((root / "tiles" / str(lod)).glob("*.json.gz")):
        with gzip.open(p, "rt", encoding="utf-8") as f:
            out.append(json.load(f))
    return out


def owned_edges(root):
    return {r["id"]: r for t in tiles(root) for r in t.get("roads", []) if r.get("own")}


def test_edges_split_at_junction(built):
    root, _ = built
    edges = owned_edges(root)
    main = sorted(e for e in edges if e.startswith("w100_"))
    side = sorted(e for e in edges if e.startswith("w101_"))
    assert main == ["w100_1_3", "w100_3_5"]
    assert side == ["w101_3_7", "w101_6_3"]
    # jede Kante gehört genau einer Kachel
    owners = [r["id"] for t in tiles(root) for r in t.get("roads", []) if r.get("own")]
    assert len(owners) == len(set(owners))


def test_model_from_tags(built):
    root, _ = built
    e = owned_edges(root)
    hs = e["w100_1_3"]["m"]
    assert hs["cls"] == "L" and hs["ms"] == 50
    assert hs["fac_l"] == 3 and hs["fac_r"] == 3 and hs["tsurf"] == "paving_stones"
    assert "radweg_zustand" in hs["est"]
    lw = e["w101_6_3"]["m"]
    assert lw["cls"] == "wohn" and lw["surf"] == "sett" and lw["cond"] == 35
    assert e["w102_7_30"]["m"]["cls"] == "rad"


def test_junction_node_has_signal(built):
    root, _ = built
    nodes = {n["id"]: n for t in tiles(root) for n in t.get("nodes", [])}
    assert nodes[3]["f"] == "traffic_signals"
    assert {1, 3, 5, 6, 7, 30} <= set(nodes)


def test_buildings_areas_pois_places(built):
    root, man = built
    t0 = tiles(root)
    assert sum(len(t.get("buildings", [])) for t in t0) == 1
    assert any(a["k"] == "wald" for t in t0 for a in t.get("areas", []))
    assert any(p.get("name") == "Bäckerei Test" for t in t0 for p in t.get("pois", []))
    assert any(p["name"] == "Teststadt" for t in t0 for p in t.get("places", []))
    assert man["statistik"]["ampeln"] == 1


def test_overview_has_only_major_roads(built):
    root, _ = built
    cls = {r["m"]["cls"] for t in tiles(root, 1) for r in t.get("roads", [])}
    assert cls == {"L"}


def test_coordinates_roundtrip(built):
    root, man = built
    from rtc.geo import to_utm
    e3, n3 = to_utm(9.235, 51.210)
    for t in tiles(root):
        for n in t.get("nodes", []):
            if n["id"] == 3:
                ox, oy = t["origin"]
                assert abs(ox + n["x"] / t["scale"] - e3) < 0.11
                assert abs(oy + n["y"] / t["scale"] - n3) < 0.11
                return
    pytest.fail("Knoten 3 nicht gefunden")


def test_estimates_are_stable():
    a = road_model(4711, {"highway": "residential"})
    b = road_model(4711, {"highway": "residential"})
    assert a == b and "zustand" in a["est"]


@pytest.mark.parametrize("raw,expected", [
    ("asphalt", "asphalt"), ("asphalt;compacted", "asphalt"), ("asphalt:lanes", "asphalt"),
    ("paving_stones; asphalt", "paving_stones"), ("gravel, grass", "gravel"), ("pebblestone", "gravel"),
    ("scub", "unpaved"), ("feldweg", "compacted"), ("concrete:plates", "concrete_plates"),
    ("cobblestone:flattened", "sett"), ("mud", "ground"), ("tartan", "asphalt"), (None, None),
])
def test_surface_normalisation(raw, expected):
    from rtc.model import norm_surface
    assert norm_surface(raw) == expected


def test_raw_surface_kept():
    m = road_model(1, {"highway": "track", "surface": "asphalt;compacted"})
    assert m["surf"] == "asphalt" and m["surf_osm"] == "asphalt;compacted"


def test_parallel_gives_identical_tiles(tmp_path):
    """Mehrere Prozesse müssen byte-gleiche Kachelinhalte liefern wie einer."""
    src = tmp_path / "test.osm"
    src.write_text(OSM, encoding="utf-8")
    region = Region(name="Test", slug="test", quellen=[], gebiet={"typ": "alles"}, rand_m=0)
    m1 = build(region, src, tmp_path / "eins", jobs=1)
    m4 = build(region, src, tmp_path / "vier", jobs=4)
    assert m1["tiles"] == m4["tiles"]
    assert m1["statistik"] == m4["statistik"]
    for lod, keys in m1["tiles"].items():
        for ix, iy in keys:
            a = tiles_one(tmp_path / "eins", lod, ix, iy)
            b = tiles_one(tmp_path / "vier", lod, ix, iy)
            assert a == b, f"Kachel {lod}/{ix}_{iy} unterscheidet sich"


def tiles_one(root, lod, ix, iy):
    with gzip.open(root / "tiles" / str(lod) / f"{ix}_{iy}.json.gz", "rt", encoding="utf-8") as f:
        t = json.load(f)
    for sec in ("buildings", "pois", "places", "lines"):  # Reihenfolge darf je Prozess variieren
        if sec in t:
            t[sec] = sorted(t[sec], key=lambda o: json.dumps(o, sort_keys=True))
    return t


def test_strip_mode_gives_identical_tiles(tmp_path):
    """Streifen-Modus (Zuständigkeit nach Länge des Startpunkts) ergibt dieselben Kacheln."""
    src = tmp_path / "test.osm"
    src.write_text(OSM, encoding="utf-8")
    region = Region(name="Test", slug="test", quellen=[], gebiet={"typ": "alles"}, rand_m=0)
    m1 = build(region, src, tmp_path / "eins", jobs=1)
    ms = build(region, src, tmp_path / "streifen", jobs=3, strip_mode="test")
    assert m1["tiles"] == ms["tiles"]
    assert m1["statistik"] == ms["statistik"]
    for lod, keys in m1["tiles"].items():
        for ix, iy in keys:
            assert tiles_one(tmp_path / "eins", lod, ix, iy) == tiles_one(tmp_path / "streifen", lod, ix, iy)


def test_netz(built):
    import gzip as _gz
    from rtc.netz import bauen_netz
    root, _ = built
    info = bauen_netz(root)
    netz = json.loads(_gz.decompress((root / "netz.json.gz").read_bytes()))
    K = netz["kanten"]
    assert info["kanten"] == len(K["id"]) == len(owned_edges(root))
    n = len(netz["knoten"]["x"])
    assert all(0 <= a < n and 0 <= b < n for a, b in zip(K["a"], K["b"]))
    assert len(set(K["id"])) == len(K["id"])
    kn = netz["knoten"]
    assert len(kn["id"]) == n and len(kn["ampel"]) == n and sum(kn["ampel"]) >= 1  # Testdaten haben eine Ampel
    man = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    assert man["netz"]["datei"] == "netz.json.gz"
    # deterministisch
    eins = (root / "netz.json.gz").read_bytes()
    bauen_netz(root)
    assert (root / "netz.json.gz").read_bytes() == eins


def test_hoehe_aus_dgm(built, tmp_path):
    """Künstliches DGM mit 5 % Steigung nach Osten: Raster und Höhenmeter je Kante müssen passen."""
    import gzip as _gz
    import numpy as np
    import tifffile
    from rtc.netz import bauen_netz
    from rtc.hoehe import bauen_hoehe, ZELLEN
    root, _ = built
    bauen_netz(root)
    man = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    e_ref = min(ix for ix, _ in man["tiles"]["0"]) * 1000
    for ix, iy in man["tiles"]["0"]:
        e = ix * 1000 + np.arange(1000) + .5
        h = np.tile(100 + 0.05 * (e - e_ref), (1000, 1)).astype(np.float32)
        tags = [(33550, "d", 3, (1.0, 1.0, 0.0)), (33922, "d", 6, (0, 0, 0, ix * 1000.0, (iy + 1) * 1000.0, 0))]
        tifffile.imwrite(tmp_path / f"dgm1_32_{ix}_{iy}_1_nw_2023.tif", h, compression="deflate", extratags=tags)
    info = bauen_hoehe(root, tmp_path, "test", dgm_ordner=tmp_path)
    assert info and info["tiles"]["0"]
    ix, iy = info["tiles"]["0"][0]
    g = np.frombuffer(_gz.decompress((root / "hoehe" / "0" / f"{ix}_{iy}.bin.gz").read_bytes()), "<i2").reshape(ZELLEN, ZELLEN)
    assert abs(g[0, 1] - g[0, 0] - 5) <= 1          # 10 m Zelle, 5 % -> 0,5 m = 5 dm
    netz = json.loads(_gz.decompress((root / "netz.json.gz").read_bytes()))
    K, x = netz["kanten"], netz["knoten"]["x"]
    for a, b, auf, ab in zip(K["a"], K["b"], K["auf"], K["ab"]):
        if auf < 0:
            continue
        assert abs((auf - ab) / 10 - 0.05 * (x[b] - x[a])) < 0.8


def test_echte_daten(built, tmp_path):
    """Zensus, Unfallatlas und Verkehrswerte im Format der echten Quellen (künstliche Inhalte)."""
    import gzip as _gz
    import io as _io
    import zipfile as _zf
    import shapefile
    from pyproj import Transformer
    from rtc.netz import bauen_netz
    from rtc.daten import bauen_daten, kanten_aus_kacheln, punkt_bei
    root, _ = built
    bauen_netz(root)
    man = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    kanten = kanten_aus_kacheln(root, man)
    lid, L = next((i, k) for i, k in kanten.items() if k["cls"] == "L")
    mx, my, _w = punkt_bei(L["c"], .5)
    # Zensus: 100-m-Zellen in EPSG:3035, Semikolon, wie Destatis
    t = Transformer.from_crs("EPSG:25832", "EPSG:3035", always_xy=True)
    zeilen = ["GITTER_ID_100m;x_mp_100m;y_mp_100m;Einwohner"]
    for dx, dy, ew in ((0, 0, 120), (100, 0, 80), (0, 100, 0), (2500, 2500, 33)):
        x, y = t.transform(mx + dx, my + dy)
        zeilen.append(f"CRS3035RES100mN{int(y)}E{int(x)};{x:.0f};{y:.0f};{ew if ew else '–'}")
    zz = tmp_path / "zensus.zip"
    with _zf.ZipFile(zz, "w") as z:
        z.writestr("Zensus2022_Bevoelkerungszahl_100m-Gitter.csv", "\n".join(zeilen).encode("utf-8"))
    # Unfallatlas: ein Radunfall (schwer) an der Hauptstraße, einer weit weg
    kopf = "OBJECTID;UIDENTSTLAE;ULAND;UREGBEZ;UKREIS;UGEMEINDE;UJAHR;UMONAT;USTUNDE;UWOCHENTAG;UKATEGORIE;UART;UTYP1;ULICHTVERH;IstRad;IstPKW;IstFuss;IstKrad;IstGkfz;IstSonstige;USTRZUSTAND;LINREFX;LINREFY;XGCSWGS84;YGCSWGS84;PLST"
    u1 = f"1;x;05;7;66;000;2023;5;8;3;2;5;3;0;1;1;0;0;0;0;0;{mx + 2:.3f}".replace(".", ",") + f";{my:.3f}".replace(".", ",") + ";9,2;51,2;1"
    u2 = "2;y;05;7;66;000;2023;6;9;4;3;1;6;0;0;1;0;0;0;0;0;100,0;100,0;9,2;51,2;1"
    uz = tmp_path / "unf.zip"
    with _zf.ZipFile(uz, "w") as z:
        z.writestr("csv/Unfallorte2023_LinRef.csv", ("\n".join([kopf, u1, u2])).encode("utf-8"))
    # Verkehrswerte: Linie entlang der Hauptstraße mit DTV
    sb = {s: _io.BytesIO() for s in ("shp", "shx", "dbf")}
    w = shapefile.Writer(shp=sb["shp"], shx=sb["shx"], dbf=sb["dbf"], shapeType=shapefile.POLYLINE)
    for f in ("STRKL", "STRNR"):
        w.field(f, "C", 10)
    for f in ("DTVKFZA", "DTVSVA"):
        w.field(f, "N", 10)
    w.line([[list(p) for p in L["c"]]]); w.record("L", "999", 7400, 420)
    w.close()
    vz = tmp_path / "vw.zip"
    with _zf.ZipFile(vz, "w") as z:
        for s, b in sb.items():
            z.writestr(f"VERKEHRSWERTE_line.{s}", b.getvalue())
    info = bauen_daten(root, tmp_path, dateien={"zensus": zz, "unfaelle": [uz], "verkehrswerte": vz})
    netz = json.loads(_gz.decompress((root / "netz.json.gz").read_bytes()))
    K = netz["kanten"]
    i = K["id"].index(lid)
    assert K["dtv"][i] == 7400 and K["dtv_sv"][i] == 420
    assert K["unf_rad"][i] == 1 and K["unf_rad_schwer"][i] == 1
    assert info["unfaelle"]["anzahl"] == 1                  # der ferne Unfall liegt außerhalb
    assert abs(sum(netz["zonen"]["ew"]) - 200) < 1           # 120 + 80; die ferne Zelle liegt außerhalb
    u = json.loads(_gz.decompress((root / "unfaelle.json.gz").read_bytes()))
    assert u["punkte"]["kante"] == [i] and u["jahre"] == [2023]


def test_unfaelle_alte_jahrgaenge(tmp_path):
    """Ältere Jahrgänge liefern .txt statt .csv; unlesbare ZIPs werden übersprungen statt abzubrechen."""
    import zipfile as _zf
    from rtc.daten import unfaelle
    kopf = "OBJECTID;UJAHR;UMONAT;USTUNDE;UWOCHENTAG;UKATEGORIE;UART;UTYP1;LICHT;IstRad;IstPKW;IstFuss;IstKrad;IstSonstig;LINREFX;LINREFY"
    zeile = "1;2016;5;8;3;2;5;3;0;1;1;0;0;0;100,5;200,5"
    alt = tmp_path / "Unfallorte2016_EPSG25832_CSV.zip"
    with _zf.ZipFile(alt, "w") as z:
        z.writestr("txt/Unfallorte2016_LinRef.txt", ("\n".join([kopf, zeile])).encode("cp1252"))
    leer = tmp_path / "Unfallorte2017_EPSG25832_CSV.zip"
    with _zf.ZipFile(leer, "w") as z:
        z.writestr("liesmich.pdf", b"%PDF")
    kaputt = tmp_path / "Unfallorte2018_EPSG25832_CSV.zip"
    kaputt.write_bytes(b"<html>Fehler</html>")
    liste = unfaelle([alt, leer, kaputt], (0, 0, 1000, 1000))
    assert len(liste) == 1 and liste[0]["jahr"] == 2016 and liste[0]["rad"] == 1 and liste[0]["kat"] == 2
    assert not kaputt.exists()  # defekter Download wird beim nächsten Lauf neu geladen
