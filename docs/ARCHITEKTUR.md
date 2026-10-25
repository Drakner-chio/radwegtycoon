# Architektur

## Ziel und Größenordnung

| Gebiet | Fläche | Faktor zur ersten Vorschau |
|---|---|---|
| Ein Ort (Test) | ca. 9 km² | 1× |
| Kreis Lippe | ca. 1.250 km² | ca. 140× |
| 50 km Umkreis | ca. 7.900 km² | ca. 900× |
| 100 km Umkreis | ca. 31.400 km² | ca. 3.500× |

Daraus folgen drei Grundsätze:

1. **Kacheln statt einer Datei.** Das Spiel lädt nur die Kacheln um die Kamera.
2. **Detailstufen.** Von weit oben reichen Hauptstraßen und Ortsflächen, nah dran jedes Haus.
3. **Zwei Ebenen in der Simulation.** Einzelne Fahrzeuge nur in einer Detailzone, dazwischen
   Verkehrsströme auf dem Hauptnetz (kommt später).

## Datenfluss

```
Geofabrik-Auszug (.osm.pbf)      oder Planet-Datei
        │  osmium merge          (bei mehreren Quellen)
        │  osmium extract        Gebiet: Verwaltungsgrenze, Kreis oder Rechteck + Rand
        │  osmium tags-filter    nur spielrelevante Daten
        ▼
gebiet.osm.pbf
        │  rtc.build  Durchlauf 1: Kreuzungsknoten zählen, Radrouten sammeln
        │  rtc.build  Durchlauf 2: Straßen → Kanten, Flächen, Gebäude, Ziele, Orte
        │  rtc.model  OSM-Tags → Spielmodell (Klasse, Querschnitt, Belag, Zustand)
        │  rtc.sink   auf Kacheln verteilen, große Mengen auf die Platte auslagern
        ▼
karte/manifest.json + karte/tiles/{0,1,2}/{ix}_{iy}.json.gz
```

## Festgelegte Entscheidungen

Diese Punkte sind teuer zu ändern und deshalb hier festgehalten.

**Koordinatensystem:** ETRS89 / UTM Zone 32N (EPSG:25832). Alles in Metern, Nord zeigt nach oben.
Das ist das amtliche System in NRW; Zählstellen, Unfallatlas und Zensus-Raster lassen sich direkt
überlagern. Das Spiel kippt die y-Achse beim Zeichnen selbst.

**Kachelschema:** Kachel `(ix, iy) = (floor(Ost / Größe), floor(Nord / Größe))`.

| Stufe | Größe | Inhalt |
|---|---|---|
| 0 Detail | 1 km | alles: Straßenkanten mit Querschnitt, Gebäude, Flächen, Knoten, Ziele, Orte |
| 1 Überblick | 8 km | Haupt- und Sammelstraßen (vereinfacht 3 m), große Flächen (vereinfacht 6 m), Flüsse, Bahn |
| 2 Fern | 32 km | Hauptstraßen (20 m), sehr große Flächen (30 m), Städte |

Stufe 0 entspricht dem amtlichen 1-km-Raster. Die Größen sind je Region einstellbar (`kachel_m`).

**Straßengraph mit stabilen IDs:**
- Knoten = OSM-Knoten an Kreuzungen und Wegenden, ID = OSM-Knoten-ID.
- Kante = Stück eines OSM-Ways zwischen zwei solchen Knoten, ID = `w{way}_{von}_{nach}`.
- Jede Kante gehört genau einer Kachel (der ihres Mittelpunkts, Feld `own: 1`); zum Zeichnen liegt sie
  zusätzlich in allen Nachbarkacheln, die sie berührt.

So findet ein Spielstand eine Straße wieder, auch wenn die Karte mit neueren OSM-Daten neu gebaut wird.
Ändert sich in OSM etwas an einer Kreuzung, fällt der Spielstand auf die Way-ID plus Geometrie zurück
(muss das Spiel noch umsetzen).

**Basisdaten und Spielstand getrennt:** Die Kacheln sind der Ausgangszustand und werden nie verändert.
Umbauten, Verschleiß und Sanierungen speichert das Spiel als eigene Schicht, geschlüsselt nach Kanten-ID.

**Deterministische Schätzungen:** Was in OSM fehlt (Zustand, Gehwege, Tempo, Radwegbelag), schätzt
`rtc.model` aus einem Hash der Way-ID. Jeder Lauf ergibt dieselbe Karte; das Feld `est` sagt, was
geschätzt ist.

## Nächste Schritte

1. ~~Kachel-Viewer~~ erledigt: `viewer/` (siehe unten).
2. Spiel auf dem Graphen: Simulation mit Vorfahrt, Ampeln, Kreisverkehren; Bauen pro Straßenzug.
3. Grobe Ebene: Verkehrsströme zwischen Orten, geeicht mit Straßenverkehrszählung und Pendlerstatistik.
4. Weitere Daten: Zensus-Raster (Einwohner), Unfallatlas (Radunfälle), Zählstellen.

## Kartenviewer (`viewer/`)

- Reine statische Seite (ES-Module, kein Build-Schritt), ausgeliefert von nginx; Kacheln per Volume unter `daten/`.
- Kacheln werden als gzip geladen und im Browser mit `DecompressionStream` entpackt.
- Weltkoordinaten im Viewer: x = Ost − Ost₀, y = Nord₀ − Nord (y nach unten), in Metern.
- Vier Darstellungsstufen: fern (LOD 2), Überblick (LOD 1), Ort und Detail (LOD 0). Gezeichnet wird in
  Raster-Stücke, die zwischengespeichert werden; darunter liegt immer die gröbere Stufe, damit beim
  Nachladen keine Löcher entstehen.
- Muster im Pixel-Stil mit 0,5 m pro Musterpixel; Spuren, Radwege und Gehwege als versetzte Linien
  (positiv = rechts der Zeichenrichtung).
- Der Inspektor zeigt das Spielmodell einer Kante; geschätzte Felder (`est`) sind markiert.
