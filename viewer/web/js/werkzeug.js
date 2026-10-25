// Radweg Tycoon – Bauwerkzeuge auf dem geladenen Detailnetz.
// Strecke: Wegpunkte (Kanten) anklicken; dazwischen sucht eine kürzeste-Wege-Suche den Verlauf entlang
// der Straße, sodass kein Abschnitt fehlt – auch keine kurzen Stücke an Kreuzungen.
// Knoten: Kreuzungen mit Eigenschaften für Ampel/Kreisverkehr.
import { isRoad } from './tiles.js';

// Netz aus Kacheln (alle Kopien, je ID einmal); eigene Kopie bevorzugt
export function lokalesNetz(tiles) {
  const kanten = new Map(), knoten = new Map(), ampeln = new Set();
  for (const t of tiles) {
    for (const r of t.roads) { const alt = kanten.get(r.id); if (!alt || (!alt.own && r.own)) kanten.set(r.id, r); }
    for (const n of t.nodes) if (n.f === 'traffic_signals' && !n.on) ampeln.add(n.id);
  }
  const kn = id => { let k = knoten.get(id); if (!k) { k = { id, x: 0, y: 0, kanten: [] }; knoten.set(id, k); } return k; };
  for (const r of kanten.values()) {
    const a = kn(r.a), b = kn(r.b); a.kanten.push(r); b.kanten.push(r);
    a.x = r.P[0][0]; a.y = r.P[0][1]; const z = r.P[r.P.length - 1]; b.x = z[0]; b.y = z[1];
  }
  return { kanten, knoten, ampeln };
}

// Kürzester Weg zwischen zwei Kanten (beide Enden enthalten). erlaubt(r) begrenzt die Suche,
// Wechsel auf eine andere Straße (Name/Klasse) kostet etwas mehr – der Weg bleibt auf „seiner“ Straße.
export function pfad(netz, von, zu, erlaubt) {
  if (von === zu) return [von];
  const name = r => (r.m0 || r.m).name || (r.m0 || r.m).ref || '', n0 = name(von), c0 = (von.m0 || von.m).cls;
  const kost = r => r.len * ((name(r) === n0 && n0) || (!n0 && (r.m0 || r.m).cls === c0) ? 1 : 1.6) + 1;
  const dist = new Map(), vor = new Map(), offen = [];
  const hoch = i => { while (i > 0) { const p = (i - 1) >> 1; if (offen[p][0] <= offen[i][0]) break; [offen[p], offen[i]] = [offen[i], offen[p]]; i = p; } };
  const runter = i => { for (;;) { let c = 2 * i + 1; if (c >= offen.length) break; if (c + 1 < offen.length && offen[c + 1][0] < offen[c][0]) c++; if (offen[i][0] <= offen[c][0]) break; [offen[c], offen[i]] = [offen[i], offen[c]]; i = c; } };
  const push = (id, d, r) => { if (d < (dist.get(id) ?? Infinity)) { dist.set(id, d); vor.set(id, r); offen.push([d, id]); hoch(offen.length - 1); } };
  push(von.a, 0, null); push(von.b, 0, null);
  const ziel = new Set([zu.a, zu.b]);
  let gefunden = null, n = 0;
  while (offen.length && n++ < 200000) {
    const [d, id] = offen[0]; const last = offen.pop(); if (offen.length) { offen[0] = last; runter(0); }
    if (d > dist.get(id)) continue;
    if (ziel.has(id)) { gefunden = id; break; }
    const k = netz.knoten.get(id); if (!k) continue;
    for (const r of k.kanten) { if (r === von || !erlaubt(r)) continue; const o = r.a === id ? r.b : r.a; push(o, d + kost(r), r); }
  }
  if (gefunden === null) return null;
  const out = [zu], seen = new Set([zu.id, von.id]);
  for (let id = gefunden, r = vor.get(id); r; id = r.a === id ? r.b : r.a, r = vor.get(id)) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
  out.push(von);
  return out.reverse();
}

// Kreuzung beschreiben (für Ampel/Kreisverkehr)
export function knotenInfo(netz, id, spiel) {
  const k = netz.knoten.get(id); if (!k) return null;
  const strassen = k.kanten.filter(r => isRoad(r.m) && r.m.car !== 0), b = spiel ? spiel.knotenFor(id) : null;
  const rang = { auto: 5, L: 4, dorf: 3, wohn: 2, zufahrt: 1, spiel: 1 };
  return { id, x: k.x, y: k.y, grad: k.kanten.length, strassen: strassen.length, rang: Math.max(0, ...strassen.map(r => rang[r.m.cls] || 0)),
    ampel: netz.ampeln.has(id) || !!(b && b.ampel), kreisel: k.kanten.some(r => r.m.round) || !!(b && b.kreisel), autobahn: strassen.some(r => r.m.cls === 'auto'),
    namen: [...new Set(strassen.map(r => r.m.name || r.m.ref).filter(Boolean))] };
}

// Nächste Kreuzung (mind. zwei Straßen) zur Weltposition
export function naechsteKreuzung(netz, x, y, max) {
  let best = null, bd = max * max;
  for (const k of netz.knoten.values()) {
    const d = (k.x - x) ** 2 + (k.y - y) ** 2; if (d >= bd) continue;
    if (k.kanten.filter(r => isRoad(r.m) && r.m.car !== 0).length < 2) continue;
    bd = d; best = k;
  }
  return best;
}
