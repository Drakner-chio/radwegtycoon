// Kacheln laden und in Weltkoordinaten umrechnen.
// Welt: Meter, x nach Osten, y nach SÜDEN (Bildschirmrichtung), Ursprung = linke obere Ecke der Region.
// UTM-Ost E -> x = E - E0,  UTM-Nord N -> y = N0 - N.

export class TileStore {
  constructor(base, manifest, onLoad) {
    this.base = base.endsWith('/') ? base : base + '/';
    this.man = manifest;
    this.sizes = manifest.tile_size_m;
    this.scale = manifest.scale;
    this.E0 = manifest.bbox_utm[0];
    this.N0 = manifest.bbox_utm[3];
    this.avail = Object.keys(manifest.tiles).map(l => new Set(manifest.tiles[l].map(([x, y]) => x + '_' + y)));
    this.cache = new Map();      // key -> dekodierte Kachel (LRU-Reihenfolge)
    this.loading = new Map();    // key -> Promise
    this.queue = [];
    this.active = 0;
    this.maxActive = 8;
    this.maxCache = [260, 80, 20];
    this.onLoad = onLoad;
    this.errors = 0;
  }
  key(l, ix, iy) { return `${l}/${ix}_${iy}`; }
  exists(l, ix, iy) { return this.avail[l] && this.avail[l].has(ix + '_' + iy); }

  // Kachel holen: sofort, falls im Speicher; sonst Ladeauftrag (Priorität = Reihenfolge der Anfragen)
  get(l, ix, iy) {
    if (!this.exists(l, ix, iy)) return undefined;
    const k = this.key(l, ix, iy);
    const t = this.cache.get(k);
    if (t) { this.cache.delete(k); this.cache.set(k, t); return t; }
    if (!this.loading.has(k) && !this.queue.some(q => q.k === k)) this.queue.push({ k, l, ix, iy });
    this.pump();
    return null;
  }
  // Lade-Warteschlange: neueste Wünsche zuerst (das, was gerade zu sehen ist)
  pump() {
    while (this.active < this.maxActive && this.queue.length) {
      const job = this.queue.pop();
      if (this.cache.has(job.k) || this.loading.has(job.k)) continue;
      this.active++;
      const p = this.fetchTile(job.l, job.ix, job.iy)
        .then(t => { this.cache.set(job.k, t); this.evict(job.l); this.onLoad && this.onLoad(job.l, job.ix, job.iy); })
        .catch(e => { this.errors++; console.warn('Kachel', job.k, e); this.avail[job.l].delete(job.ix + '_' + job.iy); })
        .finally(() => { this.active--; this.loading.delete(job.k); this.pump(); });
      this.loading.set(job.k, p);
    }
    if (this.queue.length > 400) this.queue = this.queue.slice(-200);
  }
  evict(l) {
    let n = 0;
    for (const k of this.cache.keys()) if (k.startsWith(l + '/')) n++;
    for (const k of this.cache.keys()) {
      if (n <= this.maxCache[l]) break;
      if (k.startsWith(l + '/')) { this.cache.delete(k); n--; }
    }
  }
  async fetchTile(l, ix, iy) {
    const r = await fetch(`${this.base}tiles/${l}/${ix}_${iy}.json.gz`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    let buf = new Uint8Array(await r.arrayBuffer());
    // Je nach Server kommt die Datei noch gepackt (1f 8b) oder schon entpackt an
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      const ds = new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')));
      buf = new Uint8Array(await ds.arrayBuffer());
    }
    return this.decode(JSON.parse(new TextDecoder().decode(buf)));
  }

  decode(t) {
    const sc = this.scale, ox = t.origin[0] - this.E0, oy = this.N0 - t.origin[1];
    const pts = c => { const P = new Array(c.length / 2); for (let i = 0, j = 0; i < c.length; i += 2, j++) P[j] = [ox + c[i] / sc, oy - c[i + 1] / sc]; return P; };
    const bb = P => { let x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12; for (const p of P) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; } return [x0, y0, x1, y1]; };
    const out = { lod: t.lod, ix: t.ix, iy: t.iy, size: t.size, x0: ox, y0: oy - t.size, x1: ox + t.size, y1: oy };
    out.areas = (t.areas || []).map(a => ({ k: a.k, rings: a.p.map(pts) }));
    out.lines = (t.lines || []).map(l => ({ k: l.k, name: l.name, P: pts(l.c) }));
    out.roads = (t.roads || []).map(r => {
      const P = pts(r.c);
      const p = this.patchFor && this.patchFor(r.id);
      const m = p ? { ...r.m, ...p } : r.m;
      const road = { id: r.id, w: r.w, a: r.a, b: r.b, len: r.len, own: !!r.own, m, m0: r.m, P, bb: bb(P) };
      road.half = halfWidth(m);
      return road;
    });
    out.buildings = (t.buildings || []).map(b => { const P = pts(b.p); return { t: b.t, name: b.name, lv: b.lv, P, bb: bb(P) }; });
    out.nodes = (t.nodes || []).map(n => ({ id: n.id, f: n.f, on: n.on, x: ox + n.x / sc, y: oy - n.y / sc }));
    out.pois = (t.pois || []).map(p => ({ k: p.k, name: p.name, x: ox + p.x / sc, y: oy - p.y / sc }));
    out.places = (t.places || []).map(p => ({ ...p, x: ox + p.x / sc, y: oy - p.y / sc }));
    // Knoten -> Richtung (für Zebrastreifen quer zur Straße)
    const byNode = new Map();
    for (const r of out.roads) { if (!byNode.has(r.a)) byNode.set(r.a, r); if (!byNode.has(r.b)) byNode.set(r.b, r); }
    const byId = new Map(out.roads.map(r => [r.id, r]));
    for (const n of out.nodes) {
      const r = (n.on && byId.get(n.on)) || byNode.get(n.id);
      if (!r) { n.dir = 0; n.cw = 3; continue; }
      let k = 0, best = 1e18;
      for (let i = 0; i < r.P.length; i++) { const d = (r.P[i][0] - n.x) ** 2 + (r.P[i][1] - n.y) ** 2; if (d < best) { best = d; k = i; } }
      const a = r.P[Math.max(0, k - 1)], b = r.P[Math.min(r.P.length - 1, k + 1)];
      n.dir = Math.atan2(b[1] - a[1], b[0] - a[0]);
      n.cw = r.m.cw || 3;
    }
    // Straßennamen: eine Stelle je benannter, eigener, langer Kante
    out.names = [];
    for (const r of out.roads) {
      if (!r.own || !r.m.name || r.len < 70 || !isRoad(r.m)) continue;
      const P = r.P; let acc = 0;
      for (let i = 1; i < P.length; i++) {
        const l = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
        if (acc + l >= r.len / 2) {
          const f = (r.len / 2 - acc) / (l || 1);
          let a = Math.atan2(P[i][1] - P[i - 1][1], P[i][0] - P[i - 1][0]);
          if (a > Math.PI / 2) a -= Math.PI; if (a < -Math.PI / 2) a += Math.PI;
          out.names.push({ name: r.m.name, x: P[i - 1][0] + (P[i][0] - P[i - 1][0]) * f, y: P[i - 1][1] + (P[i][1] - P[i - 1][1]) * f, a, len: r.len, cls: r.m.cls });
          break;
        }
        acc += l;
      }
    }
    return out;
  }
}

export const ROAD_CLASSES = new Set(['L', 'dorf', 'wohn', 'spiel', 'zufahrt', 'auto']);
export const isRoad = m => ROAD_CLASSES.has(m.cls);
export function halfWidth(m) {
  const cw = m.cw || 1.5;
  const track = (m.fac_l === 3 || m.fac_r === 3) ? 2.1 : 0;
  return cw + track + Math.max(m.sw_l || 0, m.sw_r || 0);
}
