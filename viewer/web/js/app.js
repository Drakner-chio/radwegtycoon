// Radweg Tycoon – Kachel-Viewer: Kamera, Detailstufen, Raster-Cache, Auswahl, Overlays.
import { TileStore, isRoad } from './tiles.js';
import { Spiel, AUSBAU, KNOTEN, gesamt, wendeAn, strassenzug } from './game.js';
import { lokalesNetz, pfad, knotenInfo, naechsteKreuzung } from './werkzeug.js';
import { Verkehr } from './verkehr.js';
import { Live } from './live.js';
import { Hoehen } from './hoehe.js';
import * as Iso from './isoansicht.js';
import { Painter, buildPatterns, hashStr, stroke, offsetLine, bikeValues, condColor, riskColor, drawCrossSection, clamp } from './render.js';

const $ = id => document.getElementById(id);
const fmt = (v, d = 0) => Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/* ----------------------------- Detailstufen -----------------------------
   Jede Stufe zeichnet Chunks (UTM-ausgerichtete Quadrate) in einer festen Auflösung vor.
   minZ = ab welchem Zoom (CSS-Pixel pro Meter) die Stufe die Hauptstufe ist. */
const LEVELS = [
  { name: 'fern', lod: 2, chunk: 32000, res: 0.016, minZ: 0 },
  { name: 'überblick', lod: 1, chunk: 8000, res: 0.0625, minZ: 0.035 },
  { name: 'ort', lod: 0, chunk: 1000, res: 0.5, minZ: 0.22 },
  { name: 'detail', lod: 0, chunk: 250, res: 2, minZ: 0.9 },
];
const MAX_CHUNKS = 220;

const params = new URLSearchParams(location.search);
const region = params.get('region') || 'lippe';
const base = params.get('karte') || `daten/${region}/karte/`;

let man, store, spiel, verkehr = null, hoehen = null, reliefAn = true, modus = 'karte';
const pxProM = () => modus === 'iso' ? Iso.pxProM() : cam.z;            // Bildschirmpunkte je Meter in der aktiven Ansicht
const weltPunkt = p => modus === 'iso' ? Iso.weltVon(p.x, p.y) : [cam.x + p.x / cam.z, cam.y + p.y / cam.z];
const view = $('view'), vctx = view.getContext('2d'), mapwin = $('mapwin');
let dpr = 1, vw = 0, vh = 0;
const cam = { x: 0, y: 0, z: 0.05 };
const chunks = new Map(); // "stufe:i:j" -> Canvas
let dirty = true, overlay = null, showNames = true, selected = null, hover = null;

/* ----------------------------- Start ----------------------------- */
async function start() {
  buildPatterns();
  try {
    const r = await fetch(base + 'manifest.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    man = await r.json();
  } catch (e) {
    $('loading').textContent = `Keine Karte unter „${base}manifest.json“ gefunden (${e.message}). Ist der Datenordner eingebunden?`;
    return;
  }
  store = new TileStore(base, man, () => { dirty = true; });
  hoehen = new Hoehen(base, man); hoehen.onLoad = () => { dirty = true; };
  try { reliefAn = localStorage.getItem('rtc-relief') !== '0'; } catch (e) {}
  if (man.hoehe) document.querySelector('.attr').insertAdjacentHTML('beforeend', ' · Höhen © ' + esc(man.hoehe.quelle.replace(/ \(.*\)$/, '')));
  spiel = new Spiel(man.slug);
  store.patchFor = id => spiel.patchFor(id);
  spiel.onChange = renderSpiel;
  setupSpiel();
  setupVerkehr();
  Iso.init({ man, store, spiel, live, hoehen });
  $('t-live').onclick = () => setLive(!liveAn); setLive(liveAn);
  $('t-relief').onclick = () => setRelief(!reliefAn); setRelief(reliefAn, true);
  $('t-iso').onclick = () => { const x = cam.x + vw / cam.z / 2, y = cam.y + vh / cam.z / 2; location.href = `iso.html?region=${encodeURIComponent(region)}${params.get('karte') ? '&karte=' + encodeURIComponent(base) : ''}&x=${Math.round(x)}&y=${Math.round(y)}`; };
  $('region').textContent = man.name;
  $('stand').textContent = man.osm_stand ? ' · OSM-Stand ' + new Date(man.osm_stand).toLocaleDateString('de-DE') : '';
  renderStats();
  setupSearch();
  new ResizeObserver(resize).observe(mapwin); resize();
  // Kamera: gespeichert oder ganze Region
  const W = man.bbox_utm[2] - man.bbox_utm[0], H = man.bbox_utm[3] - man.bbox_utm[1];
  let saved = null; try { saved = JSON.parse(localStorage.getItem('rtc-cam-' + man.slug)); } catch (e) {}
  if (saved && saved.z) Object.assign(cam, saved);
  else { cam.z = Math.min(vw / W, vh / H) * 0.95; cam.x = W / 2 - vw / cam.z / 2; cam.y = H / 2 - vh / cam.z / 2; }
  clampCam();
  $('loading').hidden = true;
  if (params.get('ansicht') === 'iso') { const x = +params.get('x'), y = +params.get('y'); zuIso(x || cam.x + vw / cam.z / 2, y || cam.y + vh / cam.z / 2); }
  inspect(null);
  requestAnimationFrame(frame);
}

/* ----------------------------- Kamera ----------------------------- */
function resize() { dpr = window.devicePixelRatio || 1; vw = mapwin.clientWidth; vh = mapwin.clientHeight; view.width = Math.round(vw * dpr); view.height = Math.round(vh * dpr); Iso.groesse(vw, vh); dirty = true; }
function clampCam() {
  if (!man) return;
  const W = man.bbox_utm[2] - man.bbox_utm[0], H = man.bbox_utm[3] - man.bbox_utm[1];
  cam.z = clamp(cam.z, 0.004, 8);
  const ww = vw / cam.z, hh = vh / cam.z;
  cam.x = clamp(cam.x, -ww * .5, W - ww * .5); cam.y = clamp(cam.y, -hh * .5, H - hh * .5);
}
function zoomAt(nz, sx, sy) { const wx = cam.x + sx / cam.z, wy = cam.y + sy / cam.z; cam.z = nz; clampCam(); cam.x = wx - sx / cam.z; cam.y = wy - sy / cam.z; clampCam(); dirty = true; }
function flyTo(wx, wy, z) { cam.z = z || Math.max(cam.z, 1.2); cam.x = wx - vw / cam.z / 2; cam.y = wy - vh / cam.z / 2; clampCam(); dirty = true; }
const levelIndex = () => { let k = 0; for (let i = 0; i < LEVELS.length; i++) if (cam.z * dpr >= LEVELS[i].minZ * 1.0 && cam.z >= LEVELS[i].minZ) k = i; return k; };

/* ----------------------------- Chunks ----------------------------- */
// UTM-Chunk (i, j) einer Stufe -> Welt-Rechteck
function chunkRect(L, i, j) {
  const E0 = man.bbox_utm[0], N0 = man.bbox_utm[3], C = L.chunk;
  return [i * C - E0, N0 - (j + 1) * C, (i + 1) * C - E0, N0 - j * C];
}
function chunksInView(L) {
  const E0 = man.bbox_utm[0], N0 = man.bbox_utm[3], C = L.chunk;
  const e0 = cam.x + E0, e1 = cam.x + vw / cam.z + E0, n1 = N0 - cam.y, n0 = N0 - (cam.y + vh / cam.z);
  const out = [];
  for (let j = Math.floor(n0 / C); j <= Math.floor(n1 / C); j++) for (let i = Math.floor(e0 / C); i <= Math.floor(e1 / C); i++) out.push([i, j]);
  // von der Mitte nach außen
  const ci = (e0 + e1) / 2 / C, cj = (n0 + n1) / 2 / C;
  return out.sort((a, b) => Math.hypot(a[0] + .5 - ci, a[1] + .5 - cj) - Math.hypot(b[0] + .5 - ci, b[1] + .5 - cj));
}
// Kacheln, die ein Chunk braucht (null = noch nicht alle geladen)
function tilesFor(L, i, j) {
  const T = man.tile_size_m[L.lod], C = L.chunk;
  const ix0 = Math.floor(i * C / T), ix1 = Math.floor(((i + 1) * C - 1) / T), iy0 = Math.floor(j * C / T), iy1 = Math.floor(((j + 1) * C - 1) / T);
  const tiles = []; let missing = false;
  for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
    const t = store.get(L.lod, ix, iy);
    if (t === null) missing = true; else if (t) tiles.push(t);
  }
  // Gebäude der Nachbarkacheln (liegen nur in der Kachel ihres Mittelpunkts)
  let extra = null;
  if (L.lod === 0 && L.res >= 1) {
    extra = [];
    for (let iy = iy0 - 1; iy <= iy1 + 1; iy++) for (let ix = ix0 - 1; ix <= ix1 + 1; ix++) {
      if (ix >= ix0 && ix <= ix1 && iy >= iy0 && iy <= iy1) continue;
      const t = store.get(0, ix, iy);
      if (t === null) missing = true; else if (t) extra.push(...t.buildings);
    }
  }
  return missing ? null : { tiles, extra };
}
// Schummerungs-Kacheln für ein Chunk-Rechteck (null = lädt noch)
function reliefFuer(L, r) {
  if (!reliefAn || !hoehen || !hoehen.ok) return [];
  const l = L.lod === 0 ? 0 : 1, T = man.tile_size_m[l], E0 = man.bbox_utm[0], N0 = man.bbox_utm[3], out = [];
  for (let ix = Math.floor((r[0] + E0) / T); ix <= Math.floor((r[2] - 1e-6 + E0) / T); ix++)
    for (let iy = Math.floor((N0 - r[3] + 1e-6) / T); iy <= Math.floor((N0 - r[1]) / T); iy++) {
      const cv = hoehen.schummerung(l, ix, iy); if (cv === null) return null; if (cv) out.push([cv, ix * T - E0, N0 - (iy + 1) * T, T]);
    }
  return out;
}
function renderChunk(L, i, j) {
  const need = tilesFor(L, i, j); if (!need) return null;
  const rel = reliefFuer(L, chunkRect(L, i, j)); if (rel === null) return null;
  const px = Math.round(L.chunk * L.res);
  const cv = document.createElement('canvas'); cv.width = cv.height = px;
  const c = cv.getContext('2d');
  const r = chunkRect(L, i, j);
  c.setTransform(L.res, 0, 0, L.res, -r[0] * L.res, -r[1] * L.res);
  if (!need.tiles.length) { c.fillStyle = '#5f8f49'; c.fillRect(r[0], r[1], L.chunk, L.chunk); }
  else new Painter(c, L.res).scene(r, need.tiles, need.extra);
  if (rel.length) { c.imageSmoothingEnabled = true; for (const [rc, x, y, T] of rel) c.drawImage(rc, x, y, T, T); }
  return cv;
}

/* ----------------------------- Zeichnen ----------------------------- */
/* ----------------------------- Live-Verkehr (Ebene 2) ----------------------------- */
const live = new Live();
let liveAn = true, liveRect = null, liveSig = '', liveBau = 0, liveLetzt = 0, liveInfoT = 0;
try { liveAn = localStorage.getItem('rtc-live') !== '0'; } catch (e) {}
const LIVE_MIN_Z = .3, LIVE_MAX_M = 3500;
function liveAktiv() { return liveAn && man && (modus === 'iso' || cam.z >= LIVE_MIN_Z); }
function liveNetz(now) {
  let vx0 = cam.x, vy0 = cam.y, vx1 = cam.x + vw / cam.z, vy1 = cam.y + vh / cam.z;
  if (modus === 'iso') [vx0, vy0, vx1, vy1] = Iso.sichtbereich();
  const innen = liveRect && vx0 >= liveRect[0] - 20 && vy0 >= liveRect[1] - 20 && vx1 <= liveRect[2] + 20 && vy1 <= liveRect[3] + 20;
  const tiles = loadedTiles(0), sig = tiles.length + ':' + (verkehr && verkehr.erg ? verkehr.erg.t : 0) + ':' + spiel.s.log.length + ':' + Object.keys(spiel.s.kanten).length + ':' + JSON.stringify(spiel.s.knoten).length;
  if (innen && sig === liveSig) return;
  if (now - liveBau < 700 && liveRect) return;
  liveBau = now; liveSig = sig;
  const cx = (vx0 + vx1) / 2, cy = (vy0 + vy1) / 2, hw = Math.min(LIVE_MAX_M, vx1 - vx0 + 300) / 2, hh = Math.min(LIVE_MAX_M, vy1 - vy0 + 300) / 2;
  liveRect = [cx - hw, cy - hh, cx + hw, cy + hh];
  const roads = [], signale = new Set();
  for (const t of tiles) {
    if (t.x1 < liveRect[0] || t.x0 > liveRect[2] || t.y1 < liveRect[1] || t.y0 > liveRect[3]) continue;
    for (const r of t.roads) if (!(r.bb[2] < liveRect[0] || r.bb[0] > liveRect[2] || r.bb[3] < liveRect[1] || r.bb[1] > liveRect[3])) roads.push(r);
    for (const n of t.nodes) if (n.f === 'traffic_signals' && !n.on) signale.add(n.id);
  }
  const radVol = id => { const v = verkehr && verkehr.erg ? verkehr.volumen(id) : null; return v === null ? 15 : v; };
  const kreisel = new Set();
  for (const [id, k] of Object.entries(spiel.s.knoten)) { if (k.ampel) signale.add(Number(id)); if (k.kreisel) kreisel.add(Number(id)); }
  live.bauen(roads, signale, radVol, liveRect, kreisel);
}
function liveSchritt(now) {
  const dt = Math.min(.25, (now - (liveLetzt || now)) / 1000); liveLetzt = now;
  liveNetz(now);
  for (let t = dt; t > 1e-6; t -= .05) live.schritt(Math.min(.05, t));
  if (now - liveInfoT > 500) {
    liveInfoT = now; const z = live.zahlen();
    $('live').textContent = `${fmt(z.autos)} Autos · ${fmt(z.raeder)} Räder · eng überholt ${fmt(z.nahUeberholenH)}/h · Abbiegekonflikte ${fmt(z.abbiegenH)}/h`;
  }
}
function setRelief(an, still) {
  reliefAn = an; try { localStorage.setItem('rtc-relief', an ? '1' : '0'); } catch (e) {}
  $('t-relief').setAttribute('aria-pressed', an); $('t-relief').hidden = !(hoehen && hoehen.ok);
  document.querySelector('[data-ov="steig"]').hidden = !(hoehen && hoehen.ok);
  if (!still) { chunks.clear(); dirty = true; }
}
function setLive(an) {
  liveAn = an; try { localStorage.setItem('rtc-live', an ? '1' : '0'); } catch (e) {}
  $('t-live').setAttribute('aria-pressed', an); dirty = true;
  if (!an) { live.agents = []; liveRect = null; $('live').hidden = true; }
}

function frame(now) {
  const la = liveAktiv();
  if (la) { liveSchritt(now); dirty = true; } else liveLetzt = 0;
  if (modus === 'iso') dirty = true;
  $('live').hidden = !la;
  if (dirty) { dirty = false; draw(); if (man) updateSurvey(); }
  requestAnimationFrame(frame);
}
function draw() {
  if (modus === 'iso') return zeichneIso();
  const s = cam.z * dpr;
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.fillStyle = '#101713'; vctx.fillRect(0, 0, view.width, view.height);
  const top = levelIndex();
  const t0 = performance.now();
  let pending = false;
  // grobe Stufen als Unterlage, feinste zuletzt
  for (let li = Math.max(0, top - 1); li <= top; li++) {
    const L = LEVELS[li];
    vctx.imageSmoothingEnabled = L.res * 1 > s;
    for (const [i, j] of chunksInView(L)) {
      const k = li + ':' + i + ':' + j;
      let cv = chunks.get(k);
      if (!cv && li === top || !cv && li < top && performance.now() - t0 < 6) {
        if (performance.now() - t0 < 30) { cv = renderChunk(L, i, j); if (cv) { chunks.set(k, cv); trimChunks(); } else pending = true; }
        else pending = true;
      }
      if (!cv) continue;
      chunks.delete(k); chunks.set(k, cv);
      const r = chunkRect(L, i, j);
      const X = Math.round((r[0] - cam.x) * s), Y = Math.round((r[1] - cam.y) * s), X2 = Math.round((r[2] - cam.x) * s), Y2 = Math.round((r[3] - cam.y) * s);
      vctx.drawImage(cv, X, Y, X2 - X, Y2 - Y);
    }
  }
  vctx.setTransform(s, 0, 0, s, -cam.x * s, -cam.y * s);
  drawMask();
  zeichneKnotenBauten();
  if (liveAktiv()) live.zeichnen(vctx, cam.z);
  if (overlay) drawOverlay(top);
  if (werkzeug !== 'auswahl') zeichneWerkzeug();
  if (hover && hover !== selected) { vctx.lineCap = 'round'; stroke(vctx, hover.P, hover.half * 2 + 1.5, 'rgba(255,255,255,.28)'); }
  for (const z of zugSel) if (z !== selected) stroke(vctx, z.P, Math.max(z.half * 2 + 1, 2.5 / cam.z), 'rgba(255,226,90,.45)');
  if (selected) {
    const o = selected.half + .6, w = Math.max(.3, 2 / cam.z);
    vctx.lineCap = 'butt'; stroke(vctx, offsetLine(selected.P, o), w, '#ffe25a', [3, 2]); stroke(vctx, offsetLine(selected.P, -o), w, '#ffe25a', [3, 2]);
    if (cam.z < 1) stroke(vctx, selected.P, Math.max(1, 3 / cam.z), '#ffe25a');
  }
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  drawPlaces(s); if (showNames && cam.z >= 1.1) drawStreetNames(s);
  $('lvl').textContent = `${LEVELS[top].name} · ${cam.z >= 1 ? fmt(cam.z, 1) : fmt(cam.z, 3)} px/m`;
  if (pending || store.active || store.queue.length) dirty = true;
  $('busy').hidden = !(store.active || store.queue.length);
  saveCam();
}
function trimChunks() { while (chunks.size > MAX_CHUNKS) chunks.delete(chunks.keys().next().value); }
let maskPath = null;
function drawMask() {
  if (!man.gebiet_utm || man.gebiet_utm.length < 3) return;
  if (!maskPath) { const E0 = man.bbox_utm[0], N0 = man.bbox_utm[3]; maskPath = man.gebiet_utm.map(([e, n]) => [e - E0, N0 - n]); }
  const W = man.bbox_utm[2] - man.bbox_utm[0], H = man.bbox_utm[3] - man.bbox_utm[1];
  vctx.beginPath(); vctx.rect(-W, -H, W * 3, H * 3);
  vctx.moveTo(maskPath[0][0], maskPath[0][1]); for (const p of maskPath) vctx.lineTo(p[0], p[1]); vctx.closePath();
  vctx.fillStyle = 'rgba(12,18,15,.55)'; vctx.fill('evenodd');
  vctx.lineWidth = 2 / cam.z; vctx.strokeStyle = 'rgba(255,250,240,.55)'; vctx.setLineDash([6 / cam.z, 4 / cam.z]);
  vctx.beginPath(); vctx.moveTo(maskPath[0][0], maskPath[0][1]); for (const p of maskPath) vctx.lineTo(p[0], p[1]); vctx.closePath(); vctx.stroke(); vctx.setLineDash([]);
}
// Kacheln (dekodiert) im Bild für eine Stufe
function loadedTiles(lod) {
  const E0 = man.bbox_utm[0], N0 = man.bbox_utm[3], T = man.tile_size_m[lod];
  const e0 = cam.x + E0, e1 = cam.x + vw / cam.z + E0, n1 = N0 - cam.y, n0 = N0 - (cam.y + vh / cam.z);
  const out = [];
  for (let iy = Math.floor(n0 / T); iy <= Math.floor(n1 / T); iy++) for (let ix = Math.floor(e0 / T); ix <= Math.floor(e1 / T); ix++) { const t = store.get(lod, ix, iy); if (t) out.push(t); }
  return out;
}
const ROUTE_COLS = ['#2f7de1', '#e0563a', '#a45ee5', '#18b39a', '#f08a3a', '#e84f9b', '#d9b520', '#5cc24a'];
const routeColor = n => ROUTE_COLS[Math.floor(hashStr(n) * ROUTE_COLS.length)];
let routeSel = null, routeSig = '';
function drawRoutes(lod) {
  const w = Math.max(3.2 / cam.z, 1.5), lens = new Map();
  const vx0 = cam.x, vy0 = cam.y, vx1 = cam.x + vw / cam.z, vy1 = cam.y + vh / cam.z;
  vctx.lineCap = 'round'; vctx.lineJoin = 'round';
  for (const pass of [0, 1]) for (const t of loadedTiles(lod)) for (const r of t.roads) {
    const rs = r.m.routes; if (!rs || !rs.length) continue;
    if (lod === 0 && !r.own) continue;
    const inView = !(r.bb[2] < vx0 || r.bb[0] > vx1 || r.bb[3] < vy0 || r.bb[1] > vy1);
    if (!inView) continue;
    rs.forEach((n, i) => {
      const sel = routeSel === n;
      if (pass === 0) { lens.set(n, (lens.get(n) || 0) + (r.len || 0)); if (routeSel && !sel) stroke(vctx, offsetLine(r.P, (i - (rs.length - 1) / 2) * w), w * .8, 'rgba(230,230,220,.35)'); }
      else if (!routeSel || sel) { const P = rs.length > 1 && !routeSel ? offsetLine(r.P, (i - (rs.length - 1) / 2) * w) : r.P; if (sel) stroke(vctx, P, w * 2.2, '#10171399'); stroke(vctx, P, sel ? w * 1.5 : w, routeColor(n)); }
    });
  }
  // Legende: Routen im Bild, längste zuerst
  const list = [...lens.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const sig = list.map(x => x[0]).join('|') + '#' + routeSel + lod;
  if (sig !== routeSig) {
    routeSig = sig;
    $('legend').innerHTML = `<div class="lbl">Radrouten im Bild</div><div class="routes">${list.map(([n]) => `<button class="rt${routeSel === n ? ' on' : ''}" data-route="${esc(n)}"><i style="background:${routeColor(n)}"></i>${esc(n)}</button>`).join('') || '<div class="hint">Keine Radroute im Bild.</div>'}</div><div class="hint">Route anklicken: hervorheben${lod === 0 ? ' · im Info-Fenster ganze Route markieren' : ' · zum Ausbauen hineinzoomen'}.</div>`;
  }
}
function waehleRoute(n) {
  routeSel = routeSel === n ? null : n; routeSig = ''; dirty = true;
  if (overlay !== 'route') setOverlay('route');
  if (selected) inspect(selected);
}
function routeKanten(n) {
  const out = new Map();
  for (const t of store.cache.values()) if (t && t.lod === 0) for (const r of t.roads) if (r.m.routes && r.m.routes.includes(n) && !out.has(r.id)) out.set(r.id, r);
  return [...out.values()];
}
/* ----------------------------- Verkehr ----------------------------- */
const VK_KL = [[1, '#a9d3f0', 1.5], [20, '#5aa9e6', 2.5], [100, '#2f6fd6', 4], [300, '#6a3fd0', 6], [1000, '#c0207a', 9]];
const vkKlasse = v => { let k = -1; for (let i = 0; i < VK_KL.length; i++) if (v >= VK_KL[i][0]) k = i; return k; };
function drawVerkehr(top) {
  if (!verkehr || !verkehr.erg) return;
  const E = verkehr.erg.vol, wpx = 1 / cam.z;
  const vx0 = cam.x, vy0 = cam.y, vx1 = cam.x + vw / cam.z, vy1 = cam.y + vh / cam.z;
  vctx.lineCap = 'round'; vctx.lineJoin = 'round';
  const paths = VK_KL.map(() => new Path2D());
  if (top >= 2) {
    for (const t of loadedTiles(0)) for (const r of t.roads) {
      if (!r.own || r.bb[2] < vx0 || r.bb[0] > vx1 || r.bb[3] < vy0 || r.bb[1] > vy1) continue;
      const e = verkehr.idx.get(r.id); if (e === undefined) continue;
      const k = vkKlasse(E[e]); if (k < 0) continue;
      const P = r.P, p = paths[k]; p.moveTo(P[0][0], P[0][1]); for (let i = 1; i < P.length; i++) p.lineTo(P[i][0], P[i][1]);
    }
  } else {
    const min = cam.z < .02 ? 3 : cam.z < .06 ? 2 : 1, { a, b, kx, ky } = verkehr;
    for (let e = 0; e < verkehr.nE; e++) {
      const k = vkKlasse(E[e]); if (k < min) continue;
      const x0 = kx[a[e]], y0 = ky[a[e]], x1 = kx[b[e]], y1 = ky[b[e]];
      if (Math.max(x0, x1) < vx0 || Math.min(x0, x1) > vx1 || Math.max(y0, y1) < vy0 || Math.min(y0, y1) > vy1) continue;
      paths[k].moveTo(x0, y0); paths[k].lineTo(x1, y1);
    }
  }
  paths.forEach((p, k) => { vctx.lineWidth = VK_KL[k][2] * wpx; vctx.strokeStyle = VK_KL[k][1]; vctx.stroke(p); });
}
const STEIG = [[0, '#3fae4a'], [30, '#9cc23e'], [50, '#e2c43a'], [80, '#e48a34'], [120, '#d8452f']];
const steigKl = v => { let k = 0; for (let i = 0; i < STEIG.length; i++) if (v >= STEIG[i][0]) k = i; return k; };
function drawSteigung(top) {
  if (!verkehr || !verkehr.netz) return;
  if (!verkehr.netz.kanten.steil) { const h = $('legend').querySelector('.hint'); if (h && !h.dataset.fehlt) { h.dataset.fehlt = 1; h.textContent = 'Im Verkehrsnetz fehlen die Steigungen: Pipeline-Schritt „hoehe“ nach „netz“ ausführen.'; } return; }
  const S = verkehr.netz.kanten.steil, wpx = 1 / cam.z, paths = STEIG.map(() => new Path2D());
  const vx0 = cam.x, vy0 = cam.y, vx1 = cam.x + vw / cam.z, vy1 = cam.y + vh / cam.z;
  vctx.fillStyle = 'rgba(12,20,16,.35)'; vctx.fillRect(cam.x, cam.y, vw / cam.z, vh / cam.z);
  if (top >= 2) {
    for (const t of loadedTiles(0)) for (const r of t.roads) {
      if (!r.own || r.bb[2] < vx0 || r.bb[0] > vx1 || r.bb[3] < vy0 || r.bb[1] > vy1) continue;
      const e = verkehr.idx.get(r.id); if (e === undefined || S[e] < 0) continue;
      const p = paths[steigKl(S[e])], P = r.P; p.moveTo(P[0][0], P[0][1]); for (let i = 1; i < P.length; i++) p.lineTo(P[i][0], P[i][1]);
    }
  } else {
    const { a, b, kx, ky } = verkehr, cls = verkehr.netz.kanten.cls, kl = verkehr.netz.klassen;
    for (let e = 0; e < verkehr.nE; e++) {
      if (S[e] < 30 && cam.z < .05) continue;
      const c = kl[cls[e]]; if (c === 'fuss' || c === 'treppe' || c === 'auto') continue;
      const x0 = kx[a[e]], y0 = ky[a[e]], x1 = kx[b[e]], y1 = ky[b[e]];
      if (Math.max(x0, x1) < vx0 || Math.min(x0, x1) > vx1 || Math.max(y0, y1) < vy0 || Math.min(y0, y1) > vy1 || S[e] < 0) continue;
      const p = paths[steigKl(S[e])]; p.moveTo(x0, y0); p.lineTo(x1, y1);
    }
  }
  vctx.lineCap = 'round'; paths.forEach((p, k) => { vctx.lineWidth = (k >= 3 ? 3.5 : 2.5) * wpx; vctx.strokeStyle = STEIG[k][1]; vctx.stroke(p); });
}
function drawZufrieden() {
  if (!verkehr || !verkehr.erg) return;
  const Z = verkehr.Z, h = verkehr.zelle / 2, e = verkehr.erg;
  for (let z = 0; z < verkehr.nZ; z++) {
    if (Z.ew[z] < 10 || !e.zWege[z]) continue;
    vctx.fillStyle = condColor(e.zZuf[z]); vctx.globalAlpha = Math.min(.5, .18 + Z.ew[z] / 1200);
    vctx.fillRect(Z.x[z] - h, Z.y[z] - h, 2 * h, 2 * h);
  }
  vctx.globalAlpha = 1;
}
let vkT = 0;
function verkehrNeu() { if (!verkehr || !verkehr.erg) return; clearTimeout(vkT); vkT = setTimeout(() => verkehr.rechnen(), 300); }
function setupVerkehr() {
  if (!man.netz) { $('verkehr').innerHTML = '<div class="note">Für diese Karte gibt es noch kein Verkehrsnetz. Pipeline neu laufen lassen (Schritt „netz“).</div>'; return; }
  verkehr = new Verkehr(base, man, id => spiel.patchFor(id));
  verkehr.knotenBau = id => spiel.knotenFor(id);
  verkehr.onStatus = t => { $('vk-status').textContent = t; };
  verkehr.onErgebnis = (erg, vorher) => { renderVerkehr(erg, vorher); ortAktuell = null; updateSurvey(true); if (overlay === 'verkehr' || overlay === 'zuf') dirty = true; if (selected) inspect(selected); };
  $('vk-status').textContent = 'Verkehrsnetz wird geladen …';
  verkehr.laden().then(() => verkehr.rechnen()).catch(e => { $('vk-status').textContent = 'Verkehr: ' + e.message; });
}
const pkt = v => (v >= 0 ? '+' : '−') + fmt(Math.abs(v), 1);
function renderVerkehr(e, v) {
  const d = v ? ` <span class="${e.anteil >= v.anteil ? 'up' : 'down'}">${pkt((e.anteil - v.anteil) * 100)}</span>` : '';
  const dz = v ? ` <span class="${e.zufrieden >= v.zufrieden ? 'up' : 'down'}">${pkt(e.zufrieden - v.zufrieden)}</span>` : '';
  $('verkehr').innerHTML = `<dl class="kv"><dt>Radanteil</dt><dd>${fmt(e.anteil * 100, 1)} %${d}</dd><dt>Radfahrten am Tag</dt><dd>${fmt(e.rad)}</dd><dt>Rad-km am Tag</dt><dd>${fmt(e.radKm)}</dd><dt>Zufriedenheit</dt><dd>${fmt(e.zufrieden, 1)}${dz}</dd><dt>Einwohner (geschätzt)</dt><dd>${fmt(verkehr.ewSumme)}</dd></dl>`;
  $('vk-status').textContent = `berechnet in ${fmt(e.ms / 1000, 1)} s · Werte sind Modellschätzungen`;
  $('top-anteil').innerHTML = `${fmt(e.anteil * 100, 1)} %${v ? ` <span class="${e.anteil >= v.anteil ? 'up' : 'down'}" style="font-size:12px">${pkt((e.anteil - v.anteil) * 100)}</span>` : ''}`;
  $('top-zuf').innerHTML = `${fmt(e.zufrieden, 0)}${v ? ` <span class="${e.zufrieden >= v.zufrieden ? 'up' : 'down'}" style="font-size:12px">${pkt(e.zufrieden - v.zufrieden)}</span>` : ''}`;
  renderSpiel();
}

function drawOverlay(top) {
  const lod = top >= 2 ? 0 : 1;
  vctx.fillStyle = 'rgba(12,20,16,.45)'; vctx.fillRect(cam.x, cam.y, vw / cam.z, vh / cam.z);
  vctx.lineCap = 'round'; vctx.lineJoin = 'round';
  const minW = 2.5 / cam.z;
  if (overlay === 'route') return drawRoutes(lod);
  if (overlay === 'verkehr') return drawVerkehr(top);
  if (overlay === 'zuf') return drawZufrieden();
  if (overlay === 'steig') return drawSteigung(top);
  for (const t of loadedTiles(lod)) for (const r of t.roads) {
    if (lod === 0 && !r.own) continue;
    const m = r.m; let col = null;
    const bv = bikeValues(m);
    if (overlay === 'cond') { if (isRoad(m) || m.cls === 'rad' || m.cls === 'feld') col = m.cond !== undefined ? condColor(Math.min(m.cond, m.tcond ?? 100)) : null; }
    else if (overlay === 'risk') { if (isRoad(m) && !bv.use) col = '#7e8279'; else if (bv.use && (isRoad(m) || m.cls === 'rad')) col = riskColor(bv.risk); }
    else if (overlay === 'net') {
      const fac = Math.max(m.fac_l || 0, m.fac_r || 0);
      if (m.cls === 'rad' || m.frs) col = '#e0563a'; else if (fac === 3) col = '#f08a3a'; else if (fac >= 1) col = '#f2c230';
      else if (isRoad(m) && m.bike === 2) col = '#7e8279'; else if (isRoad(m) && (m.ms || 50) <= 30) col = '#9cc23e'; else if (isRoad(m)) col = '#9a9fa6';
      else if (m.cls === 'feld' && m.bike !== 0) col = '#c7b287';
      if (lod === 0 && m.routes && m.routes.length) stroke(vctx, r.P, Math.max(r.half * 2 + 3, minW * 2.2), 'rgba(31,90,166,.55)');
    }
    if (col) stroke(vctx, r.P, Math.max((m.cw || 1.5) * 2.2, minW), col);
  }
}
function drawPlaces(s) {
  if (!man.orte) return;
  const maxRank = cam.z < .02 ? 2 : cam.z < .08 ? 3 : cam.z < .4 ? 4 : cam.z < 1.5 ? 5 : 0;
  if (!maxRank) return;
  const E0 = man.bbox_utm[0], N0 = man.bbox_utm[3];
  vctx.textAlign = 'center'; vctx.textBaseline = 'middle';
  const used = [];
  for (const p of man.orte) {
    if (p.rang > maxRank) continue;
    const X = (p.e - E0 - cam.x) * s, Y = (N0 - p.n - cam.y) * s;
    if (X < -100 || Y < -40 || X > view.width + 100 || Y > view.height + 40) continue;
    const size = (p.rang <= 2 ? 15 : p.rang === 3 ? 12 : 10) * dpr;
    vctx.font = `${p.rang <= 2 ? 700 : 400} ${size}px Silkscreen, monospace`;
    const tw = vctx.measureText(p.name).width;
    const box = [X - tw / 2 - 5 * dpr, Y - size * .8, tw + 10 * dpr, size * 1.6];
    if (used.some(u => !(box[0] > u[0] + u[2] || box[0] + box[2] < u[0] || box[1] > u[1] + u[3] || box[1] + box[3] < u[1]))) continue;
    used.push(box);
    vctx.fillStyle = 'rgba(16,23,19,.72)'; vctx.fillRect(...box);
    vctx.fillStyle = '#f2efe6'; vctx.fillText(p.name, X, Y + dpr);
  }
}
function drawStreetNames(s) {
  vctx.font = `${Math.round(11 * dpr)}px Silkscreen, monospace`; vctx.textAlign = 'center'; vctx.textBaseline = 'middle';
  const seen = new Set();
  for (const t of loadedTiles(0)) for (const n of t.names) {
    const X = (n.x - cam.x) * s, Y = (n.y - cam.y) * s;
    if (X < -200 || Y < -50 || X > view.width + 200 || Y > view.height + 50) continue;
    const tw = vctx.measureText(n.name).width; if (tw > n.len * s * .9) continue;
    const key = n.name + Math.round(X / 300) + ',' + Math.round(Y / 300); if (seen.has(key)) continue; seen.add(key);
    vctx.setTransform(Math.cos(n.a), Math.sin(n.a), -Math.sin(n.a), Math.cos(n.a), X, Y);
    vctx.fillStyle = 'rgba(20,22,24,.75)'; vctx.fillRect(-tw / 2 - 3 * dpr, -7 * dpr, tw + 6 * dpr, 14 * dpr);
    vctx.fillStyle = '#f2efe6'; vctx.fillText(n.name, 0, dpr);
  }
  vctx.setTransform(1, 0, 0, 1, 0, 0);
}
let saveT = 0;
function saveCam() { const now = Date.now(); if (now - saveT < 800) return; saveT = now; try { localStorage.setItem('rtc-cam-' + man.slug, JSON.stringify(cam)); } catch (e) {} }

/* ----------------------------- Auswahl ----------------------------- */
function pickRoad(wx, wy) {
  if (pxProM() < .22) return null;
  let best = null, bd = 1e9;
  for (const t of loadedTiles(0)) for (const r of t.roads) {
    const b = r.bb, h = r.half + 4;
    if (wx < b[0] - h || wx > b[2] + h || wy < b[1] - h || wy > b[3] + h) continue;
    const P = r.P;
    for (let i = 1; i < P.length; i++) {
      const ax = P[i - 1][0], ay = P[i - 1][1], dx = P[i][0] - ax, dy = P[i][1] - ay, l2 = dx * dx + dy * dy || 1;
      const u = clamp(((wx - ax) * dx + (wy - ay) * dy) / l2, 0, 1);
      const d = Math.hypot(ax + dx * u - wx, ay + dy * u - wy) - (r.m.cw || 1) - (isRoad(r.m) ? .5 : 0);
      if (d < bd) { bd = d; best = r; }
    }
  }
  return bd < Math.max(modus === 'iso' ? 1.5 : 3, 8 / pxProM()) ? best : null;
}
const CLS = { auto: 'Autobahn / Kraftfahrstraße', L: 'Hauptverkehrsstraße', dorf: 'Sammelstraße', wohn: 'Wohnstraße', spiel: 'Verkehrsberuhigter Bereich', zufahrt: 'Zufahrt', feld: 'Wirtschafts-/Waldweg', rad: 'Radweg', weg: 'Weg', fuss: 'Fußweg', treppe: 'Treppe' };
const SURF = { asphalt: 'Asphalt', concrete: 'Beton', concrete_plates: 'Betonplatten', paving_stones: 'Betonpflaster', sett: 'Kopfsteinpflaster', cobblestone: 'Feldsteinpflaster', compacted: 'Wassergeb. Decke', fine_gravel: 'Feinsplitt', gravel: 'Schotter', ground: 'Erdweg', sand: 'Sand', grass: 'Gras', grass_paver: 'Rasengitter', wood: 'Holz', metal: 'Metall', paved: 'befestigt', unpaved: 'unbefestigt' };
const EST = { tempo: 'Tempo', gehweg: 'Gehweg', belag: 'Belag', zustand: 'Zustand', radweg_belag: 'Radwegbelag', radweg_zustand: 'Radwegzustand' };
function condBar(label, v, sub, est) { const col = v >= 80 ? 'var(--ok)' : v >= 50 ? 'var(--warn)' : 'var(--bad)'; return `<div class="cond"><span>${label} <span class="lbl">${sub}</span>${est ? ' <span class="est">geschätzt</span>' : ''}</span><b>${Math.round(v)}</b><div class="bar"><s style="width:${v}%;background:${col}"></s></div></div>`; }
function inspect(r) {
  if (r) zeigeReiter('info');
  selected = r; dirty = true; if (!r) { zugSel = []; multi = []; }
  const el = $('inspect');
  if (!r) { $('insp-kind').textContent = ''; el.innerHTML = '<div class="insp-title">Nichts ausgewählt</div><div class="insp-sub">Nah heranzoomen und eine Straße oder einen Weg anklicken: Querschnitt, Belag, Zustand und die OSM-Daten.</div>'; return; }
  const m = r.m, bv = bikeValues(m), est = new Set(m.est || []);
  $('insp-kind').textContent = m.ref || '';
  let h = `<div class="insp-title">${esc(m.name || CLS[m.cls])}</div><div class="insp-sub">${CLS[m.cls]}${m.round ? ' · Kreisverkehr' : ''}${m.ms ? ` · Tempo ${m.ms === 7 ? 'Schritt' : m.ms}${est.has('tempo') ? ' (geschätzt)' : ''}` : ''}${m.ms_cond ? ' · zeitweise ' + esc(m.ms_cond) : ''}<br>Abschnitt ${fmt(r.len)} m · Kante ${esc(r.id)}</div>`;
  h += `<canvas class="xs" id="xs"></canvas><div class="xs-cap">Querschnitt aus OSM-Tags · Zeichenrichtung nach oben</div>`;
  if (m.cond !== undefined) h += condBar(isRoad(m) ? 'Fahrbahn' : 'Weg', m.cond, SURF[m.surf] || m.surf, est.has('zustand'));
  if (m.tcond !== undefined) h += condBar('Hochbord-Radweg', m.tcond, SURF[m.tsurf] || m.tsurf, est.has('radweg_zustand'));
  const ch = [];
  const fac = Math.max(m.fac_l || 0, m.fac_r || 0);
  if (!bv.allowed) ch.push(['Für Räder gesperrt', 'bad']); else if (bv.sidepath) ch.push(['Radweg daneben benutzen', 'warn']);
  if (isRoad(m) && bv.use && !m.frs && fac <= 0 && (m.ms || 0) >= 50) ch.push([`Mischverkehr mit Tempo ${m.ms}`, 'bad']);
  if (fac === 3) ch.push(['Hochbord: schlecht sichtbar für Abbieger', 'warn']);
  if (m.tsurf === 'paving_stones') ch.push(['Radweg gepflastert: rumpelig', 'warn']);
  if (m.surf === 'sett' || m.surf === 'cobblestone') ch.push(['Kopfsteinpflaster', 'bad']);
  if (['sand', 'ground', 'grass'].includes(m.surf) && bv.allowed) ch.push([(SURF[m.surf] || m.surf) + ': bei Regen schwierig', 'bad']);
  if (m.cond !== undefined) { if (m.cond < 35) ch.push(['Schlaglöcher wahrscheinlich', 'bad']); else if (m.cond < 55) ch.push(['Risse und Flickstellen', 'warn']); }
  if (m.lit === 'no' && bv.use) ch.push(['Unbeleuchtet', 'warn']);
  if (m.frs) ch.push(['Fahrradstraße', 'good']);
  if (m.cls === 'spiel') ch.push(['Verkehrsberuhigt', 'good']);
  if (isRoad(m) && m.cls !== 'spiel' && (m.ms || 99) <= 30) ch.push(['Tempo ≤ 30', 'good']);
  if (ch.length) h += `<div class="chips">${ch.map(c => `<span class="chip ${c[1]}">${esc(c[0])}</span>`).join('')}</div>`;
  if (m.routes) h += `<div class="chips">${m.routes.map(n => `<button class="chip route${routeSel === n ? ' on' : ''}" data-route="${esc(n)}" title="Route auf der Karte hervorheben"><i style="background:${routeColor(n)}"></i>${esc(n)}</button>`).join('')}</div>`;
  if (routeSel && m.routes && m.routes.includes(routeSel)) { const rk = routeKanten(routeSel); h += `<button class="bev bau-btn" data-route-mark="1"><span>Route „${esc(routeSel)}“ markieren</span><b>${rk.length} Abschn.</b></button><div class="note">Markiert alle geladenen Abschnitte (${fmt(rk.reduce((a, x) => a + x.len, 0) / 1000, 1)} km). Mehr laden: herauszoomen bis „Ort“.</div>`; }
  const vol = verkehr ? verkehr.volumen(r.id) : null, stg = verkehr && verkehr.netz ? verkehr.steigung(r.id) : null;
  if (bv.use || vol || stg) h += `<dl class="kv">${bv.use ? `<dt>Risiko fürs Rad</dt><dd>${Math.round(bv.risk * 100)} / 100</dd><dt>Fahrkomfort</dt><dd>${Math.round(bv.comfort * 100)} %</dd>` : ''}${vol !== null ? `<dt>Radverkehr (Modell)</dt><dd>${fmt(vol)} / Tag</dd>` : ''}${stg ? `<dt>Steigung</dt><dd>bis ${fmt(stg.steil, 1)} % · ↗ ${fmt(stg.auf)} / ↘ ${fmt(stg.ab)} Hm</dd>` : ''}</dl>`;
  if (est.size) h += `<div class="est">Geschätzt, weil in OSM nicht eingetragen: ${[...est].map(e => EST[e] || e).join(', ')}</div>`;
  const skip = new Set(['name', 'ref', 'est', 'routes']);
  h += `<details class="raw"><summary>Spielmodell (alle Felder)</summary><dl class="kv">${Object.entries(m).filter(([k]) => !skip.has(k)).map(([k, v]) => `<dt>${k}</dt><dd>${esc(Array.isArray(v) ? v.join(', ') : v)}</dd>`).join('')}</dl></details>`;
  h += bauPanel(r);
  h += `<div class="osm"><a href="https://www.openstreetmap.org/way/${r.w}" target="_blank" rel="noopener">Weg ${r.w} auf OpenStreetMap ansehen</a></div>`;
  el.innerHTML = h;
  drawCrossSection($('xs'), m);
}

/* ----------------------------- Spiel: Bauen ----------------------------- */
const eur = v => fmt(v) + ' €';
let zugModus = false, zugSel = [], multi = [];
function bauPanel(r) {
  const k = spiel.s.kanten[r.id];
  let h = '<div class="bau"><div class="lbl" style="margin:8px 0 4px">Ausbauen</div>';
  if (k) { const v0 = bikeValues(k.m0), v1 = bikeValues(r.m); h += `<div class="chip good" style="display:inline-block;margin-bottom:4px">Ausgebaut · Risiko ${Math.round(v0.risk * 100)} → ${Math.round(v1.risk * 100)}</div>`; }
  const zug = zugModus ? strassenzug(store, r) : multi.length > 1 ? multi : [r];
  zugSel = zug.length > 1 ? zug : [];
  const name = r.m.name || r.m.ref;
  h += `<label class="zug"${multi.length > 1 && !zugModus ? ' hidden' : ''}><input type="checkbox" id="zug" ${zugModus ? 'checked' : ''} ${name ? '' : 'disabled'}> ganzer Straßenzug${name ? (zugModus ? ` (${zug.length} Abschnitte, ${fmt(zug.reduce((a, x) => a + x.len, 0) / 1000, 2)} km geladen)` : '') : ' (ohne Namen)'}</label>`;
  const opts = AUSBAU.map(a => { const z = zug.filter(x => a.gilt(x.m)); return { a, z, c: gesamt(a, z) }; }).filter(o => o.z.length);
  if (!opts.length) h += '<div class="note">Hier gibt es nichts auszubauen.</div>';
  h += opts.map(o => `<button class="bev bau-btn" data-bau="${o.a.id}" ${o.c > spiel.s.budget ? 'disabled' : ''} title="${esc(o.a.info)}"><span>${o.a.name}</span><b>${eur(o.c)}</b></button>`).join('');
  if (multi.length > 1 && !zugModus) h = h.replace('<label class="zug"', `<div class="chip route" style="display:inline-block;margin-bottom:4px">${multi.length} Abschnitte markiert · ${fmt(multi.reduce((a, x) => a + x.len, 0) / 1000, 2)} km</div><label class="zug"`);
  else h = h.replace('<label class="zug"', '<div class="note" style="margin-bottom:4px">Umschalt + Klick markiert weitere Abschnitte.</div><label class="zug"');
  return h + '</div>';
}
function baue(id) {
  if (!selected) return;
  const a = AUSBAU.find(x => x.id === id);
  const zug = zugModus ? strassenzug(store, selected) : multi.length > 1 ? multi : [selected];
  const namen = [...new Set(zug.map(x => x.m.name || x.m.ref).filter(Boolean))];
  const e = spiel.bauen(a, zug, namen.length === 1 ? namen[0] : namen.length ? namen.length + ' Straßen' : '');
  if (!e) return;
  nachBau(`${a.name}${e.name ? ' · ' + e.name : ''}: ${e.kanten.length} Abschnitt${e.kanten.length > 1 ? 'e' : ''} für ${eur(e.kosten)}`);
}
function nachBau(msg) {
  wendeAn(store, spiel); chunks.clear(); Iso.ungueltig(); dirty = true; updateSurvey(true); verkehrNeu();
  if (selected) inspect(selected);
  if (msg) { $('bau-msg').textContent = msg; }
}
function renderSpiel() {
  if (typeof renderToolpanel === 'function' && werkzeug !== 'auswahl') renderToolpanel();
  const b = spiel.bilanz();
  $('kasse').textContent = eur(spiel.s.budget);
  $('jahr').textContent = 'Jahr ' + spiel.s.jahr;
  const erg = verkehr && verkehr.erg;
  $('jahr-ende').disabled = !erg || verkehr.laeuft;
  $('jahr-ende').textContent = erg ? `Jahr abschließen (+${eur(Spiel.einnahmen(erg))})` : 'Jahr abschließen';
  const J = spiel.s.jahre || [];
  $('jahre').innerHTML = J.length ? `<table class="jt"><tr><th>Jahr</th><th>Rad</th><th>Zufr.</th><th>Einn.</th></tr>${J.slice(-5).map(j => `<tr><td>${j.jahr}</td><td>${fmt(j.anteil * 100, 1)} %</td><td>${fmt(j.zufrieden, 0)}</td><td>${fmt(j.einnahmen / 1e6, 2)} Mio</td></tr>`).join('')}</table>` : '';
  $('bilanz').innerHTML = `<dl class="kv"><dt>Aufträge dieses Jahr</dt><dd>${b.auftraege}</dd><dt>Ausgebaut</dt><dd>${fmt(b.km, 1)} km</dd><dt>Risiko gesenkt</dt><dd>${fmt(b.risikoKm, 1)} km·Pkt</dd><dt>Komfort gewonnen</dt><dd>${fmt(b.komfortKm, 1)} km·Pkt</dd><dt>Ampeln / Kreisel gebaut</dt><dd>${b.ampeln} / ${b.kreisel}</dd></dl>`;
  $('undo').disabled = !spiel.s.log.length;
}
function setupSpiel() {
  $('inspect').addEventListener('click', e => {
    const b = e.target.closest('[data-bau]'); if (b) baue(b.dataset.bau);
    const rt = e.target.closest('[data-route]'); if (rt) waehleRoute(rt.dataset.route);
    if (e.target.closest('[data-route-mark]') && routeSel) { multi = routeKanten(routeSel); zugModus = false; if (multi.length) inspect(multi.includes(selected) ? selected : multi[0]); }
  });
  $('legend').addEventListener('click', e => { const rt = e.target.closest('[data-route]'); if (rt) waehleRoute(rt.dataset.route); });
  $('inspect').addEventListener('change', e => { if (e.target.id === 'zug') { zugModus = e.target.checked; if (selected) inspect(selected); dirty = true; } });
  $('undo').onclick = () => { const e = spiel.rueckgaengig(); if (e) nachBau('Rückgängig: ' + ((AUSBAU.find(a => a.id === e.a) || KNOTEN.find(a => a.id === e.a))?.name || '') + ' (' + eur(e.kosten) + ' zurück)'); };
  $('jahr-ende').onclick = () => { if (!verkehr || !verkehr.erg || verkehr.laeuft) return; const ein = spiel.jahrAbschliessen(verkehr.erg); $('bau-msg').textContent = `Jahr ${spiel.s.jahr - 1} abgeschlossen: ${eur(ein)} Einnahmen.`; renderSpiel(); };
  $('neu').onclick = () => { if (!$('neu').dataset.sicher) { $('neu').dataset.sicher = 1; $('neu').textContent = 'Wirklich? Nochmal klicken'; setTimeout(() => { delete $('neu').dataset.sicher; $('neu').textContent = 'Neues Spiel'; }, 3000); return; } spiel.neu(); nachBau('Neues Spiel gestartet.'); };
  renderSpiel();
}

/* ----------------------------- Ort erkennen ----------------------------- */
// Ort = nächster Ortsmittelpunkt zur Bildmitte, innerhalb eines Radius je nach Rang.
// Bestandsaufnahme für den Ort aus den Detailkacheln (eigene Kanten, Ausbauten eingerechnet).
const ORT_R = { 1: 6000, 2: 3000, 3: 1500, 4: 700 };
let ortAktuell = null, ortT = 0;
function findeOrt() {
  if (!man.orte || cam.z < LEVELS[2].minZ) return null;
  const E0 = man.bbox_utm[0], N0 = man.bbox_utm[3];
  const cx = cam.x + vw / cam.z / 2, cy = cam.y + vh / cam.z / 2;
  let best = null, bq = 2; // bis zum doppelten Radius: man ist „bei“ diesem Ort
  for (const p of man.orte) {
    const R = ORT_R[p.rang]; if (!R) continue;
    const q = Math.hypot(p.e - E0 - cx, N0 - p.n - cy) / R;
    if (q < bq) { bq = q; best = { ...p, x: p.e - E0, y: N0 - p.n, R }; }
  }
  return best;
}
function radinfraLabel(m) {
  const fac = Math.max(m.fac_l || 0, m.fac_r || 0);
  let l = { 3: 'hochbord', 2: 'radstreifen', 1: 'schutzstreifen' }[fac] || 'mischverkehr';
  if (m.bike === 2) l = 'radweg_daneben'; if (m.frs) l = 'fahrradstrasse';
  return l;
}
function ortStatistik(o) {
  const T = man.tile_size_m[0];
  let soll = 0, da = 0; const st = {}; const add = (k, v) => st[k] = (st[k] || 0) + v;
  // Kachelindizes sind absolute UTM-Kilometer (Ost, Nord)
  for (let iy = Math.floor((o.n - o.R) / T); iy <= Math.floor((o.n + o.R) / T); iy++)
    for (let ix = Math.floor((o.e - o.R) / T); ix <= Math.floor((o.e + o.R) / T); ix++) {
      if (!store.exists(0, ix, iy)) continue; soll++;
      const t = store.get(0, ix, iy); if (!t) continue; da++;
      for (const r of t.roads) {
        if (!r.own) continue;
        const mx = (r.bb[0] + r.bb[2]) / 2, my = (r.bb[1] + r.bb[3]) / 2;
        if (Math.hypot(mx - o.x, my - o.y) > o.R) continue;
        const m = r.m, km = r.len / 1000;
        add('klasse:' + m.cls, km);
        if (['L', 'dorf', 'wohn', 'spiel'].includes(m.cls)) { add('strassen', km); add('radinfra:' + radinfraLabel(m), km); if ((m.ms || 50) <= 30) add('tempo30', km); }
        if (m.cls === 'rad') add('radwege_eigen', km);
        if (m.bike !== 0 && m.cls !== 'auto') { const h = Math.max(m.fac_l || 0, m.fac_r || 0) === 3; add('belag:' + (h ? m.tsurf : m.surf), km); add('_zs', km * ((h ? m.tcond : m.cond) ?? 50)); add('_zk', km); }
      }
    }
  st.zustand_rad_mittel = st._zk ? Math.round(st._zs / st._zk * 10) / 10 : null;
  return { st, soll, da };
}
function surveyKopf(titel, st, extra) {
  const k = [['Straßen', fmt(st.strassen || 0, 1) + ' km'], ['Tempo ≤ 30', st.strassen ? Math.round((st.tempo30 || 0) / st.strassen * 100) + ' %' : '–'], ['Ø Zustand Rad', st.zustand_rad_mittel != null ? fmt(st.zustand_rad_mittel, 1) : '–']];
  return `<div class="insp-title">${esc(titel)}</div>${extra || ''}<dl class="kv">${k.map(x => `<dt>${x[0]}</dt><dd>${x[1]}</dd>`).join('')}</dl>`;
}
function updateSurvey(force) {
  const now = performance.now(); if (!force && now - ortT < 400) return; ortT = now;
  const o = findeOrt();
  if (!o) {
    if (ortAktuell !== 'region') { ortAktuell = 'region'; $('survey-ort').textContent = 'ganze Region'; $('survey').innerHTML = regionSurvey(); }
    return;
  }
  const { st, soll, da } = ortStatistik(o);
  const vk = verkehr ? verkehr.imKreis(o.x, o.y, o.R) : null;
  const sig = o.name + o.e + ':' + da + ':' + spiel.s.log.length + ':' + (verkehr && verkehr.erg ? verkehr.erg.t : 0);
  if (!force && sig === ortAktuell) return; ortAktuell = sig;
  $('survey-ort').textContent = o.name;
  const hinweis = da < soll ? `<div class="note">Lade Ortsdaten … ${da}/${soll} Kacheln</div>` : `<div class="note">Umkreis ${fmt(o.R / 1000, 1)} km um den Ortsmittelpunkt, Ausbauten eingerechnet.</div>`;
  const vkHtml = vk && vk.wege ? `<dl class="kv"><dt>Radanteil (Modell)</dt><dd>${fmt(vk.anteil * 100, 1)} %</dd><dt>Zufriedenheit</dt><dd>${fmt(vk.zufrieden, 1)}</dd><dt>Einwohner (geschätzt)</dt><dd>${fmt(vk.ew)}</dd></dl>` : '';
  $('survey').innerHTML = surveyKopf(o.name, st, hinweis) + vkHtml + surveyBars(st);
}

/* ----------------------------- Panels ----------------------------- */
let regionSurvey = () => '';
const RADINFRA = { mischverkehr: 'Mischverkehr', radweg_daneben: 'Radweg daneben', hochbord: 'Hochbord-Radweg', radstreifen: 'Radfahrstreifen', schutzstreifen: 'Schutzstreifen', fahrradstrasse: 'Fahrradstraße' };
function barsOf(st, title, prefix, labels) {
  const rows = Object.entries(st).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [labels ? (labels[k.slice(prefix.length)] || k.slice(prefix.length)) : k.slice(prefix.length), v]).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const tot = rows.reduce((a, r) => a + r[1], 0) || 1;
  if (!rows.length) return '';
  return `<div class="lbl" style="margin:8px 0 4px">${title}</div><div class="bars">${rows.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><i style="width:${Math.max(2, v / tot * 100)}%"></i><b>${fmt(v, v < 10 ? 1 : 0)} km</b></div>`).join('')}</div>`;
}
function renderStats() {
  const st = man.statistik || {};
  const facts = [['Straßen', fmt(st.strassen || 0, 0) + ' km'], ['Eigene Radwege', fmt(st.radwege_eigen || 0, 0) + ' km'], ['Tempo ≤ 30', st.strassen ? Math.round((st.tempo30 || 0) / st.strassen * 100) + ' %' : '–'],
    ['Gebäude', fmt(st.gebaeude || 0)], ['Ø Zustand Rad', st.zustand_rad_mittel ?? '–'], ...(st.hoehe_max != null ? [['Höhe', `${fmt(st.hoehe_min)}–${fmt(st.hoehe_max)} m`]] : [])];
  $('facts').innerHTML = facts.map(f => `<div class="fact"><span class="lbl">${f[0]}</span><b>${f[1]}</b></div>`).join('');
  regionSurvey = () => surveyBars(st);
}
function surveyBars(st) {
  return barsOf(st, 'Radinfrastruktur an Straßen', 'radinfra:', RADINFRA) + barsOf(st, 'Belag, wo Räder fahren dürfen', 'belag:', SURF) + barsOf(st, 'Straßen und Wege nach Art', 'klasse:', CLS);
}
function setupSearch() {
  const dl = $('orte');
  dl.innerHTML = (man.orte || []).map(o => `<option value="${esc(o.name)}">`).join('');
  $('suche').addEventListener('change', e => {
    const o = (man.orte || []).find(p => p.name.toLowerCase() === e.target.value.trim().toLowerCase());
    if (!o) return;
    flyTo(o.e - man.bbox_utm[0], man.bbox_utm[3] - o.n, o.rang <= 2 ? .25 : o.rang <= 3 ? .6 : 1.4);
    e.target.blur();
  });
}
function setOverlay(o) {
  if (modus === 'iso' && overlay !== o) zuKarte();
  overlay = overlay === o ? null : o; dirty = true;
  document.querySelectorAll('[data-ov]').forEach(b => b.setAttribute('aria-pressed', b.dataset.ov === overlay));
  const lg = $('legend'); lg.hidden = !overlay;
  const grad = '<div class="bar"></div>';
  if (overlay === 'cond') lg.innerHTML = `<div class="lbl">Zustand Fahrbahn und Radweg</div>${grad}<div class="ends"><span>gut</span><span>marode</span></div>`;
  if (overlay === 'risk') lg.innerHTML = `<div class="lbl">Risiko für Radfahrende</div>${grad}<div class="ends"><span>sicher</span><span>gefährlich</span></div><div class="keys"><i style="background:#7e8279"></i><span>Radweg daneben benutzen</span></div>`;
  if (overlay === 'net') lg.innerHTML = '<div class="lbl">Radnetz</div><div class="keys"><i style="background:#e0563a"></i><span>Radweg / Fahrradstraße</span><i style="background:#f08a3a"></i><span>Hochbord-Radweg</span><i style="background:#f2c230"></i><span>Rad-/Schutzstreifen</span><i style="background:#9cc23e"></i><span>Tempo ≤ 30, Mischverkehr</span><i style="background:#9a9fa6"></i><span>Tempo 50+, Mischverkehr</span><i style="background:#7e8279"></i><span>Radweg daneben</span><i style="background:#c7b287"></i><span>Feld- und Waldweg</span><i style="background:rgba(31,90,166,.55);height:8px"></i><span>Ausgeschilderte Radroute</span></div>';
  if (overlay === 'route') { routeSig = ''; lg.innerHTML = ''; }
  if (overlay === 'verkehr') lg.innerHTML = `<div class="lbl">Radfahrten pro Tag (Modell)</div><div class="keys">${VK_KL.map((k, i) => `<i style="background:${k[1]};height:${Math.max(3, k[2])}px"></i><span>${i < VK_KL.length - 1 ? `${k[0]}–${VK_KL[i + 1][0]}` : `ab ${k[0]}`}</span>`).join('')}</div><div class="hint">Wege zwischen Wohnorten und Zielen, umgelegt auf die angenehmsten Radrouten.</div>`;
  if (overlay === 'steig') lg.innerHTML = `<div class="lbl">Steigung (steilstes Stück über 30 m)</div><div class="keys">${STEIG.map((k, i) => `<i style="background:${k[1]}"></i><span>${i < STEIG.length - 1 ? `${k[0] / 10}–${STEIG[i + 1][0] / 10} %` : `ab ${k[0] / 10} %`}</span>`).join('')}</div><div class="hint">Aus dem Geländemodell. Steigungen fließen ins Verkehrsmodell ein.</div>`;
  if (overlay === 'zuf') lg.innerHTML = '<div class="lbl">Zufriedenheit mit dem Radnetz</div><div class="bar" style="background:linear-gradient(90deg,#d8452f,#e2c43a,#3fae4a)"></div><div class="ends"><span>unzufrieden</span><span>zufrieden</span></div><div class="hint">Je 500-m-Zelle: wie direkt und stressfrei die Radwege zu den Zielen bis 10 km sind.</div>';
  if (overlay && !['route', 'verkehr', 'zuf', 'steig'].includes(overlay) && levelIndex() < 2) lg.innerHTML += '<div class="hint">Weit herausgezoomt: nur Haupt- und Sammelstraßen.</div>';
}

/* ----------------------------- Eingabe ----------------------------- */
/* ----------------------------- Reiter im Seitenpanel ----------------------------- */
function zeigeReiter(t) {
  document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t));
  document.querySelectorAll('[data-pane]').forEach(p => p.hidden = p.dataset.pane !== t);
  $('side').classList.remove('zu');
}
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => zeigeReiter(b.dataset.tab));
$('side-zu').onclick = () => $('side').classList.toggle('zu');
function legendeSetzen() { document.documentElement.style.setProperty('--legend-bottom', ($('views').offsetHeight + 26) + 'px'); }
new ResizeObserver(legendeSetzen).observe($('views'));

/* ----------------------------- Werkzeuge: Strecke und Kreuzung ----------------------------- */
// Strecke: Start anklicken, dann Ziel (und beliebige Zwischenpunkte). Dazwischen folgt eine Wegsuche
// der Straße über alle Abschnitte – auch die kurzen Stücke an Kreuzungen werden mitgenommen.
const TASTE = { 1: 'schutz', 2: 'streifen', 3: 'hochbord', 4: 'radweg_san', 5: 'decke', 6: 'radweg', 7: 'asphalt', 8: 'tempo30', 9: 'frs', a: 'ampel', k: 'kreisel' };
let werkzeug = 'auswahl', wege = [], vorschau = null, vorschauVon = '', kHover = null, kSel = null, netzCache = null, netzSig = '';
const ausbauVon = w => AUSBAU.find(a => a.id === w), knotenbauVon = w => KNOTEN.find(a => a.id === w);
function aktivesNetz() {
  const tiles = loadedTiles(0), sig = tiles.length + ':' + spiel.s.log.length + ':' + Object.keys(spiel.s.kanten).length;
  if (sig !== netzSig) { netzCache = lokalesNetz(tiles); netzSig = sig; }
  return netzCache;
}
const erlaubtFuer = a => a.art === 'weg' ? r => !isRoad(r.m) && r.m.cls !== 'treppe' : r => isRoad(r.m) && r.m.cls !== 'auto';
function strecke(mitVorschau) {
  const out = [], seen = new Set();
  for (const seg of mitVorschau && vorschau ? [...wege, vorschau] : wege) for (const r of seg) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
  return out;
}
const letzte = () => { const w = wege[wege.length - 1]; return w ? w[w.length - 1] : null; };
function setWerkzeug(w) {
  if (werkzeug === w && w !== 'auswahl') w = 'auswahl';
  werkzeug = w; wege = []; vorschau = null; kHover = kSel = null;
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === w));
  $('mapwin').classList.toggle('bauen', w !== 'auswahl');
  if (w !== 'auswahl') { selected = null; multi = []; zugSel = []; }
  renderToolpanel(); dirty = true;
}
function renderToolpanel() {
  const tp = $('toolpanel'); if (werkzeug === 'auswahl') { tp.hidden = true; return; }
  tp.hidden = false; $('tp-icon').setAttribute('href', '#i-' + werkzeug);
  const nah = pxProM() >= .22;
  if (ausbauVon(werkzeug)) {
    const a = ausbauVon(werkzeug), alle = strecke(false), pass = alle.filter(r => a.gilt(r.m)), c = gesamt(a, pass), km = alle.reduce((s2, r) => s2 + r.len, 0) / 1000;
    $('tp-name').textContent = a.name; $('tp-info').textContent = a.info;
    const hinweis = !nah ? 'Zum Bauen bis zur Ortsansicht heranzoomen.' : !wege.length ? 'Start anklicken (Straße bzw. Weg).' : 'Ziel oder Zwischenpunkt anklicken · Enter oder Doppelklick baut · Rücktaste nimmt den letzten Punkt zurück.';
    $('tp-body').innerHTML = `<div class="k"><span>Abschnitte</span><b>${alle.length}</b></div><div class="k"><span>Länge</span><b>${fmt(km, 2)} km</b></div>
      <div class="k"><span>Passend</span><b>${pass.length}${alle.length > pass.length ? ` <small class="est">(${alle.length - pass.length} schon / nicht möglich)</small>` : ''}</b></div>
      <div class="k cost${c > spiel.s.budget ? ' zu-teuer' : ''}"><span>Kosten</span><b>${eur(c)}</b></div><div class="hint">${hinweis}</div>`;
    $('tp-bauen').disabled = !pass.length || c > spiel.s.budget; $('tp-zug').hidden = false; $('tp-zug').disabled = !wege.length; $('tp-zurueck').disabled = !wege.length;
  } else {
    const a = knotenbauVon(werkzeug), k = kSel ? knotenInfo(aktivesNetz(), kSel.id, spiel) : null, geht = k && a.gilt(k);
    $('tp-name').textContent = a.name; $('tp-info').textContent = a.info;
    const grund = !k ? (nah ? 'Kreuzung anklicken.' : 'Zum Bauen bis zur Ortsansicht heranzoomen.') : geht ? `Kreuzung ${k.namen.join(' / ') || '(ohne Namen)'} · ${k.strassen} Straßen` :
      k.ampel && a.id === 'ampel' ? 'Hier gibt es schon eine Ampel.' : k.kreisel ? 'Hier gibt es schon einen Kreisverkehr.' : k.autobahn ? 'Nicht an Autobahnen.' : a.id === 'kreisel' ? 'Ein Kreisverkehr braucht mindestens drei Straßen.' : 'Hier ist keine Kreuzung von Straßen.';
    $('tp-body').innerHTML = `<div class="k"><span>Kreuzung</span><b>${k ? k.strassen + ' Straßen' : '–'}</b></div><div class="k"><span>Höchster Rang</span><b>${k ? ['–', 'Zufahrt', 'Wohnstraße', 'Sammelstraße', 'Hauptstraße', 'Autobahn'][k.rang] : '–'}</b></div>
      <div class="k"><span>Bestand</span><b>${k ? (k.kreisel ? 'Kreisel' : k.ampel ? 'Ampel' : 'Vorfahrt') : '–'}</b></div><div class="k cost${a.fix > spiel.s.budget ? ' zu-teuer' : ''}"><span>Kosten</span><b>${eur(a.fix)}</b></div><div class="hint">${grund}</div>`;
    $('tp-bauen').disabled = !geht || a.fix > spiel.s.budget; $('tp-zug').hidden = true; $('tp-zurueck').disabled = !kSel;
  }
}
function werkzeugKlick(wx, wy) {
  if (pxProM() < .22) { zoomAt(Math.min(cam.z * 3, 1.2), (wx - cam.x) * cam.z, (wy - cam.y) * cam.z); return; }
  const netz = aktivesNetz();
  if (ausbauVon(werkzeug)) {
    const a = ausbauVon(werkzeug), r = pickRoad(wx, wy), ok = erlaubtFuer(a);
    if (!r || !ok(r)) { $('bau-msg').textContent = a.art === 'weg' ? 'Dieses Werkzeug baut Wege, keine Straßen.' : 'Dieses Werkzeug baut Straßen, keine Wege.'; return; }
    const n = netz.kanten.get(r.id) || r;
    if (!wege.length) wege.push([n]);
    else { const p = pfad(netz, letzte(), n, ok); if (p) wege.push(p.slice(1)); else $('bau-msg').textContent = 'Keine durchgehende Verbindung gefunden.'; }
    vorschau = null; vorschauVon = '';
  } else {
    const k = naechsteKreuzung(netz, wx, wy, 30 / pxProM() + 8); kSel = k;
  }
  renderToolpanel(); dirty = true;
}
function werkzeugHover(wx, wy) {
  if (pxProM() < .22) return;
  const netz = aktivesNetz();
  if (ausbauVon(werkzeug)) {
    if (!wege.length) return;
    const r = pickRoad(wx, wy), a = ausbauVon(werkzeug), ok = erlaubtFuer(a);
    const key = r ? r.id : ''; if (key === vorschauVon) return; vorschauVon = key;
    vorschau = r && ok(r) ? (pfad(netz, letzte(), netz.kanten.get(r.id) || r, ok) || [null]).slice(1).filter(Boolean) : null;
    dirty = true;
  } else {
    const k = naechsteKreuzung(netz, wx, wy, 30 / pxProM() + 8); if (k !== kHover) { kHover = k; dirty = true; }
  }
}
function werkzeugBauen() {
  if (ausbauVon(werkzeug)) {
    const a = ausbauVon(werkzeug), alle = strecke(false); if (!alle.length) return;
    const namen = [...new Set(alle.map(x => x.m.name || x.m.ref).filter(Boolean))];
    const e = spiel.bauen(a, alle, namen.length === 1 ? namen[0] : namen.length ? namen.length + ' Straßen' : '');
    if (!e) { $('bau-msg').textContent = 'Nicht genug Geld oder nichts Passendes ausgewählt.'; return; }
    wege = []; vorschau = null; vorschauVon = '';
    nachBau(`${a.name}${e.name ? ' · ' + e.name : ''}: ${e.kanten.length} Abschnitt${e.kanten.length > 1 ? 'e' : ''} für ${eur(e.kosten)}`);
  } else if (kSel) {
    const a = knotenbauVon(werkzeug), k = knotenInfo(aktivesNetz(), kSel.id, spiel), name = k.namen.join(' / ') || 'Kreuzung';
    const e = spiel.bauenKnoten(a, kSel.id, k, name); if (!e) return;
    kSel = null; nachBau(`${a.name} gebaut: ${name} für ${eur(e.kosten)}`);
  }
  renderToolpanel();
}
function werkzeugZurueck() { if (ausbauVon(werkzeug)) wege.pop(); else kSel = null; vorschau = null; vorschauVon = ''; renderToolpanel(); dirty = true; }
document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setWerkzeug(b.dataset.tool));
$('tp-bauen').onclick = werkzeugBauen; $('tp-zurueck').onclick = werkzeugZurueck;
$('tp-abbruch').onclick = () => { if (wege.length || kSel) { wege = []; kSel = null; vorschau = null; renderToolpanel(); dirty = true; } else setWerkzeug('auswahl'); };
$('tp-zug').onclick = () => { // ganze Straße des ersten Abschnitts
  const a = ausbauVon(werkzeug); if (!a || !wege.length) return;
  const zug = strassenzug(store, wege[0][0]).filter(erlaubtFuer(a)), netz = aktivesNetz();
  wege.push(zug.map(r => netz.kanten.get(r.id) || r)); renderToolpanel(); dirty = true;
};
const ZEIGE = (r, breite, farbe, strich) => stroke(vctx, r.P, breite, farbe, strich);
function zeichneWerkzeug() {
  vctx.lineCap = 'round'; vctx.lineJoin = 'round';
  const a = ausbauVon(werkzeug);
  if (a) {
    const w = r => Math.max(r.half * 2 + 2, 5 / cam.z);
    if (vorschau) for (const r of vorschau) ZEIGE(r, w(r), a.gilt(r.m) ? 'rgba(92,207,138,.38)' : 'rgba(220,220,220,.22)');
    for (const r of strecke(false)) ZEIGE(r, w(r), a.gilt(r.m) ? 'rgba(92,207,138,.85)' : 'rgba(220,220,220,.5)', a.gilt(r.m) ? null : [2 / cam.z, 2 / cam.z]);
    for (const seg of wege) { const r = seg[seg.length - 1], P = r.P, q = P[Math.floor(P.length / 2)]; vctx.beginPath(); vctx.arc(q[0], q[1], 6 / cam.z, 0, Math.PI * 2); vctx.fillStyle = '#5ccf8a'; vctx.fill(); vctx.lineWidth = 2 / cam.z; vctx.strokeStyle = '#0d1f15'; vctx.stroke(); }
  } else {
    for (const [k, farbe, fill] of [[kHover, 'rgba(255,255,255,.7)', null], [kSel, '#5ccf8a', 'rgba(92,207,138,.25)']]) {
      if (!k) continue; vctx.beginPath(); vctx.arc(k.x, k.y, Math.max(14, 14 / cam.z), 0, Math.PI * 2);
      if (fill) { vctx.fillStyle = fill; vctx.fill(); } vctx.lineWidth = 2.5 / cam.z; vctx.strokeStyle = farbe; vctx.stroke();
    }
  }
}
// Gebaute Ampeln und Kreisverkehre auf der Karte
function knotenPos(id) {
  const n = netzCache && netzCache.knoten.get(Number(id)); if (n) return [n.x, n.y];
  return verkehr && verkehr.kid ? verkehr.knotenPos(Number(id)) : null;
}
function zeichneKnotenBauten() {
  const vx0 = cam.x - 40, vy0 = cam.y - 40, vx1 = cam.x + vw / cam.z + 40, vy1 = cam.y + vh / cam.z + 40;
  for (const [id, k] of Object.entries(spiel.s.knoten)) {
    const p = knotenPos(id); if (!p || p[0] < vx0 || p[0] > vx1 || p[1] < vy0 || p[1] > vy1) continue;
    const [x, y] = p;
    if (k.kreisel) {
      const R = Math.max(11, 6 / cam.z);
      vctx.beginPath(); vctx.arc(x, y, R, 0, Math.PI * 2); vctx.fillStyle = '#4b4d53'; vctx.fill();
      vctx.lineWidth = Math.max(.4, 1.2 / cam.z); vctx.strokeStyle = '#bdb8ab'; vctx.stroke();
      vctx.beginPath(); vctx.arc(x, y, R * .48, 0, Math.PI * 2); vctx.fillStyle = '#6aa64f'; vctx.fill(); vctx.strokeStyle = '#d9d4c7'; vctx.stroke();
      if (cam.z > 1.5) { vctx.setLineDash([1.5, 1.5]); vctx.lineWidth = .18; vctx.strokeStyle = '#e9e6dc'; vctx.beginPath(); vctx.arc(x, y, R * .75, 0, Math.PI * 2); vctx.stroke(); vctx.setLineDash([]); }
    } else if (k.ampel) {
      const q = Math.max(1, 10 / (3.6 * cam.z)), w = 1.4 * q, h = 3.6 * q, ox = x + 2.5 * q, oy = y - h - 1.5 * q;
      vctx.fillStyle = '#1e2124'; vctx.fillRect(ox, oy, w, h);
      [['#ef5a4a', .2], ['#f2c230', .5], ['#4cd07d', .8]].forEach(([c, f]) => { vctx.beginPath(); vctx.arc(ox + w / 2, oy + h * f, w * .3, 0, Math.PI * 2); vctx.fillStyle = c; vctx.fill(); });
    }
  }
}

/* ----------------------------- Spielansicht (isometrisch) ----------------------------- */
// Karte = Überblick, Planung, Auswertungsebenen. Spielansicht = Ort und Detail, hier wird gespielt.
// Weit hineinzoomen in der Karte wechselt in die Spielansicht, weiter herauszoomen wieder zurück.
const ISO_AB = 2.4; // ab dieser Kartenvergrößerung (px/m) in die Spielansicht
function zuIso(x, y, stufe = 2) {
  if (!man) return;
  modus = 'iso'; overlay && setOverlay(overlay); // Ebenen gibt es nur in der Karte
  Iso.setzeMitte(x, y); Iso.setzeZoom(stufe); Iso.groesse(vw, vh);
  document.body.classList.add('iso'); $('t-iso').setAttribute('aria-pressed', 'true'); $('legend').hidden = true;
  if (!selected) $('side').classList.add('zu'); // mehr Platz für die Stadt
  liveRect = null; liveSig = ''; hover = null; dirty = true; renderToolpanel();
}
function zuKarte() {
  if (modus !== 'iso') return;
  const cx = Iso.cam.x, cy = Iso.cam.y;
  modus = 'karte'; cam.z = Math.min(ISO_AB * .7, 1.6); cam.x = cx - vw / cam.z / 2; cam.y = cy - vh / cam.z / 2; clampCam();
  document.body.classList.remove('iso'); $('t-iso').setAttribute('aria-pressed', 'false');
  liveRect = null; liveSig = ''; hover = null; dirty = true; renderToolpanel();
}
function zeichneIso() {
  const m = [];
  const umriss = (r, farbe, fill) => { if (fill) m.push({ P: r.P, breite: r.half * 2 + 1, farbe: fill }); for (const sd of [1, -1]) m.push({ P: offsetLine(r.P, sd * (r.half + .6)), breite: .45, farbe }); };
  if (hover && hover !== selected && werkzeug === 'auswahl') umriss(hover, 'rgba(255,255,255,.7)');
  for (const z of zugSel) if (z !== selected) umriss(z, 'rgba(255,226,90,.7)', 'rgba(255,226,90,.12)');
  if (selected) umriss(selected, '#ffe25a', 'rgba(255,226,90,.18)');
  if (werkzeug !== 'auswahl') m.push(...werkzeugMarker());
  const fehlt = Iso.zeichne(vctx, { live: liveAktiv(), marker: m, zeit: performance.now() / 1000 });
  // Kamera der Karte mitführen (Rückweg, gespeicherte Position)
  cam.x = Iso.cam.x - vw / cam.z / 2; cam.y = Iso.cam.y - vh / cam.z / 2;
  $('lvl').textContent = `Spielansicht · ${Iso.blick()}blick · ${fmt(Iso.pxProM(), 0)} px/m`;
  $('busy').hidden = !(store.active || store.queue.length || fehlt);
  saveCam();
}
function werkzeugMarker() {
  const out = [], a = ausbauVon(werkzeug);
  if (a) {
    if (vorschau) for (const r of vorschau) out.push({ P: r.P, breite: r.half * 2 + 2, farbe: a.gilt(r.m) ? 'rgba(92,207,138,.45)' : 'rgba(220,220,220,.3)' });
    for (const r of strecke(false)) out.push({ P: r.P, breite: r.half * 2 + 2, farbe: a.gilt(r.m) ? 'rgba(92,207,138,.85)' : 'rgba(220,220,220,.55)', strich: a.gilt(r.m) ? null : [2, 2] });
    for (const seg of wege) { const r = seg[seg.length - 1], q = r.P[Math.floor(r.P.length / 2)]; out.push({ x: q[0], y: q[1], r: 2.5, farbe: '#0d1f15', fill: '#5ccf8a' }); }
  } else {
    if (kHover) out.push({ x: kHover.x, y: kHover.y, r: 13, farbe: 'rgba(255,255,255,.8)' });
    if (kSel) out.push({ x: kSel.x, y: kSel.y, r: 13, farbe: '#5ccf8a', fill: 'rgba(92,207,138,.3)' });
  }
  return out;
}
let radT = 0;
function isoRad(dir) { // ein Rastschritt pro Mausrad-Geste
  const now = performance.now(); if (now - radT < 140) return; radT = now;
  if (dir > 0) Iso.zoom(1); else if (!Iso.zoom(-1)) { zuKarte(); return; }
  dirty = true; renderToolpanel();
}
$('t-iso').onclick = () => modus === 'iso' ? zuKarte() : zuIso(cam.x + vw / cam.z / 2, cam.y + vh / cam.z / 2);
$('r-l').onclick = () => { Iso.drehen(-1); dirty = true; };
$('r-r').onclick = () => { Iso.drehen(1); dirty = true; };
const ZEIT_FOLGE = ['tag', 'abend', 'nacht', 'morgen'], ZEIT_TEXT = { tag: '☀ Tag', abend: '🌇 Abend', nacht: '🌙 Nacht', morgen: '🌅 Morgen' };
function setZeit(z) { Iso.setzeZeit(z); $('t-zeit').textContent = ZEIT_TEXT[z]; try { localStorage.setItem('rtc-zeit', z); } catch (e) {} dirty = true; }
$('t-zeit').onclick = () => setZeit(ZEIT_FOLGE[(ZEIT_FOLGE.indexOf(Iso.tageszeit()) + 1) % 4]);
try { const z = localStorage.getItem('rtc-zeit'); if (z) setZeit(z); } catch (e) {}
$('t-haus').onclick = () => { const an = $('t-haus').getAttribute('aria-pressed') !== 'true'; $('t-haus').setAttribute('aria-pressed', an); Iso.haeuserZeigen(!an); dirty = true; };

const pointers = new Map(); let down = null, moved = false, pinch = null;
const evPos = e => { const r = view.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
view.addEventListener('pointerdown', e => {
  view.setPointerCapture(e.pointerId); const p = evPos(e); pointers.set(e.pointerId, p);
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: cam.z, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; return; }
  down = p; moved = false;
});
view.addEventListener('pointermove', e => {
  const p = evPos(e);
  if (pointers.has(e.pointerId)) {
    const prev = pointers.get(e.pointerId); pointers.set(e.pointerId, p);
    if (pinch && pointers.size === 2 && modus === 'iso') { const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); if (d > pinch.d * 1.25) { isoRad(1); pinch.d = d; } else if (d < pinch.d / 1.25) { isoRad(-1); pinch.d = d; } return; }
    if (pinch && pointers.size === 2) { const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2; cam.x -= (mx - pinch.mx) / cam.z; cam.y -= (my - pinch.my) / cam.z; pinch.mx = mx; pinch.my = my; zoomAt(pinch.z * d / pinch.d, mx, my); return; }
    if (down && Math.hypot(p.x - down.x, p.y - down.y) > 4) moved = true;
    if (moved) { if (modus === 'iso') Iso.verschiebe(p.x - prev.x, p.y - prev.y); else { cam.x -= (p.x - prev.x) / cam.z; cam.y -= (p.y - prev.y) / cam.z; clampCam(); } dirty = true; }
    return;
  }
  if (!man) return;
  if (werkzeug !== 'auswahl') werkzeugHover(...weltPunkt(p));
  const r = pickRoad(...weltPunkt(p));
  if (r !== hover) { hover = r; dirty = true; }
  const tip = $('tip');
  if (r) { const m = r.m, bv = bikeValues(m); tip.innerHTML = `<b>${esc(m.name || CLS[m.cls])}</b>${CLS[m.cls]}${m.ms ? ' · Tempo ' + (m.ms === 7 ? 'Schritt' : m.ms) : ''}<br>Zustand ${Math.round(Math.min(m.cond ?? 100, m.tcond ?? 100))}${bv.use ? ' · Risiko ' + Math.round(bv.risk * 100) : ''}`; tip.hidden = false;
    tip.style.left = clamp(p.x + 14, 4, vw - tip.offsetWidth - 4) + 'px'; tip.style.top = clamp(p.y + 16, 4, vh - tip.offsetHeight - 4) + 'px'; }
  else tip.hidden = true;
});
function endP(e) {
  if (!pointers.has(e.pointerId)) return; const p = pointers.get(e.pointerId); pointers.delete(e.pointerId);
  if (pinch) { if (pointers.size < 2) pinch = null; return; }
  if (!moved && down && man && werkzeug !== 'auswahl') { werkzeugKlick(...weltPunkt(p)); down = null; return; }
  if (!moved && down && man) { const r = pickRoad(...weltPunkt(p));
    if (e.shiftKey && r && selected) {
      if (!multi.length) multi = [selected];
      const k = multi.findIndex(x => x.id === r.id);
      if (k >= 0) multi.splice(k, 1); else multi.push(r);
      zugModus = false;
      inspect(multi.length ? multi[multi.length - 1] : null);
    } else { multi = []; inspect(r); } if (!r && modus === 'karte' && cam.z < .22) zoomAt(Math.min(cam.z * 3, 1.2), p.x, p.y); }
  down = null;
}
view.addEventListener('dblclick', () => { if (ausbauVon(werkzeug) && wege.length) werkzeugBauen(); });
view.addEventListener('pointerup', endP); view.addEventListener('pointercancel', endP);
view.addEventListener('pointerleave', () => { hover = null; $('tip').hidden = true; dirty = true; });
view.addEventListener('wheel', e => { e.preventDefault(); if (modus === 'iso') return isoRad(-e.deltaY); const p = evPos(e); zoomAt(cam.z * Math.pow(1.0015, -e.deltaY), p.x, p.y); if (cam.z > ISO_AB && !overlay) { const [x, y] = weltPunkt({ x: vw / 2, y: vh / 2 }); zuIso(x, y, 1); } }, { passive: false });
$('z-in').onclick = () => { if (modus === 'iso') return isoRad(1); zoomAt(cam.z * 1.5, vw / 2, vh / 2); if (cam.z > ISO_AB && !overlay) zuIso(cam.x + vw / cam.z / 2, cam.y + vh / cam.z / 2, 1); };
$('z-out').onclick = () => { if (modus === 'iso') { radT = 0; return isoRad(-1); } zoomAt(cam.z / 1.5, vw / 2, vh / 2); };
document.querySelectorAll('[data-ov]').forEach(b => b.onclick = () => setOverlay(b.dataset.ov));
$('t-names').onclick = () => { showNames = !showNames; $('t-names').setAttribute('aria-pressed', showNames); dirty = true; };
window.addEventListener('keydown', e => {
  if (e.target.closest && e.target.closest('input')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); $('undo').click(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (TASTE[k]) { setWerkzeug(TASTE[k]); return; }
  if (k === 'escape') { if (werkzeug !== 'auswahl' && (wege.length || kSel)) $('tp-abbruch').click(); else if (werkzeug !== 'auswahl') setWerkzeug('auswahl'); else inspect(null); return; }
  if (k === 'enter' && werkzeug !== 'auswahl') { werkzeugBauen(); return; }
  if (k === 'backspace' && werkzeug !== 'auswahl') { e.preventDefault(); werkzeugZurueck(); return; }
  if (modus === 'iso' && (k === 'q' || k === 'e')) { Iso.drehen(k === 'q' ? -1 : 1); dirty = true; return; }
  if (modus === 'iso' && k === 'h') { $('t-haus').click(); return; }
  if (modus === 'iso' && k === 'u') { $('t-zeit').click(); return; }
  if (k === 'z') setOverlay('cond'); if (k === 's') setOverlay('risk'); if (k === 'r') setOverlay('net'); if (k === 't') setOverlay('route'); if (k === 'v') setOverlay('verkehr'); if (k === 'f') setOverlay('zuf'); if (k === 'l') setLive(!liveAn); if (k === 'b') setOverlay('steig'); if (k === 'g') setRelief(!reliefAn); if (k === 'i') $('t-iso').click(); if (k === 'n') $('t-names').click();
  if (k === '+' || k === '=') { radT = 0; $('z-in').click(); } if (k === '-') { radT = 0; $('z-out').click(); }
  const pan = 120 / pxProM();
  if (k === 'arrowleft') cam.x -= pan; if (k === 'arrowright') cam.x += pan; if (k === 'arrowup') cam.y -= pan; if (k === 'arrowdown') cam.y += pan;
  if (k.startsWith('arrow')) { if (modus === 'iso') { const d = { arrowleft: [120, 0], arrowright: [-120, 0], arrowup: [0, 120], arrowdown: [0, -120] }[k]; Iso.verschiebe(d[0], d[1]); } else clampCam(); dirty = true; }
});
document.fonts && document.fonts.ready.then(() => { dirty = true; });

start();
