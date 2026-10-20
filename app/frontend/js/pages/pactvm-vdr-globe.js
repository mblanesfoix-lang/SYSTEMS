import { api, getUser, requireAuth, clearSession, toast, escapeHtml } from '/js/api.js';
import { initGlobe } from '/js/vdr-globe.js';

requireAuth();
document.getElementById('userTag').textContent = getUser() || '';
document.getElementById('logoutBtn').addEventListener('click', async () => {
  try { await api.logout(); } catch {}
  clearSession();
  location.href = '/pages/login.html';
});

const userMenuTrigger = document.getElementById('userTag');
const userMenuDropdown = document.getElementById('userDropdown');
userMenuTrigger.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = !userMenuDropdown.hidden;
  userMenuDropdown.hidden = open;
  userMenuTrigger.setAttribute('aria-expanded', String(!open));
});
document.addEventListener('click', (e) => {
  if (!document.getElementById('userMenu').contains(e.target)) {
    userMenuDropdown.hidden = true;
    userMenuTrigger.setAttribute('aria-expanded', 'false');
  }
});
document.getElementById('pwdSubmit').addEventListener('click', async () => {
  const cur = document.getElementById('pwdCurrent').value;
  const neu = document.getElementById('pwdNew').value;
  const con = document.getElementById('pwdConfirm').value;
  const errEl = document.getElementById('pwdError');
  errEl.hidden = true;
  if (!cur || !neu || !con) { errEl.textContent = 'Rellena todos los campos'; errEl.hidden = false; return; }
  if (neu !== con) { errEl.textContent = 'Las contraseñas no coinciden'; errEl.hidden = false; return; }
  try {
    await api.changePassword(cur, neu);
    toast('Contraseña actualizada');
    userMenuDropdown.hidden = true;
    userMenuTrigger.setAttribute('aria-expanded', 'false');
    ['pwdCurrent','pwdNew','pwdConfirm'].forEach(id => document.getElementById(id).value = '');
  } catch (ex) {
    errEl.textContent = ex.message || 'Error al cambiar contraseña';
    errEl.hidden = false;
  }
});

function showError(msg) {
  const box = document.getElementById('errorBox');
  box.textContent = msg;
  box.style.display = msg ? 'block' : 'none';
}

/* ---- i18n: castellano / ingles / italiano ----
 * Alcance: esta pantalla. Las cadenas estaticas llevan data-i18n (texto)
 * o data-i18n-html (permite <br>/<span>); las dinamicas pasan por t().
 * El idioma elegido se recuerda en localStorage. */
const I18N = {
  es: {
    subtitle: 'Interfaz geoespacial · VDR',
    'btn.table': 'TABLA · 200 NODOS',
    'btn.pdf': 'EXPORTAR PDF',
    'btn.spain': 'IR A {country}',
    'btn.hq': 'IR A SEDE',
    'btn.reset': 'REENCUADRAR',
    'btn.installAll': 'SIMULAR TODOS INSTALADOS',
    'btn.resetAll': 'RESET',
    'legend.star': 'Estrella · sede empresa',
    'legend.red': 'Nodo rojo · sin desplegar',
    'legend.green': 'Nodo verde · instalado (simulado)',
    hint: 'arrastra: rotar 360° · shift o botón derecho: desplazar · rueda o pellizco: zoom · doble clic: reencuadrar · clic en nodo: conmutar',
    'loss.label': 'Coste anual de no adoptar BioHybrid',
    'table.kicker': 'Cuantificación de despliegue · {country}',
    'table.byRegion': 'Reparto por comunidad autónoma',
    'table.total': 'TOTAL · nodos',
    'th.node': 'Nodo', 'th.region': 'Comunidad', 'th.state': 'Estado', 'th.nodes': 'Nodos',
    'th.absorbs': 'Absorbe<br><span>GWh/año</span>',
    'th.pellet': 'Biopellet<br><span>T/año</span>',
    'th.value': 'Valor biopellet<br><span>€/año · 350 €/T</span>',
    'th.co2': 'CO₂+CH₄ evitado<br><span>T/año</span>',
    'th.sim': 'Simular',
    'stat.absorbs': 'Absorbe GWh/año', 'stat.pellet': 'Biopellet T/año', 'stat.co2': 'CO₂+CH₄ T/año',
    'switch.label': 'Estado simulado',
    'state.pending': 'Sin desplegar', 'state.installed': 'Instalado (sim.)',
    'node.pending': 'Nodo · pendiente de desplegar', 'node.installed': 'Nodo · instalado (simulado)',
    'sub.red': 'rojo · sin desplegar', 'sub.green': 'verde · operativo simulado',
    'star.kicker': 'Ubicación · sede en', 'star.country': 'País', 'star.city': 'Ciudad',
    'star.hq': 'Base matriz',
    'star.coords': 'Coordenadas', 'star.precision': 'Precisión', 'star.weight': 'Peso ubicación',
    'precision.city': 'ciudad exacta', 'precision.country': 'centro del país',
    'stats.deployed': 'Nodos desplegados', 'stats.absorbed': 'Curtailment absorbido',
    'stats.pellet': 'Biopellet generado', 'stats.value': 'Valor biopellet',
    'stats.co2': 'CO₂+CH₄ evitado', 'stats.losing': 'Sigue perdiéndose',
    'loss.pendingNodes': 'nodos sin desplegar', 'loss.simulated': 'simulados instalados',
    'loss.recovered': 'ya recuperado', 'loss.neutralised': 'nodos desplegados · pérdida anual neutralizada',
    'loss.recoveredYear': 'recuperados al año',
    'pdf.generating': 'GENERANDO…',
    loading: 'Cargando interfaz geoespacial…',
    'unit.gwhYear': 'GWh/año', 'unit.tYear': 'T/año', 'unit.year': 'año',
    'pdf.legend': 'Estrella = sede de la empresa · cilindro = curtailment {country} pendiente de desplegar',
    'pdf.lossTitle': 'COSTE ANUAL DE NO ADOPTAR BIOHYBRID',
    'pdf.pendingOf': '{a} de {b} nodos sin desplegar',
    'pdf.row.location': 'Ubicación geográfica',
    'pdf.row.pending': 'Nodos curtailment {country} pendientes',
    'pdf.row.absorbNode': 'Absorción por nodo (GWh/año)',
    'pdf.row.absorbFleet': 'Absorción total flota (GWh/año)',
    'pdf.row.target': 'Objetivo curtailment (GW)',
    'pdf.row.pelletPrice': 'Precio biopellet (€/T)',
    'pdf.row.pelletNode': 'Biopellet por nodo (T/año)',
    'pdf.row.pelletFleet': 'Biopellet total flota (T/año)',
    'pdf.row.valueNode': 'Valor biopellet por nodo (€/año)',
    'pdf.row.valueFleet': 'Valor biopellet total flota (€/año)',
    'pdf.row.co2Node': 'CO₂+CH₄ evitado por nodo (T/año)',
    'pdf.row.co2Fleet': 'CO₂+CH₄ evitado total flota (T/año)',
    'pdf.generatedAt': 'Generado',
    'clause.ppa': 'Desbloqueo de nodos condicionado exclusivamente a PPA energético de grid curtailment bajo gobernanza Pactvm Viridi — ningún nodo se activa sin contrato de compra de excedente renovable curtailed.',
    'share.kicker': 'Presentación a cliente · enlace temporal',
    'share.create': 'GENERAR ENLACE',
    'share.codeOnce': 'El código solo se muestra ahora: no queda guardado en claro y no se puede volver a consultar.',
    'share.needEmail': 'Indica al menos un correo autorizado.',
    'share.failed': 'No se pudo generar el enlace',
    'share.empty': 'Sin enlaces emitidos',
    'crumb.restricted': '(Restringido)',
    'share.link': 'Enlace', 'share.expires': 'Caduca',
    'share.emails': 'Correos', 'share.accesses': 'Accesos', 'share.copy': 'COPIAR',
    'locked.sub': 'Reparto territorial restringido · no incluido en esta presentación',
    logout: 'Cerrar sesión',
    'ident.gis': 'Ubicación GIS', 'ident.cadastral': 'Ref. catastral',
    'ident.client': 'Cliente / proveedor',
    'ident.cadastralPending': 'pendiente de registro',
    'locked.badge': '🔒 SPV LEVEL 2 CLEARANCE REQUIRED',
    'locked.anon': '🔒 CLIENT_ANONYMIZED',
  },
  en: {
    subtitle: 'Geospatial interface · VDR',
    'btn.table': 'TABLE · 200 NODES',
    'btn.pdf': 'EXPORT PDF',
    'btn.spain': 'GO TO {country}',
    'btn.hq': 'GO TO HQ',
    'btn.reset': 'RESET VIEW',
    'btn.installAll': 'SIMULATE ALL INSTALLED',
    'btn.resetAll': 'RESET',
    'legend.star': 'Star · company HQ',
    'legend.red': 'Red node · not deployed',
    'legend.green': 'Green node · installed (simulated)',
    hint: 'drag: rotate 360° · shift or right button: pan · wheel or pinch: zoom · double click: reset view · click a node: toggle',
    'loss.label': 'Annual cost of not adopting BioHybrid',
    'table.kicker': 'Deployment quantification · {country}',
    'table.byRegion': 'Breakdown by autonomous community',
    'table.total': 'TOTAL · nodes',
    'th.node': 'Node', 'th.region': 'Community', 'th.state': 'Status', 'th.nodes': 'Nodes',
    'th.absorbs': 'Absorbs<br><span>GWh/year</span>',
    'th.pellet': 'Biopellet<br><span>t/year</span>',
    'th.value': 'Biopellet value<br><span>€/year · €350/t</span>',
    'th.co2': 'CO₂+CH₄ avoided<br><span>t/year</span>',
    'th.sim': 'Simulate',
    'stat.absorbs': 'Absorbs GWh/year', 'stat.pellet': 'Biopellet t/year', 'stat.co2': 'CO₂+CH₄ t/year',
    'switch.label': 'Simulated status',
    'state.pending': 'Not deployed', 'state.installed': 'Installed (sim.)',
    'node.pending': 'Node · pending deployment', 'node.installed': 'Node · installed (simulated)',
    'sub.red': 'red · not deployed', 'sub.green': 'green · simulated operational',
    'star.kicker': 'Location · HQ in', 'star.country': 'Country', 'star.city': 'City',
    'star.hq': 'Parent base',
    'star.coords': 'Coordinates', 'star.precision': 'Precision', 'star.weight': 'Location weight',
    'precision.city': 'exact city', 'precision.country': 'country centroid',
    'stats.deployed': 'Nodes deployed', 'stats.absorbed': 'Curtailment absorbed',
    'stats.pellet': 'Biopellet produced', 'stats.value': 'Biopellet value',
    'stats.co2': 'CO₂+CH₄ avoided', 'stats.losing': 'Still being lost',
    'loss.pendingNodes': 'nodes not deployed', 'loss.simulated': 'simulated as installed',
    'loss.recovered': 'already recovered', 'loss.neutralised': 'nodes deployed · annual loss neutralised',
    'loss.recoveredYear': 'recovered per year',
    'pdf.generating': 'GENERATING…',
    loading: 'Loading geospatial interface…',
    'unit.gwhYear': 'GWh/year', 'unit.tYear': 't/year', 'unit.year': 'year',
    'pdf.legend': 'Star = company HQ · cylinder = {country} curtailment pending deployment',
    'pdf.lossTitle': 'ANNUAL COST OF NOT ADOPTING BIOHYBRID',
    'pdf.pendingOf': '{a} of {b} nodes not deployed',
    'pdf.row.location': 'Geographic location',
    'pdf.row.pending': 'Pending {country} curtailment nodes',
    'pdf.row.absorbNode': 'Absorption per node (GWh/year)',
    'pdf.row.absorbFleet': 'Total fleet absorption (GWh/year)',
    'pdf.row.target': 'Curtailment target (GW)',
    'pdf.row.pelletPrice': 'Biopellet price (€/t)',
    'pdf.row.pelletNode': 'Biopellet per node (t/year)',
    'pdf.row.pelletFleet': 'Total fleet biopellet (t/year)',
    'pdf.row.valueNode': 'Biopellet value per node (€/year)',
    'pdf.row.valueFleet': 'Total fleet biopellet value (€/year)',
    'pdf.row.co2Node': 'CO₂+CH₄ avoided per node (t/year)',
    'pdf.row.co2Fleet': 'Total fleet CO₂+CH₄ avoided (t/year)',
    'pdf.generatedAt': 'Generated',
    'clause.ppa': 'Node unlocking is conditional solely upon an energy PPA for grid curtailment under Pactvm Viridi governance — no node is activated without a purchase contract for curtailed renewable surplus.',
    'share.kicker': 'Client presentation · temporary link',
    'share.create': 'GENERATE LINK',
    'share.codeOnce': 'The code is shown only now: it is not stored in clear text and cannot be retrieved again.',
    'share.needEmail': 'Enter at least one authorised email.',
    'share.failed': 'Could not generate the link',
    'share.empty': 'No links issued',
    'crumb.restricted': '(Restricted)',
    'share.link': 'Link', 'share.expires': 'Expires',
    'share.emails': 'Emails', 'share.accesses': 'Accesses', 'share.copy': 'COPY',
    'locked.sub': 'Territorial breakdown restricted · not included in this presentation',
    logout: 'Sign out',
    'ident.gis': 'GIS location', 'ident.cadastral': 'Cadastral ref.',
    'ident.client': 'Client / supplier',
    'ident.cadastralPending': 'pending registration',
    'locked.badge': '🔒 SPV LEVEL 2 CLEARANCE REQUIRED',
    'locked.anon': '🔒 CLIENT_ANONYMIZED',
  },
  it: {
    subtitle: 'Interfaccia geospaziale · VDR',
    'btn.table': 'TABELLA · 200 NODI',
    'btn.pdf': 'ESPORTA PDF',
    'btn.spain': 'VAI IN {country}',
    'btn.hq': 'VAI ALLA SEDE',
    'btn.reset': 'REIMPOSTA VISTA',
    'btn.installAll': 'SIMULA TUTTI INSTALLATI',
    'btn.resetAll': 'RESET',
    'legend.star': 'Stella · sede aziendale',
    'legend.red': 'Nodo rosso · non installato',
    'legend.green': 'Nodo verde · installato (simulato)',
    hint: 'trascina: ruota 360° · shift o tasto destro: sposta · rotella o pizzico: zoom · doppio clic: reimposta · clic su un nodo: commuta',
    'loss.label': 'Costo annuo del non adottare BioHybrid',
    'table.kicker': 'Quantificazione del dispiegamento · {country}',
    'table.byRegion': 'Ripartizione per comunità autonoma',
    'table.total': 'TOTALE · nodi',
    'th.node': 'Nodo', 'th.region': 'Comunità', 'th.state': 'Stato', 'th.nodes': 'Nodi',
    'th.absorbs': 'Assorbe<br><span>GWh/anno</span>',
    'th.pellet': 'Biopellet<br><span>t/anno</span>',
    'th.value': 'Valore biopellet<br><span>€/anno · 350 €/t</span>',
    'th.co2': 'CO₂+CH₄ evitate<br><span>t/anno</span>',
    'th.sim': 'Simula',
    'stat.absorbs': 'Assorbe GWh/anno', 'stat.pellet': 'Biopellet t/anno', 'stat.co2': 'CO₂+CH₄ t/anno',
    'switch.label': 'Stato simulato',
    'state.pending': 'Non installato', 'state.installed': 'Installato (sim.)',
    'node.pending': 'Nodo · in attesa di installazione', 'node.installed': 'Nodo · installato (simulato)',
    'sub.red': 'rosso · non installato', 'sub.green': 'verde · operativo simulato',
    'star.kicker': 'Ubicazione · sede in', 'star.country': 'Paese', 'star.city': 'Città',
    'star.hq': 'Base madre',
    'star.coords': 'Coordinate', 'star.precision': 'Precisione', 'star.weight': 'Peso ubicazione',
    'precision.city': 'città esatta', 'precision.country': 'centro del paese',
    'stats.deployed': 'Nodi installati', 'stats.absorbed': 'Curtailment assorbito',
    'stats.pellet': 'Biopellet prodotto', 'stats.value': 'Valore biopellet',
    'stats.co2': 'CO₂+CH₄ evitate', 'stats.losing': 'Ancora perduto',
    'loss.pendingNodes': 'nodi non installati', 'loss.simulated': 'simulati come installati',
    'loss.recovered': 'già recuperato', 'loss.neutralised': 'nodi installati · perdita annua neutralizzata',
    'loss.recoveredYear': 'recuperati all’anno',
    'pdf.generating': 'GENERAZIONE…',
    loading: 'Caricamento interfaccia geospaziale…',
    'unit.gwhYear': 'GWh/anno', 'unit.tYear': 't/anno', 'unit.year': 'anno',
    'pdf.legend': 'Stella = sede aziendale · cilindro = curtailment {country} in attesa di installazione',
    'pdf.lossTitle': 'COSTO ANNUO DEL NON ADOTTARE BIOHYBRID',
    'pdf.pendingOf': '{a} di {b} nodi non installati',
    'pdf.row.location': 'Ubicazione geografica',
    'pdf.row.pending': 'Nodi curtailment {country} in attesa',
    'pdf.row.absorbNode': 'Assorbimento per nodo (GWh/anno)',
    'pdf.row.absorbFleet': 'Assorbimento totale flotta (GWh/anno)',
    'pdf.row.target': 'Obiettivo curtailment (GW)',
    'pdf.row.pelletPrice': 'Prezzo biopellet (€/t)',
    'pdf.row.pelletNode': 'Biopellet per nodo (t/anno)',
    'pdf.row.pelletFleet': 'Biopellet totale flotta (t/anno)',
    'pdf.row.valueNode': 'Valore biopellet per nodo (€/anno)',
    'pdf.row.valueFleet': 'Valore biopellet totale flotta (€/anno)',
    'pdf.row.co2Node': 'CO₂+CH₄ evitate per nodo (t/anno)',
    'pdf.row.co2Fleet': 'CO₂+CH₄ evitate totale flotta (t/anno)',
    'pdf.generatedAt': 'Generato',
    'clause.ppa': 'Lo sblocco dei nodi è subordinato esclusivamente a un PPA energetico di grid curtailment sotto la governance di Pactvm Viridi — nessun nodo viene attivato senza contratto di acquisto dell’eccedenza rinnovabile curtailed.',
    'share.kicker': 'Presentazione al cliente · link temporaneo',
    'share.create': 'GENERA LINK',
    'share.codeOnce': 'Il codice viene mostrato solo ora: non resta salvato in chiaro e non è più consultabile.',
    'share.needEmail': 'Indica almeno un indirizzo autorizzato.',
    'share.failed': 'Impossibile generare il link',
    'share.empty': 'Nessun link emesso',
    'crumb.restricted': '(Riservato)',
    'share.link': 'Link', 'share.expires': 'Scade',
    'share.emails': 'Email', 'share.accesses': 'Accessi', 'share.copy': 'COPIA',
    'locked.sub': 'Ripartizione territoriale riservata · non inclusa in questa presentazione',
    logout: 'Esci',
    'ident.gis': 'Ubicazione GIS', 'ident.cadastral': 'Rif. catastale',
    'ident.client': 'Cliente / fornitore',
    'ident.cadastralPending': 'in attesa di registrazione',
    'locked.badge': '🔒 SPV LEVEL 2 CLEARANCE REQUIRED',
    'locked.anon': '🔒 CLIENT_ANONYMIZED',
  },
  /* Francais: registre corporatif international (TotalEnergies). */
  fr: {
    subtitle: 'Interface géospatiale · VDR',
    'btn.table': 'TABLEAU · 200 NŒUDS',
    'btn.pdf': 'EXPORTER PDF',
    'btn.spain': 'ALLER EN {country}',
    'btn.hq': 'ALLER AU SIÈGE',
    'btn.reset': 'RÉINITIALISER LA VUE',
    'btn.installAll': 'SIMULER TOUS INSTALLÉS',
    'btn.resetAll': 'RESET',
    'legend.star': 'Étoile · siège de l’entreprise',
    'legend.red': 'Nœud rouge · non déployé',
    'legend.green': 'Nœud vert · installé (simulé)',
    hint: 'glisser : rotation 360° · maj ou clic droit : déplacer · molette ou pincement : zoom · double clic : réinitialiser · clic sur un nœud : commuter',
    'loss.label': 'Coût annuel de la non-adoption de BioHybrid',
    'table.kicker': 'Quantification du déploiement · {country}',
    'table.byRegion': 'Répartition par communauté autonome',
    'table.total': 'TOTAL · nœuds',
    'th.node': 'Nœud', 'th.region': 'Communauté', 'th.state': 'Statut', 'th.nodes': 'Nœuds',
    'th.absorbs': 'Absorbe<br><span>GWh/an</span>',
    'th.pellet': 'Biopellet<br><span>t/an</span>',
    'th.value': 'Valeur biopellet<br><span>€/an · 350 €/t</span>',
    'th.co2': 'CO₂+CH₄ évité<br><span>t/an</span>',
    'th.sim': 'Simuler',
    'stat.absorbs': 'Absorbe GWh/an', 'stat.pellet': 'Biopellet t/an', 'stat.co2': 'CO₂+CH₄ t/an',
    'switch.label': 'Statut simulé',
    'state.pending': 'Non déployé', 'state.installed': 'Installé (sim.)',
    'node.pending': 'Nœud · en attente de déploiement', 'node.installed': 'Nœud · installé (simulé)',
    'sub.red': 'rouge · non déployé', 'sub.green': 'vert · opérationnel simulé',
    'star.kicker': 'Localisation · siège à', 'star.country': 'Pays', 'star.city': 'Ville',
    'star.hq': 'Base mère',
    'star.coords': 'Coordonnées', 'star.precision': 'Précision', 'star.weight': 'Poids de localisation',
    'precision.city': 'ville exacte', 'precision.country': 'centre du pays',
    'stats.deployed': 'Nœuds déployés', 'stats.absorbed': 'Curtailment absorbé',
    'stats.pellet': 'Biopellet produit', 'stats.value': 'Valeur biopellet',
    'stats.co2': 'CO₂+CH₄ évité', 'stats.losing': 'Toujours perdu',
    'loss.pendingNodes': 'nœuds non déployés', 'loss.simulated': 'simulés comme installés',
    'loss.recovered': 'déjà récupéré', 'loss.neutralised': 'nœuds déployés · perte annuelle neutralisée',
    'loss.recoveredYear': 'récupérés par an',
    'pdf.generating': 'GÉNÉRATION…',
    loading: 'Chargement de l’interface géospatiale…',
    'unit.gwhYear': 'GWh/an', 'unit.tYear': 't/an', 'unit.year': 'an',
    'pdf.legend': 'Étoile = siège de l’entreprise · cylindre = curtailment {country} en attente de déploiement',
    'pdf.lossTitle': 'COÛT ANNUEL DE LA NON-ADOPTION DE BIOHYBRID',
    'pdf.pendingOf': '{a} sur {b} nœuds non déployés',
    'pdf.row.location': 'Localisation géographique',
    'pdf.row.pending': 'Nœuds curtailment {country} en attente',
    'pdf.row.absorbNode': 'Absorption par nœud (GWh/an)',
    'pdf.row.absorbFleet': 'Absorption totale de la flotte (GWh/an)',
    'pdf.row.target': 'Objectif curtailment (GW)',
    'pdf.row.pelletPrice': 'Prix biopellet (€/t)',
    'pdf.row.pelletNode': 'Biopellet par nœud (t/an)',
    'pdf.row.pelletFleet': 'Biopellet total de la flotte (t/an)',
    'pdf.row.valueNode': 'Valeur biopellet par nœud (€/an)',
    'pdf.row.valueFleet': 'Valeur biopellet totale de la flotte (€/an)',
    'pdf.row.co2Node': 'CO₂+CH₄ évité par nœud (t/an)',
    'pdf.row.co2Fleet': 'CO₂+CH₄ évité total de la flotte (t/an)',
    'pdf.generatedAt': 'Généré',
    'clause.ppa': 'Le déverrouillage des nœuds est conditionné exclusivement à un PPA énergétique de grid curtailment sous gouvernance Pactvm Viridi — aucun nœud n’est activé sans contrat d’achat du surplus renouvelable curtailed.',
    'share.kicker': 'Présentation client · lien temporaire',
    'share.create': 'GÉNÉRER LE LIEN',
    'share.codeOnce': 'Le code n’est affiché que maintenant : il n’est pas conservé en clair et ne peut plus être consulté.',
    'share.needEmail': 'Indiquez au moins une adresse autorisée.',
    'share.failed': 'Impossible de générer le lien',
    'share.empty': 'Aucun lien émis',
    'crumb.restricted': '(Restreint)',
    'share.link': 'Lien', 'share.expires': 'Expire',
    'share.emails': 'Adresses', 'share.accesses': 'Accès', 'share.copy': 'COPIER',
    'locked.sub': 'Répartition territoriale restreinte · non incluse dans cette présentation',
    logout: 'Se déconnecter',
    'ident.gis': 'Localisation GIS', 'ident.cadastral': 'Réf. cadastrale',
    'ident.client': 'Client / fournisseur',
    'ident.cadastralPending': 'en attente d’enregistrement',
    'locked.badge': '🔒 SPV LEVEL 2 CLEARANCE REQUIRED',
    'locked.anon': '🔒 CLIENT_ANONYMIZED',
  },
};

const LANG_KEY = 'vdr.lang';
let lang = (() => {
  try { const s = localStorage.getItem(LANG_KEY); if (s && I18N[s]) return s; } catch {}
  const nav = (navigator.language || 'es').slice(0, 2).toLowerCase();
  return I18N[nav] ? nav : 'es';
})();

function t(key) { return (I18N[lang] && I18N[lang][key]) || I18N.es[key] || key; }

function applyI18n() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  // el numero del boton de tabla y el pais del cluster dependen de los
  // datos reales de la empresa (antes "España" fijo en las 4 traducciones)
  const total = currentGlobeData?.esCurtailment?.nodesTargetTotal;
  if (total) {
    document.getElementById('tableBtn').textContent = t('btn.table').replace('200', fmtInt(total));
  }
  const countryLabel = currentGlobeData?.esCurtailment?.countryLabel || '—';
  document.getElementById('focusSpainBtn').textContent = t('btn.spain').replace('{country}', countryLabel);
  document.getElementById('tableKicker').textContent = t('table.kicker').replace('{country}', countryLabel);
  // refrescar lo que se pinta desde JS
  if (currentGlobeData) {
    buildTable();
    renderAggregates();
    installed.forEach((i) => syncTableRow(i));
    if (nodePanelState.visible) renderNodePanel();
    if (starCardState.visible) showStarCard(currentGlobeData);
  }
}

function setLang(next) {
  if (!I18N[next] || next === lang) return;
  lang = next;
  try { localStorage.setItem(LANG_KEY, next); } catch {}
  syncLangSwitch();
  applyI18n();
}

function syncLangSwitch() {
  const opts = [...document.querySelectorAll('.vdr-lang__opt')];
  const idx = Math.max(0, opts.findIndex((o) => o.dataset.lang === lang));
  opts.forEach((o, i) => {
    o.classList.toggle('is-active', i === idx);
    o.setAttribute('aria-checked', String(i === idx));
  });
  document.getElementById('langThumb').style.transform = `translateX(${idx * 40}px)`;
}

document.querySelectorAll('.vdr-lang__opt').forEach((btn) => {
  btn.addEventListener('click', () => setLang(btn.dataset.lang));
});

// El motor 3D vive en /js/vdr-globe.js y lo comparten esta vista y
// la vista de invitado (enlace temporal). Ver ese modulo para el
// render, la camara orbital y el reparto de nodos.

// ---- tarjetas flotantes (estrella / nodos) ----
const starCardEl = document.getElementById('starCard');
const starCardState = { visible: false };
function positionCard(el, p) {
  if (!p || !p.visible) { el.style.opacity = '0'; return; }
  el.style.left = `${p.x}px`;
  el.style.top = `${p.y - 26}px`;
}
function showStarCard(globeData) {
  document.getElementById('starCardKicker').textContent = `${t('star.kicker')} ${globeData.star?.countryLabel || '—'}`;
  document.getElementById('starCardTitle').textContent = globeData.star?.city
    ? `${globeData.star.city}, ${globeData.star.countryLabel}`
    : (globeData.star?.countryLabel || '—');
  const st = globeData.star || {};
  /* Logo corporativo de la sede. Convencion de ruta:
   * /assets/logo-<empresa en minusculas, sin espacios>.png
   * Si el archivo no existe, onerror lo oculta y la tarjeta queda
   * igual de limpia (sin icono roto). */
  const logoEl = document.getElementById('starCardLogo');
  const slug = String(globeData.name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (slug) {
    logoEl.onerror = () => { logoEl.hidden = true; };
    logoEl.onload = () => { logoEl.hidden = false; };
    logoEl.alt = globeData.name || '';
    logoEl.src = `/assets/logo-${slug}.png`;
  } else {
    logoEl.hidden = true;
  }
  document.getElementById('starCardHqTag').textContent = t('star.hq');
  document.getElementById('starCardRows').innerHTML = `
        <div class="vdr-card__row"><span class="k">${escapeHtml(t('star.country'))}</span><span class="v">${escapeHtml(st.countryLabel || '—')}</span></div>
        <div class="vdr-card__row"><span class="k">${escapeHtml(t('star.city'))}</span><span class="v">${escapeHtml(st.city || '—')}</span></div>
        <div class="vdr-card__row"><span class="k">${escapeHtml(t('star.coords'))}</span><span class="v">${Number(st.lat ?? 0).toFixed(4)}, ${Number(st.lng ?? 0).toFixed(4)}</span></div>
        <div class="vdr-card__row"><span class="k">${escapeHtml(t('star.precision'))}</span><span class="v">${escapeHtml(st.precision === 'ciudad' ? t('precision.city') : t('precision.country'))}</span></div>
        <div class="vdr-card__row"><span class="k">${escapeHtml(t('star.weight'))}</span><span class="v">${st.weight ?? '—'}</span></div>
      `;
  starCardState.visible = true;
  starCardEl.classList.add('visible');
}
function hideStarCard() { starCardState.visible = false; starCardEl.classList.remove('visible'); }
document.getElementById('starCardClose').addEventListener('click', hideStarCard);

// ---- formato ----
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

// ---- estado de simulacion (solo en memoria de sesion, sin persistir) ----
const installed = new Set();
let currentGlobeData = null;
let globeApi = null;

// ---- panel de nodo individual ----
const nodePanelEl = document.getElementById('nodePanel');
const nodePanelState = { visible: false, index: -1 };

function nodeDefAt(index) {
  const nodes = currentGlobeData?.esCurtailment?.nodes || [];
  return nodes[index] || null;
}

function renderNodePanel() {
  const idx = nodePanelState.index;
  const def = nodeDefAt(idx);
  if (!def) return;
  const es = currentGlobeData.esCurtailment || {};
  const isOn = installed.has(idx);
  nodePanelEl.classList.toggle('installed', isOn);
  document.getElementById('nodePanelKicker').textContent = isOn ? t('node.installed') : t('node.pending');
  // en VISTA ENELse omite la comunidad, igual que ve el invitado
  document.getElementById('nodePanelTitle').textContent = (def.regionName && plane !== 'cliente')
    ? `${def.code} · ${def.regionName}`
    : def.code;
  document.getElementById('nodeStatGwh').textContent = fmtDec(def.annualEnergyGwh, 2);
  document.getElementById('nodeStatPellet').textContent = fmtInt(def.biopelletTonsYear);
  document.getElementById('nodeStatCo2').textContent = fmtInt(def.co2ch4AvoidedTonsYear);
  document.getElementById('nodeSwitchSub').textContent = isOn ? t('sub.green') : t('sub.red');
  const sw = document.getElementById('nodeSwitch');
  sw.setAttribute('aria-checked', String(isOn));
  /* Geocastral e identidad bajo SPV LEVEL 2 en ENEL_DEMO_VIEW. Las
   * metricas operativas (GWh / T / €) se mantienen visibles en ambos
   * planos: son agregados de nodo, no datos de parcela. */
  const locked = plane === 'cliente';
  const gisEl = document.getElementById('nodeGis');
  const cadEl = document.getElementById('nodeCadastral');
  const cliEl = document.getElementById('nodeClient');
  gisEl.textContent = locked
    ? t('locked.badge')
    : `${fmtDec(def.lat, 4)}, ${fmtDec(def.lng, 4)}`;
  // No hay referencia catastral real en el payload: en plano interno se
  // declara pendiente en vez de inventar un numero de parcela.
  cadEl.textContent = locked ? t('locked.badge') : t('ident.cadastralPending');
  cliEl.textContent = locked
    ? t('locked.anon')
    : (currentGlobeData?.name || '—');
  [gisEl, cadEl, cliEl].forEach((el) => el.classList.toggle('is-locked', locked));

  document.getElementById('nodeRevenue').innerHTML =
    `${fmtInt(def.biopelletTonsYear)} T × ${fmtInt(es.biopelletPriceEurPerTon)} €/T = <b style="color:var(--text-primary)">${fmtEur(def.revenueEurYear)}</b> / ${escapeHtml(t('unit.year'))}`;
  // La clausula PPA llega del backend siempre en castellano: se traduce
  // en cliente para no dejar la ficha en dos idiomas.
  document.getElementById('nodeClause').textContent = t('clause.ppa');
}

function showNodePanel(index) {
  nodePanelState.index = index;
  nodePanelState.visible = true;
  renderNodePanel();
  nodePanelEl.classList.add('visible');
}
function hideNodePanel() { nodePanelState.visible = false; nodePanelEl.classList.remove('visible'); }
document.getElementById('nodePanelClose').addEventListener('click', hideNodePanel);
document.getElementById('nodeSwitch').addEventListener('click', () => {
  if (nodePanelState.index < 0) return;
  toggleNode(nodePanelState.index);
});

// ---- conmutar nodo (3D + tabla + agregados, todo en vivo) ----
function toggleNode(index, forced) {
  const isOn = forced === undefined ? !installed.has(index) : forced;
  if (isOn) installed.add(index); else installed.delete(index);
  globeApi?.setNodeInstalled(index, isOn);
  syncTableRow(index);
  if (nodePanelState.visible && nodePanelState.index === index) renderNodePanel();
  renderAggregates();
}

function setAll(isOn) {
  const total = currentGlobeData?.esCurtailment?.nodesTargetTotal || 0;
  installed.clear();
  if (isOn) for (let i = 0; i < total; i++) installed.add(i);
  globeApi?.setAllInstalled(isOn);
  for (let i = 0; i < total; i++) syncTableRow(i);
  if (nodePanelState.visible) renderNodePanel();
  renderAggregates();
}

// ---- tabla economica ----
const tableOverlay = document.getElementById('tableOverlay');
function buildTable() {
  const es = currentGlobeData.esCurtailment || {};
  const nodes = es.nodes || [];
  document.getElementById('tableTitle').textContent = `${fmtInt(es.nodesTargetTotal)} · ${t('state.pending')}`;
  document.getElementById('tableClause').textContent = t('clause.ppa');

  // en VISTA ENELla comunidad no se muestra (SPV LEVEL 2)
  const hideRegion = plane === 'cliente';
  document.querySelectorAll('#nodeTable thead th[data-i18n="th.region"]').forEach((th) => { th.hidden = hideRegion; });
  document.getElementById('nodeTableBody').innerHTML = nodes.map((n, i) => `
        <tr data-row="${i}">
          <td>${escapeHtml(n.code)}</td>
          ${hideRegion ? '' : `<td class="region-cell">${escapeHtml(n.regionName || '—')}</td>`}
          <td class="state" data-cell="state">${escapeHtml(t('state.pending'))}</td>
          <td class="num">${fmtDec(n.annualEnergyGwh, 2)}</td>
          <td class="num">${fmtInt(n.biopelletTonsYear)}</td>
          <td class="num">${fmtEur(n.revenueEurYear)}</td>
          <td class="num">${fmtInt(n.co2ch4AvoidedTonsYear)}</td>
          <td class="switch-col">
            <button class="vdr-switch" data-toggle="${i}" role="switch" aria-checked="false"><span class="vdr-switch__knob"></span></button>
          </td>
        </tr>
      `).join('');

  document.getElementById('nodeTableFoot').innerHTML = `
        <tr>
          <td colspan="${hideRegion ? 2 : 3}">${escapeHtml(t('table.total'))} · ${fmtInt(es.nodesTargetTotal)}</td>
          <td class="num">${fmtDec(es.totalAnnualEnergyGwh, 2)}</td>
          <td class="num">${fmtInt(es.totalBiopelletTonsYear)}</td>
          <td class="num">${fmtEur(es.totalRevenueEurYear)}</td>
          <td class="num">${fmtInt(es.totalCo2ch4AvoidedTonsYear)}</td>
          <td class="switch-col"></td>
        </tr>
      `;

  // resumen por comunidad autonoma
  const regions = Array.isArray(es.regions) ? es.regions : [];
  document.getElementById('regionTableBody').innerHTML = regions
    .slice().sort((a, b) => b.nodes - a.nodes)
    .map((r) => `
          <tr data-region="${escapeHtml(r.code)}">
            <td>${escapeHtml(r.name)}</td>
            <td class="num">${fmtInt(r.nodes)}</td>
            <td class="num">${fmtDec(r.annualEnergyGwh, 2)}</td>
            <td class="num">${fmtInt(r.biopelletTonsYear)}</td>
            <td class="num">${fmtEur(r.revenueEurYear)}</td>
            <td class="num">${fmtInt(r.co2ch4AvoidedTonsYear)}</td>
          </tr>
        `).join('');

  document.getElementById('nodeTableBody').querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => toggleNode(Number(btn.dataset.toggle)));
  });
  document.getElementById('nodeTableBody').querySelectorAll('tr[data-row]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-toggle]')) return;
      showNodePanel(Number(tr.dataset.row));
    });
  });
}

function syncTableRow(index) {
  const tr = document.querySelector(`tr[data-row="${index}"]`);
  if (!tr) return;
  const isOn = installed.has(index);
  tr.classList.toggle('is-installed', isOn);
  tr.querySelector('[data-cell="state"]').textContent = isOn ? t('state.installed') : t('state.pending');
  tr.querySelector('[data-toggle]').setAttribute('aria-checked', String(isOn));
}

// ---- agregados + hero de perdida ----
function renderAggregates() {
  const es = currentGlobeData.esCurtailment || {};
  const total = es.nodesTargetTotal || 0;
  const on = installed.size;
  const pending = total - on;
  const ratioPending = total > 0 ? pending / total : 0;

  // El titular (annualLossEur) es la perdida con CERO nodos desplegados.
  // Cada nodo simulado como instalado recorta su parte proporcional:
  // asi el switch traduce "instalar" en "dejar de perder" en vivo.
  const lossNow = (es.annualLossEur || 0) * ratioPending;
  const recovered = (es.annualLossEur || 0) - lossNow;

  const isMitigated = on > 0 && pending === 0;
  const heroEl = document.getElementById('lossHero');
  heroEl.classList.toggle('mitigated', isMitigated);
  // Con 0 nodos pendientes "- 0 €" no comunica nada: la cifra grande
  // pasa a mostrar lo recuperado (positivo), que es lo que de verdad
  // cambio al instalar el ultimo nodo. Bug visual reportado 2026-10-04.
  document.getElementById('lossFigure').textContent = isMitigated
    ? `+ ${fmtEur(recovered)}`
    : `− ${fmtEur(lossNow)}`;
  document.getElementById('lossBarFill').style.width = `${ratioPending * 100}%`;
  document.getElementById('lossBreakdown').innerHTML = pending === 0
    ? `<span><b>${fmtInt(total)}</b> ${escapeHtml(t('loss.neutralised'))} · <b>${fmtEur(recovered)}</b> ${escapeHtml(t('loss.recoveredYear'))}</span>`
    : `<span><b>${fmtInt(pending)}</b> ${escapeHtml(t('loss.pendingNodes'))}</span>
           <span><b>${fmtInt(on)}</b> ${escapeHtml(t('loss.simulated'))}</span>
           <span>${escapeHtml(t('loss.recovered'))}: <b>${fmtEurCompact(recovered)}</b></span>`;

  const pelletT = (es.biopelletTonsPerNodeYear || 0) * on;
  const co2T = (es.co2ch4AvoidedTonsPerNodeYear || 0) * on;
  const gwh = (es.nodeAnnualEnergyGwh || 0) * on;
  const revenue = (es.revenueEurPerNodeYear || 0) * on;

  // Unidades por idioma: el fallback anterior mandaba 'fr' al ingles.
  const unitY = t('unit.gwhYear');
  const unitT = t('unit.tYear');
  document.getElementById('tableStats').innerHTML = `
        <div class="vdr-stat-cell"><div class="lbl">${escapeHtml(t('stats.deployed'))}</div><div class="val ${on > 0 ? 'green' : ''}">${fmtInt(on)} / ${fmtInt(total)}</div></div>
        <div class="vdr-stat-cell"><div class="lbl">${escapeHtml(t('stats.absorbed'))}</div><div class="val">${fmtDec(gwh, 2)} <span style="font-size:0.7rem;color:var(--text-dim)">${unitY}</span></div></div>
        <div class="vdr-stat-cell"><div class="lbl">${escapeHtml(t('stats.pellet'))}</div><div class="val">${fmtInt(pelletT)} <span style="font-size:0.7rem;color:var(--text-dim)">${unitT}</span></div></div>
        <div class="vdr-stat-cell"><div class="lbl">${escapeHtml(t('stats.value'))}</div><div class="val ${on > 0 ? 'green' : ''}">${fmtEurCompact(revenue)}</div></div>
        <div class="vdr-stat-cell"><div class="lbl">${escapeHtml(t('stats.co2'))}</div><div class="val">${fmtInt(co2T)} <span style="font-size:0.7rem;color:var(--text-dim)">${unitT}</span></div></div>
        <div class="vdr-stat-cell"><div class="lbl">${escapeHtml(t('stats.losing'))}</div><div class="val ${pending > 0 ? 'red' : 'green'}">${fmtEurCompact(lossNow)}</div></div>
      `;

  document.getElementById('legendCounter').textContent = `${fmtInt(on)} / ${fmtInt(total)}`;
}

/* ---- conmutador de plano: interno vs lo que ve el cliente ----
 * VISTA ENEL reproduce exactamente las restricciones del enlace de
 * invitado: sin reparto territorial (SPV LEVEL 2), sin columna de
 * comunidad, sin exportar PDF. Sirve para revisar antes de la reunion
 * que no se enseña de mas. */
let plane = 'interno';

function applyPlane() {
  const isClient = plane === 'cliente';
  document.body.classList.toggle('client-plane', isClient);
  document.getElementById('planeSwitch').classList.toggle('is-client', isClient);
  /* Kiosko: la ruta de navegacion se desactiva en plano restringido
   * para que nadie pueda volver hacia Systems desde la pantalla
   * compartida. El bloqueo es de UI, no de permisos: la sesion sigue
   * siendo la del admin. */
  document.querySelectorAll('.vdr-crumbs a').forEach((a) => {
    if (isClient) {
      if (!a.dataset.href) a.dataset.href = a.getAttribute('href') || '';
      a.removeAttribute('href');
      a.setAttribute('aria-disabled', 'true');
      a.setAttribute('tabindex', '-1');
    } else if (a.dataset.href) {
      a.setAttribute('href', a.dataset.href);
      a.removeAttribute('aria-disabled');
      a.removeAttribute('tabindex');
    }
  });
  const crumbCompanyEl = document.getElementById('crumbCompany');
  const companyName = currentGlobeData?.name || crumbCompanyEl.dataset.name || crumbCompanyEl.textContent;
  if (!crumbCompanyEl.dataset.name && companyName) crumbCompanyEl.dataset.name = companyName;
  crumbCompanyEl.textContent = isClient
    ? `${crumbCompanyEl.dataset.name || companyName} ${t('crumb.restricted')}`
    : (crumbCompanyEl.dataset.name || companyName);
  const planeClientOptEl = document.getElementById('planeClientOpt');
  if (planeClientOptEl) planeClientOptEl.textContent = `${crumbCompanyEl.dataset.name || companyName} (Res.) VDR`;

  document.getElementById('regionLocked').hidden = !isClient;
  document.getElementById('regionScroll').hidden = isClient;
  document.getElementById('exportPdfBtn').hidden = isClient;
  document.getElementById('shareBtn').hidden = isClient;
  document.querySelectorAll('.vdr-plane__opt').forEach((o) => {
    const on = o.dataset.plane === plane;
    o.classList.toggle('is-active', on);
    o.setAttribute('aria-checked', String(on));
  });
  // Offset medido, no fijo: la etiqueta ENEL_DEMO_VIEW es mas ancha que
  // PLANO INTERNO y un valor magico descuadraba el selector.
  const opts = [...document.querySelectorAll('.vdr-plane__opt')];
  const active = opts.find((o) => o.dataset.plane === plane) || opts[0];
  const thumb = document.getElementById('planeThumb');
  if (active) {
    thumb.style.width = `${active.offsetWidth}px`;
    thumb.style.transform = `translateX(${active.offsetLeft - (opts[0]?.offsetLeft ?? 0)}px)`;
  }
  if (currentGlobeData) { buildTable(); installed.forEach((i) => syncTableRow(i)); }
  if (nodePanelState.visible) renderNodePanel();
}

document.querySelectorAll('.vdr-plane__opt').forEach((btn) => {
  btn.addEventListener('click', () => { plane = btn.dataset.plane; applyPlane(); });
});

/* ---- enlace temporal para presentacion bajo NDA ---- */
const shareOverlay = document.getElementById('shareOverlay');
let shareMinutes = 15;

document.getElementById('shareBtn').addEventListener('click', () => {
  shareOverlay.classList.add('visible');
  loadShareList();
});
document.getElementById('shareClose').addEventListener('click', () => shareOverlay.classList.remove('visible'));
shareOverlay.addEventListener('click', (e) => { if (e.target === shareOverlay) shareOverlay.classList.remove('visible'); });

document.querySelectorAll('#shareMinutes .glass-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    shareMinutes = Number(btn.dataset.min);
    document.querySelectorAll('#shareMinutes .glass-pill').forEach((b) => b.classList.toggle('is-active', b === btn));
  });
});

document.getElementById('shareCreateBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const errEl = document.getElementById('shareErr');
  errEl.textContent = '';
  const emails = document.getElementById('shareEmails').value
    .split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  if (emails.length === 0) { errEl.textContent = t('share.needEmail'); return; }
  const params = new URLSearchParams(location.search);
  btn.disabled = true;
  try {
    const r = await api.pactvmVdrShareCreate({ companyId: params.get('id'), emails, minutes: shareMinutes });
    document.getElementById('shareUrl').textContent = r.url;
    document.getElementById('shareCode').textContent = r.code;
    document.getElementById('shareExpires').textContent = new Date(r.expiresAt).toLocaleString(numLocale(), { dateStyle: 'short', timeStyle: 'short' });
    document.getElementById('shareForm').hidden = true;
    document.getElementById('shareResult').hidden = false;
    loadShareList();
  } catch (ex) {
    errEl.textContent = ex.message || t('share.failed');
  } finally { btn.disabled = false; }
});

document.getElementById('shareAnotherBtn').addEventListener('click', () => {
  document.getElementById('shareResult').hidden = true;
  document.getElementById('shareForm').hidden = false;
  document.getElementById('shareEmails').value = '';
});

document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const text = document.getElementById(btn.dataset.copy).textContent;
    try { await navigator.clipboard.writeText(text); toast('Copiado'); } catch { }
  });
});

async function loadShareList() {
  const body = document.getElementById('shareListBody');
  try {
    const rows = await api.pactvmVdrSharesList();
    if (rows.length === 0) { body.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-dim);">${escapeHtml(t('share.empty'))}</td></tr>`; return; }
    body.innerHTML = rows.map((r) => {
      const estado = r.revoked ? 'Revocado' : r.expired ? 'Caducado' : 'Activo';
      const color = r.revoked || r.expired ? 'var(--text-dim)' : '#7fe0a4';
      return `<tr>
            <td style="font-size:0.68rem;">${escapeHtml(r.emails.join(', '))}</td>
            <td style="font-size:0.68rem;">${new Date(r.expiresAt).toLocaleString(numLocale(), { dateStyle: 'short', timeStyle: 'short' })}</td>
            <td style="font-size:0.66rem;color:${color};">${estado}</td>
            <td class="num">${r.accessCount}</td>
            <td>${r.revoked || r.expired ? '' : `<button class="glass-pill" data-revoke="${escapeHtml(r.id)}">REVOCAR</button>`}</td>
          </tr>`;
    }).join('');
    body.querySelectorAll('[data-revoke]').forEach((b) => {
      b.addEventListener('click', async () => {
        try { await api.pactvmVdrShareRevoke(b.dataset.revoke); loadShareList(); } catch (ex) { showError(ex.message); }
      });
    });
  } catch (ex) { showError(ex.message || 'Error al cargar enlaces'); }
}

function openTable() { tableOverlay.classList.add('visible'); }
function closeTable() { tableOverlay.classList.remove('visible'); }
document.getElementById('tableClose').addEventListener('click', closeTable);
document.getElementById('tableBtn').addEventListener('click', openTable);
tableOverlay.addEventListener('click', (e) => { if (e.target === tableOverlay) closeTable(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTable(); });
document.getElementById('installAllBtn').addEventListener('click', () => setAll(true));
document.getElementById('resetAllBtn').addEventListener('click', () => setAll(false));

function onMarkerClick(hit) {
  if (!currentGlobeData) return;
  if (hit.kind === 'star') { showStarCard(currentGlobeData); return; }
  if (hit.kind === 'cluster') { openTable(); return; }
  if (hit.kind === 'node') {
    showNodePanel(hit.index);
    toggleNode(hit.index);
  }
}

// ---- Exportar PDF: imagen encuadrada + datos empresa + roster nodos ----
async function exportGlobePdf(company, globeData, globeControls, btn) {
  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = t('pdf.generating'); }
  try {
    const shotDataUrl = globeControls.captureFramedShot();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const MARGIN = 40;
    const contentW = pageW - MARGIN * 2;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('VDR · Pactvm Viridi', MARGIN, MARGIN);
    doc.setFontSize(13);
    doc.text(company.name, MARGIN, MARGIN + 22);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(110, 110, 115);
    const pdfCountryLabel = globeData?.esCurtailment?.countryLabel || '—';
    doc.text(t('pdf.legend').replace('{country}', pdfCountryLabel), MARGIN, MARGIN + 38);
    doc.setTextColor(20, 20, 20);

    const imgY = MARGIN + 54;
    const imgH = contentW * 0.6;
    doc.addImage(shotDataUrl, 'PNG', MARGIN, imgY, contentW, imgH);

    let rowY = imgY + imgH + 26;
    const es = globeData.esCurtailment || {};
    const pending = (es.nodesTargetTotal || 0) - installed.size;
    const lossNow = (es.annualLossEur || 0) * ((es.nodesTargetTotal || 0) > 0 ? pending / es.nodesTargetTotal : 0);

    // titular: la cifra que sostiene el argumento comercial
    doc.setFillColor(255, 240, 239);
    doc.setDrawColor(220, 90, 82);
    doc.roundedRect(MARGIN, rowY - 4, contentW, 54, 6, 6, 'FD');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(180, 60, 52);
    doc.text(t('pdf.lossTitle'), MARGIN + 14, rowY + 12);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.setTextColor(200, 45, 36);
    doc.text(`- ${fmtEur(lossNow)}`, MARGIN + 14, rowY + 38);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(150, 80, 74);
    doc.text(t('pdf.pendingOf').replace('{a}', fmtInt(pending)).replace('{b}', fmtInt(es.nodesTargetTotal)), MARGIN + contentW - 190, rowY + 38);
    rowY += 74;

    const rows = [
      [t('pdf.row.location'), globeData.star?.countryLabel || '—'],
      [t('star.city'), globeData.star?.city || '—'],
      [t('pdf.row.pending').replace('{country}', pdfCountryLabel), `${fmtInt(pending)} / ${fmtInt(es.nodesTargetTotal)}`],
      [t('pdf.row.target'), `${es.curtailmentGwTargetMin ?? '—'}–${es.curtailmentGwTargetMax ?? '—'}`],
      [t('pdf.row.absorbNode'), fmtDec(es.nodeAnnualEnergyGwh, 2)],
      [t('pdf.row.absorbFleet'), fmtDec(es.totalAnnualEnergyGwh, 2)],
      [t('pdf.row.pelletNode'), fmtInt(es.biopelletTonsPerNodeYear)],
      [t('pdf.row.pelletFleet'), fmtInt(es.totalBiopelletTonsYear)],
      [t('pdf.row.pelletPrice'), fmtInt(es.biopelletPriceEurPerTon)],
      [t('pdf.row.valueNode'), fmtEur(es.revenueEurPerNodeYear)],
      [t('pdf.row.valueFleet'), fmtEur(es.totalRevenueEurYear)],
      [t('pdf.row.co2Node'), fmtInt(es.co2ch4AvoidedTonsPerNodeYear)],
      [t('pdf.row.co2Fleet'), fmtInt(es.totalCo2ch4AvoidedTonsYear)],
    ];
    doc.setFontSize(10);
    rows.forEach(([k, v]) => {
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(110, 110, 115);
      doc.text(k, MARGIN, rowY);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(20, 20, 20);
      doc.text(String(v), MARGIN + 280, rowY);
      doc.setDrawColor(228, 228, 232);
      doc.line(MARGIN, rowY + 6, pageW - MARGIN, rowY + 6);
      rowY += 19;
    });

    if (t('clause.ppa')) {
      rowY += 8;
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(9);
      doc.setTextColor(150, 40, 35);
      const wrapped = doc.splitTextToSize(t('clause.ppa'), contentW);
      doc.text(wrapped, MARGIN, rowY);
      rowY += wrapped.length * 12;
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 155);
    doc.text(`${t('pdf.generatedAt')} ${new Date().toLocaleString(numLocale(), { dateStyle: 'medium', timeStyle: 'short' })} · S-NFI Systems`, MARGIN, rowY + 14);

    const blob = doc.output('blob');
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, '_blank');
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000);
  } catch (ex) {
    showError(ex.message || 'Error al generar el PDF');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
  }
}

// idioma antes de cargar datos: la pantalla de carga ya sale traducida
syncLangSwitch();
applyI18n();

(async () => {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  if (!id) { showError('Falta el identificador de empresa (id)'); document.getElementById('vdrLoading').classList.add('hidden'); return; }
  try {
    const [company, globeData] = await Promise.all([
      api.pactvmVdrCompanyGet(id),
      api.pactvmVdrCompanyGlobe(id),
    ]);
    currentGlobeData = globeData;
    document.getElementById('crumbCompany').textContent = company.name;
    document.getElementById('companyTitle').textContent = company.name;

    const globeControls = await initGlobe(globeData, {
      container: 'vdrStage',
      onMarkerClick,
      isStarCardVisible: () => starCardState.visible,
      onStarProject: (p) => positionCard(starCardEl, p),
    });
    globeApi = globeControls;
    buildTable();
    renderAggregates();
    applyI18n(); // reetiqueta ya con los datos reales (p.ej. nº de nodos)
    applyPlane(); // estado inicial del conmutador interno/cliente
    document.getElementById('vdrLoading').classList.add('hidden');

    document.getElementById('exportPdfBtn').addEventListener('click', (e) => {
      exportGlobePdf(company, globeData, globeControls, e.currentTarget);
    });
    document.getElementById('resetViewBtn').addEventListener('click', () => {
      globeControls.resetView();
      hideStarCard();
      hideNodePanel();
    });
    document.getElementById('focusSpainBtn').addEventListener('click', () => globeControls.focusSpain());
    document.getElementById('focusStarBtn').addEventListener('click', () => {
      globeControls.focusStar();
      showStarCard(globeData);
    });
  } catch (ex) {
    showError(ex.message || 'Error al cargar la empresa');
    document.getElementById('vdrLoading').classList.add('hidden');
  }
})();
