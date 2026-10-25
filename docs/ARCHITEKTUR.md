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
2. Spiel auf dem Graphen: ~~Bauen pro Kante/Straßenzug~~ (Stufe 1 erledigt, `viewer/web/js/game.js`);
   Verkehr Ebene 1 (Nachfrage, Radrouten, Radanteil, Zufriedenheit, Jahresbudget) erledigt, siehe unten;
   Ebene 2 (sichtbare Autos/Räder) erste Fassung erledigt; offen: Autoverkehr im Modell, Eichung, Linksabbiegen/Gegenverkehr.
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

## Spiel, Stufe 1: Bauen (`viewer/web/js/game.js`)

- Ein Ausbau ist ein Patch auf das Spielmodell einer Kante (dieselben Felder wie in den Kacheln,
  z. B. `fac_l/fac_r`, `tsurf/tcond`, `ms`, `frs`). Beim Dekodieren einer Kachel wird der Patch
  über das Original gelegt (`m0` bleibt erhalten), dadurch zeichnet die Karte den Ausbau sofort.
- Spielstand im Browser (`localStorage`, Schlüssel `rtc-spiel-<slug>`), verknüpft über die Kanten-IDs.
  Jeder Auftrag hat einen Logeintrag mit dem Vorzustand → Rückgängig ist exakt.
- Kosten: €/m Länge (Fahrbahn erneuern: €/m² über `cw`), Pauschale einmal pro Auftrag.
- Straßenzug: gleiche Bezeichnung (Name oder Nummer), über Knoten verbunden, in den geladenen Detailkacheln.
- Wirkung: Risiko und Komfort aus `bikeValues()` vorher/nachher, längengewichtet.
- Mehrfachauswahl: Umschalt + Klick sammelt Abschnitte, ein Auftrag baut alle aus.
- Bestandsaufnahme pro Ort: nächster Ortsmittelpunkt zur Bildmitte (bis zum doppelten Radius je Rang:
  Stadt 6 km, Kleinstadt 3 km, Dorf/Stadtteil 1,5 km, Weiler 0,7 km); gezählt werden eigene Kanten der
  Detailkacheln im einfachen Radius, Ausbauten eingerechnet. Kachelindizes sind absolute UTM-Kilometer.
- Radrouten-Overlay (`T`): jede Route in eigener Farbe (Hash des Namens), mehrere Routen auf einer Kante
  nebeneinander. Legende = Routen im Bild; Klick hebt eine Route hervor. Im Info-Fenster lässt sich die
  hervorgehobene Route komplett markieren (alle geladenen Detailkacheln) und in einem Auftrag ausbauen.
  Dafür enthält Stufe 1 seit Format 2 alle Routenkanten.
- „Zum Radweg ausbauen“ macht aus Feld-/Wald-/Fußwegen einen roten Asphalt-Radweg (`cls` wird `rad`).

## Verkehr, Ebene 1 (`pipeline/rtc/netz.py`, `viewer/web/js/verkehr*.js`)

- Pipeline-Schritt `netz` (läuft in `bauen`/`alles` mit) liest die Detailkacheln und schreibt `netz.json.gz`:
  Graph (Knoten, Kanten mit Rad-relevanten Modellfeldern, spaltenweise) und 500-m-Zellen mit geschätzten
  Einwohnern (Wohngebäude: Grundfläche × Geschosse × 0,75 / 45 m²), Arbeitsplätzen (Gewerbegebäude) und
  Zielen aus POIs (Schule, Einkauf, Versorgung, Freizeit, Bahnhof). Jede Zelle hängt am nächsten
  fürs Rad nutzbaren Knoten.
- Browser: `verkehr.js` berechnet je Kante einen Faktor „gefühlte Meter je Meter“ aus `bikeValues()`
  (mit Ausbauten): `1 + 2,2 · Risiko + 1,5 · (1 − Komfort)`; Fußweg ohne Radfreigabe 3,5 (schieben),
  Fahrbahn mit Radweg daneben 4, Autobahn/Treppe gesperrt. Die Startzellen werden auf mehrere Web Worker
  verteilt (`verkehr-worker.js`), das Modell selbst steht in `verkehr-modell.js` (auch in Node lauffähig).
- Modell je Startzelle: Wege = Einwohner × 2,2, Verteilung auf Ziele per Schwerkraft (Luftlinie,
  exp(−d / 6 km)); Dijkstra auf gefühlten Metern bis 16 km; Radanteil
  `0,38 / (1 + (L / 4,2 km)^2,4) · exp(−1,1 · (q − 1,25))` mit q = gefühlt / echt; Umlegen auf den
  Kürzeste-Wege-Baum. Zufriedenheit je Zelle: wie direkt und stressarm die Ziele bis 10 km erreichbar sind.
  Wege innerhalb einer Zelle und der Autoverkehr sind noch nicht modelliert. Alle Werte: `PARAM`.
- Spielschleife: Ausbau → Neuberechnung (Anzeige der Änderung) → „Jahr abschließen“ bringt Einnahmen
  `400.000 € + 12.000 € × Zufriedenheit + 2 Mio. € × Radanteil` (Platzhalter bis zur Eichung).

## Verkehr, Ebene 2: Live-Verkehr (`viewer/web/js/live.js`)

- Läuft ab Zoom 0,3 px/m im sichtbaren Ausschnitt plus Rand (höchstens 3,5 × 3,5 km), Taste `L` schaltet.
  Netz = Kanten der geladenen Detailkacheln (mit Ausbauten); wird beim Verschieben neu aufgebaut,
  Fahrzeuge auf weiter bestehenden Kanten bleiben.
- Mengen in der Spitzenstunde (10 % des Tages): Rad aus Ebene 1, Auto vorerst geschätzt nach Klasse
  (`AUTO_TAG`, ±40 % per Hash der Way-ID). Ein- und Ausfahrt an Knoten außerhalb des Gebiets und an Sackgassen,
  Abbiegen zufällig gewichtet nach den Mengen der abgehenden Kanten.
- Folgemodell IDM je Spur (Auto-Spur und Radspur je Kante und Richtung, rechts der Fahrtrichtung versetzt:
  Auto `cw/2`, Rad im Mischverkehr/Streifen am Fahrbahnrand, Hochbord `cw + 1,1 m`).
- Vorfahrt: Ampel (zwei Phasen nach Achse, 26 s, 3 s Räumzeit, Radvorlauf 2 s), Kreisverkehr vor Einfahrt,
  sonst Straßenrang (Fahrradstraße = Sammelstraße), gleicher Rang: rechts vor links. Knoten werden nach
  einer Durchfahrt kurz für andere Zufahrten gesperrt; wer > 9 s (Rad 6 s) wartet, fährt.
- Kennzahlen: „eng überholt“ (Auto überholt Rad auf gleicher Kante mit < 1,5 m Seitenabstand, nicht bei
  Radfahrstreifen/Hochbord/Fahrradstraße) und „Abbiegekonflikte“ (Rechtsabbieger über Hochbord-Radweg,
  während ein Rad weniger als 18 m entfernt ist), jeweils pro Stunde.

## Spielansicht (isometrisch, `viewer/web/js/isoansicht.js`)

- Die Karte ist Überblick und Planung (mit allen Auswertungsebenen); gespielt wird in der Spielansicht.
  Weites Hineinzoomen in der Karte (> 2,4 px/m) wechselt hinein, Herauszoomen unter die kleinste Stufe zurück;
  Taste `I`. Werkzeuge, Auswahl und Info funktionieren in beiden Ansichten (gleiche Weltkoordinaten,
  Markierungen werden je Ansicht projiziert). Ebenen schalten auf die Karte zurück.
- 2:1-Isometrie, vierfach drehbar (`Q`/`E`), Zoomstufen 1–6 Pixel/m in halber Auflösung (Pixel-Look).
- Gelände aus dem Höhenmodell (1,5-fach überhöht, relativ zur Bildmitte), verdichtete Linien und Flächen,
  Hangschattierung in 10-m-Zellen, Gebäude auf ihrer tiefsten Ecke (Sockel am Hang); Klicks werden iterativ
  auf das Gelände zurückprojiziert.
- Gebäude: Fenster je Geschoss, Sockel, Haustür, Sattel- oder Walmdach mit Ziegelreihen, Schornstein,
  Solarmodule auf Süddächern; Flachdächer für Gewerbe. Bäume, Büsche, Laternen, Ampeln mit aktueller Phase,
  gebaute Kreisel, Zebrastreifen an markierten Querungen, Haltelinien vor Ampeln, runde Kreuzungsecken.
- Leben: Fahrzeugtypen des Live-Verkehrs (Pkw, Kleinwagen, Transporter, Bus) mit Licht, Radler mit
  Tretbewegung, Passanten auf Gehwegen, belegte Parkplätze.
- Tageszeiten (`U`): Tönung per Multiplikation; nachts beleuchtete Fenster auf einer eigenen Lichtebene
  (Verdeckung, indem jedes Objekt seine Silhouette aus der Lichtebene löscht), Lichtkegel von Laternen und
  Scheinwerfern.
- Bau-Rückmeldung: Baken entlang neuer Strecken (25 s), Kosten und Wirkung (Radanteil, Zufriedenheit) als
  aufsteigende Zahl über dem Bauort.
- Statische Szene mit Rand zwischengespeichert; Fahrzeuge, Passanten, Ampeln und Baken je Bild darüber,
  davorliegende Gebäude/Bäume über ihnen neu gezeichnet. `iso.html` leitet auf die Spielansicht weiter.

## Höhen (`pipeline/rtc/hoehe.py`, `viewer/web/js/hoehe.js`)

- Quelle NRW: DGM1 von Geobasis NRW (1-m-Raster, GeoTIFF, 1-km-Kacheln im selben Raster wie unsere Kacheln,
  Datenlizenz Deutschland – Zero 2.0). Die Dateiliste kommt aus dem Download-Verzeichnis; Dateien werden in
  `/data/quellen/dgm1/` zwischengespeichert (Lippe: rund 2.000 Kacheln, einige GB). Außerhalb von NRW: keine
  Höhen (später Copernicus GLO-30 als Ersatz). Regionsdatei: `hoehe: dgm1_nrw`; Schritt `hoehe` läuft in
  `alles` mit, `--dgm <ordner>` nimmt eigene GeoTIFFs.
- Spielraster: 10-m-Zellmittel je 1-km-Kachel, 80 m im Überblick; Kanten bekommen Höhenmeter auf/ab und die
  steilste Steigung über 30 m (`netz.json.gz`).
- Verkehrsmodell: Faktoren je Richtung; 1 Hm bergauf = 10 gefühlte Meter, über 6 % Steigung Zuschlag
  (`BERG` in `verkehr.js`).
- Karte: Schummerung (Licht aus Nordwest, 2,5- bzw. 4-fach überhöht) in den Raster-Stücken, Ebene „Steigung“ (`B`),
  Relief schaltbar (`G`), Steigung im Info-Fenster.
- Offen: Gelände in der Iso-Ansicht, Höhenlinien.

## Bauwerkzeuge und Oberfläche

- Oberfläche: Karte als Vollbild, schwebende Panels (Kopfzeile mit Haushalt/Radanteil/Zufriedenheit,
  Werkzeugleiste links, Werkzeug-Panel oben, Ansichten unten links, Seitenpanel mit Reitern Info/Bauamt/
  Verkehr/Ort). Schriften: Inter für Text, Silkscreen für kleine Beschriftungen.
- Streckenwerkzeug (`js/werkzeug.js`): Wegpunkte sind Kanten; zwischen zwei Wegpunkten sucht ein Dijkstra
  auf dem geladenen Detailnetz den Verlauf (Wechsel auf andere Straßennamen/-klassen kostet 60 % mehr, damit
  der Weg auf „seiner“ Straße bleibt). So fehlen keine kurzen Abschnitte an Kreuzungen. Straßenwerkzeuge
  laufen nur über Straßen, Wegwerkzeuge nur über Wege; Abschnitte, auf die der Ausbau nicht passt, werden
  angezeigt, aber nicht berechnet. „Ganze Straße“ übernimmt den Straßenzug des ersten Abschnitts.
- Kreuzungen: Ampel (150.000 €) und Kreisverkehr (650.000 €) als Knoten-Bauten im Spielstand (`knoten`),
  rückgängig wie Streckenausbauten. Wirkung: Live-Verkehr (Ampelphasen bzw. Kreisel mit Vorfahrt für Fahrzeuge
  von links und Tempo ~20), Verkehrsmodell über Knotenstrafen (gefühlte Meter fürs Queren: Hauptstraße 45,
  Sammelstraße 18, mit Ampel 10, mit Kreisel 14; `KNOTEN_STRAFE` in `verkehr.js`), Darstellung in Karte und Iso.
- Tasten: 1–9 Streckenwerkzeuge, A Ampel, K Kreisverkehr, Enter/Doppelklick bauen, Rücktaste Wegpunkt zurück,
  Esc abbrechen, Strg+Z rückgängig.

## Spielablauf: Hauptmenü, Spielgebiet, Spielstände

- Beim Öffnen erscheint das Hauptmenü (Weiterspielen, Neues Spiel, Spiel laden, Steuerung); im Spiel über
  das Logo oben links oder Taste `M` (dann auch Speichern).
- Neues Spiel: Name, dann Spielgebiet als Kreis auf der Karte (Mittelpunkt per Klick, Radius 0,5–60 km,
  Schnellwahl 1/3/10/25 km) oder ganze Region. Das Gebiet (`spiel.s.gebiet`, Weltmeter) begrenzt
  - das Verkehrsmodell: nur Zellen im Kreis sind Start und Ziel (Maske im Worker),
  - alle Kennzahlen (Radanteil, Zufriedenheit, Einwohner, Einnahmen),
  - das Bauen (Mitte des Abschnitts bzw. Kreuzung muss im Kreis liegen),
  - die Darstellung (außerhalb abgedunkelt, in Karte und Spielansicht).
  Startkapital 250 € je Einwohner (mind. 300.000 €), Einnahmen je Jahr Einwohner × (60 + 1,2 × Zufriedenheit
  + 250 × Radanteil) € – Platzhalter bis zur Eichung.
- Spielstände (`js/speicher.js`): laufender Stand automatisch (`rtc-spiel-<slug>`), dazu sechs Speicherplätze
  (`rtc-save-<slug>-<n>`) mit Metadaten, Export/Import als JSON-Datei (Sicherung, anderer Rechner).
- Spielansicht genordet (Drehung 45° + k·90°), Schutz-/Radfahrstreifen verbreitern schmale Fahrbahnen
  auf 7 bzw. 8 m (160 € je m Länge und m Mehrbreite).
