/**
 * Elvira JSON store — readElvira()/writeElvira() sobre ELVIRA_FILE.
 *
 * No es una mesa ni expone rutas: es la utilidad de persistencia compartida
 * por reff-crm.routes.js (trackTokens del buscador IA/LinkedIn/Email),
 * cnmc.routes.js y elvira-bridges.routes.js (todas leen/escriben el mismo
 * data/elvira.json). Se extrae a modulo propio para no duplicar la funcion
 * tres veces ni depender de hoisting entre archivos distintos.
 */

import fs from 'node:fs';

export function createElviraStore(ELVIRA_FILE, atomicWriteJson) {
  function readElvira() {
    try { return JSON.parse(fs.readFileSync(ELVIRA_FILE, 'utf8')); }
    catch { return {}; }
  }
  function writeElvira(state) {
    state.updatedAt = new Date().toISOString();
    atomicWriteJson(ELVIRA_FILE, state);
  }
  return { readElvira, writeElvira };
}
