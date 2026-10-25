// Radweg Tycoon – Verkehr Ebene 1 im Browser: Netz laden, Kantenfaktoren aus dem Spielmodell
// (mit Ausbauten) berechnen, Startzellen auf mehrere Worker verteilen, Ergebnisse zusammenführen.
import { ladeJsonGz } from './verkehr-modell.js';
import { bikeValues } from './render.js';

const u = v => v === -1 ? undefined : v;

// Steigungen: 1 Höhenmeter bergauf fühlt sich wie 10 m Strecke an; über 6 % Steigung zusätzlich anstrengend
export const BERG = { hm: 10, steilAb: 0.06, steil: 8 };
// Kreuzungen (gefühlte Meter): Hauptstraße / Sammelstraße ohne Sicherung, mit Ampel, mit Kreisverkehr
export const KNOTEN_STRAFE = { haupt: 45, sammel: 18, ampel: 10, kreisel: 14 };

// Gefühlte Meter je Meter fürs Rad. Infinity = nicht befahrbar.
export function radFaktor(m) {
  if (m.cls === 'auto' || m.cls === 'treppe') return Infinity;
  const bv = bikeValues(m);
  if (!bv.allowed) return m.cls === 'fuss' ? 3.5 : Infinity; // Fußweg: schieben
  if (bv.sidepath) return 4;                                   // Fahrbahn verboten, Radweg daneben nehmen
  return 1 + 2.2 * bv.risk + 1.5 * (1 - bv.comfort);
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
  modell(e) {
    const n = this.netz, K = n.kanten;
    const m = { cls: n.klassen[K.cls[e]], ms: u(K.ms[e]), bike: u(K.bike[e]), car: u(K.car[e]), fac_l: u(K.fac_l[e]), fac_r: u(K.fac_r[e]), frs: u(K.frs[e]),
      surf: n.belaege[K.surf[e]], cond: u(K.cond[e]), tsurf: n.belaege[K.tsurf[e]], tcond: u(K.tcond[e]) };
    const p = this.patchFor(K.id[e]);
    return p ? { ...m, ...p } : m;
  }
  // je Richtung: Grundfaktor + Höhenmeter bergauf (BERG.hm gefühlte Meter je Hm) + Zuschlag für steile Stücke
  faktoren() {
    const f = new Float32Array(2 * this.nE), K = this.netz.kanten, auf = K.auf, ab = K.ab, steil = K.steil;
    for (let e = 0; e < this.nE; e++) {
      const g = radFaktor(this.modell(e)); f[2 * e] = f[2 * e + 1] = g;
      if (g === Infinity || !auf || auf[e] < 0) continue;
      const L = Math.max(5, this.len[e]), st = Math.max(0, steil[e] / 1000 - BERG.steilAb) * BERG.steil;
      f[2 * e] = g + (BERG.hm * auf[e] / 10) / L + st;
      f[2 * e + 1] = g + (BERG.hm * ab[e] / 10) / L + st * .5;
    }
    return f;
  }
  // Gefühlte Meter für das Queren einer Kreuzung: Hauptstraße ohne Ampel/Kreisel ist unangenehm
  knotenStrafe() {
    const st = new Float32Array(this.nK), ids = this.netz.knoten.id;
    for (let v = 0; v < this.nK; v++) {
      if (this.kGrad[v] < 3 || this.kStr[v] < 2) continue;
      let p = this.kRang[v] >= 4 ? KNOTEN_STRAFE.haupt : this.kRang[v] === 3 ? KNOTEN_STRAFE.sammel : 0; if (!p) continue;
      const b = ids ? this.knotenBau(ids[v]) : null;
      if (this.kAmpel[v] || (b && b.ampel)) p = Math.min(p, KNOTEN_STRAFE.ampel);
      if (this.kRund[v] || (b && b.kreisel)) p = Math.min(p, KNOTEN_STRAFE.kreisel);
      st[v] = p;
    }
    return st;
  }
  steigung(id) { const e = this.idx && this.idx.get(id), K = this.netz && this.netz.kanten; if (e === undefined || !K || !K.steil || K.steil[e] < 0) return null; return { steil: K.steil[e] / 10, auf: K.auf[e] / 10, ab: K.ab[e] / 10 }; }

  // Neu rechnen; während einer laufenden Rechnung wird höchstens eine weitere vorgemerkt
  async rechnen() {
    if (this.laeuft) { this.wieder = true; return; }
    this.laeuft = true; const t0 = performance.now();
    const f = this.faktoren(), strafe = this.knotenStrafe(), maske = this.maske(), W = this.worker.length;
    // Zellen reihum verteilen (Lastausgleich: große Städte nicht alle in einem Block)
    const stueck = Math.max(1, Math.ceil(this.nZ / (W * 6))), auftraege = [];
    for (let v = 0; v < this.nZ; v += stueck) auftraege.push([v, Math.min(this.nZ, v + stueck)]);
    const vol = new Float64Array(this.nE), Z = { zWege: new Float32Array(this.nZ), zRad: new Float32Array(this.nZ), zRadIn: new Float32Array(this.nZ), zZuf: new Float32Array(this.nZ), zZufW: new Float32Array(this.nZ) };
    let wege = 0, rad = 0, radKm = 0, fertig = 0; const gesamt = auftraege.length;
    await Promise.all(this.worker.map(w => new Promise((ok, fail) => {
      const naechster = () => {
        const a = auftraege.shift(); if (!a) { w.onmessage = null; return ok(); }
        w.onmessage = ev => {
          const m = ev.data;
          if (m.typ === 'fehler') return fail(new Error(m.text));
          if (m.typ !== 'ergebnis') return;
          const r = m.r; for (let e = 0; e < this.nE; e++) vol[e] += r.vol[e];
                for (const k of ["zWege", "zRad", "zZuf", "zZufW"]) Z[k].set(r[k].subarray(m.von, m.bis), m.von);
          wege += r.summeWege; rad += r.summeRad; radKm += r.summeRadKm; fertig++;
          if (!this._radIn) this._radIn = new Float64Array(this.nZ);
          for (let z = 0; z < this.nZ; z++) this._radIn[z] += r.zRadIn[z];
          this.onStatus(`Verkehr wird berechnet … ${Math.round(fertig / gesamt * 100)} %`);
          naechster();
        };
        w.postMessage({ typ: 'rechne', id: a[0], faktor: f, strafe, maske, von: a[0], bis: a[1] });
      };
      naechster();
    })));
    Z.zRadIn = Float32Array.from(this._radIn); this._radIn = null;
    let zs = 0, zw = 0; for (let z = 0; z < this.nZ; z++) if (Z.zZufW[z] > 0) { zs += Z.zZuf[z] * this.Z.ew[z]; zw += this.Z.ew[z]; }
    this.vorher = this.erg;
    this.erg = { vol: Float32Array.from(vol), ...Z, wege, rad, radKm, anteil: wege ? rad / wege : 0, zufrieden: zw ? zs / zw : 0, ew: this.einwohner(), ms: performance.now() - t0, t: Date.now() };
    this.laeuft = false;
    this.onErgebnis(this.erg, this.vorher);
    if (this.wieder) { this.wieder = false; this.rechnen(); }
  }
  // Spielgebiet (Kreis in Weltkoordinaten) -> Zellmaske; null = ganze Region
  maske() { if (!this.gebiet) return null; const g = this.gebiet, m = new Uint8Array(this.nZ); for (let z = 0; z < this.nZ; z++) m[z] = Math.hypot(this.Z.x[z] - g.x, this.Z.y[z] - g.y) <= g.r ? 1 : 0; return m; }
  einwohner(g = this.gebiet) { let s = 0; for (let z = 0; z < this.nZ; z++) if (!g || Math.hypot(this.Z.x[z] - g.x, this.Z.y[z] - g.y) <= g.r) s += this.Z.ew[z]; return s; }
  knotenPos(id) { const v = this.kid && this.kid.get(id); return v === undefined ? null : [this.kx[v], this.ky[v]]; }
  volumen(id) { const e = this.idx && this.idx.get(id); return e === undefined || !this.erg ? null : this.erg.vol[e]; }
  // Kennzahlen für einen Kreis (Ortsansicht)
  imKreis(x, y, R) {
    if (!this.erg) return null; let w = 0, r = 0, ew = 0, zs = 0;
    for (let z = 0; z < this.nZ; z++) { if (Math.hypot(this.Z.x[z] - x, this.Z.y[z] - y) > R) continue; w += this.erg.zWege[z]; r += this.erg.zRad[z]; ew += this.Z.ew[z]; zs += this.erg.zZuf[z] * this.Z.ew[z]; }
    return { wege: w, rad: r, anteil: w ? r / w : 0, ew, zufrieden: ew ? zs / ew : 0 };
  }
}
