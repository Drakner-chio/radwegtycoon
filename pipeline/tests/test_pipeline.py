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
