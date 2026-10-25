// Zeichnen im Pixel-Stil: Musterkacheln, Flächen, Straßen-Querschnitte, Gebäude.
import { isRoad } from './tiles.js';

const TAU = Math.PI * 2;
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export const hashStr = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

/* ----------------------------- Musterkacheln (1 Musterpixel = 0,5 m) ----------------------------- */
export const PAT = {};
function mk(w, h, fn) { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const c = cv.getContext('2d'); fn(c, mulberry32(w * 31 + h * 7 + Object.keys(PAT).length)); return cv; }
const px = (c, x, y, w, h, col) => { c.fillStyle = col; c.fillRect(x, y, w, h); };
const speck = (c, r, w, h, n, cols) => { for (let i = 0; i < n; i++) px(c, r() * w | 0, r() * h | 0, 1, 1, cols[r() * cols.length | 0]); };
const bricks = (base, cols) => (c, r) => { px(c, 0, 0, 16, 16, base); for (let y = 0; y < 16; y += 2) for (let x = 0; x < 16; x += 4) { const o = (y / 2) % 2 ? 2 : 0; px(c, (x + o) % 16, y, 3, 1, cols[r() * cols.length | 0]); } };
export function buildPatterns() {
  PAT.asphalt = mk(32, 32, (c, r) => { px(c, 0, 0, 32, 32, '#4b4d53'); speck(c, r, 32, 32, 80, ['#55575e', '#424449', '#5c5e64']); });
  PAT.paving_stones = mk(16, 16, bricks('#8e8a82', ['#a29e95', '#9a968d', '#aaa69c']));
  PAT.paving_red = mk(16, 16, bricks('#8a3c2d', ['#b0503c', '#a64a37', '#b85a45']));
  PAT.sett = mk(12, 12, (c, r) => { px(c, 0, 0, 12, 12, '#5b5a57'); for (let y = 0; y < 12; y += 3) for (let x = 0; x < 12; x += 3) { const o = (y / 3) % 2 ? 1 : 0; px(c, (x + o) % 12, y, 2, 2, ['#8a8780', '#7d7a73', '#96938b'][r() * 3 | 0]); } });
  PAT.concrete = mk(24, 24, (c, r) => { px(c, 0, 0, 24, 24, '#9c9a94'); speck(c, r, 24, 24, 40, ['#a7a59f', '#93918b']); px(c, 0, 0, 24, 1, '#86847e'); px(c, 0, 0, 1, 24, '#86847e'); });
  PAT.compacted = mk(24, 24, (c, r) => { px(c, 0, 0, 24, 24, '#c7b287'); speck(c, r, 24, 24, 90, ['#d3bf95', '#b9a479', '#c2ad82', '#ad986d']); });
  PAT.gravel = mk(24, 24, (c, r) => { px(c, 0, 0, 24, 24, '#a9a293'); speck(c, r, 24, 24, 120, ['#bdb6a7', '#948d7e', '#cfc8b8']); });
  PAT.ground = mk(24, 24, (c, r) => { px(c, 0, 0, 24, 24, '#9a7b55'); speck(c, r, 24, 24, 90, ['#a88a62', '#8a6c48', '#7f9a4d']); });
  PAT.sand = mk(24, 24, (c, r) => { px(c, 0, 0, 24, 24, '#d9c69a'); speck(c, r, 24, 24, 70, ['#e6d6ae', '#c9b586']); });
  PAT.grass_s = mk(16, 16, (c, r) => { px(c, 0, 0, 16, 16, '#7ca552'); speck(c, r, 16, 16, 30, ['#6c9446', '#8cb862']); });
  PAT.sidewalk = mk(12, 12, (c) => { px(c, 0, 0, 12, 12, '#bdb8ab'); px(c, 0, 0, 12, 1, '#b0ab9d'); px(c, 0, 0, 1, 12, '#b0ab9d'); px(c, 0, 6, 12, 1, '#b5b0a3'); px(c, 6, 0, 1, 12, '#b5b0a3'); });
  PAT.redasph = mk(24, 24, (c, r) => { px(c, 0, 0, 24, 24, '#a9533f'); speck(c, r, 24, 24, 50, ['#b45d48', '#9b4a37']); });
  PAT.wood = mk(8, 8, (c) => { px(c, 0, 0, 8, 8, '#8a6a45'); px(c, 0, 0, 8, 1, '#6e5233'); });
  PAT.grass = mk(32, 32, (c, r) => { px(c, 0, 0, 32, 32, '#6aa64f'); speck(c, r, 32, 32, 70, ['#5d9846', '#78b35b']); });
  PAT.res = mk(32, 32, (c, r) => { px(c, 0, 0, 32, 32, '#79ad5a'); speck(c, r, 32, 32, 60, ['#6f9f50', '#86b966', '#91bf70']); });
  PAT.meadow = mk(32, 32, (c, r) => { px(c, 0, 0, 32, 32, '#88b45c'); speck(c, r, 32, 32, 70, ['#7aa551', '#97c26a', '#e8dc6a']); });
  PAT.farm = mk(32, 32, (c, r) => { px(c, 0, 0, 32, 32, '#c4b06a'); for (let k = 1; k < 32; k += 4) px(c, 0, k, 32, 1, '#ab9853'); speck(c, r, 32, 32, 20, ['#d4c27e']); });
  PAT.heath = mk(32, 32, (c, r) => { px(c, 0, 0, 32, 32, '#8e8f5c'); speck(c, r, 32, 32, 120, ['#9a7a8e', '#7e8150', '#a8a36a', '#8a6a80']); });
  PAT.scrub = mk(32, 32, (c, r) => { px(c, 0, 0, 32, 32, '#6f9a4c'); for (let i = 0; i < 10; i++) { const x = r() * 29 | 0, y = r() * 29 | 0; px(c, x, y, 3, 3, '#4f7e3a'); px(c, x, y, 2, 1, '#6da552'); } });
  PAT.forest = mk(48, 48, (c, r) => { px(c, 0, 0, 48, 48, '#2f5f2c');
    for (let i = 0; i < 14; i++) { const cx = r() * 48 | 0, cy = r() * 48 | 0, rad = 4 + (r() * 4 | 0);
      for (let y = -rad; y <= rad; y++) for (let x = -rad; x <= rad; x++) { if (x * x + y * y > rad * rad) continue; const sh = (x + y) / rad; px(c, (cx + x + 48) % 48, (cy + y + 48) % 48, 1, 1, sh < -.5 ? '#5aa04a' : sh > .5 ? '#1f4a22' : '#3a7c37'); } } });
  PAT.military = mk(32, 32, (c, r) => { px(c, 0, 0, 32, 32, '#8c9a6a'); speck(c, r, 32, 32, 80, ['#7f8d5f', '#99a676', '#a89a6c']); });
  PAT.industrial = mk(32, 32, (c, r) => { px(c, 0, 0, 32, 32, '#a39e93'); speck(c, r, 32, 32, 40, ['#99948a', '#aca79c']); });
  PAT.parking = mk(20, 20, (c, r) => { px(c, 0, 0, 20, 20, '#5a5c62'); speck(c, r, 20, 20, 20, ['#64666c', '#505257']); px(c, 0, 0, 1, 10, '#c8c6bf'); });
  PAT.pitch = mk(16, 16, (c) => { px(c, 0, 0, 16, 16, '#58a24a'); px(c, 0, 0, 16, 8, '#62ad52'); });
  PAT.wetland = mk(24, 24, (c, r) => { px(c, 0, 0, 24, 24, '#6f9a6c'); speck(c, r, 24, 24, 40, ['#5f8aa0', '#7aa877', '#567f52']); });
  PAT.water = mk(32, 32, (c, r) => { px(c, 0, 0, 32, 32, '#3a79bd'); for (let i = 0; i < 8; i++) px(c, r() * 28 | 0, r() * 30 | 0, 4, 1, '#6aa6e0'); });
  PAT.cemetery = mk(16, 16, (c) => { px(c, 0, 0, 16, 16, '#6f9e58'); for (let y = 2; y < 16; y += 6) for (let x = 2; x < 16; x += 5) px(c, x, y, 2, 3, '#a7a49c'); });
  PAT.track = mk(16, 16, (c, r) => { px(c, 0, 0, 16, 16, '#b8553f'); speck(c, r, 16, 16, 20, ['#c4614a', '#a84a36']); });
}
// Vollfarben für grobe Stufen (Muster würden dort flimmern)
const SOLID = { asphalt: '#4b4d53', paving_stones: '#9a968d', paving_red: '#a64a37', sett: '#7d7a73', concrete: '#9c9a94', compacted: '#c7b287',
  gravel: '#a9a293', ground: '#9a7b55', sand: '#d9c69a', grass_s: '#7ca552', sidewalk: '#bdb8ab', redasph: '#a9533f', wood: '#8a6a45',
  grass: '#6aa64f', res: '#7fae5f', meadow: '#88b45c', farm: '#c4b06a', heath: '#8e8f5c', scrub: '#6f9a4c', forest: '#2f5f2c', military: '#8c9a6a',
  industrial: '#a39e93', parking: '#5a5c62', pitch: '#58a24a', wetland: '#6f9a6c', water: '#3a79bd', cemetery: '#6f9e58', track: '#b8553f' };

export const AREA_PAT = { wohngebiet: 'res', wald: 'forest', wiese: 'meadow', park: 'meadow', garten: 'meadow', kleingarten: 'meadow', obstwiese: 'meadow',
  spielplatz: 'meadow', acker: 'farm', militaer: 'military', gewerbe: 'industrial', hof: 'industrial', bahn: 'industrial', baustelle: 'industrial',
  brache: 'industrial', friedhof: 'cemetery', abbau: 'sand', sand: 'sand', heide: 'heath', gebuesch: 'scrub', wasser: 'water', feuchtgebiet: 'wetland',
  fels: 'gravel', schule: 'res', parkplatz: 'parking', sportanlage: 'industrial', sportplatz: 'pitch', laufbahn: 'track' };

export function surfPat(s, red) {
  switch (s) {
    case 'paving_stones': case 'paved': return red ? 'paving_red' : 'paving_stones';
    case 'sett': case 'cobblestone': return 'sett';
    case 'concrete': case 'concrete_plates': case 'metal': return 'concrete';
    case 'compacted': case 'fine_gravel': return 'compacted';
    case 'gravel': case 'unpaved': return 'gravel';
    case 'ground': return 'ground';
    case 'sand': return 'sand';
    case 'grass': case 'grass_paver': return 'grass_s';
    case 'wood': return 'wood';
    default: return red ? 'redasph' : 'asphalt';
  }
}

/* ----------------------------- Geometrie ----------------------------- */
// Versatz positiv = rechts in Zeichenrichtung (Bildschirm, y nach unten)
export function offsetLine(P, off) {
  if (!off) return P; const out = new Array(P.length);
  for (let i = 0; i < P.length; i++) {
    const a = P[Math.max(0, i - 1)], b = P[i], c = P[Math.min(P.length - 1, i + 1)];
    let n1x = 0, n1y = 0, n2x = 0, n2y = 0;
    if (i > 0) { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; n1x = -dy / l; n1y = dx / l; }
    if (i < P.length - 1) { const dx = c[0] - b[0], dy = c[1] - b[1], l = Math.hypot(dx, dy) || 1; n2x = -dy / l; n2y = dx / l; }
    if (i === 0) { n1x = n2x; n1y = n2y; } if (i === P.length - 1) { n2x = n1x; n2y = n1y; }
    let nx = n1x + n2x, ny = n1y + n2y; const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
    const sc = clamp(1 / Math.max(nx * n1x + ny * n1y, .35), 1, 2.5);
    out[i] = [b[0] + nx * off * sc, b[1] + ny * off * sc];
  }
  return out;
}
export function trace(c, P) { c.beginPath(); c.moveTo(P[0][0], P[0][1]); for (let i = 1; i < P.length; i++) c.lineTo(P[i][0], P[i][1]); }
export function stroke(c, P, w, style, dash) { if (P.length < 2) return; c.lineWidth = w; c.strokeStyle = style; if (dash) c.setLineDash(dash); trace(c, P); c.stroke(); if (dash) c.setLineDash([]); }
function band(c, r, d0, d1, style, side) { if (d1 <= d0) return; stroke(c, offsetLine(r.P, side * (d0 + d1) / 2), d1 - d0, style); }
function rings(c, R) { c.beginPath(); for (const ring of R) { c.moveTo(ring[0][0], ring[0][1]); for (let i = 1; i < ring.length; i++) c.lineTo(ring[i][0], ring[i][1]); c.closePath(); } }

/* ----------------------------- Spielwerte aus dem Modell ----------------------------- */
const SURF_COMFORT = { asphalt: 1, concrete: .88, concrete_plates: .75, paving_stones: .78, paved: .85, sett: .42, cobblestone: .35, compacted: .72,
  fine_gravel: .7, gravel: .5, ground: .43, sand: .22, grass: .3, grass_paver: .35, wood: .7, metal: .8, unpaved: .5 };
export const comfortOf = (s, c) => (SURF_COMFORT[s] ?? .7) * (.45 + .55 * c / 100);
export function bikeValues(m) {
  const road = isRoad(m), fac = Math.max(m.fac_l || 0, m.fac_r || 0), ms = m.ms || 30;
  const rideSurf = fac === 3 ? m.tsurf : m.surf, rideCond = fac === 3 ? m.tcond : m.cond;
  const allowed = m.bike !== 0, sidepath = m.bike === 2 && road;
  let risk;
  if (!allowed) risk = 0;
  else if (m.frs) risk = .14;
  else if (!road) risk = .04;
  else if (fac === 3) risk = ms <= 30 ? .15 : .22;
  else if (fac === 2) risk = ms <= 30 ? .16 : .32;
  else if (fac === 1) risk = ms <= 30 ? .22 : .45;
  else if (m.cls === 'spiel') risk = .1;
  else if (m.cls === 'zufahrt') risk = .12;
  else { risk = ms <= 30 ? .42 : ms <= 50 ? 1 : 1.2; if (m.cls === 'wohn') risk *= .85; }
  risk += (1 - (rideCond ?? 60) / 100) * .12;
  return { risk, comfort: comfortOf(rideSurf, rideCond ?? 60), rideSurf, rideCond: rideCond ?? 60, allowed, sidepath, use: allowed && !sidepath };
}
export const condColor = v => v >= 80 ? '#3fae4a' : v >= 65 ? '#9cc23e' : v >= 50 ? '#e2c43a' : v >= 35 ? '#e48a34' : '#d8452f';
export const riskColor = r => r < .2 ? '#3fae4a' : r < .35 ? '#9cc23e' : r < .5 ? '#e2c43a' : r < .75 ? '#e48a34' : '#d8452f';

/* ----------------------------- Chunk zeichnen ----------------------------- */
const ROOFS = [['#c3593e', '#a14531', '#7a3324'], ['#a94c36', '#873b2a', '#5e2a1f'], ['#60666f', '#4b5058', '#363a41'], ['#8c5b3d', '#70472f', '#503222'], ['#bb6b4b', '#97563c', '#6d3e2b'], ['#7b4f44', '#634037', '#462c26']];
const FLAT = new Set(['garage', 'garages', 'industrial', 'commercial', 'retail', 'warehouse', 'carport', 'roof', 'school', 'sports_centre', 'sports_hall', 'public', 'service', 'kindergarten', 'apartments', 'fire_station', 'silo', 'farm_auxiliary', 'barn', 'hospital', 'office', 'university']);

export class Painter {
  constructor(c, res) {
    this.c = c; this.res = res; this.fine = res >= 1;
    this.pc = new Map();
  }
  fill(name) {
    if (!this.fine) return SOLID[name] || '#6aa64f';
    let p = this.pc.get(name);
    if (!p) { p = this.c.createPattern(PAT[name] || PAT.asphalt, 'repeat'); p.setTransform(new DOMMatrix().scale(.5)); this.pc.set(name, p); }
    return p;
  }
  // Ganze Szene eines Rechtecks (Weltkoordinaten) aus einer oder mehreren Kacheln
  scene(rect, tiles, extraBuildings) {
    const c = this.c, [x0, y0, x1, y1] = rect;
    c.save(); c.beginPath(); c.rect(x0, y0, x1 - x0, y1 - y0); c.clip();
    c.fillStyle = this.fill('grass'); c.fillRect(x0, y0, x1 - x0, y1 - y0);
    const vis = o => !(o.bb[2] < x0 || o.bb[0] > x1 || o.bb[3] < y0 || o.bb[1] > y1);
    for (const t of tiles) for (const a of t.areas) {
      const pat = AREA_PAT[a.k]; if (!pat) continue;
      rings(c, a.rings); c.fillStyle = this.fill(pat); c.fill('evenodd');
      if (a.k === 'sportplatz' && this.fine) { c.lineWidth = .3; c.strokeStyle = 'rgba(255,255,255,.7)'; c.stroke(); }
    }
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (const t of tiles) for (const l of t.lines) {
      if (l.k.startsWith('w:')) stroke(c, l.P, l.k === 'w:river' ? 12 : l.k === 'w:canal' ? 10 : l.k === 'w:stream' ? 1.8 : 1.1, '#4b8bd0');
      else if (l.k === 'r:rail') { stroke(c, l.P, 3.2, '#8a8477'); if (this.fine) { stroke(c, l.P, 1.6, '#5d4838', [.4, .6]); stroke(c, l.P, .25, '#c3c7cc'); } }
      else if (l.k.startsWith('r:')) stroke(c, l.P, 1.4, '#9a958a', [3, 2]);
    }
    const roads = [];
    for (const t of tiles) for (const r of t.roads) if (vis({ bb: [r.bb[0] - r.half, r.bb[1] - r.half, r.bb[2] + r.half, r.bb[3] + r.half] })) roads.push(r);
    this.roads(roads);
    if (this.fine) for (const t of tiles) this.nodes(t.nodes);
    const bs = [];
    for (const t of tiles) for (const b of t.buildings) bs.push(b);
    if (extraBuildings) for (const b of extraBuildings) if (vis(b)) bs.push(b);
    for (const b of bs) this.building(b);
    c.restore();
  }
  roads(R) {
    const c = this.c, fine = this.fine, minW = 1.2 / this.res;
    const W = w => Math.max(w, minW);
    // 1) Seitenraum: Gehwege, Hochbord-Radwege
    if (fine) for (const r of R) { const m = r.m; if (!isRoad(m)) continue;
      for (const sd of [1, -1]) { const sw = sd > 0 ? m.sw_r : m.sw_l, fac = sd > 0 ? m.fac_r : m.fac_l; let d = m.cw;
        if (fac === 3) { band(c, r, d, d + .3, '#8d887c', sd); band(c, r, d + .3, d + 1.9, this.fill(surfPat(m.tsurf, true)), sd); d += 2.1; }
        if (sw) band(c, r, d, d + sw, this.fill('sidewalk'), sd); } }
    else for (const r of R) { const m = r.m; if (!isRoad(m)) continue; const h = r.half; if (h > m.cw) stroke(c, r.P, W(h * 2), SOLID.sidewalk); }
    // 2) Wege
    for (const r of R) { const m = r.m; if (isRoad(m)) continue;
      const red = m.cls === 'rad';
      const pat = red ? (m.surf === 'asphalt' ? 'redasph' : surfPat(m.surf, true)) : surfPat(m.surf, false);
      if (fine) stroke(c, r.P, m.cw * 2 + .5, red ? '#7d3a2b' : 'rgba(60,50,35,.45)');
      stroke(c, r.P, W(m.cw * 2), this.fill(pat));
      if (fine && m.cls === 'treppe') stroke(c, r.P, m.cw * 2, 'rgba(0,0,0,.35)', [.3, .4]);
      if (fine && this.res >= 2) defects(c, r, r.P, m.cw, m.cond, red, 3);
    }
    // 3) Bordstein + Fahrbahn (nach Klassen, Hauptstraßen zuletzt)
    if (fine) for (const r of R) { const m = r.m; if (isRoad(m)) stroke(c, r.P, m.cw * 2 + .5, m.cls === 'spiel' ? '#8e8a82' : '#8d887c'); }
    for (const r of R) { const m = r.m; if (!isRoad(m)) continue;
      const col = !fine && (m.cls === 'L' || m.cls === 'auto') ? '#e9c25a' : this.fill(surfPat(m.surf, m.cls === 'spiel' && m.surf !== 'asphalt'));
      stroke(c, r.P, W(m.cw * 2), col); }
    if (!fine) return;
    // 4) Markierungen
    for (const r of R) { const m = r.m; if (!isRoad(m)) continue;
      if ((m.cls === 'L' || m.cls === 'dorf' || m.cls === 'auto') && !m.oneway && m.cw >= 2.75 && m.surf === 'asphalt') stroke(c, r.P, .15, '#e9e6dc', m.cls === 'dorf' ? [2, 4] : [3, 3]);
      for (const sd of [1, -1]) { const fac = sd > 0 ? m.fac_r : m.fac_l;
        if (fac === 1 || fac === 2) stroke(c, offsetLine(r.P, sd * (m.cw - 1.6)), .25, '#e9e6dc', fac === 1 ? [1, 1] : null); }
      if (m.frs) stroke(c, r.P, .5, '#2f6cbf', [1, 6]);
    }
    // 5) Schäden
    if (this.res >= 2) for (const r of R) { const m = r.m; if (!isRoad(m)) continue;
      defects(c, r, r.P, m.cw, m.cond, false, 1);
      if (m.tcond !== undefined) for (const sd of [1, -1]) { const fac = sd > 0 ? m.fac_r : m.fac_l; if (fac === 3) defects(c, r, offsetLine(r.P, sd * (m.cw + 1.1)), .8, m.tcond, true, sd > 0 ? 5 : 6); } }
  }
  nodes(N) {
    const c = this.c;
    for (const n of N) {
      if (n.f === 'crossing' || n.f === 'traffic_signals') {
        const L = n.cw || 3;
        c.save(); c.translate(n.x, n.y); c.rotate(n.dir); for (let k = -L + .3; k < L; k += .9) { c.fillStyle = '#ebe8de'; c.fillRect(k, -1.5, .5, 3); } c.restore();
        if (n.f === 'traffic_signals') { c.fillStyle = '#16181b'; c.fillRect(n.x + Math.cos(n.dir + Math.PI / 2) * (L + .8) - .5, n.y + Math.sin(n.dir + Math.PI / 2) * (L + .8) - .5, 1, 1); }
      } else if (n.f === 'mini_roundabout') { c.fillStyle = '#d4d0c4'; c.beginPath(); c.arc(n.x, n.y, 2, 0, TAU); c.fill(); c.fillStyle = '#e9e6dc'; c.beginPath(); c.arc(n.x, n.y, 1.5, 0, TAU); c.fill(); }
      else if (n.f === 'bollard' || n.f === 'cycle_barrier') { c.fillStyle = '#f2efe6'; c.fillRect(n.x - .3, n.y - .3, .6, .6); c.fillStyle = '#c8463a'; c.fillRect(n.x - .3, n.y, .6, .3); }
    }
  }
  building(b) {
    const c = this.c, ring = b.P, h = hashStr(b.t + ring[0][0].toFixed(1) + ring[0][1].toFixed(1));
    const flat = FLAT.has(b.t);
    const pal = b.t === 'church' || b.t === 'chapel' ? ['#575b67', '#3c3f48', '#2c2f36'] : ROOFS[(h * ROOFS.length) | 0];
    const path = () => { c.beginPath(); c.moveTo(ring[0][0], ring[0][1]); for (let i = 1; i < ring.length; i++) c.lineTo(ring[i][0], ring[i][1]); c.closePath(); };
    if (!this.fine) { path(); c.fillStyle = flat ? '#8b9198' : pal[0]; c.fill(); return; }
    c.save(); c.translate(1.2, 1.2); path(); c.fillStyle = 'rgba(20,35,20,.35)'; c.fill(); c.restore();
    path();
    if (flat) {
      c.fillStyle = b.t === 'school' || b.t === 'kindergarten' ? '#c4783c' : (b.t === 'garage' || b.t === 'garages' || b.t === 'carport') ? '#8f9297' : b.t === 'apartments' ? '#9a6b56' : b.t === 'barn' || b.t === 'farm_auxiliary' ? '#8a6d55' : '#8b9198';
      c.fill(); c.lineWidth = .6; c.strokeStyle = 'rgba(0,0,0,.35)'; c.stroke(); return;
    }
    c.fillStyle = pal[0]; c.fill();
    let best = 0, ax = 1, ay = 0;
    for (let i = 1; i < ring.length; i++) { const dx = ring[i][0] - ring[i - 1][0], dy = ring[i][1] - ring[i - 1][1], l = Math.hypot(dx, dy); if (l > best) { best = l; ax = dx / l; ay = dy / l; } }
    let cx = 0, cy = 0; for (let i = 0; i < ring.length - 1; i++) { cx += ring[i][0]; cy += ring[i][1]; } cx /= Math.max(1, ring.length - 1); cy /= Math.max(1, ring.length - 1);
    const nx = -ay, ny = ax;
    c.save(); path(); c.clip();
    c.fillStyle = pal[1]; c.beginPath(); c.moveTo(cx + ax * 80, cy + ay * 80); c.lineTo(cx - ax * 80, cy - ay * 80); c.lineTo(cx - ax * 80 + nx * 80, cy - ay * 80 + ny * 80); c.lineTo(cx + ax * 80 + nx * 80, cy + ay * 80 + ny * 80); c.closePath(); c.fill();
    c.strokeStyle = pal[2]; c.lineWidth = .6; c.beginPath(); c.moveTo(cx - ax * best * .42, cy - ay * best * .42); c.lineTo(cx + ax * best * .42, cy + ay * best * .42); c.stroke();
    if (h < .2) { c.fillStyle = '#26344d'; c.save(); c.translate(cx - nx * 2.2, cy - ny * 2.2); c.rotate(Math.atan2(ay, ax)); c.fillRect(-best * .25, -1.2, best * .5, 2.4); c.restore(); }
    c.restore();
    path(); c.lineWidth = .5; c.strokeStyle = pal[2]; c.stroke();
  }
}
function defects(c, r, P, half, cond, red, salt) {
  if (cond >= 85 || half < .6) return;
  const R = mulberry32((hashStr(r.id) * 1e9 | 0) + salt);
  let acc = 0; const step = Math.max(3, cond / 4);
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (!L) continue;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    for (acc += L; acc > step; acc -= step) {
      const f = 1 - (acc - step) / L; if (f < 0 || f > 1) continue;
      const x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f, w = (R() * 2 - 1) * (half - .5), X = x - uy * w, Y = y + ux * w, kind = R();
      if (cond < 35 && kind < .4) { c.fillStyle = red ? '#3a1a14' : '#1f2023'; c.beginPath(); c.ellipse(X, Y, .6 + R() * .5, .45 + R() * .3, 0, 0, TAU); c.fill(); }
      else if (cond < 55 && kind < .7) { c.fillStyle = red ? 'rgba(60,25,15,.55)' : '#3b3d42'; c.fillRect(X - 1, Y - .6, 2 + R() * 1.5, 1.2); }
      else { c.strokeStyle = red ? '#5a2418' : '#2a2c30'; c.lineWidth = .3; c.beginPath(); c.moveTo(X, Y); let qx = X, qy = Y; for (let k = 0; k < 4; k++) { qx += ux * .6 + (R() - .5) * .6; qy += uy * .6 + (R() - .5) * .6; c.lineTo(qx, qy); } c.stroke(); }
    }
  }
}

/* ----------------------------- Querschnitt fürs Info-Panel ----------------------------- */
const fmt = (v, d) => v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
export function drawCrossSection(cv, m) {
  const rect = cv.getBoundingClientRect(), dp = window.devicePixelRatio || 1;
  cv.width = Math.round(rect.width * dp); cv.height = Math.round(rect.height * dp);
  const c = cv.getContext('2d'); c.clearRect(0, 0, cv.width, cv.height);
  const Z = [];
  const side = sd => { const out = []; const fac = sd > 0 ? m.fac_r : m.fac_l, sw = sd > 0 ? m.sw_r : m.sw_l;
    if (fac === 3) out.push([.3, '#8d887c', ''], [1.6, surfPat(m.tsurf, true), 'Rad 1,6']);
    if (sw) out.push([sw, 'sidewalk', 'Geh ' + fmt(sw, 1)]); return out; };
  if (isRoad(m)) {
    const fl = m.fac_l === 1 || m.fac_l === 2, fr = m.fac_r === 1 || m.fac_r === 2;
    Z.push(...side(-1).reverse());
    if (fl) Z.push([1.6, 'lane', 'Rad 1,6']);
    Z.push([m.cw - (fl ? 1.6 : 0), surfPat(m.surf, false), 'Fahrbahn ' + fmt(m.cw - (fl ? 1.6 : 0), 2), 'mid']);
    Z.push([m.cw - (fr ? 1.6 : 0), surfPat(m.surf, false), m.oneway ? '' : 'Fahrbahn ' + fmt(m.cw - (fr ? 1.6 : 0), 2)]);
    if (fr) Z.push([1.6, 'lane', 'Rad 1,6']);
    Z.push(...side(1));
  } else Z.push([1.2, 'grass', ''], [m.cw * 2, surfPat(m.surf, m.cls === 'rad'), fmt(m.cw * 2, 1) + ' m'], [1.2, 'grass', '']);
  const tot = Z.reduce((a, z) => a + z[0], 0), sc = (cv.width - 8 * dp) / Math.max(tot, 4), top = 6 * dp, hh = cv.height - 40 * dp;
  let x = 4 * dp + (cv.width - 8 * dp - tot * sc) / 2, mid = null; const labels = [];
  for (const z of Z) {
    const w = z[0] * sc;
    if (z[1] === 'lane') c.fillStyle = '#5e5152';
    else if (PAT[z[1]]) { const p = c.createPattern(PAT[z[1]], 'repeat'); p.setTransform(new DOMMatrix().scale(dp * 1.5)); c.fillStyle = p; }
    else c.fillStyle = z[1];
    const raised = ['sidewalk', 'paving_red', 'redasph', '#8d887c', 'grass'].includes(z[1]);
    c.fillRect(x, top + (raised ? 0 : 4 * dp), w, hh - (raised ? 0 : 4 * dp));
    if (z[2]) labels.push([x + w / 2, z[2]]);
    x += w; if (z[3] === 'mid') mid = x;
  }
  if (mid !== null) {
    if (!m.oneway) { c.fillStyle = '#e9e6dc'; c.fillRect(mid - dp, top + hh * .3, 2 * dp, hh * .4); }
    c.fillStyle = 'rgba(255,255,255,.85)'; c.font = `${14 * dp}px VT323, monospace`; c.textAlign = 'center';
    if (m.oneway) c.fillText('▲', mid, top + hh * .6); else { c.fillText('▼', mid - m.cw * sc / 2, top + hh * .6); c.fillText('▲', mid + m.cw * sc / 2, top + hh * .6); }
  }
  c.fillStyle = '#5a5f57'; c.fillRect(0, top + hh, cv.width, dp);
  c.font = `${10 * dp}px "Pixelify Sans", sans-serif`; c.textAlign = 'center'; c.strokeStyle = '#8a836f';
  labels.forEach((l, i) => { const y = top + hh + (i % 2 ? 26 : 13) * dp; c.beginPath(); c.moveTo(l[0], top + hh); c.lineTo(l[0], y - 9 * dp); c.stroke(); c.fillStyle = '#5a5f57'; c.fillText(l[1], clamp(l[0], 24 * dp, cv.width - 24 * dp), y); });
}
