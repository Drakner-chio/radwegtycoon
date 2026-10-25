# Radweg Tycoon – Hinweise für Claude

Hobbyprojekt: Pixel-Aufbauspiel zum Radnetz-Ausbau auf echten OSM-Daten.
Zielgebiet: Kreis Lippe bzw. ein Umkreis von 50–100 km. Sprache im Projekt (Code-Kommentare,
Doku, UI, Commit-Messages): Deutsch.

## Stand
- `pipeline/`: OSM → Kacheln, siehe `docs/ARCHITEKTUR.md` und `docs/KACHELFORMAT.md`.
- `viewer/`: Kartenviewer + Spiel (statisch, nginx), lädt `daten/<slug>/karte/`; Aufruf `?region=<slug>`.
  Bauen: `js/game.js`; Verkehr Ebene 1: `pipeline/rtc/netz.py` → `netz.json.gz`, `js/verkehr*.js`;
  Ebene 2 (Live-Verkehr): `js/live.js`. Höhen: `pipeline/rtc/hoehe.py` → `hoehe/`, `js/hoehe.js`.
  Iso-Prototyp: `iso.html`, `js/iso.js`.
- `prototypen/`: Testdorf-Spiel (Feldraster) und erste Ortsvorschau (eine HTML-Datei mit
  eingebetteten Daten). Beide sind Vorstufen; das eigentliche Spiel baut auf dem Viewer auf.

## Regeln
- Koordinaten immer UTM 32N (EPSG:25832) in Metern; Kachelkoordinaten in Dezimetern relativ zur Ecke.
- Kanten-IDs `w{way}_{von}_{nach}` nicht ändern – Spielstände hängen daran.
- Schätzungen in `rtc/model.py` müssen deterministisch bleiben (Hash der Way-ID), geschätzte Felder in `est`.
- Bei Änderungen an Kachelinhalt `FORMAT_VERSION` bzw. `MODEL_VERSION` in `rtc/__init__.py` erhöhen
  und `docs/KACHELFORMAT.md` anpassen.
- Keine konkreten Heimatort-Bezüge (Ortsnamen, Koordinaten) ins Repo; eigene Regionen nach
  `pipeline/regionen/lokal/` (gitignored).
- OSM-Hinweis „© OpenStreetMap-Mitwirkende, ODbL“ muss im Spiel sichtbar sein.

## Testen
```bash
cd pipeline && pip install -r requirements.txt && python -m pytest tests
python -m rtc bauen regionen/ausschnitt.yaml --daten ./daten --eingabe <map.osm>
```
osmium-tool (für `ausschnitt`) gibt es im Docker-Image; lokal reicht `--eingabe`.
