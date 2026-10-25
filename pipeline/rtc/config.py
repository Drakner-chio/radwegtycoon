"""Regionsdateien (YAML) laden und prüfen.

Beispiel::

    name: Kreis Lippe
    slug: lippe
    quellen:
      - https://download.geofabrik.de/europe/germany/nordrhein-westfalen/detmold-regbez-latest.osm.pbf
    gebiet:
      typ: verwaltung        # verwaltung | kreis | bbox | alles
      name: Kreis Lippe
      admin_level: 6
    rand_m: 1500             # Puffer um das Gebiet
"""
from __future__ import annotations

import dataclasses
import pathlib
import re

import yaml


@dataclasses.dataclass
class Region:
    name: str
    slug: str
    quellen: list[str]
    gebiet: dict
    rand_m: float = 1000.0
    kachel_m: tuple[int, int, int] = (1000, 8000, 32000)
    pfad: pathlib.Path | None = None

    @property
    def typ(self) -> str:
        return self.gebiet.get("typ", "alles")


class ConfigError(ValueError):
    pass


def load_region(path: str | pathlib.Path) -> Region:
    path = pathlib.Path(path)
    if not path.exists():
        raise ConfigError(f"Regionsdatei nicht gefunden: {path}")
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    for key in ("name", "quellen", "gebiet"):
        if key not in data:
            raise ConfigError(f"{path.name}: Feld '{key}' fehlt")
    slug = data.get("slug") or re.sub(r"[^a-z0-9]+", "-", data["name"].lower()).strip("-")
    quellen = data["quellen"]
    if isinstance(quellen, str):
        quellen = [quellen]
    g = data["gebiet"]
    typ = g.get("typ", "alles")
    if typ == "kreis":
        if "zentrum" not in g or "radius_km" not in g:
            raise ConfigError(f"{path.name}: gebiet.typ=kreis braucht 'zentrum: [lat, lon]' und 'radius_km'")
    elif typ == "verwaltung":
        if "name" not in g:
            raise ConfigError(f"{path.name}: gebiet.typ=verwaltung braucht 'name' (z. B. 'Kreis Lippe')")
    elif typ == "bbox":
        if len(g.get("bbox", [])) != 4:
            raise ConfigError(f"{path.name}: gebiet.typ=bbox braucht 'bbox: [min_lat, min_lon, max_lat, max_lon]'")
    elif typ != "alles":
        raise ConfigError(f"{path.name}: unbekannter gebiet.typ '{typ}'")
    kachel = tuple(data.get("kachel_m", (1000, 8000, 32000)))
    if len(kachel) != 3:
        raise ConfigError(f"{path.name}: kachel_m braucht drei Werte (Detail, Überblick, Fern)")
    return Region(name=data["name"], slug=slug, quellen=quellen, gebiet=g,
                  rand_m=float(data.get("rand_m", 1000)), kachel_m=kachel, pfad=path)
