// Radweg Tycoon – Spielansicht (isometrisch). Wird vom Hauptspiel (app.js) als zweite Ansicht genutzt:
// gleiche Kacheln, Ausbauten, Werkzeuge und derselbe Live-Verkehr wie die Karte, andere Darstellung:
// - Projektion 2:1-isometrisch, vierfach drehbar. Welt (x Ost, y Süd, z hoch, Meter) -> gedreht (u, v) ->
//   Bild: sx = (u − v)·S, sy = (u + v)·S/2 − z·S·HZ.  Betrachter schaut aus Richtung +u+v.
// - Gezeichnet wird in eine niedrig aufgelöste Leinwand (1 Pixel = PX Bildschirmpunkte) und hart
//   hochskaliert: Pixel-Look ohne Handarbeit.
// - Gebäude: echte Grundrisse hochgezogen, Fensterraster je Geschoss, Satteldach bei rechteckigen
//   Wohnhäusern, sonst Flachdach. Bäume prozedural in Wald, Gärten und Parks (deterministisch).
// - Statische Szene wird zwischengespeichert; Fahrzeuge kommen pro Bild darüber, Gebäude und Bäume
//   davor werden über ihnen neu gezeichnet (Verdeckung).
import { isRoad } from './tiles.js';
import { offsetLine, hashStr, mulberry32 } from './render.js';
import { at } from './live.js';

export const PX = 2;
const HZ = 0.86;
export const ZOOMS = [1, 1.5, 2, 3, 4, 6];

/* ----------------------------- Farben ----------------------------- */
const C = {
  gras: ['#4d7a37', '#456f31', '#56853e', '#4a7434'], garten: ['#5a8c40', '#52823a', '#63964a'], wald: ['#3a5d2a', '#33542a', '#40652e'],
  acker: ['#b89d5c', '#a98f50', '#c2a765'], wasser: ['#3b74b5', '#4682c2', '#336aa6'], sand: ['#d6c08c', '#cdb57f'],
  gewerbe: ['#8e8a82', '#86827a'], parkplatz: ['#56585e', '#5d5f65'], hof: ['#8d8576', '#857d6e'], friedhof: ['#4f7c3d', '#47733a'],
  asphalt: ['#3b3d43', '#37393f', '#3f4147'], gehweg: ['#8f8b86', '#86827d', '#97938e'], bord: '#b9b3a8', radweg: ['#a3493b', '#9a4335', '#ab5142'],
  markierung: '#e9e3d0', weg: ['#b9a277', '#ae976c'], wegAsphalt: ['#55575c', '#4e5055'], pflaster: ['#8a857d', '#807b73'],
  wand: ['#e2d2a2', '#cfb98e', '#c4a46a', '#a9483a', '#b85c3e', '#a6a097', '#d9cfc2', '#c9b85e', '#8f8466'],
  dach: ['#5a4f55', '#6e3b2c', '#8a3c2e', '#3d3c44', '#7a5236', '#4f5560'], flach: ['#6a6862', '#77736b', '#5f5e5a'],
  glas: '#2a3a52', glasHell: '#6f8fb3', rahmen: '#efe8d8', schatten: 'rgba(10,20,10,.28)',
};
const BODEN = { wohngebiet: 'garten', garten: 'garten', park: 'garten', kleingarten: 'garten', obstwiese: 'garten', spielplatz: 'garten', schule: 'garten',
  wiese: 'gras', heide: 'gras', gebuesch: 'gras', brache: 'gras', feuchtgebiet: 'gras', wald: 'wald', acker: 'acker', wasser: 'wasser', sand: 'sand', abbau: 'sand',
  gewerbe: 'gewerbe', bahn: 'hof', hof: 'hof', baustelle: 'hof', militaer: 'gras', parkplatz: 'parkplatz', friedhof: 'friedhof', sportanlage: 'gras', sportplatz: 'garten', laufbahn: 'radweg', fels: 'hof' };

/* ----------------------------- Zustand ----------------------------- */
let man, store, spiel, live, hoehen = null;
const lo = document.createElement('canvas'), lctx = lo.getContext('2d');          // Bild in Pixelauflösung
const st = document.createElement('canvas'), sctx = st.getContext('2d');          // statische Szene mit Rand
export const cam = { x: 0, y: 0, zi: 3, rot: 0 };
let S = ZOOMS[cam.zi], W = 0, H = 0, statisch = null, haeuser = true;
const MARGE = 160; // Pixel Rand der statischen Szene

/* ----------------------------- Projektion ----------------------------- */
// Drehung um die Kameramitte in 90°-Schritten
function rot(x, y) {
  const dx = x - cam.x, dy = y - cam.y;
  switch (cam.rot) { case 1: return [dy, -dx]; case 2: return [-dx, -dy]; case 3: return [-dy, dx]; default: return [dx, dy]; }
}
function unrot(u, v) {
  switch (cam.rot) { case 1: return [cam.x - v, cam.y + u]; case 2: return [cam.x - u, cam.y - v]; case 3: return [cam.x + v, cam.y - u]; default: return [cam.x + u, cam.y + v]; }
}
// Gelände: Höhe relativ zur Bildmitte (h0), überhöht. gelFix setzt eine feste Grundhöhe (Gebäude, Fahrzeuge).
const EX = 1.5;
let h0 = 0, gelFix = null, gelFehlt = false;
function gel(x, y) {
  if (!hoehen || !hoehen.ok) return 0;
  const h = hoehen.hoehe(x, y); if (h === null) return 0;
  return (h - h0) * EX;
}
// Welt -> Pixel der niedrig aufgelösten Leinwand (ohne Rand); z über Gelände
function P(x, y, z = 0) { const [u, v] = rot(x, y), g = gelFix !== null ? gelFix : gel(x, y); return [W / 2 + (u - v) * S, H / 2 + (u + v) * S / 2 - (z + g) * S * HZ]; }
// Polylinie verdichten, damit sie dem Gelände folgt
function dicht(Pl, max = 6, zu = false) {
  if (!hoehen || !hoehen.ok) return Pl;
  const out = [], n = Pl.length, m = zu ? n : n - 1;
  for (let i = 0; i < m; i++) { const a = Pl[i], b = Pl[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.max(1, Math.ceil(l / max)); for (let j = 0; j < k; j++) out.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]); }
  if (!zu) out.push(Pl[n - 1]);
  return out;
}
function tiefe(x, y) { const [u, v] = rot(x, y); return u + v; }
function welt(px, py) { const a = (px - W / 2) / S, b = (py - H / 2) * 2 / S; return unrot((a + b) / 2, (b - a) / 2); }

function poly(c, pts, z = 0, ox = 0, oy = 0) { c.beginPath(); for (let i = 0; i < pts.length; i++) { const p = P(pts[i][0], pts[i][1], z); i ? c.lineTo(p[0] + ox, p[1] + oy) : c.moveTo(p[0] + ox, p[1] + oy); } c.closePath(); }

/* ----------------------------- Muster ----------------------------- */
const muster = {};
function rauschen(farben, seed, grob = 1) {
  const key = farben.join() + grob; if (muster[key]) return muster[key];
  const cv = document.createElement('canvas'); cv.width = cv.height = 32; const c = cv.getContext('2d'), r = mulberry32(seed);
  c.fillStyle = farben[0]; c.fillRect(0, 0, 32, 32);
  for (let i = 0; i < 140; i++) { c.fillStyle = farben[1 + Math.floor(r() * (farben.length - 1))]; c.fillRect(Math.floor(r() * 32), Math.floor(r() * 32), grob + (r() < .3 ? 1 : 0), grob); }
  return (muster[key] = lctx.createPattern(cv, 'repeat'));
}
function ackerMuster() {
  if (muster.acker) return muster.acker;
  const cv = document.createElement('canvas'); cv.width = cv.height = 16; const c = cv.getContext('2d');
  c.fillStyle = C.acker[0]; c.fillRect(0, 0, 16, 16); c.fillStyle = C.acker[1];
  for (let i = 0; i < 16; i += 4) for (let j = 0; j < 16; j++) c.fillRect((j + i) % 16, j, 1, 1);
  return (muster.acker = lctx.createPattern(cv, 'repeat'));
}
function wiese(farben, blumen, seed) {
  const key = 'w' + farben.join() + blumen; if (muster[key]) return muster[key];
  const N = 64, cv = document.createElement('canvas'); cv.width = cv.height = N; const c = cv.getContext('2d'), r = mulberry32(seed);
  c.fillStyle = farben[0]; c.fillRect(0, 0, N, N);
  for (let i = 0; i < 520; i++) { c.fillStyle = farben[1 + Math.floor(r() * (farben.length - 1))]; c.fillRect(Math.floor(r() * N), Math.floor(r() * N), 1, 1); }
  for (let i = 0; i < 70; i++) { const x = Math.floor(r() * N), y = Math.floor(r() * N); c.fillStyle = hell(farben[0], .78); c.fillRect(x, y, 1, 2); c.fillRect(x + 1, y + 1, 1, 1); c.fillStyle = hell(farben[0], 1.22); c.fillRect(x, y - 1, 1, 1); }
  const bl = ['#f2e9d8', '#f0c93a', '#e46aa0', '#c94a3a', '#b9a6f0'];
  for (let i = 0; i < blumen; i++) { const x = Math.floor(r() * N), y = Math.floor(r() * N); c.fillStyle = bl[Math.floor(r() * bl.length)]; c.fillRect(x, y, 1, 1); if (r() < .4) c.fillRect(x + 1, y, 1, 1); }
  return (muster[key] = lctx.createPattern(cv, 'repeat'));
}
const boden = k => k === 'acker' ? ackerMuster() : k === 'gras' ? wiese(C.gras, 2, 21) : k === 'garten' ? wiese(C.garten, 16, 22) : k === 'friedhof' ? wiese(C.friedhof, 10, 23) : rauschen(C[k] || C.gras, k.length * 7 + 3);

/* ----------------------------- Sprites: Bäume ----------------------------- */
const baumCache = new Map();
function baumSprite(art, groesse) {
  const key = art + ':' + groesse + ':' + S; if (baumCache.has(key)) return baumCache.get(key);
  const h = Math.max(art === 'busch' ? 3 : 6, Math.round(groesse * S * HZ * (art === 'busch' ? .8 : 1.1))), w = Math.max(art === 'busch' ? 4 : 5, Math.round(h * (art === 'nadel' ? .55 : art === 'busch' ? 1.5 : .8)));
  const cv = document.createElement('canvas'); cv.width = w + 2; cv.height = h + 2; const c = cv.getContext('2d'), r = mulberry32(groesse * 97 + (art === 'nadel' ? 5 : 1));
  const stamm = Math.max(1, Math.round(w * .12));
  if (art !== 'busch') { c.fillStyle = '#4a3423'; c.fillRect(Math.round(w / 2 - stamm / 2) + 1, Math.round(h * .62), stamm, Math.round(h * .38)); }
  const gruen = art === 'nadel' ? ['#24482a', '#2e5a33', '#3a6c3c', '#1b3a22'] : ['#3d6e2c', '#4d8436', '#5e9a3f', '#2f5a24'];
  if (art === 'busch') {
    const cx = w / 2, cy = h * .55, rx = w / 2, ry = h * .45, bl = r() < .35 ? ['#d84a7a', '#f0c93a', '#f2e9d8'][Math.floor(r() * 3)] : null;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const d = ((x + .5 - cx) / rx) ** 2 + ((y + .5 - cy) / ry) ** 2; if (d > 1 - r() * .2) continue; const licht = (x - cx) / rx * -.6 + (y - cy) / ry * -.8; c.fillStyle = bl && r() < .12 ? bl : gruen[licht > .3 ? 2 : licht < -.4 ? 3 : (r() < .3 ? 0 : 1)]; c.fillRect(x + 1, y + 1, 1, 1); }
  } else if (art === 'nadel') {
    for (let y = 0; y < h * .85; y++) { const t = y / (h * .85), bw = Math.max(1, Math.round(w * t * .95)); for (let x = 0; x < bw; x++) { const xx = Math.round(w / 2 - bw / 2) + x; c.fillStyle = gruen[x < bw * .4 ? 2 : x > bw * .75 ? 3 : (r() < .25 ? 0 : 1)]; c.fillRect(xx + 1, y + 1, 1, 1); } }
  } else {
    const cx = w / 2, cy = h * .42, rx = w / 2, ry = h * .42;
    for (let y = 0; y < h * .84; y++) for (let x = 0; x < w; x++) {
      const d = ((x + .5 - cx) / rx) ** 2 + ((y + .5 - cy) / ry) ** 2; if (d > 1 - r() * .18) continue;
      const licht = (x - cx) / rx * -.6 + (y - cy) / ry * -.8;
      c.fillStyle = gruen[licht > .35 ? 2 : licht < -.45 ? 3 : (r() < .3 ? 0 : 1)]; c.fillRect(x + 1, y + 1, 1, 1);
    }
  }
  const s = { cv, w: cv.width, h: cv.height }; baumCache.set(key, s); return s;
}

/* ----------------------------- Geometrie-Helfer ----------------------------- */
function flaeche(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a / 2; }
function schwerpunkt(p) { let x = 0, y = 0; for (const q of p) { x += q[0]; y += q[1]; } return [x / p.length, y / p.length]; }
function inRing(x, y, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
function inFlaeche(x, y, rings) { let c = false; for (const r of rings) if (inRing(x, y, r)) c = !c; return c; }
// kleinstes umschließendes Rechteck über die Kantenrichtungen des Grundrisses
function rechteck(p) {
  let best = null;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length], dx = q[0] - p[i][0], dy = q[1] - p[i][1], l = Math.hypot(dx, dy); if (l < .5) continue;
    const ax = dx / l, ay = dy / l; let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
    for (const r of p) { const a = r[0] * ax + r[1] * ay, b = -r[0] * ay + r[1] * ax; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
    const A = (a1 - a0) * (b1 - b0);
    if (!best || A < best.A) best = { A, ax, ay, a0, a1, b0, b1 };
  }
  if (!best) return null;
  let { ax, ay, a0, a1, b0, b1 } = best;
  if (a1 - a0 < b1 - b0) { [ax, ay] = [-ay, ax]; [a0, a1, b0, b1] = [b0, b1, -a1, -a0]; } // a = lange Achse
  const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
  return { A: best.A, cx: ca * ax - cb * ay, cy: ca * ay + cb * ax, ax, ay, bx: -ay, by: ax, la: (a1 - a0) / 2, lb: (b1 - b0) / 2 };
}

/* ----------------------------- Szene aufbereiten (je Kachel einmal) ----------------------------- */
const WOHN = new Set(['house', 'residential', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'farm', 'yes', 'villa']);
function gebaeudeModell(b, salt) {
  const p = b.P.slice(0, b.P.length > 3 && b.P[0][0] === b.P[b.P.length - 1][0] && b.P[0][1] === b.P[b.P.length - 1][1] ? -1 : undefined);
  if (p.length < 3) return null;
  const A = Math.abs(flaeche(p)), h = hashStr(salt), t = b.t || 'yes';
  let geschosse = b.lv || (t === 'apartments' ? 3 + Math.floor(h * 2) : t === 'house' || t === 'detached' || t === 'residential' ? 1 + (h < .35 ? 1 : 0) : A < 30 ? 0 : A < 220 ? 1 + (h < .3 ? 1 : 0) : 2);
  const garage = A < 30 || t === 'garage' || t === 'garages' || t === 'shed' || t === 'carport';
  const gewerbe = ['industrial', 'warehouse', 'commercial', 'retail', 'supermarket', 'farm_auxiliary', 'barn'].includes(t);
  const wandH = garage ? 2.6 : gewerbe ? Math.max(4.5, (b.lv || 1) * 4.2) : Math.max(1, geschosse) * 2.9;
  const r = rechteck(p);
  const sattel = !garage && !gewerbe && r && WOHN.has(t) && A / r.A > .82 && r.lb < 7.5 && (b.lv || 2) <= 3;
  const wand = garage ? '#a6a097' : gewerbe ? ['#a6a097', '#8f9aa3', '#b9b0a0', '#7d8a7a'][Math.floor(h * 4)] : C.wand[Math.floor(h * C.wand.length)];
  const dach = C.dach[Math.floor(hashStr(salt + 'd') * C.dach.length)];
  const c = schwerpunkt(p);
  const sh = hashStr(salt + 's');
  return { schornstein: sattel && sh < .65 ? (sh * 2.4 - .8) : 0, p: sattel ? null : p, r, sattel, H: wandH, wand, dach, flach: C.flach[Math.floor(h * 3)], fenster: !garage, gewerbe, cx: c[0], cy: c[1], A };
}
function bereite(t) {
  if (t._iso) return t._iso;
  const haus = [], baeume = [];
  t.buildings.forEach((b, i) => { const m = gebaeudeModell(b, `${t.ix}_${t.iy}_${i}`); if (m) haus.push(m); });
  // Straßen-Raster für Abstände der Bäume
  const G = 16, rg = new Map();
  for (const r of t.roads) for (let i = 1; i < r.P.length; i++) {
    const a = r.P[i - 1], b = r.P[i], n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 8);
    for (let k = 0; k <= n; k++) { const x = a[0] + (b[0] - a[0]) * k / n, y = a[1] + (b[1] - a[1]) * k / n, key = Math.floor(x / G) + ',' + Math.floor(y / G); (rg.get(key) || rg.set(key, []).get(key)).push([x, y, r.half + 1.8]); }
  }
  const frei = (x, y) => {
    const gx = Math.floor(x / G), gy = Math.floor(y / G);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const q of rg.get((gx + i) + ',' + (gy + j)) || []) if (Math.hypot(q[0] - x, q[1] - y) < q[2]) return false;
    for (const h of haus) { if (Math.abs(h.cx - x) > 40 || Math.abs(h.cy - y) > 40) continue; const pp = h.p || ecken(h.r); if (inRing(x, y, pp)) return false; const d = Math.hypot(h.cx - x, h.cy - y); if (d < 3) return false; }
    return true;
  };
  const DICHTE = { wald: [6.5, .9], park: [14, .45], garten: [12, .4], wohngebiet: [15, .28], friedhof: [11, .5], obstwiese: [9, .7], kleingarten: [13, .35], gebuesch: [8, .5], schule: [18, .3] };
  for (const a of t.areas) {
    const d = DICHTE[a.k]; if (!d) continue;
    const [g, p] = d; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const ring of a.rings) for (const q of ring) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
    x0 = Math.max(x0, t.x0); x1 = Math.min(x1, t.x1); y0 = Math.max(y0, t.y0); y1 = Math.min(y1, t.y1);
    for (let gx = Math.floor(x0 / g); gx <= Math.floor(x1 / g); gx++) for (let gy = Math.floor(y0 / g); gy <= Math.floor(y1 / g); gy++) {
      const hh = hashStr(a.k + gx + ':' + gy); if (hh > p) continue;
      const x = (gx + .15 + .7 * hashStr('x' + gx + ':' + gy)) * g, y = (gy + .15 + .7 * hashStr('y' + gx + ':' + gy)) * g;
      if (x < t.x0 || x >= t.x1 || y < t.y0 || y >= t.y1 || !inFlaeche(x, y, a.rings) || !frei(x, y)) continue;
      const nadel = a.k === 'wald' ? hashStr('n' + gx + gy) < .55 : a.k === 'friedhof' ? hh < .3 : hh < .12;
      baeume.push({ x, y, art: nadel ? 'nadel' : 'laub', g: [7, 9, 11, 13][Math.floor(hashStr('g' + gx + gy) * 4)] });
    }
  }
  // Büsche und Gartenbäume rund um Wohnhäuser
  for (const h of haus) {
    if (!h.sattel && h.A > 400) continue;
    const n = 2 + Math.floor(hashStr('b' + h.cx + h.cy) * 4);
    for (let i = 0; i < n; i++) {
      const w = hashStr('w' + i + h.cx) * Math.PI * 2, d = Math.sqrt(h.A) * .6 + 2.5 + hashStr('d' + i + h.cy) * 6;
      const x = h.cx + Math.cos(w) * d, y = h.cy + Math.sin(w) * d;
      if (x < t.x0 || x >= t.x1 || y < t.y0 || y >= t.y1 || !frei(x, y)) continue;
      const k = hashStr('k' + i + h.cx);
      baeume.push(k < .7 ? { x, y, art: 'busch', g: 2 + Math.floor(k * 4) } : { x, y, art: k < .85 ? 'laub' : 'nadel', g: 6 + Math.floor(k * 6) });
    }
  }
  // Straßenlaternen: alle ~30 m abwechselnd links/rechts auf dem Gehweg bzw. am Rand
  const lampen = [];
  for (const r of t.roads) {
    const m = r.m; if (!r.own || !['L', 'dorf', 'wohn', 'spiel'].includes(m.cls) || r.len < 20) continue;
    const Pl = r.P; let acc = 0, next = 12 + 10 * hashStr('l' + r.id), seite = 1;
    for (let i = 1; i < Pl.length; i++) {
      const a = Pl[i - 1], b = Pl[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (!l) continue;
      while (next <= acc + l && next < r.len - 8) {
        const f = (next - acc) / l, x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f, nx = -(b[1] - a[1]) / l, ny = (b[0] - a[0]) / l;
        const sw = seite > 0 ? m.sw_r : m.sw_l, track = (seite > 0 ? m.fac_r : m.fac_l) === 3 ? 1.8 : 0, off = m.cw + .3 + track + (sw ? sw * .7 : .6);
        lampen.push({ x: x + nx * off * seite, y: y + ny * off * seite }); seite = -seite; next += 30;
      }
      acc += l;
    }
  }
  return (t._iso = { haus, baeume, lampen });
}
const ecken = r => [[r.cx - r.ax * r.la - r.bx * r.lb, r.cy - r.ay * r.la - r.by * r.lb], [r.cx + r.ax * r.la - r.bx * r.lb, r.cy + r.ay * r.la - r.by * r.lb], [r.cx + r.ax * r.la + r.bx * r.lb, r.cy + r.ay * r.la + r.by * r.lb], [r.cx - r.ax * r.la + r.bx * r.lb, r.cy - r.ay * r.la + r.by * r.lb]];

/* ----------------------------- Zeichnen: Boden und Straßen ----------------------------- */
function band(c, Pl, d0, d1, fill, ox, oy) {
  if (d1 <= d0 || Pl.length < 2) return;
  const A = dicht(offsetLine(Pl, d0)), B = dicht(offsetLine(Pl, d1)).reverse();
  c.beginPath(); [...A, ...B].forEach((q, i) => { const p = P(q[0], q[1]); i ? c.lineTo(p[0] + ox, p[1] + oy) : c.moveTo(p[0] + ox, p[1] + oy); }); c.closePath(); c.fillStyle = fill; c.fill();
}
function scheibe(c, x, y, r, fill, ox, oy) { const p = P(x, y); c.beginPath(); c.ellipse(p[0] + ox, p[1] + oy, r * S * 1.414, r * S * .707, 0, 0, Math.PI * 2); c.fillStyle = fill; c.fill(); }
function linie(c, Pl, off, breite, farbe, strich, ox, oy) {
  const L = dicht(off ? offsetLine(Pl, off) : Pl); c.beginPath(); L.forEach((q, i) => { const p = P(q[0], q[1]); i ? c.lineTo(p[0] + ox, p[1] + oy) : c.moveTo(p[0] + ox, p[1] + oy); });
  c.lineWidth = Math.max(1, breite * S); c.strokeStyle = farbe; c.setLineDash(strich ? strich.map(v => v * S) : []); c.stroke(); c.setLineDash([]);
}
function strassen(c, roads, ox, oy) {
  c.lineJoin = 'round'; c.lineCap = 'butt';
  const asph = rauschen(C.asphalt, 11), geh = rauschen(C.gehweg, 12, 2), rad = rauschen(C.radweg, 13), weg = rauschen(C.weg, 14), wegA = rauschen(C.wegAsphalt, 15), pfl = rauschen(C.pflaster, 16, 2);
  // Wege
  for (const r of roads) { const m = r.m; if (isRoad(m)) continue; const w = Math.max(.6, m.cw || 1); const f = m.cls === 'rad' ? (m.surf === 'asphalt' ? rad : pfl) : m.surf === 'asphalt' ? wegA : m.surf === 'paving_stones' ? pfl : weg; band(c, r.P, -w, w, f, ox, oy); }
  // Seitenraum: Gehwege, Hochbord-Radwege, Bord
  for (const r of roads) { const m = r.m; if (!isRoad(m)) continue;
    for (const sd of [1, -1]) { const sw = sd > 0 ? m.sw_r : m.sw_l, fac = sd > 0 ? m.fac_r : m.fac_l; let d = m.cw;
      band(c, r.P, sd > 0 ? d : -(d + .3), sd > 0 ? d + .3 : -d, C.bord, ox, oy); d += .3;
      if (fac === 3) { band(c, r.P, sd > 0 ? d : -(d + 1.6), sd > 0 ? d + 1.6 : -d, (m.tsurf || 'asphalt') === 'asphalt' ? rad : pfl, ox, oy); d += 1.8; }
      if (sw) band(c, r.P, sd > 0 ? d : -(d + sw), sd > 0 ? d + sw : -d, geh, ox, oy); } }
  // Fahrbahn (Kreuzungen über Scheiben an den Enden)
  for (const r of roads) { const m = r.m; if (!isRoad(m)) continue; band(c, r.P, -m.cw, m.cw, m.surf === 'asphalt' || !m.surf ? asph : pfl, ox, oy); }
  // Kreuzungsflächen nur an Knoten mit mindestens zwei Straßen (keine Scheiben an Sackgassen)
  const grad = new Map(); for (const r of roads) if (isRoad(r.m)) for (const n of [r.a, r.b]) grad.set(n, (grad.get(n) || 0) + 1);
  for (const r of roads) { const m = r.m; if (!isRoad(m)) continue; const f = m.surf === 'asphalt' || !m.surf ? asph : pfl;
    if (grad.get(r.a) > 1) scheibe(c, r.P[0][0], r.P[0][1], m.cw, f, ox, oy); if (grad.get(r.b) > 1) scheibe(c, r.P[r.P.length - 1][0], r.P[r.P.length - 1][1], m.cw, f, ox, oy); }
  // Markierungen, Rad-/Schutzstreifen
  for (const r of roads) { const m = r.m; if (!isRoad(m) || r.len < 12) continue;
    const Pi = kuerzen(r.P, Math.min(m.cw + 2, r.len / 3));
    if (Pi.length < 2) continue;
    for (const sd of [1, -1]) { const fac = sd > 0 ? m.fac_r : m.fac_l;
      if (fac === 2) { band(c, Pi, sd > 0 ? m.cw - 1.6 : -m.cw, sd > 0 ? m.cw : -m.cw + 1.6, rad, ox, oy); linie(c, Pi, sd * (m.cw - 1.65), .15, C.markierung, null, ox, oy); }
      if (fac === 1) linie(c, Pi, sd * (m.cw - 1.5), .15, C.markierung, [1, 1], ox, oy); }
    if (!m.oneway && m.cw >= 2.5 && ['L', 'dorf', 'auto'].includes(m.cls)) linie(c, Pi, 0, .15, C.markierung, m.cls === 'dorf' ? [2, 4] : [3, 3], ox, oy); }
}
function kuerzen(Pl, d) { // Polylinie an beiden Enden um d kürzen (Markierung nicht in die Kreuzung)
  const out = []; let acc = 0; const L = []; for (let i = 1; i < Pl.length; i++) L.push(Math.hypot(Pl[i][0] - Pl[i - 1][0], Pl[i][1] - Pl[i - 1][1]));
  const tot = L.reduce((a, b) => a + b, 0); if (tot <= 2 * d) return [];
  for (let i = 0; i < L.length; i++) {
    const a = Pl[i], b = Pl[i + 1], s0 = acc, s1 = acc + L[i]; acc = s1;
    const f0 = Math.max(0, (d - s0) / L[i]), f1 = Math.min(1, (tot - d - s0) / L[i]); if (f0 >= 1 || f1 <= 0 || f1 <= f0) continue;
    const p0 = [a[0] + (b[0] - a[0]) * f0, a[1] + (b[1] - a[1]) * f0], p1 = [a[0] + (b[0] - a[0]) * f1, a[1] + (b[1] - a[1]) * f1];
    if (!out.length) out.push(p0); out.push(p1);
  }
  return out;
}

/* ----------------------------- Zeichnen: Gebäude ----------------------------- */
function hell(hex, f) { const n = parseInt(hex.slice(1), 16); const k = v => Math.max(0, Math.min(255, Math.round(v * f))); return `rgb(${k(n >> 16)},${k(n >> 8 & 255)},${k(n & 255)})`; }
// Sichtbare Wand (Normale zum Betrachter) mit Licht von links
function wand(c, a, b, z0, z1, farbe, fenster, cx, cy, ox, oy) {
  const [ua, va] = rot(a[0], a[1]), [ub, vb] = rot(b[0], b[1]);
  let nx = vb - va, ny = -(ub - ua); const [uc, vc] = rot(cx, cy);
  if (nx * ((ua + ub) / 2 - uc) + ny * ((va + vb) / 2 - vc) < 0) { nx = -nx; ny = -ny; }
  if (nx + ny <= 0) return;                                  // zeigt weg vom Betrachter
  const links = ny > nx;                                     // Seite nach links unten
  const q = [P(a[0], a[1], z0), P(b[0], b[1], z0), P(b[0], b[1], z1), P(a[0], a[1], z1)];
  c.beginPath(); q.forEach((p, i) => i ? c.lineTo(p[0] + ox, p[1] + oy) : c.moveTo(p[0] + ox, p[1] + oy)); c.closePath();
  c.fillStyle = hell(farbe, links ? 1 : .74); c.fill();
  if (fenster && z1 - z0 > 2) { const s0 = [P(a[0], a[1], z0), P(b[0], b[1], z0), P(b[0], b[1], z0 + .4), P(a[0], a[1], z0 + .4)]; c.beginPath(); s0.forEach((p, i) => i ? c.lineTo(p[0] + ox, p[1] + oy) : c.moveTo(p[0] + ox, p[1] + oy)); c.closePath(); c.fillStyle = hell(farbe, links ? .62 : .5); c.fill(); }
  if (!fenster || S < 1.9) return;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 2.4) return;
  const n = Math.floor((L - .8) / 2.6), rest = (L - n * 2.6) / 2, geschosse = Math.max(1, Math.round((z1 - z0) / 2.9));
  c.fillStyle = C.glas;
  for (let f = 0; f < geschosse; f++) {
    const zu = z0 + f * 2.9 + 1.0, zo = zu + 1.25; if (zo > z1 - .2) break;
    for (let k = 0; k < n; k++) {
      const s0 = (rest + k * 2.6 + .8) / L, s1 = (rest + k * 2.6 + 1.85) / L;
      const p0 = [a[0] + (b[0] - a[0]) * s0, a[1] + (b[1] - a[1]) * s0], p1 = [a[0] + (b[0] - a[0]) * s1, a[1] + (b[1] - a[1]) * s1];
      const w = [P(p0[0], p0[1], zu), P(p1[0], p1[1], zu), P(p1[0], p1[1], zo), P(p0[0], p0[1], zo)];
      c.beginPath(); w.forEach((p, i) => i ? c.lineTo(p[0] + ox, p[1] + oy) : c.moveTo(p[0] + ox, p[1] + oy)); c.closePath();
      c.fillStyle = (k + f) % 3 === 0 ? C.glasHell : C.glas; c.fill();
      if (S >= 3) { c.strokeStyle = 'rgba(239,232,216,.75)'; c.lineWidth = 1; c.stroke(); }
    }
  }
}
function gebaeude(c, h, ox, oy) {
  const p = h.sattel ? ecken(h.r) : h.p;
  const alt = gelFix; gelFix = Math.min(...p.map(q => gel(q[0], q[1])));
  try { gebaeudeInnen(c, h, p, ox, oy); } finally { gelFix = alt; }
}
function gebaeudeInnen(c, h, p, ox, oy) {
  // Schatten nach rechts hinten
  if (h.H > 1) { c.fillStyle = C.schatten; poly(c, p.map(q => [q[0] + h.H * .35, q[1] - h.H * .2]), 0, ox, oy); c.fill(); }
  if (!haeuser) { c.fillStyle = hell(h.wand, .9); poly(c, p, .1, ox, oy); c.fill(); c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1; c.stroke(); return; }
  // Wände von hinten nach vorn
  const kanten = []; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; kanten.push([a, b, tiefe((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)]); }
  kanten.sort((x, y) => x[2] - y[2]);
  for (const [a, b] of kanten) wand(c, a, b, 0, h.H, h.wand, h.fenster, h.cx, h.cy, ox, oy);
  if (!h.sattel) { // Flachdach mit Attika
    c.fillStyle = h.flach; poly(c, p, h.H, ox, oy); c.fill(); c.strokeStyle = hell(h.flach, 1.25); c.lineWidth = 1; c.stroke(); return;
  }
  const r = h.r, ue = .45, la = r.la + ue, lb = r.lb + ue, rh = Math.min(4.2, r.lb * .8), z = h.H, zf = h.H + rh;
  const k = (sa, sb) => [r.cx + r.ax * la * sa + r.bx * lb * sb, r.cy + r.ay * la * sa + r.by * lb * sb];
  const R1 = [r.cx - r.ax * la, r.cy - r.ay * la], R2 = [r.cx + r.ax * la, r.cy + r.ay * la];
  // Giebel (Dreiecke an den Schmalseiten, ohne Überstand)
  for (const s of [-1, 1]) {
    const g1 = [r.cx + r.ax * r.la * s - r.bx * r.lb, r.cy + r.ay * r.la * s - r.by * r.lb], g2 = [r.cx + r.ax * r.la * s + r.bx * r.lb, r.cy + r.ay * r.la * s + r.by * r.lb], gs = [r.cx + r.ax * r.la * s, r.cy + r.ay * r.la * s];
    const [nu, nv] = rot(r.cx + r.ax * s, r.cy + r.ay * s), [cu, cv] = rot(r.cx, r.cy); const du = nu - cu, dv = nv - cv; if (du + dv <= 0) continue;
    const q = [P(g1[0], g1[1], z), P(g2[0], g2[1], z), P(gs[0], gs[1], zf)];
    c.beginPath(); q.forEach((pp, i) => i ? c.lineTo(pp[0] + ox, pp[1] + oy) : c.moveTo(pp[0] + ox, pp[1] + oy)); c.closePath(); c.fillStyle = hell(h.wand, dv > du ? 1 : .74); c.fill();
  }
  // Dachflächen: hintere zuerst
  const flaechen = [[k(-1, -1), k(1, -1), R2, R1, -1], [k(-1, 1), k(1, 1), R2, R1, 1]].map(f => { const m = schwerpunkt(f.slice(0, 4)); return [f, tiefe(m[0], m[1])]; }).sort((a, b) => a[1] - b[1]);
  for (const [f] of flaechen) {
    const [nu, nv] = rot(r.cx + r.bx * f[4], r.cy + r.by * f[4]), [cu, cv] = rot(r.cx, r.cy), du = nu - cu, dv = nv - cv;
    const q = [P(f[0][0], f[0][1], z - .25), P(f[1][0], f[1][1], z - .25), P(f[2][0], f[2][1], zf), P(f[3][0], f[3][1], zf)];
    c.beginPath(); q.forEach((pp, i) => i ? c.lineTo(pp[0] + ox, pp[1] + oy) : c.moveTo(pp[0] + ox, pp[1] + oy)); c.closePath();
    const ton = du + dv < 0 ? .78 : dv > du ? 1.12 : .92;
    c.fillStyle = hell(h.dach, ton); c.fill();
    if (S >= 2) { // Ziegelreihen parallel zur Traufe
      const n = Math.max(3, Math.round(rh * 2.2)); c.strokeStyle = hell(h.dach, ton * .8); c.lineWidth = 1; c.beginPath();
      for (let i = 1; i < n; i++) { const t = i / n, A = [q[0][0] + (q[3][0] - q[0][0]) * t, q[0][1] + (q[3][1] - q[0][1]) * t], B = [q[1][0] + (q[2][0] - q[1][0]) * t, q[1][1] + (q[2][1] - q[1][1]) * t]; c.moveTo(Math.round(A[0] + ox) + .5, Math.round(A[1] + oy) + .5); c.lineTo(Math.round(B[0] + ox) + .5, Math.round(B[1] + oy) + .5); }
      c.stroke();
    }
    c.strokeStyle = hell(h.dach, .62); c.lineWidth = 1; c.beginPath(); c.moveTo(q[2][0] + ox, q[2][1] + oy); c.lineTo(q[3][0] + ox, q[3][1] + oy); c.stroke();
  }
  if (h.schornstein) { const t = h.schornstein, x = r.cx + r.ax * r.la * t, y = r.cy + r.ay * r.la * t; kiste(c, x, y, r.ax, r.ay, .7, .7, zf - .9, zf + .7, '#8a4a36', ox, oy); }
}
function laterne(c, l, ox, oy) {
  const p = P(l.x, l.y), h = Math.round(5.2 * S * HZ), x = Math.round(p[0] + ox), y = Math.round(p[1] + oy), w = Math.max(1, Math.round(S * .25));
  c.fillStyle = '#2f3236'; c.fillRect(x, y - h, w, h);
  c.fillStyle = '#3d4146'; c.fillRect(x - Math.round(S * .5), y - h, Math.max(2, Math.round(S * 1.1)), Math.max(1, Math.round(S * .3)));
  c.fillStyle = '#f4e7b0'; c.fillRect(x - Math.round(S * .4), y - h + Math.max(1, Math.round(S * .3)), Math.max(1, Math.round(S * .8)), 1);
}
function baum(c, b, ox, oy) {
  const s = baumSprite(b.art, b.g), p = P(b.x, b.y);
  c.fillStyle = C.schatten; c.beginPath(); c.ellipse(p[0] + ox + s.w * .25, p[1] + oy, s.w * .5, s.w * .22, 0, 0, Math.PI * 2); c.fill();
  c.drawImage(s.cv, Math.round(p[0] + ox - s.w / 2), Math.round(p[1] + oy - s.h + 1));
}

/* ----------------------------- Statische Szene ----------------------------- */
function sichtbereich() { // Welt-Rechteck, das die Leinwand samt Rand abdeckt
  const pts = [[-MARGE, -MARGE - 60], [W + MARGE, -MARGE - 60], [-MARGE, H + MARGE], [W + MARGE, H + MARGE]].map(q => welt(q[0], q[1]));
  return [Math.min(...pts.map(q => q[0])), Math.min(...pts.map(q => q[1])), Math.max(...pts.map(q => q[0])), Math.max(...pts.map(q => q[1]))];
}
function kachelnIn(r) {
  const T = man.tile_size_m[0], E0 = man.bbox_utm[0], N0 = man.bbox_utm[3], out = []; let fehlt = false;
  for (let ix = Math.floor((r[0] + E0) / T); ix <= Math.floor((r[2] + E0) / T); ix++)
    for (let iy = Math.floor((N0 - r[3]) / T); iy <= Math.floor((N0 - r[1]) / T); iy++) { const t = store.get(0, ix, iy); if (t === null) fehlt = true; else if (t) out.push(t); }
  return { tiles: out, fehlt };
}
function baueStatisch() {
  gelFix = null; h0 = 0; const hm = hoehen && hoehen.ok ? hoehen.hoehe(cam.x, cam.y) : null; if (hm !== null) h0 = hm;
  const r = sichtbereich(), { tiles, fehlt } = kachelnIn(r);
  st.width = W + 2 * MARGE; st.height = H + 2 * MARGE;
  const c = sctx, ox = MARGE, oy = MARGE;
  c.imageSmoothingEnabled = false;
  c.fillStyle = wiese(C.gras, 2, 21); c.fillRect(0, 0, st.width, st.height);
  for (const t of tiles) for (const a of t.areas) {
    const k = BODEN[a.k]; if (!k) continue;
    c.beginPath(); for (const ring of a.rings) dicht(ring, 10, true).forEach((q, i) => { const p = P(q[0], q[1]); i ? c.lineTo(p[0] + ox, p[1] + oy) : c.moveTo(p[0] + ox, p[1] + oy); });
    c.fillStyle = boden(k); c.fill('evenodd');
  }
  for (const t of tiles) for (const l of t.lines) if (l.k.startsWith('w:')) linie(c, l.P, 0, l.k === 'w:river' ? 12 : l.k === 'w:canal' ? 10 : l.k === 'w:stream' ? 1.8 : 1.1, C.wasser[0], null, ox, oy);
    else if (l.k === 'r:rail') { linie(c, l.P, 0, 3, '#8a8072', null, ox, oy); linie(c, l.P, .7, .2, '#c3c7cc', null, ox, oy); linie(c, l.P, -.7, .2, '#c3c7cc', null, ox, oy); }
  const roads = new Map(); for (const t of tiles) for (const rd of t.roads) if (!roads.has(rd.id) && !(rd.bb[2] < r[0] || rd.bb[0] > r[2] || rd.bb[3] < r[1] || rd.bb[1] > r[3])) roads.set(rd.id, rd);
  strassen(c, [...roads.values()].sort((a, b) => (isRoad(a.m) ? 1 : 0) - (isRoad(b.m) ? 1 : 0)), ox, oy);
  schummerung(c, r, ox, oy);
  // gebaute Kreisverkehre: Fahrbahnring mit Mittelinsel
  const knotenXY = new Map(); for (const rd of roads.values()) { knotenXY.set(rd.a, rd.P[0]); knotenXY.set(rd.b, rd.P[rd.P.length - 1]); }
  for (const [id, k] of Object.entries(spiel.s.knoten || {})) {
    const q = knotenXY.get(Number(id)); if (!q || !k.kreisel) continue;
    scheibe(c, q[0], q[1], 12, rauschen(C.asphalt, 11), ox, oy); scheibe(c, q[0], q[1], 5.6, C.bord, ox, oy); scheibe(c, q[0], q[1], 5, wiese(C.garten, 16, 22), ox, oy);
  }
  // Objekte nach Tiefe
  const obj = [];
  for (const t of tiles) { const z = bereite(t);
    for (const h of z.haus) if (h.cx > r[0] - 30 && h.cx < r[2] + 30 && h.cy > r[1] - 30 && h.cy < r[3] + 30) obj.push({ typ: 'h', o: h, d: tiefe(h.cx, h.cy) });
    for (const b of z.baeume) if (b.x > r[0] && b.x < r[2] && b.y > r[1] && b.y < r[3]) obj.push({ typ: 'b', o: b, d: tiefe(b.x, b.y) });
    for (const l of z.lampen) if (l.x > r[0] && l.x < r[2] && l.y > r[1] && l.y < r[3]) obj.push({ typ: 'l', o: l, d: tiefe(l.x, l.y) });
    for (const n of t.nodes) if (n.f === 'traffic_signals' && !n.on && !(spiel.s.knoten || {})[n.id]?.kreisel) obj.push(...ampeln(n, roads));
  }
  for (const [id, k] of Object.entries(spiel.s.knoten || {})) if (k.ampel) obj.push(...ampeln({ id: Number(id) }, roads)); // gebaute Ampeln
  obj.sort((a, b) => a.d - b.d);
  for (const o of obj) {
    if (o.typ === 'h') { gebaeude(c, o.o, ox, oy); o.bb = gebBox(o.o); }
    else if (o.typ === 'l') { laterne(c, o.o, ox, oy); const p = P(o.o.x, o.o.y); o.bb = [p[0] - 2, p[1] - 5.5 * S, p[0] + 3, p[1]]; }
    else if (o.typ === 'b') { baum(c, o.o, ox, oy); const p = P(o.o.x, o.o.y), s = baumSprite(o.o.art, o.o.g); o.bb = [p[0] - s.w / 2, p[1] - s.h, p[0] + s.w / 2, p[1]]; }
  }
  statisch = { cam: { ...cam }, S, W, H, obj, ampeln: obj.filter(o => o.typ === 'a'), fehlt: fehlt || !!(hoehen && hoehen.ok && hoehen.laden.size) };
}
// Hänge schattieren: 10-m-Zellen, Licht aus Nordwest; dunkle und helle Flächen halbtransparent
function schummerung(c, r, ox, oy) {
  if (!hoehen || !hoehen.ok) return;
  const Z = 10, x0 = Math.floor(r[0] / Z) * Z, y0 = Math.floor(r[1] / Z) * Z;
  const Lx = -1, Ly = -1, Lz = 1.6, Ll = Math.hypot(Lx, Ly, Lz), s0 = Lz / Ll; // Licht aus Nordwest (y nach Süden)
  for (let y = y0; y < r[3]; y += Z) for (let x = x0; x < r[2]; x += Z) {
    const a = hoehen.hoehe(x, y), b = hoehen.hoehe(x + Z, y), d = hoehen.hoehe(x, y + Z); if (a === null || b === null || d === null) continue;
    const gx = (b - a) / Z * EX * 1.5, gy = (d - a) / Z * EX * 1.5, nl = Math.hypot(gx, gy, 1), sh = (-gx * Lx - gy * Ly + Lz) / nl / Ll - s0;
    if (Math.abs(sh) < .01) continue;
    c.fillStyle = sh < 0 ? `rgba(14,24,38,${Math.min(.45, -sh * 1.6)})` : `rgba(255,246,214,${Math.min(.22, sh * 1.1)})`;
    const q = [P(x, y), P(x + Z, y), P(x + Z, y + Z), P(x, y + Z)];
    c.beginPath(); q.forEach((p, i) => i ? c.lineTo(p[0] + ox, p[1] + oy) : c.moveTo(p[0] + ox, p[1] + oy)); c.closePath(); c.fill();
  }
}
function gebBox(h) { const p = h.sattel ? ecken(h.r) : h.p; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const q of p) for (const z of [0, h.H + 4.5]) { const s = P(q[0], q[1], z); x0 = Math.min(x0, s[0]); x1 = Math.max(x1, s[0]); y0 = Math.min(y0, s[1]); y1 = Math.max(y1, s[1]); } return [x0, y0, x1, y1]; }
// Ampelmasten: an jeder Zufahrt rechts neben der Fahrbahn, 7 m vor dem Knoten
function ampeln(n, roads) {
  const out = [];
  for (const r of roads.values()) {
    if (!isRoad(r.m) || (r.a !== n.id && r.b !== n.id)) continue;
    const L = r.P.length, ende = r.b === n.id, q = ende ? r.P[L - 1] : r.P[0], q2 = ende ? r.P[Math.max(0, L - 2)] : r.P[Math.min(L - 1, 1)];
    const dx = q[0] - q2[0], dy = q[1] - q2[1], l = Math.hypot(dx, dy) || 1, hx = dx / l, hy = dy / l; // Fahrtrichtung zum Knoten
    const ab = Math.min(7, l * .9), off = r.m.cw + 1.2;
    const x = q[0] - hx * ab - hy * off, y = q[1] - hy * ab + hx * off;
    out.push({ typ: 'a', x, y, hx, hy, id: n.id, d: tiefe(x, y) });
  }
  return out;
}
function ampelZeichnen(c, a) {
  const p = P(a.x, a.y), h = 4.6 * S * HZ, f = live.ampelFarbe(a.id, a.hx, a.hy);
  c.fillStyle = '#2b2d30'; c.fillRect(Math.round(p[0]), Math.round(p[1] - h), Math.max(1, Math.round(S * .3)), Math.round(h));
  const kw = Math.max(2, Math.round(S * .7)), kh = Math.max(4, Math.round(S * 1.7)), kx = Math.round(p[0] - kw / 2 + .5), ky = Math.round(p[1] - h - kh * .2);
  c.fillStyle = '#1b1c1e'; c.fillRect(kx, ky, kw, kh);
  const lamp = (i, an, farbe) => { c.fillStyle = an ? farbe : '#3a3a3a'; c.fillRect(kx + Math.floor(kw / 4), ky + 1 + i * Math.floor((kh - 1) / 3), Math.max(1, kw - 2 * Math.floor(kw / 4)), Math.max(1, Math.floor((kh - 2) / 3))); };
  lamp(0, f === 'rot', '#ff3b2b'); lamp(1, f === 'gelb', '#ffc21a'); lamp(2, f === 'gruen', '#3cff6a');
}

/* ----------------------------- Fahrzeuge ----------------------------- */
function kiste(c, x, y, hx, hy, l, b, z0, z1, farbe, ox = 0, oy = 0) {
  const nx = -hy, ny = hx, k = [[x - hx * l / 2 - nx * b / 2, y - hy * l / 2 - ny * b / 2], [x + hx * l / 2 - nx * b / 2, y + hy * l / 2 - ny * b / 2], [x + hx * l / 2 + nx * b / 2, y + hy * l / 2 + ny * b / 2], [x - hx * l / 2 + nx * b / 2, y - hy * l / 2 + ny * b / 2]];
  const sx = x, sy = y;
  for (let i = 0; i < 4; i++) wand(c, k[i], k[(i + 1) % 4], z0, z1, farbe, false, sx, sy, ox, oy);
  c.fillStyle = hell(farbe, 1.18); poly(c, k, z1, ox, oy); c.fill();
}
function fahrzeug(c, g) {
  const q = at(g.e, g.s), hx = q[2] * g.dir, hy = q[3] * g.dir, off = live.versatz(g), x = q[0] - hy * off, y = q[1] + hx * off;
  gelFix = gel(x, y); try { fahrzeugInnen(c, g, x, y, hx, hy); } finally { gelFix = null; }
  return [x, y];
}
function fahrzeugInnen(c, g, x, y, hx, hy) {
  if (g.mode === 'auto') {
    const p = P(x, y); c.fillStyle = C.schatten; c.beginPath(); c.ellipse(p[0] + S * .4, p[1] + S * .2, S * 2.4, S * 1.1, 0, 0, Math.PI * 2); c.fill();
    kiste(c, x, y, hx, hy, 4.3, 1.8, .25, .95, g.farbe);
    kiste(c, x - hx * .25, y - hy * .25, hx, hy, 2.2, 1.6, .95, 1.45, '#2c3a4c');
    if (g.bremst) { const b = P(x - hx * 2.15, y - hy * 2.15, .7); c.fillStyle = '#ff3a2a'; c.fillRect(Math.round(b[0]) - 1, Math.round(b[1]), 2, 1); }
  } else {
    linie(c, [[x - hx * .85, y - hy * .85], [x + hx * .85, y + hy * .85]], 0, .12, '#1c211e', null, 0, 0);
    kiste(c, x, y, hx, hy, .5, .45, .9, 1.55, g.farbe);
    const k = P(x, y, 1.85); c.fillStyle = '#e8c39e'; c.fillRect(Math.round(k[0]) - 1, Math.round(k[1]) - 1, Math.max(2, Math.round(S * .45)), Math.max(2, Math.round(S * .45)));
  }
  return [x, y];
}

/* ----------------------------- Bild ----------------------------- */
export function zeichne(vctx, opt = {}) {
  if (!statisch || statisch.S !== S || statisch.cam.rot !== cam.rot || statisch.W !== W || statisch.H !== H) baueStatisch();
  // Verschiebung gegenüber der statischen Szene (ganze Pixel)
  const versatz = () => { const a = P(statisch.cam.x, statisch.cam.y); return [Math.round(a[0] - W / 2), Math.round(a[1] - H / 2)]; };
  let [ou, ov] = versatz();
  if (Math.abs(ou) > MARGE * .8 || Math.abs(ov) > MARGE * .8 || (statisch.fehlt && !store.active && !store.queue.length && !(hoehen && hoehen.laden.size))) { baueStatisch(); [ou, ov] = versatz(); }
  lctx.imageSmoothingEnabled = false;
  lctx.drawImage(st, -MARGE + ou, -MARGE + ov);
  // Ampeln und Fahrzeuge über der Szene; davorliegende Gebäude/Bäume darüber neu
  const fz = [];
  if (opt.live) for (const g of live.agents) { const q = at(g.e, g.s); fz.push({ g, d: tiefe(q[0], q[1]) }); }
  for (const a of statisch.ampeln) fz.push({ a, d: a.d });
  fz.sort((a, b) => a.d - b.d);
  const neu = new Set();
  for (const f of fz) {
    let px, py;
    if (f.g) { const [x, y] = fahrzeug(lctx, f.g); [px, py] = P(x, y); } else { ampelZeichnen(lctx, f.a); [px, py] = P(f.a.x, f.a.y); }
    px -= ou; py -= ov; // in Koordinaten der statischen Szene
    for (const o of statisch.obj) if (o.d > f.d + 1 && o.bb && px > o.bb[0] - 6 && px < o.bb[2] + 6 && py > o.bb[1] - 6 && py < o.bb[3] + 8) neu.add(o);
  }
  if (neu.size) for (const o of [...neu].sort((a, b) => a.d - b.d)) o.typ === 'h' ? gebaeude(lctx, o.o, 0, 0) : o.typ === 'l' ? laterne(lctx, o.o, 0, 0) : baum(lctx, o.o, 0, 0);
  if (opt.marker) marker(lctx, opt.marker);
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.imageSmoothingEnabled = false;
  vctx.drawImage(lo, 0, 0, W * PX * dpr(), H * PX * dpr());
  return statisch.fehlt;
}
const dpr = () => window.devicePixelRatio || 1;

/* ----------------------------- Markierungen (Auswahl, Werkzeuge) ----------------------------- */
// { P: Polylinie, breite (m), farbe, strich } oder { x, y, r (m), farbe, fill }
function marker(c, liste) {
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (const m of liste) {
    if (m.P) { linie(c, m.P, 0, Math.max(m.breite, 3 / S), m.farbe, m.strich, 0, 0); continue; }
    const p = P(m.x, m.y), rx = Math.max(m.r * S * 1.414, 6), ry = rx / 2;
    c.beginPath(); c.ellipse(p[0], p[1], rx, ry, 0, 0, Math.PI * 2);
    if (m.fill) { c.fillStyle = m.fill; c.fill(); } c.lineWidth = 1.5; c.strokeStyle = m.farbe; c.stroke();
  }
}

/* ----------------------------- Schnittstelle ----------------------------- */
export function init(d) { man = d.man; store = d.store; spiel = d.spiel; live = d.live; hoehen = d.hoehen || null; }
export function groesse(cssW, cssH) { W = Math.ceil(cssW / PX); H = Math.ceil(cssH / PX); lo.width = W; lo.height = H; statisch = null; }
export function ungueltig() { statisch = null; }
export function setzeMitte(x, y) { cam.x = x; cam.y = y; }
export const pxProM = () => S * PX;                       // Bildschirmpunkte je Meter
export const zoomStufe = () => cam.zi;
export function zoom(d) { const z = cam.zi + d; if (z < 0) return false; cam.zi = Math.min(ZOOMS.length - 1, z); S = ZOOMS[cam.zi]; baumCache.clear(); statisch = null; return true; }
export function setzeZoom(i) { cam.zi = Math.max(0, Math.min(ZOOMS.length - 1, i)); S = ZOOMS[cam.zi]; baumCache.clear(); statisch = null; }
export function drehen(d) { cam.rot = (cam.rot + d + 4) % 4; statisch = null; }
export function haeuserZeigen(an) { haeuser = an; statisch = null; }
// Bildschirmpunkt (CSS-Pixel) -> Welt
export function weltVon(cssX, cssY) {
  const px = cssX / PX, py = cssY / PX; let q = welt(px, py);
  for (let i = 0; i < 4; i++) q = welt(px, py + gel(q[0], q[1]) * S * HZ);
  return q;
}
// Verschieben um CSS-Pixel
export function verschiebe(dx, dy) {
  const a = dx / PX / S, b = dy / PX * 2 / S, du = -(a + b) / 2, dv = -(b - a) / 2;
  const k = { 0: [du, dv], 1: [-dv, du], 2: [-du, -dv], 3: [dv, -du] }[cam.rot];
  cam.x += k[0]; cam.y += k[1];
}
export { sichtbereich };
export const blick = () => ['Nord', 'Ost', 'Süd', 'West'][cam.rot];
