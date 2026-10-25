// Radweg Tycoon – Spiellogik, Stufe 1: Ausbauten pro Kante, Budget, Spielstand.
// Ein Ausbau ist ein „Patch“ auf das Spielmodell einer Kante (gleiche Felder wie in den Kacheln).
// Der Spielstand hängt an den Kanten-IDs w{way}_{von}_{nach} und liegt im Browser (localStorage).
import { isRoad, halfWidth } from './tiles.js';
import { bikeValues } from './render.js';

export const START_BUDGET = 2_000_000;

// Kosten grob nach üblichen Richtwerten (€/m Straßenlänge bzw. pauschal).
// gilt(m) entscheidet, ob der Ausbau für die Kante angeboten wird.
export const AUSBAU = [
  // cw im Spielmodell ist die halbe Fahrbahnbreite. breiteMin = nötige volle Fahrbahnbreite; schmalere
  // Fahrbahnen werden beim Bau verbreitert (Mehrkosten je Meter Mehrbreite, siehe kosten()).
  { id: 'schutz', art: 'strasse', name: 'Schutzstreifen', info: 'Markierung beidseitig, Autos dürfen bei Bedarf drüber. Verbreitert die Fahrbahn auf 7 m, falls nötig.', proM: 30, fix: 0, breiteMin: 7,
    gilt: m => isRoad(m) && ['L', 'dorf', 'wohn'].includes(m.cls) && 2 * (m.cw || 0) >= 5 && Math.max(m.fac_l || 0, m.fac_r || 0) < 1 && !m.frs,
    patch: m => ({ fac_l: 1, fac_r: 1, bike: 1, cw: Math.max(m.cw || 0, 3.5) }) },
  { id: 'streifen', art: 'strasse', name: 'Radfahrstreifen', info: 'Durchgezogene Linie, eigener Fahrstreifen fürs Rad. Verbreitert die Fahrbahn auf 8 m, falls nötig.', proM: 70, fix: 0, breiteMin: 8,
    gilt: m => isRoad(m) && ['L', 'dorf', 'wohn'].includes(m.cls) && 2 * (m.cw || 0) >= 5 && Math.max(m.fac_l || 0, m.fac_r || 0) < 2 && !m.frs,
    patch: m => ({ fac_l: 2, fac_r: 2, bike: 1, cw: Math.max(m.cw || 0, 4) }) },
  { id: 'hochbord', art: 'strasse', name: 'Baulicher Radweg', info: 'Getrennt von der Fahrbahn, asphaltiert, beidseitig.', proM: 480, fix: 0,
    gilt: m => isRoad(m) && m.cls !== 'auto' && m.cls !== 'spiel' && Math.max(m.fac_l || 0, m.fac_r || 0) !== 3,
    patch: m => ({ fac_l: 3, fac_r: 3, tsurf: 'asphalt', tcond: 96, bike: 1 }) },
  { id: 'radweg_san', art: 'strasse', name: 'Radweg sanieren', info: 'Neue Asphaltdecke auf dem vorhandenen Radweg.', proM: 160, fix: 0,
    gilt: m => Math.max(m.fac_l || 0, m.fac_r || 0) === 3 && ((m.tcond ?? 100) < 90 || m.tsurf !== 'asphalt'),
    patch: m => ({ tsurf: 'asphalt', tcond: 96 }) },
  { id: 'decke', art: 'strasse', name: 'Fahrbahn erneuern', info: 'Neue Deckschicht, gleicher Belag.', proM: 0, proM2: 45, fix: 0,
    gilt: m => isRoad(m) && (m.cond ?? 100) < 90,
    patch: m => ({ cond: 96 }) },
  { id: 'asphalt', art: 'weg', name: 'Weg asphaltieren', info: 'Glatter Belag für Wirtschafts-, Rad- und Fußwege.', proM: 110, fix: 0,
    gilt: m => !isRoad(m) && m.cls !== 'treppe' && (m.surf !== 'asphalt' || (m.cond ?? 100) < 90),
    patch: m => ({ surf: 'asphalt', cond: 96, ...(m.cls === 'fuss' || m.cls === 'weg' ? { bike: 1 } : {}) }) },
  { id: 'radweg', art: 'weg', name: 'Zum Radweg ausbauen', info: 'Asphaltierter, roter Radweg (2,5 m) statt Feld-, Wald- oder Fußweg.', proM: 260, fix: 0,
    gilt: m => ['feld', 'weg', 'fuss'].includes(m.cls),
    patch: m => ({ cls: 'rad', surf: 'asphalt', cond: 96, cw: Math.max(m.cw || 0, 1.25), bike: 1, ms: 0 }) },
  { id: 'tempo30', art: 'strasse', name: 'Tempo 30', info: 'Schilder; senkt das Risiko im Mischverkehr deutlich.', proM: 2, fix: 3000,
    gilt: m => isRoad(m) && ['dorf', 'wohn', 'L'].includes(m.cls) && (m.ms || 50) > 30,
    patch: m => ({ ms: 30 }) },
  { id: 'frs', art: 'strasse', name: 'Fahrradstraße', info: 'Rad hat Vorrang, Autos nur als Anlieger, Tempo 30.', proM: 15, fix: 6000,
    gilt: m => isRoad(m) && ['dorf', 'wohn', 'zufahrt'].includes(m.cls) && !m.frs,
    patch: m => ({ frs: 1, ms: 30, bike: 1 }) },
];

// Bauten an Kreuzungen. k: { grad, strassen, rang, ampel, kreisel, autobahn } aus dem geladenen Netz
export const KNOTEN = [
  { id: 'ampel', name: 'Ampel', info: 'Lichtsignalanlage mit Radvorlauf. Sicherer Querungen, Wartezeit für alle.', fix: 150_000,
    gilt: k => k.strassen >= 2 && k.grad >= 3 && !k.ampel && !k.kreisel && !k.autobahn },
  { id: 'kreisel', name: 'Kreisverkehr', info: 'Kompakter Kreisverkehr: Einfahrende warten, alle fahren langsam.', fix: 650_000,
    gilt: k => k.strassen >= 3 && !k.kreisel && !k.autobahn },
];

export const VERBREITERN_JE_M = 160; // € je Meter Straßenlänge und Meter Mehrbreite
export function kosten(a, r) {
  const m = r.m || r.m0, breite = 2 * (m.cw || 2.5);
  const mehr = a.breiteMin ? Math.max(0, a.breiteMin - breite) * VERBREITERN_JE_M : 0;
  return Math.round(r.len * (a.proM + (a.proM2 || 0) * breite + mehr));
}
// Pauschale (Schilder, Planung) fällt einmal pro Auftrag an, nicht pro Abschnitt
export const gesamt = (a, roads) => roads.length ? a.fix + roads.reduce((s, r) => s + kosten(a, r), 0) : 0;

export class Spiel {
  constructor(slug) {
    this.key = 'rtc-spiel-' + slug;
    this.s = { budget: START_BUDGET, kanten: {}, log: [] };
    try { const v = JSON.parse(localStorage.getItem(this.key)); if (v && v.kanten) this.s = v; } catch (e) {}
    if (!this.s.jahr) { this.s.jahr = 1; this.s.jahre = []; }
    if (!this.s.knoten) this.s.knoten = {};
    this.onChange = () => {};
  }
  speichern() { try { localStorage.setItem(this.key, JSON.stringify(this.s)); } catch (e) {} this.onChange(); }
  patchFor(id) { const k = this.s.kanten[id]; return k ? k.p : null; }
  knotenFor(id) { return this.s.knoten[id] || null; }

  // Bau an einer Kreuzung (Ampel ersetzt nichts, Kreisverkehr ersetzt eine Ampel)
  bauenKnoten(a, id, k, name) {
    if (!a.gilt(k) || a.fix > this.s.budget) return null;
    const alt = this.s.knoten[id] || null;
    this.s.knoten[id] = a.id === 'kreisel' ? { ...(alt || {}), kreisel: 1, ampel: 0 } : { ...(alt || {}), [a.id]: 1 };
    const e = { a: a.id, name, kosten: a.fix, kanten: [], vorher: {}, knoten: [id], vorherK: { [id]: alt }, t: Date.now() };
    this.s.budget -= a.fix; this.s.log.push(e); this.speichern();
    return e;
  }

  // Ausbau auf eine Liste von Kanten anwenden (eine Kante oder ganzer Straßenzug). Ein Logeintrag = ein Bauauftrag.
  bauen(a, roads, name) {
    const ziel = roads.filter(r => a.gilt(r.m));
    const summe = gesamt(a, ziel);
    if (!ziel.length || summe > this.s.budget) return null;
    const eintrag = { a: a.id, name, kosten: summe, kanten: [], vorher: {}, t: Date.now() };
    for (const r of ziel) {
      const alt = this.s.kanten[r.id];
      eintrag.vorher[r.id] = alt ? alt : null;
      const basis = { ...(r.m0 || r.m), ...(alt ? alt.p : {}) };
      this.s.kanten[r.id] = { p: { ...(alt ? alt.p : {}), ...a.patch(basis) }, len: r.len, m0: r.m0 || r.m };
      eintrag.kanten.push(r.id);
    }
    this.s.budget -= summe;
    this.s.log.push(eintrag);
    this.speichern();
    return eintrag;
  }
  rueckgaengig() {
    const e = this.s.log.pop(); if (!e) return null;
    for (const id of e.kanten) { if (e.vorher[id]) this.s.kanten[id] = e.vorher[id]; else delete this.s.kanten[id]; }
    for (const id of e.knoten || []) { if (e.vorherK[id]) this.s.knoten[id] = e.vorherK[id]; else delete this.s.knoten[id]; }
    this.s.budget += e.kosten;
    this.speichern();
    return e;
  }
  neu() { this.s = { budget: START_BUDGET, kanten: {}, knoten: {}, log: [], jahr: 1, jahre: [] }; this.speichern(); }

  // Jahresabschluss: Einnahmen aus Grundbetrag, Zufriedenheit und Radanteil (Platzhalter, später eichen).
  // Danach lassen sich die Aufträge des Jahres nicht mehr rückgängig machen.
  static einnahmen(erg) { return Math.round((400_000 + 12_000 * erg.zufrieden + 2_000_000 * erg.anteil) / 1000) * 1000; }
  jahrAbschliessen(erg) {
    const ein = Spiel.einnahmen(erg);
    this.s.jahre.push({ jahr: this.s.jahr, anteil: erg.anteil, zufrieden: erg.zufrieden, radKm: erg.radKm, ausgaben: this.s.log.reduce((a, e) => a + e.kosten, 0), einnahmen: ein });
    this.s.budget += ein; this.s.jahr++; this.s.log = [];
    this.speichern();
    return ein;
  }

  // Wirkung: längengewichtete Risiko-Senkung und Komfortgewinn über alle ausgebauten Kanten
  bilanz() {
    let km = 0, risikoKm = 0, komfortKm = 0;
    for (const k of Object.values(this.s.kanten)) {
      const v0 = bikeValues(k.m0), v1 = bikeValues({ ...k.m0, ...k.p });
      km += k.len / 1000;
      if (v0.allowed || v1.allowed) { risikoKm += v0.risk * k.len / 1000 - v1.risk * k.len / 1000; komfortKm += (v1.comfort - (v0.allowed ? v0.comfort : 0)) * k.len / 1000; }
    }
    const kn = Object.values(this.s.knoten);
    return { km, risikoKm, komfortKm, auftraege: this.s.log.length, ampeln: kn.filter(k => k.ampel).length, kreisel: kn.filter(k => k.kreisel).length };
  }
}

// Patch auf eine geladene Kante anwenden (alle Kopien in allen Kacheln)
export function wendeAn(store, spiel) {
  for (const t of store.cache.values()) {
    if (!t || !t.roads) continue;
    for (const r of t.roads) {
      const p = spiel.patchFor(r.id);
      if (!r.m0) r.m0 = r.m;
      r.m = p ? { ...r.m0, ...p } : r.m0;
      r.half = halfWidth(r.m);
    }
  }
}

// Straßenzug: gleiche Bezeichnung (Name oder Nummer) und Art in geladenen Detailkacheln, verbunden über Knoten
export function strassenzug(store, start) {
  const key = r => (r.m0 || r.m).name || (r.m0 || r.m).ref;
  const k = key(start); if (!k) return [start];
  const kand = new Map();
  for (const t of store.cache.values()) if (t && t.lod === 0) for (const r of t.roads) if (key(r) === k && !kand.has(r.id)) kand.set(r.id, r);
  const anKnoten = new Map();
  for (const r of kand.values()) for (const n of [r.a, r.b]) { if (!anKnoten.has(n)) anKnoten.set(n, []); anKnoten.get(n).push(r); }
  const seen = new Set([start.id]), out = [start], q = [start];
  while (q.length) { const r = q.pop(); for (const n of [r.a, r.b]) for (const s of anKnoten.get(n) || []) if (!seen.has(s.id)) { seen.add(s.id); out.push(s); q.push(s); } }
  return out;
}
