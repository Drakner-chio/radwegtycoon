// Radweg Tycoon – Verkehr Ebene 2: sichtbare Autos und Räder im aktuellen Kartenausschnitt.
//
// - Netz: Kanten der geladenen Detailkacheln im Simulationsgebiet (Ausschnitt + Rand).
// - Mengen: Radverkehr aus Ebene 1 (Fahrten/Tag je Kante); Autoverkehr vorerst nach Straßenklasse geschätzt.
//   Angezeigt wird die Spitzenstunde (10 % des Tagesverkehrs).
// - Bewegung: Folgemodell IDM je Spur (Auto-Spur bzw. Radspur pro Kante und Richtung), Abbiegen zufällig
//   gewichtet nach den Mengen der abgehenden Kanten. Ein- und Ausfahrt am Rand des Gebiets und an Sackgassen.
// - Vorfahrt: Ampeln (zwei Phasen nach Achse), Kreisverkehr (Einfahrende warten), sonst Straßenrang,
//   bei gleichem Rang rechts vor links. Wer zu lange wartet, fährt vorsichtig.
// - Konflikte (Kennzahlen): zu enges Überholen von Rädern im Mischverkehr / auf Schutzstreifen und
//   Rechtsabbieger über einen Hochbord-Radweg, während ein Rad kommt.
import { isRoad } from './tiles.js';
import { bikeValues, hashStr, offsetLine } from './render.js';

const SPITZE = 0.1;                       // Anteil des Tagesverkehrs in der Spitzenstunde
const AUTO_TAG = { auto: 30000, L: 7000, dorf: 2500, wohn: 300, zufahrt: 60, spiel: 80 };
const RANG = { auto: 5, L: 4, dorf: 3, wohn: 2, zufahrt: 1, spiel: 1, rad: 0, feld: 0, weg: 0, fuss: 0 };
const IDM = { auto: { a: 1.6, b: 2.2, s0: 2.2, T: 1.2, len: 4.4, w: 1.8 }, rad: { a: 1.0, b: 1.6, s0: 1.2, T: 0.9, len: 1.8, w: 0.6 } };
const FARBEN = ['#c9473a', '#e8e4da', '#2d5fa8', '#3a3d42', '#9aa3ad', '#d9a630', '#3f8a4c', '#7a4b9a', '#1f2b26'];
const RADFARBEN = ['#f2c230', '#5cc24a', '#2f7de1', '#e0563a', '#e84f9b', '#f2efe6'];

export function autoProTag(r) {
  const m = r.m; if (!isRoad(m) || m.car === 0) return 0;
  let v = (AUTO_TAG[m.cls] || 100) * (0.6 + 0.8 * hashStr(String(r.w || r.id)));
  if (m.frs || m.car === 2) v *= 0.3;
  return v;
}

function geom(P) {
  const cum = new Float64Array(P.length); for (let i = 1; i < P.length; i++) cum[i] = cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
  return cum;
}
// Punkt und Richtung bei Bogenlänge s
export function at(e, s) {
  const P = e.P, c = e.cum; s = Math.max(0, Math.min(e.L, s));
  let lo = 0, hi = P.length - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= s) lo = mid; else hi = mid; }
  const l = c[hi] - c[lo] || 1, f = (s - c[lo]) / l, dx = (P[hi][0] - P[lo][0]) / l, dy = (P[hi][1] - P[lo][1]) / l;
  return [P[lo][0] + (P[hi][0] - P[lo][0]) * f, P[lo][1] + (P[hi][1] - P[lo][1]) * f, dx, dy];
}

export class Live {
  constructor() { this.E = new Map(); this.N = new Map(); this.agents = []; this.t = 0; this.next = 1; this.rect = null; this.stat = { nahUeberholen: 0, abbiegen: 0, seit: 0 }; }

  // Netz aus Kachel-Kanten aufbauen; vorhandene Fahrzeuge auf weiter bestehenden Kanten bleiben.
  // autoVol(id): gezählter Kfz-Verkehr je Tag (Straßen.NRW) oder null -> dann Schätzung nach Straßenklasse
  bauen(roads, signale, radVol, rect, kreisel = new Set(), autoVol = null) {
    const alt = this.E; this.E = new Map(); this.N = new Map(); this.rect = rect;
    const node = id => { let n = this.N.get(id); if (!n) { n = { id, out: [], inn: [], x: 0, y: 0, sig: signale.has(id) && !kreisel.has(id), kreisel: kreisel.has(id), rand: false }; this.N.set(id, n); } return n; };
    for (const r of roads) {
      if (this.E.has(r.id) || r.P.length < 2) continue;
      const m = r.m, road = isRoad(m), bv = bikeValues(m);
      const gez = autoVol ? autoVol(r.id) : null;
      const auto = road && m.car !== 0 && m.cls !== 'auto' ? (gez > 0 ? gez * (m.frs || m.car === 2 ? 0.3 : 1) : autoProTag(r)) : 0;
      const radOk = m.cls !== 'treppe' && m.cls !== 'auto' && (road ? bv.use : m.bike !== 0);
      const rad = radOk ? Math.max(radVol(r.id) || 0, road ? 0 : 2) : 0;
      if (!auto && !rad) continue;
      const e = { id: r.id, w: r.w, m, P: r.P, cum: geom(r.P), a: node(r.a), b: node(r.b), road, auto, rad,
        rang: m.frs ? 3 : (RANG[m.cls] ?? 0), round: !!m.round, oneway: !!m.oneway, onewayRad: !!m.oneway && m.oneway_bike !== 0 && m.cls !== 'rad' };
      e.L = e.cum[e.cum.length - 1];
      e.vAuto = Math.max(2, (m.cls === 'spiel' ? 7 : (m.ms || (m.cls === 'zufahrt' ? 30 : 50))) / 3.6);
      e.vRad = 3.5 + 2.6 * bv.comfort;
      e.lanes = {}; // "auto+1", "rad-1" -> sortierte Fahrzeuge (Fahrtrichtung)
      this.E.set(r.id, e);
      e.a.out.push(e); e.b.out.push(e);
      e.a.x = r.P[0][0]; e.a.y = r.P[0][1]; const z = r.P[r.P.length - 1]; e.b.x = z[0]; e.b.y = z[1];
    }
    const [x0, y0, x1, y1] = rect;
    for (const n of this.N.values()) { n.aussen = n.x < x0 || n.x > x1 || n.y < y0 || n.y > y1; n.rand = n.aussen || n.out.length === 1; }
    // Fahrzeuge übernehmen
    const keep = [];
    for (const g of this.agents) { const e = this.E.get(g.e.id); if (!e) continue; g.e = e; g.nxt = null; keep.push(g); }
    this.agents = keep; this.ordnen();
    if (!alt.size) this.vorfuellen();
  }

  // Start: Fahrzeuge gemäß Dichte (Menge / Geschwindigkeit) verteilen
  vorfuellen() {
    for (const e of this.E.values()) for (const mode of ['auto', 'rad']) {
      const q = (mode === 'auto' ? e.auto : e.rad) * SPITZE / 3600 / 2; if (!q) continue;
      const v = mode === 'auto' ? e.vAuto : e.vRad, dichte = q / v;
      for (const dir of [1, -1]) {
        if (!this.erlaubt(e, dir, mode)) continue;
        let n = dichte * e.L; const k = Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
        for (let i = 0; i < k; i++) this.neu(e, dir, mode, Math.random() * e.L, v * 0.8);
      }
    }
    this.ordnen();
  }
  erlaubt(e, dir, mode) { if (mode === 'auto') return !!e.auto && (!e.oneway || dir === 1); return !!e.rad && (!e.onewayRad || dir === 1); }
  neu(e, dir, mode, s, v) {
    const id = this.next++, h = hashStr('a' + id);
    // Fahrzeugtyp: Bus nur auf Haupt-/Sammelstraßen, sonst Kleinwagen, Pkw, Transporter
    const h2 = hashStr('t' + id), bus = mode === 'auto' && h2 < .015 && (e.m.cls === 'L' || e.m.cls === 'dorf');
    const typ = mode === 'rad' ? 'rad' : bus ? 'bus' : h2 < .14 ? 'transporter' : h2 < .38 ? 'klein' : 'pkw';
    const len = { rad: 1.8, bus: 12, transporter: 5.3, klein: 3.7, pkw: 4.4 }[typ];
    const g = { id, e, dir, mode, typ, len, s, v, v0f: 0.88 + 0.22 * h, nxt: null, warte: 0, farbe: bus ? '#e9e6dc' : mode === 'auto' ? FARBEN[Math.floor(h * 997) % FARBEN.length] : RADFARBEN[Math.floor(h * 991) % RADFARBEN.length], hemd: RADFARBEN[Math.floor(h2 * 977) % RADFARBEN.length], bremst: false };
    this.agents.push(g); return g;
  }
  ordnen() {
    for (const e of this.E.values()) e.lanes = {};
    for (const g of this.agents) { const k = g.mode + g.dir; (g.e.lanes[k] || (g.e.lanes[k] = [])).push(g); }
    for (const e of this.E.values()) for (const k in e.lanes) e.lanes[k].sort((p, q) => this.vor(p) - this.vor(q));
  }
  vor(g) { return g.dir === 1 ? g.s : g.e.L - g.s; }           // zurückgelegt auf der Kante
  rest(g) { return g.e.L - this.vor(g); }                       // bis zum Knoten
  ziel(g) { return g.dir === 1 ? g.e.b : g.e.a; }

  waehle(g) {
    const n = this.ziel(g); if (n.aussen || n.out.length <= 1) return null; // Rand oder Sackgasse: Ausfahrt
    const opt = []; let sum = 0;
    for (const e of n.out) {
      if (e === g.e && n.out.length > 1) continue;
      const dir = e.a === n ? 1 : -1; if (!this.erlaubt(e, dir, g.mode)) continue;
      const w = (g.mode === 'auto' ? e.auto : e.rad) + 0.5; opt.push([e, dir, w]); sum += w;
    }
    if (!opt.length) return null;
    let r = Math.random() * sum; for (const o of opt) { r -= o[2]; if (r <= 0) return o; } return opt[opt.length - 1];
  }

  // Richtung, aus der ein Fahrzeug in den Knoten einfährt (Einheitsvektor)
  ankunft(g) { const s = g.dir === 1 ? g.e.L - 0.5 : 0.5, p = at(g.e, s); return [p[2] * g.dir, p[3] * g.dir]; }

  // Ampelfarbe für eine Zufahrt mit Richtung (hx, hy) – für die Darstellung
  ampelFarbe(id, hx, hy) {
    const achse = Math.abs(hx) > Math.abs(hy) ? 0 : 1, T = 26, t = (this.t + hashStr('s' + id) * T * 2) % (T * 2), phase = t < T ? 0 : 1, inPhase = t % T;
    if (inPhase < 3) return phase !== achse ? 'gelb' : 'rot';
    return phase === achse ? (inPhase > T - 3 ? 'gelb' : 'gruen') : 'rot';
  }
  ampelGruen(n, g) {
    const [hx, hy] = this.ankunft(g), achse = Math.abs(hx) > Math.abs(hy) ? 0 : 1;
    const T = 26, t = (this.t + hashStr('s' + n.id) * T * 2) % (T * 2), phase = t < T ? 0 : 1, inPhase = t % T;
    if (inPhase < 3) return false;                       // Räumzeit: alle rot
    if (g.mode === 'rad' && phase !== achse && inPhase > T - 2) return true; // Radvorlauf (2 s früher grün)
    return phase === achse;
  }

  mussWarten(g) {
    const n = this.ziel(g), nx = g.nxt; if (!nx) return false;
    if (n.sig) return !this.ampelGruen(n, g);
    if (n.kreisel) { // gebauter Kreisverkehr: Einfahrende warten auf Fahrzeuge von links, die gleich in den Kreis fahren
      const [hx, hy] = this.ankunft(g);
      for (const f of n.out) { if (f === g.e) continue; const fdir = f.b === n ? 1 : -1;
        for (const mode of ['auto', 'rad']) { const lane = f.lanes[mode + fdir]; if (!lane || !lane.length) continue; const o = lane[lane.length - 1];
          if (o.warte > 0.5) continue; const d = this.rest(o); if (d > 14) continue; const [ox, oy] = this.ankunft(o); if (hx * oy - hy * ox > 0.3) return true; } }
      return false;
    }
    const e = g.e, rang = e.round ? 9 : e.rang;
    if (rang >= 9) return false;
    const [hx, hy] = this.ankunft(g), nah = g.mode === 'auto' ? 28 : 16;
    for (const f of n.out) {
      if (f === e) continue;
      const fdir = f.b === n ? 1 : -1;
      for (const mode of ['auto', 'rad']) {
        const lane = f.lanes[mode + fdir]; if (!lane || !lane.length) continue;
        const o = lane[lane.length - 1]; if (o.warte > 0.5 && !(f.round)) continue;
        const d = this.rest(o); if (d > (o.mode === 'auto' ? nah : 14) || o.v * 2.8 + 6 < d) continue;
        const oRang = f.round ? 9 : f.rang;
        if (nx[0].round && !f.round) continue;                         // im Kreisel hat der Kreisel Vorrang
        if (oRang > rang) return true;
        if (oRang === rang) { const [ox, oy] = this.ankunft(o); if (hx * oy - hy * ox < -0.3) return true; } // von rechts
      }
    }
    return false;
  }

  schritt(dt) {
    this.t += dt; this.stat.seit += dt;
    for (const g of this.agents) {
      const P = IDM[g.mode], e = g.e, vMax = (g.mode === 'auto' ? e.vAuto : e.vRad) * g.v0f;
      if (!g.nxt) g.nxt = this.waehle(g) || 0;
      // Vordermann
      const lane = e.lanes[g.mode + g.dir], i = lane.indexOf(g); let gap = 1e9, vl = vMax;
      if (i < lane.length - 1) { const l = lane[i + 1]; gap = this.vor(l) - this.vor(g) - (l.len + g.len) / 2; vl = l.v; }
      else {
        const r = this.rest(g);
        if (g.nxt) { const nl = g.nxt[0].lanes[g.mode + g.nxt[1]]; if (nl && nl.length) { const l = nl[0]; gap = r + this.vor(l) - (l.len + g.len) / 2; vl = l.v; } }
        // Haltelinie
        if (r < 40) {
          const kn = this.ziel(g), bes = kn.besetzt;
          const belegt = g.mode === 'auto' && r < 12 && bes && bes.bis > this.t && bes.spur !== e.id + g.dir; // Knoten gerade von anderer Zufahrt befahren
          const warten = g.nxt && (belegt || this.mussWarten(g)) && g.warte < (g.mode === 'auto' ? 9 : 6);
          if (warten) { const h = r - 1.5; if (h < gap) { gap = Math.max(0.1, h); vl = 0; } }
          if (warten && g.v < 0.3) g.warte += dt; else if (!warten) g.warte = 0;
          if (kn.kreisel && r < 30) { const vk = 5 + r * 0.25; if (vk < vl) { gap = Math.min(gap, r + 6); vl = vk; } } // im Kreisel langsam
          // Kurven bremsen: in Wohnstraßen/Abbiegen langsamer
          if (g.nxt && g.nxt[0] !== e && g.mode === 'auto') { const vk = 6 + r * 0.35; if (vk < vl && r < 25) { gap = Math.min(gap, r + 8); vl = Math.min(vl, vk); } }
        }
      }
      const s0 = P.s0 + Math.max(0, g.v * P.T + g.v * (g.v - vl) / (2 * Math.sqrt(P.a * P.b)));
      let acc = P.a * (1 - Math.pow(g.v / vMax, 4) - Math.pow(s0 / Math.max(gap, 0.1), 2));
      acc = Math.max(-8, acc); g.bremst = acc < -1;
      g.v = Math.max(0, g.v + acc * dt); g.s += g.dir * g.v * dt;
    }
    // Kantenwechsel, Ausfahrt
    const raus = new Set();
    for (const g of this.agents) {
      while (this.rest(g) <= 0) {
        const ueber = -this.rest(g), n = this.ziel(g);
        if (!g.nxt) { raus.add(g); break; }
        const [ne, nd] = g.nxt;
        if (g.mode === 'auto') { this.pruefeAbbiegen(g, n, ne); n.besetzt = { spur: g.e.id + g.dir, bis: this.t + 1.6 }; }
        g.e = ne; g.dir = nd; g.s = nd === 1 ? ueber : ne.L - ueber; g.nxt = null; g.warte = 0;
      }
    }
    if (raus.size) this.agents = this.agents.filter(g => !raus.has(g));
    this.einfahren(dt);
    this.ordnen();
    this.konflikte();
  }

  // Neue Fahrzeuge an Randknoten und Sackgassen (Poisson mit der halben Kantenmenge)
  einfahren(dt) {
    for (const n of this.N.values()) {
      if (!n.rand) continue;
      for (const e of n.out) for (const mode of ['auto', 'rad']) {
        const dir = e.a === n ? 1 : -1; if (!this.erlaubt(e, dir, mode)) continue;
        const q = (mode === 'auto' ? e.auto : e.rad) * SPITZE / 3600 / 2;
        if (Math.random() < q * dt) {
          const lane = e.lanes[mode + dir]; if (lane && lane.length && this.vor(lane[0]) < 12) continue;
          const g = this.neu(e, dir, mode, dir === 1 ? 0 : e.L, (mode === 'auto' ? e.vAuto : e.vRad) * 0.7);
          (e.lanes[mode + dir] || (e.lanes[mode + dir] = [])).unshift(g);
        }
      }
    }
  }

  // Seitenabstand (m) der Spurmitte rechts der Fahrtrichtung
  versatz(g) {
    const e = g.e, m = e.m, cw = m.cw || 3;
    if (g.mode === 'auto') return e.oneway ? 0 : cw / 2;
    if (!e.road) return 0.5;
    const fac = g.dir === 1 ? m.fac_r : m.fac_l;
    if (fac === 3) return cw + 1.1;
    if (fac === 1 || fac === 2) return cw - 0.8;
    return e.oneway ? cw - 0.6 : cw - 0.6;
  }

  konflikte() {
    for (const e of this.E.values()) for (const dir of [1, -1]) {
      const ra = e.lanes['rad' + dir], au = e.lanes['auto' + dir]; if (!ra || !au) continue;
      const fac = dir === 1 ? e.m.fac_r : e.m.fac_l; if (fac >= 2 || e.m.frs) continue;
      for (const c of au) for (const b of ra) {
        const d = this.vor(c) - this.vor(b);
        if (Math.abs(d) < 1 && c.v > b.v + 3 && !c._ueb?.has(b.id)) {
          const luecke = (this.versatz(b) - 0.3) - (this.versatz(c) + 0.9);
          if (luecke < 1.5) { this.stat.nahUeberholen++; (c._ueb || (c._ueb = new Set())).add(b.id); }
        }
      }
    }
  }
  // Rechtsabbieger über Hochbord-Radweg: Rad derselben Richtung kommt von hinten
  pruefeAbbiegen(g, n, ne) {
    const e = g.e, fac = g.dir === 1 ? e.m.fac_r : e.m.fac_l; if (fac !== 3 || ne === e) return;
    const [hx, hy] = this.ankunft(g), nd = ne.a === n ? 1 : -1, p = at(ne, nd === 1 ? 1 : ne.L - 1), ox = p[2] * nd, oy = p[3] * nd;
    if (hx * oy - hy * ox < 0.5) return; // keine Rechtskurve (y nach unten: rechts = positives Kreuzprodukt)
    const ra = e.lanes['rad' + g.dir]; if (!ra) return;
    for (const b of ra) { const r = this.rest(b); if (r > 0 && r < 18 && b.v > 2) { this.stat.abbiegen++; return; } }
  }

  zahlen() {
    let a = 0, r = 0; for (const g of this.agents) g.mode === 'auto' ? a++ : r++;
    const h = Math.max(this.stat.seit, 60) / 3600;
    return { autos: a, raeder: r, nahUeberholenH: this.stat.nahUeberholen / h, abbiegenH: this.stat.abbiegen / h };
  }

  zeichnen(c, z) {
    for (const g of this.agents) {
      const P = IDM[g.mode], p = at(g.e, g.s), dx = p[2] * g.dir, dy = p[3] * g.dir, off = this.versatz(g);
      const x = p[0] - dy * off, y = p[1] + dx * off; // rechts der Fahrtrichtung (y nach unten)
      const L = Math.max(g.len || P.len, (g.mode === 'auto' ? 5.5 : 3.4) / z), W = Math.max(P.w, (g.mode === 'auto' ? 2.8 : 1.8) / z); // Mindestgröße in Bildpunkten
      c.save(); c.translate(x, y); c.rotate(Math.atan2(dy, dx));
      if (g.mode === 'auto') {
        c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(-L / 2 + .25, -W / 2 + .25, L, W);
        c.fillStyle = g.farbe; c.fillRect(-L / 2, -W / 2, L, W);
        if (z > 3) { c.fillStyle = 'rgba(20,30,40,.55)'; c.fillRect(L * .05, -W / 2 + .2, L * .22, W - .4); c.fillRect(-L * .38, -W / 2 + .2, L * .16, W - .4); }
        if (g.bremst) { c.fillStyle = '#ff3a2a'; c.fillRect(-L / 2 - .05, -W / 2, Math.max(.25, .6 / z), W * .3); c.fillRect(-L / 2 - .05, W / 2 - W * .3, Math.max(.25, .6 / z), W * .3); }
      } else {
        c.fillStyle = '#1c211e'; c.fillRect(-L / 2, -W / 4, L, W / 2);
        c.fillStyle = g.farbe; c.fillRect(-L * .15, -W / 2, L * .35, W);
      }
      c.restore();
    }
  }
}
