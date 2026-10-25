# Kachelformat (Version 2, Spielmodell 2)

Jede Kachel ist eine gzip-komprimierte JSON-Datei `tiles/{stufe}/{ix}_{iy}.json.gz`.

```jsonc
{
  "v": 1,            // Formatversion
  "m": 2,            // Version des Spielmodells
  "lod": 0,          // Stufe 0 / 1 / 2
  "ix": 475, "iy": 5752,
  "size": 1000,      // Kantenlänge in Metern
  "origin": [475000, 5752000],  // Ecke unten links in UTM 32N
  "scale": 10,       // Koordinaten sind ganze Dezimeter relativ zu origin
  "areas": [...], "roads": [...], "lines": [...], "buildings": [...],
  "nodes": [...], "pois": [...], "places": [...]
}
```

Koordinaten: `Ost = origin[0] + x / scale`, `Nord = origin[1] + y / scale`. Linien und Ringe sind
flache Listen `[x0, y0, x1, y1, …]`. Werte dürfen außerhalb der Kachel liegen (Straßen werden nicht
abgeschnitten, Flächen schon).

## roads

```jsonc
{
  "id": "w34350497_123_456",  // Kanten-ID (stabil)
  "w": 34350497,              // OSM-Way
  "a": 123, "b": 456,         // Start-/Endknoten (OSM-IDs), Zeichenrichtung a -> b
  "len": 298.7,               // Länge in m
  "own": 1,                   // nur in der Kachel, der die Kante gehört
  "c": [x0, y0, ...],
  "m": { ...Spielmodell... }
}
```

In Stufe 1 und 2 enthalten Straßen nur `id`, `c` und ein verkürztes `m` (`cls`, `name`, `ref`, `ms`, `cw`,
`oneway`, `routes`). Stufe 1 enthält Haupt- und Sammelstraßen und seit Format 2 zusätzlich jede Kante einer
ausgeschilderten Radroute (auch Rad- und Wirtschaftswege), damit Routen im Überblick verfolgbar sind.

### Spielmodell `m`

| Feld | Bedeutung |
|---|---|
| `cls` | `auto`, `L` Hauptverkehrsstraße, `dorf` Sammelstraße, `wohn` Wohnstraße, `spiel` verkehrsberuhigt, `zufahrt`, `feld` Wirtschaftsweg, `rad` Radweg, `weg`, `fuss`, `treppe` |
| `hw` | ursprünglicher `highway`-Wert |
| `name`, `ref` | Straßenname, Nummer (z. B. `L 942`) |
| `cw` | halbe Fahrbahnbreite in m (Mitte bis Bordstein) |
| `oneway`, `round` | Einbahnstraße, Kreisverkehr |
| `ms`, `ms_cond` | Tempolimit km/h, zeitweise Regel |
| `fac_l`, `fac_r` | Radinfrastruktur links/rechts in Zeichenrichtung: 1 Schutzstreifen, 2 Radfahrstreifen, 3 Hochbord-Radweg, -1 separat erfasst |
| `frs` | Fahrradstraße |
| `bike` | 0 Räder verboten, 2 Radweg daneben benutzen; fehlt = erlaubt |
| `car` | 0 keine Autos, 2 nur Anlieger; fehlt = erlaubt |
| `sw_l`, `sw_r` | Gehwegbreite links/rechts in m |
| `surf`, `cond` | Fahrbahnbelag, Zustand 0–100. Beläge: `asphalt`, `concrete`, `concrete_plates`, `paving_stones`, `sett`, `cobblestone`, `compacted`, `fine_gravel`, `gravel`, `ground`, `sand`, `grass`, `grass_paver`, `wood`, `metal`, `paved`, `unpaved` |
| `surf_osm` | ursprünglicher OSM-Wert, falls er vereinheitlicht wurde (z. B. `asphalt;compacted`) |
| `tsurf`, `tcond` | Belag und Zustand des Hochbord-Radwegs |
| `routes` | Namen der ausgeschilderten Radrouten |
| `lit`, `segregated`, `tracktype`, `bridge`, `tunnel`, `layer`, `service` | aus OSM übernommen |
| `est` | Liste geschätzter Werte: `tempo`, `gehweg`, `belag`, `zustand`, `radweg_belag`, `radweg_zustand` |

## nodes

Graph-Knoten (Kreuzungen, Wegenden) und markierte Punkte auf Kanten.

```jsonc
{"id": 123, "x": 1234, "y": 5678, "f": "traffic_signals", "on": "w1_2_3"}
```

`f`: `traffic_signals`, `crossing`, `give_way`, `stop`, `mini_roundabout`, `turning_circle`, `bus_stop`,
Sperren wie `bollard`, `cycle_barrier`, `gate`. `on` steht nur bei Punkten mitten auf einer Kante.

## areas

```jsonc
{"k": "wald", "p": [[äußerer Ring], [Loch], ...]}
```

Arten: `wohngebiet`, `wald`, `wiese`, `acker`, `militaer`, `gewerbe`, `hof`, `friedhof`, `kleingarten`,
`obstwiese`, `heide`, `gebuesch`, `wasser`, `feuchtgebiet`, `sand`, `fels`, `abbau`, `brache`,
`baustelle`, `bahn`, `park`, `garten`, `schule`, `parkplatz`, `sportanlage`, `sportplatz`, `spielplatz`,
`laufbahn`.

## buildings

`{"t": "house", "p": [Ring], "lv": 2, "name": "…"}` – `t` ist der OSM-`building`-Wert. Gebäude liegen in
der Kachel ihres Mittelpunkts und werden nicht zugeschnitten.

## lines, pois, places

- `lines`: `{"k": "w:stream" | "r:rail" | …, "c": [...], "name": "…"}`
- `pois`: `{"k": "shop:bakery", "x", "y", "name"}` – Ziele für Fahrten
- `places`: `{"name", "typ", "rang", "ew", "x", "y"}` – Ortsnamen (Rang 1 Stadt … 6 Einzelhof)

## manifest.json

Name, Erstellzeit, OSM-Stand, `bbox_utm`, `bbox_wgs84`, vereinfachtes Gebietspolygon `gebiet_utm`,
`tile_size_m`, Liste aller Kacheln je Stufe (`tiles`), Größe je Stufe, Ortsliste und `statistik`
(km nach Klasse, Radinfrastruktur, Belag, Tempo 30, mittlerer Zustand, Gebäude usw.).
`ampeln` zählt OSM-Ampelknoten; eine Kreuzung hat oft mehrere davon (einen je Zufahrt).
