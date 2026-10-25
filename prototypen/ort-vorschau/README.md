# Erste Ortsvorschau

Eine HTML-Seite mit eingebetteten Kartendaten (Vorstufe zum Kachel-Viewer).

```bash
python3 osm2game.py map.osm ort.json
python3 -c "import pathlib;t=pathlib.Path('vorlage.html').read_text();d=pathlib.Path('ort.json').read_text();pathlib.Path('ort-vorschau.html').write_text(t.replace('/*DATA*/null',d))"
```

`map.osm` kommt aus dem Export auf openstreetmap.org. Die erzeugte HTML enthält OSM-Daten (ODbL) und
wird deshalb nicht eingecheckt.
