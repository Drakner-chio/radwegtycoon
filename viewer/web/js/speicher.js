// Radweg Tycoon – Spielstände: mehrere Speicherplätze im Browser, Export/Import als Datei.
// Der laufende Stand liegt weiter unter rtc-spiel-<slug> (Autosave nach jedem Bau, siehe game.js);
// Speicherplätze sind Kopien davon mit Metadaten für die Anzeige.
export const PLAETZE = 6;
const key = (slug, platz) => `rtc-save-${slug}-${platz}`;

export function liste(slug) {
  const out = [];
  for (let p = 1; p <= PLAETZE; p++) {
    let v = null; try { v = JSON.parse(localStorage.getItem(key(slug, p))); } catch (e) {}
    out.push(v ? { platz: p, ...v.meta } : { platz: p, leer: true });
  }
  return out;
}
export function meta(s, erg) {
  return { name: s.name || 'Mein Radnetz', datum: Date.now(), jahr: s.jahr || 1, budget: s.budget, gebiet: s.gebiet || null,
    anteil: erg ? erg.anteil : null, zufrieden: erg ? erg.zufrieden : null, bauten: Object.keys(s.kanten || {}).length + Object.keys(s.knoten || {}).length };
}
export function speichern(slug, platz, s, erg) {
  try { localStorage.setItem(key(slug, platz), JSON.stringify({ version: 1, meta: meta(s, erg), stand: s })); return true; }
  catch (e) { return false; } // Speicher voll
}
export function laden(slug, platz) { try { const v = JSON.parse(localStorage.getItem(key(slug, platz))); return v ? v.stand : null; } catch (e) { return null; } }
export function loeschen(slug, platz) { try { localStorage.removeItem(key(slug, platz)); } catch (e) {} }

// Datei-Export (z. B. als Sicherung oder für einen anderen Rechner)
export function exportieren(slug, s, erg) {
  const blob = new Blob([JSON.stringify({ version: 1, region: slug, meta: meta(s, erg), stand: s })], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `radwegtycoon-${slug}-${(s.name || 'spiel').replace(/[^a-z0-9äöüß-]+/gi, '_')}-jahr${s.jahr || 1}.json`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
export function importieren(datei) {
  return datei.text().then(t => { const v = JSON.parse(t); if (!v || !v.stand || !v.stand.kanten) throw new Error('Keine Spielstand-Datei'); return v; });
}
