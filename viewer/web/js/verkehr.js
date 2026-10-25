// Radweg Tycoon – Verkehr Ebene 1 im Browser: Netz laden, Kantenfaktoren aus dem Spielmodell
// (mit Ausbauten) berechnen, Startzellen auf mehrere Worker verteilen, Ergebnisse zusammenführen.
import { ladeJsonGz } from './verkehr-modell.js';
import { bikeValues } from './render.js';
import { isRoad } from './tiles.js';

const u = v => v === -1 ? undefined : v;

// Steigungen: 1 Höhenmeter bergauf fühlt sich wie 10 m Strecke an; über 6 % Steigung zusätzlich anstrengend
export const BERG = { hm: 10, steilAb: 0.06, steil: 8 };
// Kreuzungen (gefühlte Meter): Hauptstraße / Sammelstraße ohne Sicherung, mit Ampel, mit Kreisverkehr
export const KNOTEN_STRAFE = { haupt: 45, sammel: 18, ampel: 10, kreisel: 14 };

// Gefühlte Meter je Meter fürs Rad. Infinity = nicht befahrbar. kfz: Kfz pro Tag (Mischverkehr wird mit viel Verkehr unangenehmer)
export function radFaktor(m, kfz = 0) {
  if (m.cls === 'auto' || m.cls === 'treppe') return Infinity;
  const bv = bikeValues(m);
  if (!bv.allowed) return m.cls === 'fuss' ? 3.5 : Infinity; // Fußweg: schieben
  if (bv.sidepath) return 4;                                   // Fahrbahn verboten, Radweg daneben nehmen
  const misch = isRoad(m) && !m.frs && Math.max(m.fac_l || 0, m.fac_r || 0) === 0;
  return 1 + 2.2 * bv.risk + 1.5 * (1 - bv.comfort) + (misch ? AUTO.stress * Math.min(1.5, kfz / AUTO.stressKfz) : 0);
}

// Autoverkehr: Reisegeschwindigkeit (Anteil des Tempolimits), Standardtempo je Klasse, Kapazität (Kfz/Tag, beide Richtungen),
// Zeitzuschläge an Knoten, Faktor für Anliegerstraßen und BPR-Stauformel t = t0 · (1 + a · (V/C)^b)
export const AUTO = {
  tempo: { auto: 110, L: 80, dorf: 50, wohn: 30, zufahrt: 20, spiel: 7 },
  reise: { auto: .85, L: .8, dorf: .7, wohn: .65, zufahrt: .6, spiel: .8 },
  kap: { auto: 70000, L: 18000, dorf: 12000, wohn: 5000, zufahrt: 1500, spiel: 800 },
  anlieger: 4, ampel: 12, kreisel: 5, bpr: { a: .15, b: 4, max: 5 },
  stress: .5, stressKfz: 6000, eichMin: .6, eichMax: 3,
  // Der Eichfaktor enthält vor allem Durchgangs- und Fernverkehr auf Hauptstraßen; Nebenstraßen bekommen nur seine Wurzel
  haupt: new Set(['auto', 'L']), nebenMin: .8, nebenMax: 1.5,
};
export function autoZeit0(m, len) {
  if (!isRoad(m) || m.car === 0) return Infinity;
  const v = (m.ms > 0 ? m.ms : AUTO.tempo[m.cls] || 30) * (AUTO.reise[m.cls] || .7) / 3.6;
  return len / v * (m.frs || m.car === 2 ? AUTO.anlieger : 1);
}

export class Verkehr {
  constructor(base, man, patchFor) {
    // Version aus Größe und Höhenstand: nach `netz`/`hoehe` wird die neue Datei geladen, nicht die zwischengespeicherte
    const v = man.netz ? `${man.netz.bytes}-${man.hoehe ? man.hoehe.max : 0}` : '0';
    this.url = new URL(base + (man.netz && man.netz.datei || 'netz.json.gz') + '?v=' + encodeURIComponent(v), location.href).href;
    this.patchFor = patchFor; this.knotenBau = () => null; this.gebiet = null;
    this.ok = !!man.netz;
    this.erg = null; this.vorher = null; this.laeuft = false; this.wieder = false;
    this.onStatus = () => {}; this.onErgebnis = () => {};
  }
  async laden() {
    const n = this.netz = await ladeJsonGz(this.url);
    const K = n.kanten, nE = K.id.length;
    this.nE = nE; this.idx = new Map(); for (let e = 0; e < nE; e++) this.idx.set(K.id[e], e);
    this.kx = Float32Array.from(n.knoten.x); this.ky = Float32Array.from(n.knoten.y);
    this.a = Int32Array.from(K.a); this.b = Int32Array.from(K.b); this.len = Float32Array.from(K.len);
    this.Z = n.zonen; this.nZ = n.zonen.x.length; this.zelle = n.zelle_m;
    this.ewSumme = this.Z.ew.reduce((s, v) => s + v, 0);
    // Knoten: OSM-ID -> Index, größter Straßenrang und Zahl der Autostraßen je Knoten (für Knotenstrafen)
    const nK = n.knoten.x.length; this.nK = nK;
    this.kid = new Map(); if (n.knoten.id) n.knoten.id.forEach((id, i) => this.kid.set(id, i));
    this.kAmpel = n.knoten.ampel ? Uint8Array.from(n.knoten.ampel) : new Uint8Array(nK);
    this.kRang = new Uint8Array(nK); this.kStr = new Uint8Array(nK); this.kGrad = new Uint8Array(nK); this.kRund = new Uint8Array(nK);
    const RANG = { auto: 5, L: 4, dorf: 3, wohn: 2, zufahrt: 1, spiel: 1 };
    for (let e = 0; e < nE; e++) { const c = n.klassen[K.cls[e]], r = RANG[c] || 0, auto = r > 0 && K.car[e] !== 0;
      for (const v of [this.a[e], this.b[e]]) { this.kGrad[v]++; if (auto) { this.kStr[v]++; if (r > this.kRang[v]) this.kRang[v] = r; } if (K.round && K.round[e] === 1) this.kRund[v] = 1; } }
    const anz = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
    this.worker = [];
    await Promise.all(Array.from({ length: anz }, () => new Promise((ok, fail) => {
      const w = new Worker(new URL('./verkehr-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = ev => { if (ev.data.typ === 'bereit') { w.onmessage = null; ok(); } else if (ev.data.typ === 'fehler') fail(new Error(ev.data.text)); };
      w.onerror = e => fail(e); w.postMessage({ typ: 'init', url: this.url }); this.worker.push(w);
    })));
  }
  modell(e, ohneBau = false) {
    const n = this.netz, K = n.kanten;
    const m = { cls: n.klassen[K.cls[e]], ms: u(K.ms[e]), bike: u(K.bike[e]), car: u(K.car[e]), fac_l: u(K.fac_l[e]), fac_r: u(K.fac_r[e]), frs: u(K.frs[e]),
      surf: n.belaege[K.surf[e]], cond: u(K.cond[e]), tsurf: n.belaege[K.tsurf[e]], tcond: u(K.tcond[e]) };
    if (K.oneway[e] === 1) m.oneway = 1;
    const p = ohneBau ? null : this.patchFor(K.id[e]);
    return p ? { ...m, ...p } : m;
  }
  // je Richtung: Grundfaktor + Höhenmeter bergauf (BERG.hm gefühlte Meter je Hm) + Zuschlag für steile Stücke
  faktoren(ohneBau = false, kfz = null) {
    const f = new Float32Array(2 * this.nE), K = this.netz.kanten, auf = K.auf, ab = K.ab, steil = K.steil;
    for (let e = 0; e < this.nE; e++) {
      const g = radFaktor(this.modell(e, ohneBau), kfz ? kfz[e] : 0); f[2 * e] = f[2 * e + 1] = g;
      if (g === Infinity || !auf || auf[e] < 0) continue;
      const L = Math.max(5, this.len[e]), st = Math.max(0, steil[e] / 1000 - BERG.steilAb) * BERG.steil;
      f[2 * e] = g + (BERG.hm * auf[e] / 10) / L + st;
      f[2 * e + 1] = g + (BERG.hm * ab[e] / 10) / L + st * .5;
    }
    return f;
  }
  // Gefühlte Meter für das Queren einer Kreuzung: Hauptstraße ohne Ampel/Kreisel ist unangenehm
  // Fahrzeit je Richtung in Sekunden; stau[e] = Zuschlagsfaktor aus der Grundrechnung
  autoZeiten(ohneBau, stau) {
    const z = new Float32Array(2 * this.nE);
    for (let e = 0; e < this.nE; e++) {
      const m = this.modell(e, ohneBau), t = autoZeit0(m, this.len[e]) * (stau ? stau[e] : 1);
      z[2 * e] = t; z[2 * e + 1] = m.oneway ? Infinity : t;
    }
    return z;
  }
  autoKnoten(ohneBau) {
    const k = new Float32Array(this.nK), ids = this.netz.knoten.id;
    for (let v = 0; v < this.nK; v++) {
      if (this.kGrad[v] < 3 || this.kStr[v] < 2) continue;
      const b = ohneBau || !ids ? null : this.knotenBau(ids[v]);
      if (this.kRund[v] || (b && b.kreisel)) k[v] = AUTO.kreisel; else if (this.kAmpel[v] || (b && b.ampel)) k[v] = AUTO.ampel;
    }
    return k;
  }
  istHaupt(e) { if (!this._haupt) { const K = this.netz.kanten, kl = this.netz.klassen; this._haupt = Uint8Array.from(K.cls, (c, e) => AUTO.haupt.has(kl[c]) || (K.dtv && K.dtv[e] > 0) ? 1 : 0); } return this._haupt[e] === 1; }
  eichK(e, k) { return this.istHaupt(e) ? k : Math.min(AUTO.nebenMax, Math.max(AUTO.nebenMin, Math.sqrt(k))); }
  kapazitaet(e) { return AUTO.kap[this.netz.klassen[this.netz.kanten.cls[e]]] || 3000; }
  knotenStrafe(ohneBau = false) {
    const st = new Float32Array(this.nK), ids = this.netz.knoten.id;
    for (let v = 0; v < this.nK; v++) {
      if (this.kGrad[v] < 3 || this.kStr[v] < 2) continue;
      let p = this.kRang[v] >= 4 ? KNOTEN_STRAFE.haupt : this.kRang[v] === 3 ? KNOTEN_STRAFE.sammel : 0; if (!p) continue;
      const b = ids && !ohneBau ? this.knotenBau(ids[v]) : null;
      if (this.kAmpel[v] || (b && b.ampel)) p = Math.min(p, KNOTEN_STRAFE.ampel);
      if (this.kRund[v] || (b && b.kreisel)) p = Math.min(p, KNOTEN_STRAFE.kreisel);
      st[v] = p;
    }
    return st;
  }
  steigung(id) { const e = this.idx && this.idx.get(id), K = this.netz && this.netz.kanten; if (e === undefined || !K || !K.steil || K.steil[e] < 0) return null; return { steil: K.steil[e] / 10, auf: K.auf[e] / 10, ab: K.ab[e] / 10 }; }

  // Ein Durchlauf über alle Startzellen (verteilt auf die Worker)
  async lauf(f, strafe, maske, auto, text) {
    const W = this.worker.length;
    // Zellen reihum verteilen (Lastausgleich: große Städte nicht alle in einem Block)
    const stueck = Math.max(1, Math.ceil(this.nZ / (W * 6))), auftraege = [];
    for (let v = 0; v < this.nZ; v += stueck) auftraege.push([v, Math.min(this.nZ, v + stueck)]);
    const vol = new Float64Array(this.nE), volA = new Float64Array(this.nE), radIn = new Float64Array(this.nZ);
    const Z = { zWege: new Float32Array(this.nZ), zRad: new Float32Array(this.nZ), zZuf: new Float32Array(this.nZ), zZufW: new Float32Array(this.nZ) };
    const s = { wege: 0, rad: 0, radKm: 0, auto: 0, autoKm: 0 }; let fertig = 0; const gesamt = auftraege.length;
    await Promise.all(this.worker.map(w => new Promise((ok, fail) => {
      const naechster = () => {
        const a = auftraege.shift(); if (!a) { w.onmessage = null; return ok(); }
        w.onmessage = ev => {
          const m = ev.data;
          if (m.typ === 'fehler') return fail(new Error(m.text));
          if (m.typ !== 'ergebnis') return;
          const r = m.r; for (let e = 0; e < this.nE; e++) vol[e] += r.vol[e];
          if (r.volA.length) for (let e = 0; e < this.nE; e++) volA[e] += r.volA[e];
          for (const k of ['zWege', 'zRad', 'zZuf', 'zZufW']) Z[k].set(r[k].subarray(m.von, m.bis), m.von);
          for (let z = 0; z < this.nZ; z++) radIn[z] += r.zRadIn[z];
          s.wege += r.summeWege; s.rad += r.summeRad; s.radKm += r.summeRadKm; s.auto += r.summeAuto; s.autoKm += r.summeAutoKm; fertig++;
          this.onStatus(`${text} … ${Math.round(fertig / gesamt * 100)} %`);
          naechster();
        };
        w.postMessage({ typ: 'rechne', id: a[0], faktor: f, strafe, maske, auto, von: a[0], bis: a[1] });
      };
      naechster();
    })));
    return { vol, volA, Z: { ...Z, zRadIn: Float32Array.from(radIn) }, s };
  }

  // Grundzustand ohne Bauten fürs aktuelle Spielgebiet: Autoverkehr frei fließend, daraus Stauzuschläge,
  // zweiter Lauf mit Stau; danach Eichung an den Zählstellen (Straßen.NRW). Wird je Gebiet einmal gerechnet.
  async grundzustand(maske) {
    const strafe = this.knotenStrafe(true), knoten = this.autoKnoten(true);
    const r1 = await this.lauf(this.faktoren(true), strafe, maske, { zeit: this.autoZeiten(true, null), knoten }, 'Grundzustand wird berechnet (1/2)');
    const k = this.eichen(r1.volA).k;
    const stau = this.stauFaktoren(r1.volA, k);
    const kfz1 = Float32Array.from(r1.volA, (v, e) => this.kfzVon(e, v, k));
    const r2 = await this.lauf(this.faktoren(true, kfz1), strafe, maske, { zeit: this.autoZeiten(true, stau), knoten }, 'Grundzustand wird berechnet (2/2)');
    const volA = Float32Array.from(r2.volA), eich = this.eichen(volA);
    return { volA, stau, stress: kfz1, ...eich };
  }
  stauFaktoren(volA, k) {
    const st = new Float32Array(this.nE), B = AUTO.bpr;
    for (let e = 0; e < this.nE; e++) st[e] = Math.min(B.max, 1 + B.a * Math.pow(this.kfzVon(e, volA[e], k) / this.kapazitaet(e), B.b));
    return st;
  }
  // Zählwert, wenn vorhanden, sonst geeichtes Modell
  kfzVon(e, v, k) { const d = this.netz.kanten.dtv; return d && d[e] > 0 ? d[e] : v * this.eichK(e, k); }
  // Eichfaktor = Median aus Zählung / Modell an den gezählten Kanten im Spielgebiet; dazu die Abweichung
  eichen(volA) {
    const d = this.netz.kanten.dtv, q = [], paare = [];
    if (d) for (let e = 0; e < this.nE; e++) if (d[e] > 0 && volA[e] > 30 && this.kanteImGebiet(e)) { q.push(d[e] / volA[e]); paare.push(e); }
    q.sort((x, y) => x - y);
    const roh = q.length ? q[q.length >> 1] : 1, k = Math.min(AUTO.eichMax, Math.max(AUTO.eichMin, roh));
    // mittlere relative Abweichung (gewichtet nach Länge) und Korrelation im log-Raum
    let ab = 0, w = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (const e of paare) { const m = volA[e] * k, z = d[e], l = this.len[e]; ab += l * Math.abs(m - z) / z; w += l;
      const x = Math.log(m), y = Math.log(z); sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
    const n = paare.length, kov = sxy - sx * sy / n, r = n > 2 ? kov / Math.sqrt((sxx - sx * sx / n) * (syy - sy * sy / n)) : null;
    // Aufschlüsselung: Median Zählung/Modell je Zählwert-Stufe und je OSM-Klasse (zeigt, wo das Modell danebenliegt)
    const gruppen = [];
    const gruppe = (name, test) => { const v = paare.filter(test).map(e => d[e] / volA[e]).sort((x, y) => x - y); if (v.length >= 5) gruppen.push({ name, n: v.length, median: v[v.length >> 1], q1: v[v.length >> 2], q3: v[(3 * v.length) >> 2] }); };
    for (const [lo, hi] of [[0, 3000], [3000, 8000], [8000, 15000], [15000, Infinity]]) gruppe(`${lo / 1000}–${hi === Infinity ? '' : hi / 1000}${hi === Infinity ? ' und mehr' : ''} Tsd. Kfz`, e => d[e] >= lo && d[e] < hi);
    for (const c of ['L', 'dorf', 'wohn', 'zufahrt']) gruppe(`Klasse ${c}`, e => this.netz.klassen[this.netz.kanten.cls[e]] === c);
    gruppe('Rand des Gebiets (äußere 15 %)', e => this.gebiet ? Math.hypot(this.kx[this.a[e]] - this.gebiet.x, this.ky[this.a[e]] - this.gebiet.y) > .85 * this.gebiet.r : false);
    return { k, kRoh: roh, zaehlstellen: n, abweichung: w ? ab / w : null, korrelation: r && isFinite(r) ? r : null, gruppen };
  }
  kanteImGebiet(e) { const g = this.gebiet; if (!g) return true; const v = this.a[e]; return Math.hypot(this.kx[v] - g.x, this.ky[v] - g.y) <= g.r; }

  // Neu rechnen; während einer laufenden Rechnung wird höchstens eine weitere vorgemerkt
  async rechnen() {
    if (this.laeuft) { this.wieder = true; return; }
    this.laeuft = true; const t0 = performance.now();
    try {
      const maske = this.maske(), key = JSON.stringify(this.gebiet || null);
      if (!this.basis || this.basis.key !== key) { this.basis = { key, ...await this.grundzustand(maske) }; this.basis.kfz = this.kfzFeld(this.basis.volA); this.erg = null; }
      // Mischverkehrs-Stress fürs Rad: wie im Grundzustand plus die Änderung des Kfz-Verkehrs aus der letzten Rechnung
      const B = this.basis, stress = this.erg ? Float32Array.from(B.stress, (v, e) => Math.max(0, v + this.erg.kfz[e] - B.kfz[e])) : B.stress;
      const r = await this.lauf(this.faktoren(false, stress), this.knotenStrafe(), maske, { zeit: this.autoZeiten(false, B.stau), knoten: this.autoKnoten(false) }, 'Verkehr wird berechnet');
      const Z = r.Z, volA = Float32Array.from(r.volA), kfz = this.kfzFeld(volA);
      let zs = 0, zw = 0; for (let z = 0; z < this.nZ; z++) if (Z.zZufW[z] > 0) { zs += Z.zZuf[z] * this.Z.ew[z]; zw += this.Z.ew[z]; }
      // Stau: Kfz-km auf Kanten über 90 % Auslastung
      let stauKm = 0, kfzKm = 0; for (let e = 0; e < this.nE; e++) { if (!kfz[e]) continue; const km = kfz[e] * this.len[e] / 1000; kfzKm += km; if (kfz[e] / this.kapazitaet(e) > .9) stauKm += km; }
      this.vorher = this.erg;
      this.erg = { vol: Float32Array.from(r.vol), volA, kfz, ...Z, wege: r.s.wege, rad: r.s.rad, radKm: r.s.radKm, autoFahrten: r.s.auto, autoKm: r.s.autoKm,
        anteil: r.s.wege ? r.s.rad / r.s.wege : 0, zufrieden: zw ? zs / zw : 0, ew: this.einwohner(), kfzKm, stauKm,
        eichung: { k: B.k, kRoh: B.kRoh, zaehlstellen: B.zaehlstellen, abweichung: B.abweichung, korrelation: B.korrelation, gruppen: B.gruppen }, ms: performance.now() - t0, t: Date.now() };
    } finally { this.laeuft = false; }
    this.onErgebnis(this.erg, this.vorher);
    if (this.wieder) { this.wieder = false; this.rechnen(); }
  }
  // Kfz/Tag je Kante: gezählte Kanten = Zählwert + geeichte Änderung gegenüber dem Grundzustand, sonst geeichtes Modell
  kfzFeld(volA) {
    const B = this.basis, d = this.netz.kanten.dtv, out = new Float32Array(this.nE);
    for (let e = 0; e < this.nE; e++) {
      out[e] = d && d[e] > 0 ? Math.max(.15 * d[e], d[e] + B.k * (volA[e] - B.volA[e])) : volA[e] * this.eichK(e, B.k);
      if (B.kfz) out[e] = Math.max(out[e], .1 * B.kfz[e]); // Anlieger- und Lieferverkehr bleibt
    }
    return out;
  }
  // Spielgebiet (Kreis in Weltkoordinaten) -> Zellmaske; null = ganze Region
  maske() { if (!this.gebiet) return null; const g = this.gebiet, m = new Uint8Array(this.nZ); for (let z = 0; z < this.nZ; z++) m[z] = Math.hypot(this.Z.x[z] - g.x, this.Z.y[z] - g.y) <= g.r ? 1 : 0; return m; }
  einwohner(g = this.gebiet) { let s = 0; for (let z = 0; z < this.nZ; z++) if (!g || Math.hypot(this.Z.x[z] - g.x, this.Z.y[z] - g.y) <= g.r) s += this.Z.ew[z]; return s; }
  knotenPos(id) { const v = this.kid && this.kid.get(id); return v === undefined ? null : [this.kx[v], this.ky[v]]; }
  // Echte Daten je Kante (Pipeline-Schritt „daten“): gezählter Kfz-Verkehr und Radunfälle
  dtv(id) { const e = this.idx && this.idx.get(id), K = this.netz && this.netz.kanten; if (e === undefined || !K || !K.dtv || K.dtv[e] < 0) return null; return { kfz: K.dtv[e], sv: K.dtv_sv[e] }; }
  unfaelle(id) { const e = this.idx && this.idx.get(id), K = this.netz && this.netz.kanten; if (e === undefined || !K || !K.unf_rad) return null; return { rad: K.unf_rad[e], schwer: K.unf_rad_schwer[e] }; }
  kfz(id) { const e = this.idx && this.idx.get(id); return e === undefined || !this.erg ? null : this.erg.kfz[e]; }
  kfzGrund(id) { const e = this.idx && this.idx.get(id); return e === undefined || !this.basis || !this.basis.kfz ? null : this.basis.kfz[e]; }
  auslastung(id) { const e = this.idx && this.idx.get(id); return e === undefined || !this.erg ? null : this.erg.kfz[e] / this.kapazitaet(e); }
  volumen(id) { const e = this.idx && this.idx.get(id); return e === undefined || !this.erg ? null : this.erg.vol[e]; }
  // Kennzahlen für einen Kreis (Ortsansicht)
  imKreis(x, y, R) {
    if (!this.erg) return null; let w = 0, r = 0, ew = 0, zs = 0;
    for (let z = 0; z < this.nZ; z++) { if (Math.hypot(this.Z.x[z] - x, this.Z.y[z] - y) > R) continue; w += this.erg.zWege[z]; r += this.erg.zRad[z]; ew += this.Z.ew[z]; zs += this.erg.zZuf[z] * this.Z.ew[z]; }
    return { wege: w, rad: r, anteil: w ? r / w : 0, ew, zufrieden: ew ? zs / ew : 0 };
  }
}
