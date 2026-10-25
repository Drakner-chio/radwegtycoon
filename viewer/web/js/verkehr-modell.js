// Radweg Tycoon – Verkehrsmodell Ebene 1 (rechnet im Worker, ohne DOM).
//
// 1. Nachfrage: Jede Zelle erzeugt Wege (Einwohner × WEGE_JE_EW) und verteilt sie nach einem
//    Schwerkraftmodell auf die anderen Zellen (Ziele gewichtet, Luftlinie mit exp-Abfall).
// 2. Radrouten: Dijkstra je Startzelle auf „gefühlten Metern“ (Länge × Faktor aus Risiko und Komfort).
// 3. Verkehrsmittelwahl: Radanteil fällt mit der Weglänge und mit dem Umweg-/Stressfaktor q = gefühlt / echt.
// 4. Umlegen: Radwege je Ziel auf den Kürzeste-Wege-Baum, von den Blättern zur Wurzel aufsummiert.
// 5. Autoverkehr: die übrigen Wege (ohne kurze Fußwege und Mitfahrende) als Kfz-Fahrten auf den
//    schnellsten Weg (Fahrzeit in Sekunden je Richtung, mit Stauzuschlag aus der letzten Rechnung).
// Alle Parameter stehen in PARAM, damit sie sich später an Zähldaten eichen lassen.

export const PARAM = {
  wegeJeEw: 2.2,          // Wege pro Einwohner und Tag, die die Zelle verlassen (ohne Wege innerhalb der Zelle)
  abfallKm: 6,            // Schwerkraftmodell: exp(-Luftlinie / abfallKm)
  maxLuftKm: 40,          // weiter entfernte Ziele zählen nicht
  ziel: { ew: 0.6, arbeit: 1.0, einkauf: 25, schule: 60, versorgung: 15, freizeit: 8, bahnhof: 80 },
  grenzeGefuehlt: 16000,  // Dijkstra-Abbruch in gefühlten Metern (längere Radwege sind selten)
  rad: { basis: 0.38, halbKm: 4.2, form: 2.4, qRef: 1.25, qStrafe: 1.1, max: 0.65 },
  zufriedenKm: 10,        // Zufriedenheit: Wege bis zu dieser Länge zählen
  // Auto: Anteil der Nicht-Rad-Wege mit dem Auto (Rest ÖPNV), kurze Wege eher zu Fuß, Fahrer statt Mitfahrer
  auto: { anteil: 0.74, fussKm: 1.3, fahrer: 0.8, grenzeSek: 1800 },
};
// Kfz-Fahrten (Fahrzeuge) für einen Weg der Länge L km mit Radanteil pr
export const autoFahrten = (T, L, pr, p = PARAM.auto) => T * (1 - pr) * p.anteil * (1 - Math.exp(-L / p.fussKm)) * p.fahrer;

// Graph aus der Netzdatei (Spalten) in CSR-Form bringen
export function baueGraph(netz) {
  const nK = netz.knoten.x.length, nE = netz.kanten.a.length;
  const a = Int32Array.from(netz.kanten.a), b = Int32Array.from(netz.kanten.b), len = Float32Array.from(netz.kanten.len);
  const deg = new Int32Array(nK + 1);
  for (let e = 0; e < nE; e++) { deg[a[e] + 1]++; deg[b[e] + 1]++; }
  for (let i = 0; i < nK; i++) deg[i + 1] += deg[i];
  const start = deg, adjE = new Int32Array(2 * nE), adjN = new Int32Array(2 * nE), pos = start.slice(0, nK);
  for (let e = 0; e < nE; e++) { adjE[pos[a[e]]] = e; adjN[pos[a[e]]++] = b[e]; adjE[pos[b[e]]] = e; adjN[pos[b[e]]++] = a[e]; }
  const Z = netz.zonen, nZ = Z.x.length;
  return { nK, nE, a, b, len, start, adjE, adjN, nZ,
    zx: Float32Array.from(Z.x), zy: Float32Array.from(Z.y), zk: Int32Array.from(Z.knoten), zan: Float32Array.from(Z.anbindung),
    ew: Float32Array.from(Z.ew), arbeit: Float32Array.from(Z.arbeit), einkauf: Float32Array.from(Z.einkauf), schule: Float32Array.from(Z.schule),
    versorgung: Float32Array.from(Z.versorgung), freizeit: Float32Array.from(Z.freizeit), bahnhof: Float32Array.from(Z.bahnhof) };
}

// gzip-JSON laden (Browser und Worker)
export async function ladeJsonGz(url) {
  const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status + ' für ' + url);
  let buf = new Uint8Array(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  return JSON.parse(new TextDecoder().decode(buf));
}

export const radAnteil = (L, q, p = PARAM.rad) => Math.min(p.max, p.basis / (1 + Math.pow(L / p.halbKm, p.form)) * Math.exp(-p.qStrafe * (q - p.qRef)));

// faktor[2e] / faktor[2e+1]: gefühlte Meter je Meter in Richtung a->b bzw. b->a (Infinity = nicht befahrbar)
// maske[z] = 0: Zelle liegt außerhalb des Spielgebiets (weder Start noch Ziel)
// auto (optional): { zeit: Float32Array(2·nE) Sekunden je Richtung (Infinity = gesperrt), knoten: Float32Array(nK) Sekunden }
export function rechne(G, faktor, fortschritt, von = 0, bis = G.nZ, strafe = null, maske = null, auto = null) {
  const P = PARAM, { nK, nZ, len, zk, zx, zy } = G;
  const W = new Float64Array(nZ);
  for (let z = 0; z < nZ; z++) W[z] = P.ziel.ew * G.ew[z] + P.ziel.arbeit * G.arbeit[z] + P.ziel.einkauf * G.einkauf[z] + P.ziel.schule * G.schule[z] + P.ziel.versorgung * G.versorgung[z] + P.ziel.freizeit * G.freizeit[z] + P.ziel.bahnhof * G.bahnhof[z];
  // Zellen je Knoten (mehrere Zellen können am selben Knoten hängen)
  const zNext = new Int32Array(nZ).fill(-1), zHead = new Int32Array(nK).fill(-1);
  for (let z = 0; z < nZ; z++) { zNext[z] = zHead[zk[z]]; zHead[zk[z]] = z; }

  const heapN = new Int32Array(G.nE * 2 + 16), heapD = new Float64Array(G.nE * 2 + 16);
  const baum = () => ({ dist: new Float64Array(nK).fill(Infinity), lenTo: new Float64Array(nK), pred: new Int32Array(nK).fill(-1), load: new Float64Array(nK), order: new Int32Array(nK), n: 0 });
  const BR = baum(), BA = auto ? baum() : null;
  // Dijkstra von s; gewicht[2e+Richtung] je Meter (proM) oder je Kante, knoten[v] Zuschlag beim Erreichen von v
  const dijkstra = (B, s, gewicht, proM, knoten, grenze) => {
    const { dist, lenTo, pred, order } = B, { start, adjE, adjN, b } = G; let hn = 1, n = 0;
    dist[s] = 0; lenTo[s] = 0; pred[s] = -1; heapN[0] = s; heapD[0] = 0;
    while (hn) {
      const u = heapN[0], du = heapD[0];
      hn--; if (hn) { const ln = heapN[hn], ld = heapD[hn]; let i = 0; for (;;) { let c = 2 * i + 1; if (c >= hn) break; if (c + 1 < hn && heapD[c + 1] < heapD[c]) c++; if (heapD[c] >= ld) break; heapN[i] = heapN[c]; heapD[i] = heapD[c]; i = c; } heapN[i] = ln; heapD[i] = ld; }
      if (du > dist[u]) continue;
      order[n++] = u;
      for (let k = start[u]; k < start[u + 1]; k++) {
        const e = adjE[k], v = adjN[k], f = gewicht[2 * e + (v === b[e] ? 0 : 1)]; if (f === Infinity) continue; // Richtung a->b bzw. b->a
        const nd = du + (proM ? len[e] * f : f) + (knoten ? knoten[v] : 0);
        if (nd < dist[v] && nd <= grenze) {
          dist[v] = nd; lenTo[v] = lenTo[u] + len[e]; pred[v] = e;
          let i = hn++; while (i > 0) { const p = (i - 1) >> 1; if (heapD[p] <= nd) break; heapN[i] = heapN[p]; heapD[i] = heapD[p]; i = p; } heapN[i] = v; heapD[i] = nd;
        }
      }
    }
    B.n = n;
  };
  // Last von den Blättern zur Wurzel auf die Kanten legen, danach Baum zurücksetzen
  const umlegen = (B, vol) => {
    const { order, load, pred, dist } = B;
    for (let i = B.n - 1; i > 0; i--) { const u = order[i], l = load[u]; if (l) { const e = pred[u]; vol[e] += l; const p = G.a[e] === u ? G.b[e] : G.a[e]; load[p] += l; } }
    for (let i = 0; i < B.n; i++) { const u = order[i]; dist[u] = Infinity; load[u] = 0; pred[u] = -1; }
  };

  const vol = new Float64Array(G.nE), volA = auto ? new Float64Array(G.nE) : null;
  const zWege = new Float64Array(nZ), zRad = new Float64Array(nZ), zZuf = new Float64Array(nZ), zZufW = new Float64Array(nZ), zRadIn = new Float64Array(nZ);
  const maxD2 = (P.maxLuftKm * 1000) ** 2, dKm = new Float64Array(nZ), g = new Float64Array(nZ), prD = new Float32Array(nZ);
  let summeWege = 0, summeRad = 0, summeRadKm = 0, summeAuto = 0, summeAutoKm = 0;

  for (let o = von; o < bis; o++) {
    if (maske && !maske[o]) continue;
    const T = G.ew[o] * P.wegeJeEw;
    if (T < 0.5) continue;
    // Schwerkraft: Anteile je Ziel
    let den = 0;
    for (let d = 0; d < nZ; d++) {
      g[d] = 0; if (d === o || W[d] <= 0 || (maske && !maske[d])) continue;
      const dx = zx[d] - zx[o], dy = zy[d] - zy[o], d2 = dx * dx + dy * dy;
      if (d2 > maxD2) continue;
      dKm[d] = Math.sqrt(d2) / 1000; g[d] = W[d] * Math.exp(-dKm[d] / P.abfallKm); den += g[d];
    }
    if (den <= 0) continue;
    zWege[o] = T; summeWege += T;
    dijkstra(BR, zk[o], faktor, true, strafe, P.grenzeGefuehlt);
    // Ziele im Radbaum: Radanteil, Last auf den Zielknoten
    let zuf = 0, zufW = 0, rad = 0;
    for (let i = 0; i < BR.n; i++) {
      const u = BR.order[i];
      for (let d = zHead[u]; d >= 0; d = zNext[d]) {
        if (!g[d]) continue;
        const L = (BR.lenTo[u] + G.zan[o] + G.zan[d]) / 1000, q = BR.lenTo[u] > 0 ? BR.dist[u] / BR.lenTo[u] : 1;
        const Tod = T * g[d] / den, pr = radAnteil(Math.max(L, .3), q), r = Tod * pr;
        BR.load[u] += r; rad += r; summeRadKm += r * L; zRadIn[d] += r; prD[d] = pr;
        if (L <= P.zufriedenKm) { zuf += Tod * 100 * Math.exp(-1.2 * Math.max(0, q - 1.15)); zufW += Tod; }
        g[d] = -g[d]; // markiert: erreicht
      }
    }
    // nicht erreichte nahe Ziele drücken die Zufriedenheit
    for (let d = 0; d < nZ; d++) { if (g[d] > 0 && dKm[d] * 1.3 <= P.zufriedenKm) zufW += T * g[d] / den; if (g[d] < 0) g[d] = -g[d]; }
    zRad[o] = rad; summeRad += rad; zZuf[o] = zufW ? zuf / zufW : 0; zZufW[o] = zufW;
    umlegen(BR, vol);
    // Autofahrten auf dem schnellsten Weg
    if (auto) {
      dijkstra(BA, zk[o], auto.zeit, false, auto.knoten, P.auto.grenzeSek);
      for (let i = 0; i < BA.n; i++) {
        const u = BA.order[i];
        for (let d = zHead[u]; d >= 0; d = zNext[d]) {
          if (!g[d]) continue;
          const L = (BA.lenTo[u] + G.zan[o] + G.zan[d]) / 1000, f = autoFahrten(T * g[d] / den, L, prD[d]);
          BA.load[u] += f; summeAuto += f; summeAutoKm += f * L;
        }
      }
      umlegen(BA, volA);
    }
    prD.fill(0);
    if (fortschritt && (o & 31) === 0) fortschritt((o - von) / Math.max(1, bis - von));
  }
  return { vol: Float32Array.from(vol), volA: volA ? Float32Array.from(volA) : new Float32Array(0), zWege: Float32Array.from(zWege), zRad: Float32Array.from(zRad), zRadIn: Float32Array.from(zRadIn),
    zZuf: Float32Array.from(zZuf), zZufW: Float32Array.from(zZufW), summeWege, summeRad, summeRadKm, summeAuto, summeAutoKm };
}
