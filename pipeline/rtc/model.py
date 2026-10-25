"""OSM-Tags -> Spielmodell einer Straße / eines Weges.

Das Ergebnis ist der *Ausgangszustand* im Spiel. Alles, was nicht in OSM steht,
wird geschätzt und in ``est`` vermerkt, damit das Spiel es kenntlich machen kann.
Schätzungen sind deterministisch (Hash der Way-ID), damit jeder Lauf der
Pipeline dieselbe Karte erzeugt.
"""
from __future__ import annotations

import hashlib

# Spielklassen
#   L       Hauptverkehrsstraße (Bundes-/Landesstraße)
#   dorf    Sammelstraße (Kreis-/Gemeindeverbindung)
#   wohn    Wohnstraße
#   spiel   Verkehrsberuhigter Bereich
#   zufahrt Zufahrt, Parkplatzgasse, Hofzufahrt
#   feld    Wirtschafts-/Waldweg
#   rad     eigenständiger Radweg (auch gemeinsamer Geh-/Radweg)
#   weg     sonstiger Weg
#   fuss    Fußweg, Fußgängerzone
#   treppe  Treppe
#   auto    Autobahn / Kraftfahrstraße (für Räder gesperrt)
ROAD_CLASSES = {"L", "dorf", "wohn", "spiel", "zufahrt", "auto"}

# Halbe Fahrbahnbreite in Metern (Mitte bis Bordstein) je Klasse
HALF_WIDTH = {"auto": 5.5, "L": 3.25, "dorf": 3.0, "wohn": 2.75, "spiel": 2.6, "zufahrt": 1.75,
              "feld": 1.5, "rad": 1.25, "weg": 1.0, "fuss": 0.9, "treppe": 0.8}

# Typischer Zustand je Belag, wenn smoothness fehlt (0..100)
SURFACE_COND = {"asphalt": 70, "concrete": 62, "concrete_plates": 55, "paving_stones": 62, "paved": 65, "sett": 55,
                "cobblestone": 50, "compacted": 58, "fine_gravel": 58, "gravel": 45, "ground": 40, "sand": 30,
                "grass": 45, "grass_paver": 50, "wood": 55, "metal": 70, "unpaved": 45}

SMOOTHNESS = {"excellent": 95, "good": 82, "intermediate": 60, "bad": 35, "very_bad": 20,
              "horrible": 10, "very_horrible": 5, "impassable": 0}

HIGHWAY_CLASS = {
    "motorway": "auto", "motorway_link": "auto", "trunk": "L", "trunk_link": "L",
    "primary": "L", "primary_link": "L", "secondary": "L", "secondary_link": "L",
    "tertiary": "dorf", "tertiary_link": "dorf", "unclassified": "dorf",
    "residential": "wohn", "living_street": "spiel", "service": "zufahrt", "track": "feld",
    "cycleway": "rad", "path": "weg", "bridleway": "weg", "footway": "fuss", "pedestrian": "fuss",
    "steps": "treppe",
}

# Für das Spiel relevante highway-Werte (alles andere wird ignoriert)
HIGHWAYS = set(HIGHWAY_CLASS)


def stable_unit(key: str | int) -> float:
    """Deterministische Zahl in [0, 1) für Schätzungen."""
    h = hashlib.blake2b(str(key).encode(), digest_size=8).digest()
    return int.from_bytes(h, "big") / 2**64


# Spiel-Beläge. Alles aus OSM wird auf einen dieser Werte abgebildet.
SURFACES = ("asphalt", "concrete", "concrete_plates", "paving_stones", "sett", "cobblestone", "compacted",
            "fine_gravel", "gravel", "ground", "sand", "grass", "grass_paver", "wood", "metal", "paved", "unpaved")

SURFACE_ALIAS = {
    "asphalt": "asphalt", "chipseal": "asphalt", "tartan": "asphalt", "artificial_turf": "grass",
    "concrete": "concrete", "concrete:lanes": "concrete_plates", "concrete:plates": "concrete_plates",
    "concrete_plates": "concrete_plates", "paving_stones": "paving_stones", "paving_stones:lanes": "paving_stones",
    "bricks": "paving_stones", "brick": "paving_stones", "sett": "sett", "cobblestone": "cobblestone",
    "cobblestone:flattened": "sett", "unhewn_cobblestone": "cobblestone", "compacted": "compacted",
    "fine_gravel": "fine_gravel", "gravel": "gravel", "pebblestone": "gravel", "rock": "gravel", "bare_rock": "gravel",
    "shells": "gravel", "ground": "ground", "dirt": "ground", "earth": "ground", "soil": "ground", "mud": "ground",
    "clay": "ground", "scrub": "ground", "woodchips": "ground", "feldweg": "compacted", "sand": "sand",
    "grass": "grass", "grass_paver": "grass_paver", "wood": "wood", "metal": "metal", "metal_grid": "metal",
    "paved": "paved", "unpaved": "unpaved", "stone": "sett", "granite": "sett",
}


def norm_surface(raw: str | None) -> str | None:
    """OSM-surface -> Spiel-Belag. Mehrfachwerte ('asphalt;compacted') nehmen den ersten bekannten,
    Zusätze wie ':lanes' werden abgeschnitten, Unbekanntes wird 'paved'/'unpaved' anhand von Stichworten."""
    if not raw:
        return None
    for part in raw.replace(",", ";").split(";"):
        v = part.strip().lower().replace(" ", "_")
        if v in SURFACE_ALIAS:
            return SURFACE_ALIAS[v]
        base = v.split(":")[0]
        if base in SURFACE_ALIAS:
            return SURFACE_ALIAS[base]
    v = raw.lower()
    if any(k in v for k in ("asph", "beton", "pflast", "paved")):
        return "paved"
    return "unpaved"


def _f(v: str | None) -> float | None:
    if not v:
        return None
    try:
        return float(v.replace(",", ".").split()[0])
    except ValueError:
        return None


def _speed(v: str | None) -> int | None:
    if not v:
        return None
    if v in ("walk", "DE:walk"):
        return 7
    if v in ("DE:urban",):
        return 50
    if v in ("DE:rural",):
        return 100
    try:
        return int(v.split()[0])
    except ValueError:
        return None


def _fac(v: str) -> int:
    """cycleway-Wert -> Spiel-Radinfrastruktur. -1 = separat erfasst."""
    if v in ("track", "opposite_track"):
        return 3
    if v in ("lane", "opposite_lane"):
        return 2
    if v == "separate":
        return -1
    return 0


def road_model(way_id: int, tags: dict[str, str]) -> dict | None:
    hw = tags.get("highway")
    cls = HIGHWAY_CLASS.get(hw or "")
    if cls is None or tags.get("area") == "yes":
        return None
    if hw == "path" and tags.get("bicycle") == "designated":
        cls = "rad"
    est: list[str] = []
    road = cls in ROAD_CLASSES
    m: dict = {"cls": cls, "hw": hw}
    if tags.get("name"):
        m["name"] = tags["name"]
    if tags.get("ref"):
        m["ref"] = tags["ref"]

    # Breite
    cw = HALF_WIDTH[cls]
    if cls == "zufahrt" and tags.get("service") in ("driveway", "parking_aisle"):
        cw = 1.4
    oneway = tags.get("oneway") == "yes" or tags.get("junction") == "roundabout" or cls == "auto"
    w = _f(tags.get("width"))
    if w and 0.5 < w < 30:
        cw = w / 2
    elif road and cls != "auto":
        if tags.get("lanes") == "1":
            cw = min(cw, 2.1)
        if oneway:
            cw = min(cw, 2.4)
    m["cw"] = round(cw, 2)
    if oneway:
        m["oneway"] = 1
    if tags.get("junction") == "roundabout":
        m["round"] = 1

    # Tempo
    if road or cls == "feld":
        ms = _speed(tags.get("maxspeed"))
        if ms is None:
            ms = {"spiel": 7, "L": 50, "dorf": 50, "wohn": 30, "zufahrt": 20, "feld": 30, "auto": 130}[cls]
            est.append("tempo")
        m["ms"] = ms
        if tags.get("maxspeed:conditional"):
            m["ms_cond"] = tags["maxspeed:conditional"]

    # Radinfrastruktur je Seite (links/rechts bezogen auf die Zeichenrichtung des Ways)
    if road and cls != "auto":
        def cv(side: str) -> str:
            return tags.get(f"cycleway:{side}") or tags.get("cycleway:both") or tags.get("cycleway") or ""
        fl, fr = _fac(cv("left")), _fac(cv("right"))
        if tags.get("cycleway") in ("track", "lane") and not any(
                k in tags for k in ("cycleway:left", "cycleway:right", "cycleway:both")):
            fl = fr = _fac(tags["cycleway"])
        if fl:
            m["fac_l"] = fl
        if fr:
            m["fac_r"] = fr
        if tags.get("cycleway:lane") == "advisory" or tags.get("cycleway:both:lane") == "advisory":
            if fl == 2:
                m["fac_l"] = 1
            if fr == 2:
                m["fac_r"] = 1
    if tags.get("bicycle_road") == "yes" or tags.get("cyclestreet") == "yes":
        m["frs"] = 1

    # Darf/soll man hier Rad fahren?
    bic = tags.get("bicycle", "")
    no_bike = (bic in ("no", "dismount") or cls in ("treppe", "auto")
               or (cls == "fuss" and bic not in ("yes", "designated", "permissive")))
    if no_bike:
        m["bike"] = 0
    elif bic == "use_sidepath" or m.get("fac_l") == -1 or m.get("fac_r") == -1:
        m["bike"] = 2  # Radweg daneben (benutzungspflichtig / separat erfasst)
    mv = tags.get("motor_vehicle") or tags.get("motorcar") or ""
    if (cls in ("rad", "weg", "fuss", "treppe") or mv == "no" or tags.get("access") in ("no", "private")
            or (cls == "feld" and mv in ("", "agricultural", "forestry", "agricultural;forestry"))):
        m["car"] = 0  # im Spiel keine Autos (Wirtschaftswege: nur Landwirtschaft)
    elif mv == "destination" or tags.get("access") == "destination":
        m["car"] = 2  # nur Anlieger

    # Gehwege
    if road and cls not in ("auto", "zufahrt"):
        def sw(side: str) -> float:
            v = tags.get(f"sidewalk:{side}") or tags.get("sidewalk:both")
            s = tags.get("sidewalk")
            if v is None and s is not None:
                v = "yes" if s in ("both", "yes", side) else "separate" if s == "separate" else "no"
            if v == "yes":
                return 1.6
            if v is None and cls != "spiel":
                return -1.0  # unbekannt
            return 0.0
        swl, swr = sw("left"), sw("right")
        if swl < 0 or swr < 0:
            est.append("gehweg")
            dflt = 1.4 if cls == "wohn" else 1.8
            swl = dflt if swl < 0 else swl
            swr = dflt if swr < 0 else swr
        if swl:
            m["sw_l"] = swl
        if swr:
            m["sw_r"] = swr

    # Belag & Zustand der Fahrbahn
    raw = tags.get("surface")
    surf = norm_surface(raw)
    if not surf:
        surf = "asphalt" if road or cls == "rad" else "compacted"
        est.append("belag")
    elif raw != surf:
        m["surf_osm"] = raw
    m["surf"] = surf
    noise = (stable_unit(way_id) - 0.5) * 24
    sm = tags.get("smoothness")
    if sm in SMOOTHNESS:
        m["cond"] = SMOOTHNESS[sm]
    else:
        m["cond"] = int(max(8, min(92, SURFACE_COND.get(surf, 55) + noise)))
        est.append("zustand")

    # Hochbord-Radweg: eigener Belag und Zustand
    if m.get("fac_l") == 3 or m.get("fac_r") == 3:
        ts = (tags.get("cycleway:both:surface") or tags.get("cycleway:right:surface")
              or tags.get("cycleway:left:surface") or tags.get("cycleway:surface"))
        ts = norm_surface(ts)
        if not ts:
            ts = "paving_stones"
            est.append("radweg_belag")
        m["tsurf"] = ts
        tsm = (tags.get("cycleway:both:smoothness") or tags.get("cycleway:right:smoothness")
               or tags.get("cycleway:left:smoothness"))
        if tsm in SMOOTHNESS:
            m["tcond"] = SMOOTHNESS[tsm]
        else:
            m["tcond"] = int(max(8, min(90, SURFACE_COND.get(ts, 55) - 6 + noise * 0.8)))
            est.append("radweg_zustand")

    for k in ("lit", "segregated", "tracktype", "bridge", "tunnel", "layer", "service"):
        if tags.get(k):
            m[k] = tags[k]
    if tags.get("oneway:bicycle") == "no":
        m["oneway_bike"] = 0
    if est:
        m["est"] = est
    return m


# ---------------------------------------------------------------------------
# Flächen, Gebäude, POIs

AREA_KINDS = {
    # landuse
    "residential": "wohngebiet", "forest": "wald", "meadow": "wiese", "grass": "wiese", "farmland": "acker",
    "military": "militaer", "industrial": "gewerbe", "commercial": "gewerbe", "retail": "gewerbe",
    "farmyard": "hof", "cemetery": "friedhof", "quarry": "abbau", "allotments": "kleingarten",
    "recreation_ground": "wiese", "orchard": "obstwiese", "vineyard": "acker", "village_green": "wiese",
    "construction": "baustelle", "railway": "bahn", "brownfield": "brache", "greenfield": "wiese",
    # natural
    "wood": "wald", "heath": "heide", "scrub": "gebuesch", "water": "wasser", "wetland": "feuchtgebiet",
    "sand": "sand", "grassland": "wiese", "bare_rock": "fels",
    # leisure / amenity
    "pitch": "sportplatz", "park": "park", "playground": "spielplatz", "garden": "garten",
    "sports_centre": "sportanlage", "track": "laufbahn", "swimming_pool": "wasser", "water_park": "wasser",
    "golf_course": "wiese", "stadium": "sportanlage", "nature_reserve": None,
    "parking": "parkplatz", "school": "schule", "kindergarten": "schule", "university": "schule",
    "grave_yard": "friedhof", "hospital": "gewerbe",
}

# Flächen, die im Überblick (LOD 1/2) erscheinen
OVERVIEW_AREAS = {"wohngebiet", "wald", "acker", "wiese", "gewerbe", "wasser", "militaer", "heide"}


def area_kind(tags: dict[str, str]) -> tuple[str, str] | None:
    """-> ("building", typ) oder ("area", art) oder None."""
    b = tags.get("building")
    if b and b != "no":
        return "building", b
    if tags.get("building:part"):
        return None
    for k in ("amenity", "leisure", "landuse", "natural"):
        v = tags.get(k)
        if v and v in AREA_KINDS and AREA_KINDS[v]:
            if k == "amenity" and v not in ("parking", "school", "kindergarten", "university", "grave_yard", "hospital"):
                continue
            return "area", AREA_KINDS[v]
    if tags.get("waterway") == "riverbank" or tags.get("water"):
        return "area", "wasser"
    return None


POI_KEYS = ("amenity", "shop", "leisure", "tourism", "railway", "public_transport")
POI_KEEP = {
    "amenity": {"school", "kindergarten", "university", "college", "townhall", "place_of_worship", "pharmacy",
                "doctors", "hospital", "library", "fire_station", "police", "post_office", "fuel", "bank",
                "restaurant", "cafe", "fast_food", "bicycle_parking", "bicycle_rental", "charging_station",
                "community_centre", "theatre", "cinema", "marketplace", "dentist", "bus_station"},
    "shop": None,  # alle Läden
    "leisure": {"sports_centre", "swimming_pool", "stadium", "park", "playground", "water_park"},
    "tourism": {"museum", "attraction", "hotel", "camp_site", "zoo", "viewpoint"},
    "railway": {"station", "halt"},
    "public_transport": {"station"},
}


def poi_kind(tags: dict[str, str]) -> str | None:
    for k in POI_KEYS:
        v = tags.get(k)
        if not v:
            continue
        keep = POI_KEEP[k]
        if keep is None or v in keep:
            return f"{k}:{v}"
    return None


NODE_FLAGS = {"traffic_signals", "crossing", "give_way", "stop", "mini_roundabout", "turning_circle",
              "bus_stop", "motorway_junction"}
BARRIER_FLAGS = {"bollard", "cycle_barrier", "gate", "lift_gate", "block", "kissing_gate", "swing_gate"}


def node_flag(tags: dict[str, str]) -> str | None:
    h = tags.get("highway")
    if h in NODE_FLAGS:
        return h
    b = tags.get("barrier")
    if b in BARRIER_FLAGS:
        return b
    return None


PLACE_RANK = {"city": 1, "town": 2, "suburb": 3, "village": 3, "hamlet": 4, "quarter": 4,
              "neighbourhood": 5, "isolated_dwelling": 6, "locality": 6}
