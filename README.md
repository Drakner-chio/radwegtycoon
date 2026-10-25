# Radweg Tycoon

Ein Aufbauspiel im Pixel-Stil: Du baust das Radnetz einer echten Region aus – erst ein einzelner Ort,
dann der Kreis Lippe, später ein Umkreis von 50 bis 100 km. Straßen, Radwege, Beläge und Gebäude kommen aus
OpenStreetMap; Auto- und Radverkehr werden simuliert.

## Aufbau des Repos

| Ordner | Inhalt |
|---|---|
| `pipeline/` | Kartenpipeline: OpenStreetMap → Spielkacheln (Python, Docker) |
| `viewer/` | Kartenviewer im Spielstil: lädt die Kacheln nach, ganze Region flüssig (nginx, Docker) |
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

## Kartenviewer

Zeigt eine fertig gebaute Region im Pixel-Stil: vom ganzen Kreis bis zur einzelnen Straße mit Querschnitt,
Belag, Zustand und Risiko fürs Rad. Die Kacheln werden beim Verschieben und Zoomen nachgeladen.

```bash
docker build -t radwegtycoon-viewer viewer/
docker run -d --name radwegtycoon-viewer --restart unless-stopped -p 8190:80 \
  -v /mnt/user/appdata/radwegtycoon:/usr/share/nginx/html/daten:ro radwegtycoon-viewer
# dann im Browser:  http://<server>:8190/?region=lippe
```

`region` ist der `slug` der Regionsdatei, der Viewer lädt `daten/<slug>/karte/`. Nach einem neuen
Pipeline-Lauf reicht ein Neuladen der Seite; nach `git pull` das Image neu bauen und den Container neu starten.
Tasten: Mausrad/+/− zoomen, Umschalt + Klick markiert mehrere Abschnitte zum gemeinsamen Ausbau, Pfeile verschieben, `Z` Zustand, `S` Sicherheit, `R` Radnetz, `T` Radrouten, `N` Namen.

## Lizenz der Kartendaten

Alle erzeugten Kacheln enthalten Daten aus OpenStreetMap: © OpenStreetMap-Mitwirkende, ODbL 1.0
(<https://www.openstreetmap.org/copyright>). Das Spiel muss diesen Hinweis sichtbar anzeigen.
