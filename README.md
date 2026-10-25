# Radweg Tycoon

Ein Aufbauspiel im Pixel-Stil: Du baust das Radnetz einer echten Region aus – erst ein einzelner Ort,
dann der Kreis Lippe, später ein Umkreis von 50 bis 100 km. Straßen, Radwege, Beläge und Gebäude kommen aus
OpenStreetMap; Auto- und Radverkehr werden simuliert.

## Aufbau des Repos

| Ordner | Inhalt |
|---|---|
| `pipeline/` | Kartenpipeline: OpenStreetMap → Spielkacheln (Python, Docker) |
| `prototypen/` | Bisherige Prototypen: Testdorf-Spiel und die erste Ortsvorschau |
| `docs/` | Architektur und Kachelformat |

## Kartenpipeline in drei Schritten

Die Pipeline läuft bei dir (z. B. auf dem Unraid-Server) und braucht Docker.

```bash
# 1. Image bauen
docker build -t radwegtycoon-pipeline pipeline/

# 2. Lauf für den Kreis Lippe (lädt ~130 MB von Geofabrik, dauert einige Minuten)
docker run --rm -v /mnt/user/appdata/radwegtycoon:/data radwegtycoon-pipeline alles regionen/lippe.yaml

# 3. Ergebnis ansehen
#    /mnt/user/appdata/radwegtycoon/lippe/karte/manifest.json        Übersicht und Statistik
#    /mnt/user/appdata/radwegtycoon/lippe/karte/vorschau_*.png       Kontrollbilder
#    /mnt/user/appdata/radwegtycoon/lippe/karte/tiles/{0,1,2}/…      die Spielkacheln
```

Vorhandene Regionen in `pipeline/regionen/`:

| Datei | Gebiet | Quelle |
|---|---|---|
| `ausschnitt.yaml` | eigene kleine OSM-Datei (mit `--eingabe`) | – |
| `lippe.yaml` | Kreis Lippe nach Verwaltungsgrenze | Regierungsbezirk Detmold |
| `umkreis-50km.yaml` | 50 km um einen Mittelpunkt (Vorlage) | NRW + Niedersachsen |
| `umkreis-100km.yaml` | 100 km um einen Mittelpunkt (Vorlage) | Deutschland |

Eigene Regionen, z. B. mit dem echten Mittelpunkt, gehören nach `pipeline/regionen/lokal/`. Der Ordner
wird von git ignoriert; Aufruf dann mit `regionen/lokal/meine-region.yaml`.

**Mehr Kerne nutzen:** Standard sind so viele Prozesse wie Kerne, höchstens 16. Mehr gibt man mit
`--jobs` an, z. B. `… radwegtycoon-pipeline alles regionen/lippe.yaml --jobs 32`. Die Pipeline schneidet
das Gebiet dafür in Nord-Süd-Streifen (osmium) und verteilt sie auf die Prozesse.

Einzelne Schritte gehen auch getrennt: `download`, `ausschnitt`, `bauen`, `vorschau`, `info`.
Eine vorhandene Datei (z. B. die Planet-Datei) nutzt man über `quellen:` in der Regionsdatei mit
einem Pfad unter `/data/quellen/`.

Ohne Docker, z. B. zum Testen mit einer `map.osm` aus dem Export von openstreetmap.org:

```bash
cd pipeline
pip install -r requirements.txt
python -m rtc bauen regionen/ausschnitt.yaml --daten ./daten --eingabe ~/Downloads/map.osm
python -m rtc vorschau regionen/ausschnitt.yaml --daten ./daten
python -m pytest tests
```

## Lizenz der Kartendaten

Alle erzeugten Kacheln enthalten Daten aus OpenStreetMap: © OpenStreetMap-Mitwirkende, ODbL 1.0
(<https://www.openstreetmap.org/copyright>). Das Spiel muss diesen Hinweis sichtbar anzeigen.
