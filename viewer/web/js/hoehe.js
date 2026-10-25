// Höhenraster (Pipeline-Schritt „hoehe“): 100 × 100 Zellen je Kachel, Int16 in dm, Zeilen Nord -> Süd.
// Liefert Relief-Schummerung als kleine Leinwand je Kachel und Höhenabfragen für Weltkoordinaten.
import { ladeJsonGz } from './verkehr-modell.js';

export class Hoehen {
  constructor(base, man) {
    this.base = base; this.man = man; this.h = man.hoehe; this.ok = !!man.hoehe;
    this.avail = this.ok ? Object.fromEntries(Object.entries(this.h.tiles).map(([l, a]) => [l, new Set(a.map(k => k[0] + '_' + k[1]))])) : {};
    this.cache = new Map(); this.laden = new Map(); this.relief = new Map(); this.onLoad = () => {};
    this.N = this.h ? this.h.zellen : 100; this.E0 = man.bbox_utm[0]; this.N0 = man.bbox_utm[3];
  }
  // undefined = keine Daten, null = lädt, sonst Int16Array
  raster(l, ix, iy) {
    const k = l + '/' + ix + '_' + iy; if (!this.avail[l] || !this.avail[l].has(ix + '_' + iy)) return undefined;
    if (this.cache.has(k)) return this.cache.get(k);
    if (!this.laden.has(k)) this.laden.set(k, this.hole(`${this.base}hoehe/${l}/${ix}_${iy}.bin.gz?v=${this.h.min}_${this.h.max}_${this.h.tiles['0'].length}`).then(a => { this.cache.set(k, a); this.laden.delete(k); this.onLoad(); }).catch(() => { this.cache.set(k, undefined); this.laden.delete(k); }));
    return null;
  }
  async hole(url) {
    const r = await fetch(url); if (!r.ok) throw new Error(r.status);
    let b = new Uint8Array(await r.arrayBuffer());
    if (b[0] === 0x1f && b[1] === 0x8b) b = new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    return new Int16Array(b.buffer, b.byteOffset, b.byteLength / 2);
  }
  // Schummerung: Licht aus Nordwest, überhöht; dunkle und helle Flächen als Alpha
  schummerung(l, ix, iy) {
    const k = l + '/' + ix + '_' + iy; if (this.relief.has(k)) return this.relief.get(k);
    const a = this.raster(l, ix, iy); if (!a) return a;
    const N = this.N, cs = this.man.tile_size_m[l] / N, ex = l === 0 ? 2.5 : 4, F = this.h.fehlt;
    const cv = document.createElement('canvas'); cv.width = cv.height = N; const c = cv.getContext('2d'), img = c.createImageData(N, N), d = img.data;
    const z = (r, q) => { r = Math.max(0, Math.min(N - 1, r)); q = Math.max(0, Math.min(N - 1, q)); const v = a[r * N + q]; return v === F ? NaN : v / 10; };
    const Lx = -1, Ly = 1, Lz = 1.4, Ll = Math.hypot(Lx, Ly, Lz), s0 = Lz / Ll;
    for (let r = 0; r < N; r++) for (let q = 0; q < N; q++) {
      let gx = (z(r, q + 1) - z(r, q - 1)) / (2 * cs) * ex, gy = (z(r - 1, q) - z(r + 1, q)) / (2 * cs) * ex;
      if (Number.isNaN(gx) || Number.isNaN(gy)) continue;
      const nl = Math.hypot(gx, gy, 1), s = (-gx * Lx - gy * Ly + Lz) / nl / Ll, df = s - s0, i = (r * N + q) * 4;
      if (df < 0) { d[i] = 10; d[i + 1] = 18; d[i + 2] = 30; d[i + 3] = Math.min(150, -df * 420); }
      else { d[i] = 255; d[i + 1] = 248; d[i + 2] = 225; d[i + 3] = Math.min(90, df * 300); }
    }
    c.putImageData(img, 0, 0); this.relief.set(k, cv); return cv;
  }
  // Höhe in m an Weltkoordinaten (x = Ost − Ost₀, y = Nord₀ − Nord); null wenn unbekannt
  hoehe(x, y, l = 0) {
    const T = this.man.tile_size_m[l], cs = T / this.N, E = x + this.E0, Nn = this.N0 - y;
    const fx = E / cs - .5, fy = Nn / cs - .5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    let s = 0, w = 0;
    for (const [cx, cy, wi] of [[x0, y0, (1 - tx) * (1 - ty)], [x0 + 1, y0, tx * (1 - ty)], [x0, y0 + 1, (1 - tx) * ty], [x0 + 1, y0 + 1, tx * ty]]) {
      const ix = Math.floor(cx / this.N), iy = Math.floor(cy / this.N), a = this.raster(l, ix, iy); if (!a) continue;
      const v = a[(this.N - 1 - (cy - iy * this.N)) * this.N + (cx - ix * this.N)]; if (v === this.h.fehlt) continue;
      s += v / 10 * wi; w += wi;
    }
    return w > 0 ? s / w : null;
  }
}
