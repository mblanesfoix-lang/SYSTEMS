import { initGlobe } from '/js/vdr-globe.js';

const params = new URLSearchParams(location.search);
const token = params.get('t') || '';

const $ = (id) => document.getElementById(id);
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---- i18n (mismo diccionario que la vista interna, sin claves de PDF) ---- */
const I18N = {
  es: {
    subtitle: 'Interfaz geoespacial · VDR',
    'btn.table': 'TABLA · 200 NODOS', 'btn.spain': 'IR A {country}', 'btn.hq': 'IR A SEDE', 'btn.reset': 'REENCUADRAR',
    'btn.installAll': 'SIMULAR TODOS INSTALADOS', 'btn.resetAll': 'RESET',
    'legend.star': 'Estrella · sede empresa', 'legend.red': 'Nodo rojo · sin desplegar', 'legend.green': 'Nodo verde · instalado (simulado)',
    hint: 'arrastra: rotar 360° · shift o botón derecho: desplazar · rueda o pellizco: zoom · doble clic: reencuadrar · clic en nodo: conmutar',
    'loss.label': 'Coste anual de no adoptar BioHybrid',
    'table.kicker': 'Cuantificación de despliegue · {country}', 'table.byRegion': 'Reparto por comunidad autónoma', 'table.total': 'TOTAL · nodos',
    'th.node': 'Nodo', 'th.region': 'Comunidad', 'th.state': 'Estado', 'th.nodes': 'Nodos',
    'th.absorbs': 'Absorbe<br><span>GWh/año</span>', 'th.pellet': 'Biopellet<br><span>T/año</span>',
    'th.value': 'Valor biopellet<br><span>€/año · 350 €/T</span>', 'th.co2': 'CO₂+CH₄ evitado<br><span>T/año</span>', 'th.sim': 'Simular',
    'stat.absorbs': 'Absorbe GWh/año', 'stat.pellet': 'Biopellet T/año', 'stat.co2': 'CO₂+CH₄ T/año',
    'switch.label': 'Estado simulado', 'state.pending': 'Sin desplegar', 'state.installed': 'Instalado (sim.)',
    'node.pending': 'Nodo · pendiente de desplegar', 'node.installed': 'Nodo · instalado (simulado)',
    'sub.red': 'rojo · sin desplegar', 'sub.green': 'verde · operativo simulado',
    'star.kicker': 'Ubicación · sede en', 'star.hq': 'Base matriz',
    'star.country': 'País', 'star.city': 'Ciudad', 'star.coords': 'Coordenadas',
    'star.precision': 'Precisión', 'star.weight': 'Peso ubicación', 'precision.city': 'ciudad exacta', 'precision.country': 'centro del país',
    'stats.deployed': 'Nodos desplegados', 'stats.absorbed': 'Curtailment absorbido', 'stats.pellet': 'Biopellet generado',
    'stats.value': 'Valor biopellet', 'stats.co2': 'CO₂+CH₄ evitado', 'stats.losing': 'Sigue perdiéndose',
    'loss.pendingNodes': 'nodos sin desplegar', 'loss.simulated': 'simulados instalados', 'loss.recovered': 'ya recuperado',
    'loss.neutralised': 'nodos desplegados · pérdida anual neutralizada', 'loss.recoveredYear': 'recuperados al año',
    'gate.title': 'Acceso restringido', 'gate.sub': 'Introduce el correo autorizado y el código facilitado en la reunión.',
    'gate.btn': 'Verificar acceso', 'gate.verifying': 'Verificando…', 'gate.bothFields': 'Indica correo y código.',
    'gate.network': 'Error de red. Reinténtalo.',
    'gate.nda': 'Contenido confidencial · acceso sujeto a acuerdo de confidencialidad firmado',
    'gate.rights': '© S-NFI Corp. · Todos los derechos reservados',
    'gate.expired': 'Este enlace ha caducado.', 'gate.revoked': 'Este enlace ha sido revocado.', 'gate.notFound': 'Enlace no válido.',
    'gate.sessionEnded': 'La sesión ha terminado.', 'gate.sessionEndedSub': 'El enlace de presentación ha caducado.',
    confidential: 'Confidencial · sujeto a NDA · © S-NFI Corp.',
    expires: 'caduca en',
    'locked.sub': 'Reparto territorial restringido · no incluido en esta presentación',
    'unit.gwhYear': 'GWh/año', 'unit.tYear': 'T/año', 'unit.year': 'año',
    'clause.ppa': 'Desbloqueo de nodos condicionado exclusivamente a PPA energético de grid curtailment bajo gobernanza Pactvm Viridi — ningún nodo se activa sin contrato de compra de excedente renovable curtailed.',
    'ident.gis': 'Ubicación GIS', 'ident.cadastral': 'Ref. catastral',
    'ident.client': 'Cliente / proveedor',
    'locked.badge': '🔒 SPV LEVEL 2 CLEARANCE REQUIRED',
    'locked.anon': '🔒 CLIENT_ANONYMIZED',
  },
  en: {
    subtitle: 'Geospatial interface · VDR',
    'btn.table': 'TABLE · 200 NODES', 'btn.spain': 'GO TO {country}', 'btn.hq': 'GO TO HQ', 'btn.reset': 'RESET VIEW',
    'btn.installAll': 'SIMULATE ALL INSTALLED', 'btn.resetAll': 'RESET',
    'legend.star': 'Star · company HQ', 'legend.red': 'Red node · not deployed', 'legend.green': 'Green node · installed (simulated)',
    hint: 'drag: rotate 360° · shift or right button: pan · wheel or pinch: zoom · double click: reset view · click a node: toggle',
    'loss.label': 'Annual cost of not adopting BioHybrid',
    'table.kicker': 'Deployment quantification · {country}', 'table.byRegion': 'Breakdown by autonomous community', 'table.total': 'TOTAL · nodes',
    'th.node': 'Node', 'th.region': 'Community', 'th.state': 'Status', 'th.nodes': 'Nodes',
    'th.absorbs': 'Absorbs<br><span>GWh/year</span>', 'th.pellet': 'Biopellet<br><span>t/year</span>',
    'th.value': 'Biopellet value<br><span>€/year · €350/t</span>', 'th.co2': 'CO₂+CH₄ avoided<br><span>t/year</span>', 'th.sim': 'Simulate',
    'stat.absorbs': 'Absorbs GWh/year', 'stat.pellet': 'Biopellet t/year', 'stat.co2': 'CO₂+CH₄ t/year',
    'switch.label': 'Simulated status', 'state.pending': 'Not deployed', 'state.installed': 'Installed (sim.)',
    'node.pending': 'Node · pending deployment', 'node.installed': 'Node · installed (simulated)',
    'sub.red': 'red · not deployed', 'sub.green': 'green · simulated operational',
    'star.kicker': 'Location · HQ in', 'star.hq': 'Parent base',
    'star.country': 'Country', 'star.city': 'City', 'star.coords': 'Coordinates',
    'star.precision': 'Precision', 'star.weight': 'Location weight', 'precision.city': 'exact city', 'precision.country': 'country centroid',
    'stats.deployed': 'Nodes deployed', 'stats.absorbed': 'Curtailment absorbed', 'stats.pellet': 'Biopellet produced',
    'stats.value': 'Biopellet value', 'stats.co2': 'CO₂+CH₄ avoided', 'stats.losing': 'Still being lost',
    'loss.pendingNodes': 'nodes not deployed', 'loss.simulated': 'simulated as installed', 'loss.recovered': 'already recovered',
    'loss.neutralised': 'nodes deployed · annual loss neutralised', 'loss.recoveredYear': 'recovered per year',
    'gate.title': 'Restricted access', 'gate.sub': 'Enter your authorised email and the code provided in the meeting.',
    'gate.btn': 'Verify access', 'gate.verifying': 'Verifying…', 'gate.bothFields': 'Enter email and code.',
    'gate.network': 'Network error. Try again.',
    'gate.nda': 'Confidential content · access subject to a signed non-disclosure agreement',
    'gate.rights': '© S-NFI Corp. · All rights reserved',
    'gate.expired': 'This link has expired.', 'gate.revoked': 'This link has been revoked.', 'gate.notFound': 'Invalid link.',
    'gate.sessionEnded': 'Session ended.', 'gate.sessionEndedSub': 'The presentation link has expired.',
    confidential: 'Confidential · subject to NDA · © S-NFI Corp.',
    expires: 'expires in',
    'locked.sub': 'Territorial breakdown restricted · not included in this presentation',
    'unit.gwhYear': 'GWh/year', 'unit.tYear': 't/year', 'unit.year': 'year',
    'clause.ppa': 'Node unlocking is conditional solely upon an energy PPA for grid curtailment under Pactvm Viridi governance — no node is activated without a purchase contract for curtailed renewable surplus.',
    'ident.gis': 'GIS location', 'ident.cadastral': 'Cadastral ref.',
    'ident.client': 'Client / supplier',
    'locked.badge': '🔒 SPV LEVEL 2 CLEARANCE REQUIRED',
    'locked.anon': '🔒 CLIENT_ANONYMIZED',
  },
  it: {
    subtitle: 'Interfaccia geospaziale · VDR',
    'btn.table': 'TABELLA · 200 NODI', 'btn.spain': 'VAI IN {country}', 'btn.hq': 'VAI ALLA SEDE', 'btn.reset': 'REIMPOSTA VISTA',
    'btn.installAll': 'SIMULA TUTTI INSTALLATI', 'btn.resetAll': 'RESET',
    'legend.star': 'Stella · sede aziendale', 'legend.red': 'Nodo rosso · non installato', 'legend.green': 'Nodo verde · installato (simulato)',
    hint: 'trascina: ruota 360° · shift o tasto destro: sposta · rotella o pizzico: zoom · doppio clic: reimposta · clic su un nodo: commuta',
    'loss.label': 'Costo annuo del non adottare BioHybrid',
    'table.kicker': 'Quantificazione del dispiegamento · {country}', 'table.byRegion': 'Ripartizione per comunità autonoma', 'table.total': 'TOTALE · nodi',
    'th.node': 'Nodo', 'th.region': 'Comunità', 'th.state': 'Stato', 'th.nodes': 'Nodi',
    'th.absorbs': 'Assorbe<br><span>GWh/anno</span>', 'th.pellet': 'Biopellet<br><span>t/anno</span>',
    'th.value': 'Valore biopellet<br><span>€/anno · 350 €/t</span>', 'th.co2': 'CO₂+CH₄ evitate<br><span>t/anno</span>', 'th.sim': 'Simula',
    'stat.absorbs': 'Assorbe GWh/anno', 'stat.pellet': 'Biopellet t/anno', 'stat.co2': 'CO₂+CH₄ t/anno',
    'switch.label': 'Stato simulato', 'state.pending': 'Non installato', 'state.installed': 'Installato (sim.)',
    'node.pending': 'Nodo · in attesa di installazione', 'node.installed': 'Nodo · installato (simulato)',
    'sub.red': 'rosso · non installato', 'sub.green': 'verde · operativo simulato',
    'star.kicker': 'Ubicazione · sede in', 'star.hq': 'Base madre',
    'star.country': 'Paese', 'star.city': 'Città', 'star.coords': 'Coordinate',
    'star.precision': 'Precisione', 'star.weight': 'Peso ubicazione', 'precision.city': 'città esatta', 'precision.country': 'centro del paese',
    'stats.deployed': 'Nodi installati', 'stats.absorbed': 'Curtailment assorbito', 'stats.pellet': 'Biopellet prodotto',
    'stats.value': 'Valore biopellet', 'stats.co2': 'CO₂+CH₄ evitate', 'stats.losing': 'Ancora perduto',
    'loss.pendingNodes': 'nodi non installati', 'loss.simulated': 'simulati come installati', 'loss.recovered': 'già recuperato',
    'loss.neutralised': 'nodi installati · perdita annua neutralizzata', 'loss.recoveredYear': 'recuperati all’anno',
    'gate.title': 'Accesso riservato', 'gate.sub': 'Inserisci l’email autorizzata e il codice fornito in riunione.',
    'gate.btn': 'Verifica accesso', 'gate.verifying': 'Verifica…', 'gate.bothFields': 'Inserisci email e codice.',
    'gate.network': 'Errore di rete. Riprova.',
    'gate.nda': 'Contenuto riservato · accesso soggetto ad accordo di riservatezza firmato',
    'gate.rights': '© S-NFI Corp. · Tutti i diritti riservati',
    'gate.expired': 'Questo link è scaduto.', 'gate.revoked': 'Questo link è stato revocato.', 'gate.notFound': 'Link non valido.',
    'gate.sessionEnded': 'Sessione terminata.', 'gate.sessionEndedSub': 'Il link di presentazione è scaduto.',
    confidential: 'Riservato · soggetto a NDA · © S-NFI Corp.',
    expires: 'scade tra',
    'locked.sub': 'Ripartizione territoriale riservata · non inclusa in questa presentazione',
    'unit.gwhYear': 'GWh/anno', 'unit.tYear': 't/anno', 'unit.year': 'anno',
    'clause.ppa': 'Lo sblocco dei nodi è subordinato esclusivamente a un PPA energetico di grid curtailment sotto la governance di Pactvm Viridi — nessun nodo viene attivato senza contratto di acquisto dell’eccedenza rinnovabile curtailed.',
    'ident.gis': 'Ubicazione GIS', 'ident.cadastral': 'Rif. catastale',
    'ident.client': 'Cliente / fornitore',
    'locked.badge': '🔒 SPV LEVEL 2 CLEARANCE REQUIRED',
    'locked.anon': '🔒 CLIENT_ANONYMIZED',
  },
  /* Francais: registre corporatif international (TotalEnergies). */
  fr: {
    subtitle: 'Interface géospatiale · VDR',
    'btn.table': 'TABLEAU · 200 NŒUDS', 'btn.spain': 'ALLER EN {country}', 'btn.hq': 'ALLER AU SIÈGE', 'btn.reset': 'RÉINITIALISER LA VUE',
    'btn.installAll': 'SIMULER TOUS INSTALLÉS', 'btn.resetAll': 'RESET',
    'legend.star': 'Étoile · siège de l’entreprise', 'legend.red': 'Nœud rouge · non déployé', 'legend.green': 'Nœud vert · installé (simulé)',
    hint: 'glisser : rotation 360° · maj ou clic droit : déplacer · molette ou pincement : zoom · double clic : réinitialiser · clic sur un nœud : commuter',
    'loss.label': 'Coût annuel de la non-adoption de BioHybrid',
    'table.kicker': 'Quantification du déploiement · {country}', 'table.byRegion': 'Répartition par communauté autonome', 'table.total': 'TOTAL · nœuds',
    'th.node': 'Nœud', 'th.region': 'Communauté', 'th.state': 'Statut', 'th.nodes': 'Nœuds',
    'th.absorbs': 'Absorbe<br><span>GWh/an</span>', 'th.pellet': 'Biopellet<br><span>t/an</span>',
    'th.value': 'Valeur biopellet<br><span>€/an · 350 €/t</span>', 'th.co2': 'CO₂+CH₄ évité<br><span>t/an</span>', 'th.sim': 'Simuler',
    'stat.absorbs': 'Absorbe GWh/an', 'stat.pellet': 'Biopellet t/an', 'stat.co2': 'CO₂+CH₄ t/an',
    'switch.label': 'Statut simulé', 'state.pending': 'Non déployé', 'state.installed': 'Installé (sim.)',
    'node.pending': 'Nœud · en attente de déploiement', 'node.installed': 'Nœud · installé (simulé)',
    'sub.red': 'rouge · non déployé', 'sub.green': 'vert · opérationnel simulé',
    'star.kicker': 'Localisation · siège à', 'star.hq': 'Base mère',
    'star.country': 'Pays', 'star.city': 'Ville', 'star.coords': 'Coordonnées',
    'star.precision': 'Précision', 'star.weight': 'Poids de localisation', 'precision.city': 'ville exacte', 'precision.country': 'centre du pays',
    'stats.deployed': 'Nœuds déployés', 'stats.absorbed': 'Curtailment absorbé', 'stats.pellet': 'Biopellet produit',
    'stats.value': 'Valeur biopellet', 'stats.co2': 'CO₂+CH₄ évité', 'stats.losing': 'Toujours perdu',
    'loss.pendingNodes': 'nœuds non déployés', 'loss.simulated': 'simulés comme installés', 'loss.recovered': 'déjà récupéré',
    'loss.neutralised': 'nœuds déployés · perte annuelle neutralisée', 'loss.recoveredYear': 'récupérés par an',
    'gate.title': 'Accès restreint', 'gate.sub': 'Saisissez l’adresse autorisée et le code fourni lors de la réunion.',
    'gate.btn': 'Vérifier l’accès', 'gate.verifying': 'Vérification…', 'gate.bothFields': 'Indiquez l’adresse et le code.',
    'gate.network': 'Erreur réseau. Réessayez.',
    'gate.nda': 'Contenu confidentiel · accès soumis à un accord de confidentialité signé',
    'gate.rights': '© S-NFI Corp. · Tous droits réservés',
    'gate.expired': 'Ce lien a expiré.', 'gate.revoked': 'Ce lien a été révoqué.', 'gate.notFound': 'Lien non valide.',
    'gate.sessionEnded': 'La session est terminée.', 'gate.sessionEndedSub': 'Le lien de présentation a expiré.',
    confidential: 'Confidentiel · soumis à NDA · © S-NFI Corp.',
    expires: 'expire dans',
    'locked.sub': 'Répartition territoriale restreinte · non incluse dans cette présentation',
    'unit.gwhYear': 'GWh/an', 'unit.tYear': 't/an', 'unit.year': 'an',
    'clause.ppa': 'Le déverrouillage des nœuds est conditionné exclusivement à un PPA énergétique de grid curtailment sous gouvernance Pactvm Viridi — aucun nœud n’est activé sans contrat d’achat du surplus renouvelable curtailed.',
    'ident.gis': 'Localisation GIS', 'ident.cadastral': 'Réf. cadastrale',
    'ident.client': 'Client / fournisseur',
    'locked.badge': '🔒 SPV LEVEL 2 CLEARANCE REQUIRED',
    'locked.anon': '🔒 CLIENT_ANONYMIZED',
  },
};

let lang = (() => {
  const nav = (navigator.language || 'es').slice(0, 2).toLowerCase();
  return I18N[nav] ? nav : 'es';
})();
const t = (k) => (I18N[lang] && I18N[lang][k]) || I18N.es[k] || k;

// Locale de formato ligada al idioma activo: con 'es-ES' fijo, en EN/FR
// los separadores de millar salian en formato espanol.
const NUM_LOCALE = { es: 'es-ES', en: 'en-GB', it: 'it-IT', fr: 'fr-FR' };
const numLocale = () => NUM_LOCALE[lang] || 'es-ES';
const fmtInt = (n) => Number(n || 0).toLocaleString(numLocale(), { maximumFractionDigits: 0 });
const fmtDec = (n, d = 2) => Number(n || 0).toLocaleString(numLocale(), { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtEur = (n) => `${fmtInt(n)} €`;
function fmtEurCompact(n) {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1e6) return `${fmtDec(v / 1e6, 1)} M€`;
  if (Math.abs(v) >= 1e3) return `${fmtDec(v / 1e3, 1)} k€`;
  return fmtEur(v);
}

function applyI18n() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  $('gateTitle').textContent = t('gate.title');
  $('gateSub').textContent = t('gate.sub');
  $('gateBtn').textContent = t('gate.btn');
  $('confidentialNote').textContent = t('confidential');
  const total = globeData?.esCurtailment?.nodesTargetTotal;
  if (total) $('tableBtn').textContent = t('btn.table').replace('200', fmtInt(total));
  const countryLabel = globeData?.esCurtailment?.countryLabel || '—';
  $('focusSpainBtn').textContent = t('btn.spain').replace('{country}', countryLabel);
  $('tableKicker').textContent = t('table.kicker').replace('{country}', countryLabel);
  if (globeData) {
    buildTable(); renderAggregates();
    installed.forEach((i) => syncTableRow(i));
    if (nodePanelState.visible) renderNodePanel();
    if (starCardState.visible) showStarCard();
  }
}
function syncLangSwitch() {
  const opts = [...document.querySelectorAll('.vdr-lang__opt')];
  const idx = Math.max(0, opts.findIndex((o) => o.dataset.lang === lang));
  opts.forEach((o, i) => { o.classList.toggle('is-active', i === idx); o.setAttribute('aria-checked', String(i === idx)); });
  $('langThumb').style.transform = `translateX(${idx * 40}px)`;
}
document.querySelectorAll('.vdr-lang__opt').forEach((btn) => {
  btn.addEventListener('click', () => { lang = btn.dataset.lang; syncLangSwitch(); applyI18n(); });
});

/* ---- estado ---- */
let globeData = null;
let globeApi = null;
let expiresAt = null;
const installed = new Set();

/* ---- puerta de acceso ---- */
async function checkShare() {
  if (!token) { showGateState(t('gate.notFound')); return; }
  try {
    const r = await fetch(`/api/vdr-share/${encodeURIComponent(token)}`);
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      const map = { EXPIRED: 'gate.expired', REVOKED: 'gate.revoked', NOT_FOUND: 'gate.notFound' };
      showGateState(t(map[d.status] || 'gate.notFound'));
      return;
    }
  } catch { showGateState(t('gate.network')); }
}

function showGateState(msg) {
  $('gateForm').hidden = true;
  const el = $('gateState');
  el.hidden = false;
  el.textContent = msg;
}

$('gateBtn').addEventListener('click', async () => {
  const email = $('gateEmail').value.trim();
  const code = $('gateCode').value.trim();
  const err = $('gateErr');
  err.textContent = '';
  if (!email || !code) { err.textContent = t('gate.bothFields'); return; }
  const btn = $('gateBtn');
  btn.disabled = true; btn.textContent = t('gate.verifying');
  try {
    const r = await fetch(`/api/vdr-share/${encodeURIComponent(token)}/unlock`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    const data = await r.json().catch(() => ({}));
    btn.disabled = false; btn.textContent = t('gate.btn');
    if (!r.ok) {
      const map = { EXPIRED: 'gate.expired', REVOKED: 'gate.revoked', NOT_FOUND: 'gate.notFound' };
      if (data.status && map[data.status]) { showGateState(t(map[data.status])); return; }
      err.textContent = data.error || t('gate.network');
      return;
    }
    await enterPresentation(data);
  } catch {
    btn.disabled = false; btn.textContent = t('gate.btn');
    err.textContent = t('gate.network');
  }
});
$('gateCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('gateBtn').click(); });
$('gateEmail').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('gateCode').focus(); });

async function enterPresentation(payload) {
  globeData = payload.globe;
  expiresAt = payload.expiresAt;
  $('gate').classList.add('hidden');
  $('hud').hidden = false;
  $('companyTitle').textContent = payload.company.name;

  globeApi = await initGlobe(globeData, {
    container: 'vdrStage',
    onMarkerClick,
    isStarCardVisible: () => starCardState.visible,
    onStarProject: (p) => positionCard($('starCard'), p),
  });

  buildTable();
  renderAggregates();
  applyI18n();
  startCountdown();

  $('tableBtn').addEventListener('click', () => $('tableOverlay').classList.add('visible'));
  $('focusSpainBtn').addEventListener('click', () => globeApi.focusSpain());
  $('focusStarBtn').addEventListener('click', () => { globeApi.focusStar(); showStarCard(); });
  $('resetViewBtn').addEventListener('click', () => { globeApi.resetView(); hideStarCard(); hideNodePanel(); });
}

/* ---- caducidad: al llegar a cero la presentacion se cierra sola ---- */
function startCountdown() {
  const el = $('countdownText');
  const box = $('countdown');
  const tick = () => {
    const left = new Date(expiresAt).getTime() - Date.now();
    if (left <= 0) { endSession(); return; }
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    el.textContent = `${t('expires')} ${m}:${String(s).padStart(2, '0')}`;
    box.classList.toggle('warn', left < 120000);
  };
  tick();
  setInterval(tick, 1000);
}

function endSession() {
  // se retira el contenido de la pantalla al caducar
  globeData = null;
  $('hud').hidden = true;
  $('vdrStage').innerHTML = '';
  $('gate').classList.remove('hidden');
  $('gateTitle').textContent = t('gate.sessionEnded');
  $('gateSub').textContent = t('gate.sessionEndedSub');
  showGateState(t('gate.expired'));
}

/* ---- tarjeta de sede ---- */
const starCardState = { visible: false };
function positionCard(el, p) {
  if (!p || !p.visible) { el.style.opacity = '0'; return; }
  el.style.left = `${p.x}px`;
  el.style.top = `${p.y - 26}px`;
}
function showStarCard() {
  const st = globeData?.star || {};
  $('starCardKicker').textContent = `${t('star.kicker')} ${st.countryLabel || '—'}`;
  $('starCardTitle').textContent = st.city ? `${st.city}, ${st.countryLabel}` : (st.countryLabel || '—');
  /* Logo corporativo de la sede. Convencion de ruta:
   * /assets/logo-<empresa en minusculas, sin espacios>.png
   * Si el archivo no existe, onerror lo oculta y la tarjeta queda
   * limpia (sin icono roto). */
  const logoEl = $('starCardLogo');
  const slug = String(globeData?.name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (slug) {
    logoEl.onerror = () => { logoEl.hidden = true; };
    logoEl.onload = () => { logoEl.hidden = false; };
    logoEl.alt = globeData?.name || '';
    logoEl.src = `/assets/logo-${slug}.png`;
  } else {
    logoEl.hidden = true;
  }
  $('starCardHqTag').textContent = t('star.hq');
  $('starCardRows').innerHTML = `
        <div class="vdr-card__row"><span class="k">${escapeHtml(t('star.country'))}</span><span class="v">${escapeHtml(st.countryLabel || '—')}</span></div>
        <div class="vdr-card__row"><span class="k">${escapeHtml(t('star.city'))}</span><span class="v">${escapeHtml(st.city || '—')}</span></div>
        <div class="vdr-card__row"><span class="k">${escapeHtml(t('star.coords'))}</span><span class="v">${Number(st.lat ?? 0).toFixed(4)}, ${Number(st.lng ?? 0).toFixed(4)}</span></div>
        <div class="vdr-card__row"><span class="k">${escapeHtml(t('star.precision'))}</span><span class="v">${escapeHtml(st.precision === 'ciudad' ? t('precision.city') : t('precision.country'))}</span></div>
      `;
  starCardState.visible = true;
  $('starCard').classList.add('visible');
}
function hideStarCard() { starCardState.visible = false; $('starCard').classList.remove('visible'); }
$('starCardClose').addEventListener('click', hideStarCard);

/* ---- panel de nodo ---- */
const nodePanelState = { visible: false, index: -1 };
const nodeDefAt = (i) => (globeData?.esCurtailment?.nodes || [])[i] || null;

function renderNodePanel() {
  const def = nodeDefAt(nodePanelState.index);
  if (!def) return;
  const es = globeData.esCurtailment || {};
  const isOn = installed.has(nodePanelState.index);
  $('nodePanel').classList.toggle('installed', isOn);
  $('nodePanelKicker').textContent = isOn ? t('node.installed') : t('node.pending');
  // sin comunidad: la ubicacion territorial va bajo SPV LEVEL 2
  $('nodePanelTitle').textContent = def.code;
  $('nodeStatGwh').textContent = fmtDec(def.annualEnergyGwh, 2);
  $('nodeStatPellet').textContent = fmtInt(def.biopelletTonsYear);
  $('nodeStatCo2').textContent = fmtInt(def.co2ch4AvoidedTonsYear);
  $('nodeSwitchSub').textContent = isOn ? t('sub.green') : t('sub.red');
  $('nodeSwitch').setAttribute('aria-checked', String(isOn));
  $('nodeRevenue').innerHTML = `${fmtInt(def.biopelletTonsYear)} T × ${fmtInt(es.biopelletPriceEurPerTon)} €/T = <b style="color:var(--text-primary)">${fmtEur(def.revenueEurYear)}</b> / ${escapeHtml(t('unit.year'))}`;
  // La clausula PPA llega del backend siempre en castellano: se traduce
  // en cliente para no dejar la ficha en dos idiomas.
  $('nodeClause').textContent = t('clause.ppa');
}
function showNodePanel(i) { nodePanelState.index = i; nodePanelState.visible = true; renderNodePanel(); $('nodePanel').classList.add('visible'); }
function hideNodePanel() { nodePanelState.visible = false; $('nodePanel').classList.remove('visible'); }
$('nodePanelClose').addEventListener('click', hideNodePanel);
$('nodeSwitch').addEventListener('click', () => { if (nodePanelState.index >= 0) toggleNode(nodePanelState.index); });

function toggleNode(i, forced) {
  const isOn = forced === undefined ? !installed.has(i) : forced;
  if (isOn) installed.add(i); else installed.delete(i);
  globeApi?.setNodeInstalled(i, isOn);
  syncTableRow(i);
  if (nodePanelState.visible && nodePanelState.index === i) renderNodePanel();
  renderAggregates();
}
function setAll(isOn) {
  const total = globeData?.esCurtailment?.nodesTargetTotal || 0;
  installed.clear();
  if (isOn) for (let i = 0; i < total; i++) installed.add(i);
  globeApi?.setAllInstalled(isOn);
  for (let i = 0; i < total; i++) syncTableRow(i);
  if (nodePanelState.visible) renderNodePanel();
  renderAggregates();
}

function onMarkerClick(hit) {
  if (!globeData) return;
  if (hit.kind === 'star') { showStarCard(); return; }
  if (hit.kind === 'cluster') { $('tableOverlay').classList.add('visible'); return; }
  if (hit.kind === 'node') { showNodePanel(hit.index); toggleNode(hit.index); }
}

/* ---- tabla ---- */
function buildTable() {
  const es = globeData.esCurtailment || {};
  const nodes = es.nodes || [];
  $('tableTitle').textContent = `${fmtInt(es.nodesTargetTotal)} · ${t('state.pending')}`;
  $('tableClause').textContent = t('clause.ppa');

  $('nodeTableBody').innerHTML = nodes.map((n, i) => `
        <tr data-row="${i}">
          <td>${escapeHtml(n.code)}</td>
          <td class="state" data-cell="state">${escapeHtml(t('state.pending'))}</td>
          <td class="num">${fmtDec(n.annualEnergyGwh, 2)}</td>
          <td class="num">${fmtInt(n.biopelletTonsYear)}</td>
          <td class="num">${fmtEur(n.revenueEurYear)}</td>
          <td class="num">${fmtInt(n.co2ch4AvoidedTonsYear)}</td>
          <td class="switch-col"><button class="vdr-switch" data-toggle="${i}" role="switch" aria-checked="false"><span class="vdr-switch__knob"></span></button></td>
        </tr>`).join('');

  $('nodeTableFoot').innerHTML = `
        <tr>
          <td colspan="2">${escapeHtml(t('table.total'))} · ${fmtInt(es.nodesTargetTotal)}</td>
          <td class="num">${fmtDec(es.totalAnnualEnergyGwh, 2)}</td>
          <td class="num">${fmtInt(es.totalBiopelletTonsYear)}</td>
          <td class="num">${fmtEur(es.totalRevenueEurYear)}</td>
          <td class="num">${fmtInt(es.totalCo2ch4AvoidedTonsYear)}</td>
          <td class="switch-col"></td>
        </tr>`;

  // el reparto por comunidad va bloqueado en la vista de invitado
  // (ver bloque SPV LEVEL 2), no se renderiza tabla aqui

  $('nodeTableBody').querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => toggleNode(Number(btn.dataset.toggle)));
  });
  $('nodeTableBody').querySelectorAll('tr[data-row]').forEach((tr) => {
    tr.addEventListener('click', (e) => { if (!e.target.closest('[data-toggle]')) showNodePanel(Number(tr.dataset.row)); });
  });
}

function syncTableRow(i) {
  const tr = document.querySelector(`tr[data-row="${i}"]`);
  if (!tr) return;
  const isOn = installed.has(i);
  tr.classList.toggle('is-installed', isOn);
  tr.querySelector('[data-cell="state"]').textContent = isOn ? t('state.installed') : t('state.pending');
  tr.querySelector('[data-toggle]').setAttribute('aria-checked', String(isOn));
}

function renderAggregates() {
  const es = globeData.esCurtailment || {};
  const total = es.nodesTargetTotal || 0;
  const on = installed.size;
  const pending = total - on;
  const ratioPending = total > 0 ? pending / total : 0;
  const lossNow = (es.annualLossEur || 0) * ratioPending;
  const recovered = (es.annualLossEur || 0) - lossNow;

  const isMitigated = on > 0 && pending === 0;
  $('lossHero').classList.toggle('mitigated', isMitigated);
  $('lossFigure').textContent = isMitigated ? `+ ${fmtEur(recovered)}` : `− ${fmtEur(lossNow)}`;
  $('lossBarFill').style.width = `${ratioPending * 100}%`;
  $('lossBreakdown').innerHTML = pending === 0
    ? `<span><b>${fmtInt(total)}</b> ${escapeHtml(t('loss.neutralised'))} · <b>${fmtEur(recovered)}</b> ${escapeHtml(t('loss.recoveredYear'))}</span>`
    : `<span><b>${fmtInt(pending)}</b> ${escapeHtml(t('loss.pendingNodes'))}</span>
           <span><b>${fmtInt(on)}</b> ${escapeHtml(t('loss.simulated'))}</span>
           <span>${escapeHtml(t('loss.recovered'))}: <b>${fmtEurCompact(recovered)}</b></span>`;

  // Unidades por idioma: el fallback anterior mandaba 'fr' al ingles.
  const unitY = t('unit.gwhYear');
  const unitT = t('unit.tYear');
  $('tableStats').innerHTML = `
        <div class="vdr-stat-cell"><div class="lbl">${escapeHtml(t('stats.deployed'))}</div><div class="val ${on > 0 ? 'green' : ''}">${fmtInt(on)} / ${fmtInt(total)}</div></div>
        <div class="vdr-stat-cell"><div class="lbl">${escapeHtml(t('stats.absorbed'))}</div><div class="val">${fmtDec((es.nodeAnnualEnergyGwh || 0) * on, 2)} <span style="font-size:0.7rem;color:var(--text-dim)">${unitY}</span></div></div>
        <div class="vdr-stat-cell"><div class="lbl">${escapeHtml(t('stats.pellet'))}</div><div class="val">${fmtInt((es.biopelletTonsPerNodeYear || 0) * on)} <span style="font-size:0.7rem;color:var(--text-dim)">${unitT}</span></div></div>
        <div class="vdr-stat-cell"><div class="lbl">${escapeHtml(t('stats.value'))}</div><div class="val ${on > 0 ? 'green' : ''}">${fmtEurCompact((es.revenueEurPerNodeYear || 0) * on)}</div></div>
        <div class="vdr-stat-cell"><div class="lbl">${escapeHtml(t('stats.co2'))}</div><div class="val">${fmtInt((es.co2ch4AvoidedTonsPerNodeYear || 0) * on)} <span style="font-size:0.7rem;color:var(--text-dim)">${unitT}</span></div></div>
        <div class="vdr-stat-cell"><div class="lbl">${escapeHtml(t('stats.losing'))}</div><div class="val ${pending > 0 ? 'red' : 'green'}">${fmtEurCompact(lossNow)}</div></div>`;

  $('legendCounter').textContent = `${fmtInt(on)} / ${fmtInt(total)}`;
}

$('tableClose').addEventListener('click', () => $('tableOverlay').classList.remove('visible'));
$('tableOverlay').addEventListener('click', (e) => { if (e.target === $('tableOverlay')) $('tableOverlay').classList.remove('visible'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('tableOverlay').classList.remove('visible'); });
$('installAllBtn').addEventListener('click', () => setAll(true));
$('resetAllBtn').addEventListener('click', () => setAll(false));

syncLangSwitch();
applyI18n();
checkShare();
