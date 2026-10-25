// Worker: rechnet einen Teil der Startzellen des Verkehrsmodells.
import { baueGraph, rechne, ladeJsonGz } from './verkehr-modell.js';
let G = null;
onmessage = async ev => {
  const m = ev.data;
  try {
    if (m.typ === 'init') { G = baueGraph(await ladeJsonGz(m.url)); postMessage({ typ: 'bereit' }); return; }
    if (m.typ === 'rechne') {
      const r = rechne(G, m.faktor, f => postMessage({ typ: 'fortschritt', id: m.id, f }), m.von, m.bis, m.strafe, m.maske, m.auto);
      postMessage({ typ: 'ergebnis', id: m.id, von: m.von, bis: m.bis, r }, [r.vol.buffer, r.volA.buffer, r.zWege.buffer, r.zRad.buffer, r.zRadIn.buffer, r.zZuf.buffer, r.zZufW.buffer]);
    }
  } catch (e) { postMessage({ typ: 'fehler', text: String(e && e.message || e) }); }
};
