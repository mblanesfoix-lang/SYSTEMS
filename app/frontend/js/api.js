// Elvi-Ra API client
const TOKEN_KEY = 'elvira_token';
const USER_KEY  = 'elvira_user';
const ROLE_KEY  = 'elvira_role';
const ACTIVE_SHEET_KEY = 'elvira_active_sheet';

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function getUser()  { return localStorage.getItem(USER_KEY); }
export function getRole()  { return localStorage.getItem(ROLE_KEY); }
export function getActiveSheet() { return localStorage.getItem(ACTIVE_SHEET_KEY); }
export function setActiveSheet(id) { localStorage.setItem(ACTIVE_SHEET_KEY, id); }

export function setSession(token, user, role) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, user);
  if (role) localStorage.setItem(ROLE_KEY, role);
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(ROLE_KEY);
  localStorage.removeItem(ACTIVE_SHEET_KEY);
}

async function req(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) {
    clearSession();
    if (!location.pathname.endsWith('/login.html')) location.href = '/pages/login.html';
    throw new Error('unauthorized');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

export function api(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  let body;
  if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
  }
  return req(method, url, body);
}

Object.assign(api, {
  login:          (username, password) => req('POST', '/api/login', { username, password }),
  logout:         () => req('POST', '/api/logout'),
  me:             () => req('GET',  '/api/me'),
  changePassword: (currentPassword, newPassword) => req('POST', '/api/change-password', { currentPassword, newPassword }),

  listSheets:    () => req('GET',    '/api/sheets'),
  createSheet:   (name) => req('POST', '/api/sheets', { name }),
  deleteSheet:   (sid) => req('DELETE', `/api/sheets/${sid}`),

  listCompanies:  (sid) => req('GET',   `/api/sheets/${sid}/companies`),
  createCompany:  (sid, c) => req('POST', `/api/sheets/${sid}/companies`, c),
  updateCompany:  (sid, cid, c) => req('PUT', `/api/sheets/${sid}/companies/${cid}`, c),
  deleteCompany:  (sid, cid) => req('DELETE', `/api/sheets/${sid}/companies/${cid}`),
  moveCompany:    (cid, fromSheetId, toSheetId) => req('POST', `/api/companies/${cid}/move`, { fromSheetId, toSheetId }),

  overview: () => req('GET', '/api/overview'),

  searchCompanies: (filters) => req('POST', '/api/search', filters),
  searchHistory:   () => req('GET', '/api/search/history'),
  deleteHistory:   (hid) => req('DELETE', `/api/search/history/${hid}`),
  addFromSearch:   (sid, result) => req('POST', `/api/sheets/${sid}/companies/from-search`, result),

  allCompanies:   () => req('GET', '/api/companies/all'),
  linkedinFind:   (companyId) => req('POST', '/api/linkedin', { companyId }),
  emailGenerate:  (payload) => req('POST', '/api/email', payload),

  // Elvi-Ra · orquestador
  elviraOverview:    () => req('GET',  '/api/elvira/overview'),
  elviraSystems:     () => req('GET',  '/api/elvira/systems'),
  elviraSystemSet:   (key, patch) => req('PUT', `/api/elvira/systems/${key}`, patch),
  elviraSystemPing:  (key) => req('POST', `/api/elvira/systems/${key}/ping`),
  elviraOphs:        () => req('GET',  '/api/elvira/ophs'),
  elviraOphsConfig:  (cfg) => req('PUT', '/api/elvira/ophs/config', cfg),
  elviraOphsScore:   (payload) => req('POST', '/api/elvira/ophs/score', payload),
  sentinelEvents:    () => req('GET',  '/api/elvira/sentinel/events'),
  sentinelEmit:      (ev) => req('POST', '/api/elvira/sentinel/events', ev),
  herzogAudits:      () => req('GET',  '/api/elvira/herzog/audits'),
  herzogAudit:       (a) => req('POST', '/api/elvira/herzog/audits', a),
  tcontroler:        () => req('GET',  '/api/elvira/tcontroler'),
  tcontrolerReset:   () => req('DELETE', '/api/elvira/tcontroler/reset'),

  // CNMC · Embudo Legal
  cnmcSearch:        (empresa, cif, periodo) => req('POST', '/api/elvira/cnmc/search', { empresa, cif, periodo }),
  cnmcIngest:        (doc) => req('POST', '/api/elvira/cnmc/ingest', doc),
  cnmcDocuments:     () => req('GET',  '/api/elvira/cnmc/documents'),
  cnmcAudit:         (companyId, docId) => req('POST', `/api/elvira/cnmc/audit/${companyId}`, docId ? { docId } : {}),

  // Sentinel · trazabilidad forense IP
  sentinelLog:       (params = {}) => req('GET', `/api/sentinel/forensic-log?${new URLSearchParams(params).toString()}`),
  sentinelVerifyChain: () => req('GET', '/api/sentinel/verify-chain'),
  sentinelIpStats:   () => req('GET', '/api/sentinel/ip-stats'),
  sentinelReviewQueue: () => req('GET', '/api/sentinel/review-queue'),
  sentinelDecide:    (ip, decision) => req('POST', `/api/sentinel/review-queue/${encodeURIComponent(ip)}/decide`, { decision }),
  sentinelIpReport:  (ip) => req('GET', `/api/sentinel/review-queue/${encodeURIComponent(ip)}/report`),
  sentinelTimeline:  (minutes = 60) => req('GET', `/api/sentinel/traffic-timeline?minutes=${minutes}`),
  sentinelBlockIp:   (ip, reason) => req('POST', '/api/sentinel/block-ip', { ip, reason }),
  sentinelLogHuman:  (params = {}) => req('GET', `/api/sentinel/forensic-log-human?${new URLSearchParams(params).toString()}`),
  sentinelLogExport: (params = {}) => req('GET', `/api/sentinel/forensic-log/export?${new URLSearchParams(params).toString()}`),
  sentinelReanchorChain: () => req('POST', '/api/sentinel/reanchor-chain'),
  sentinelAllowlist:     () => req('GET', '/api/sentinel/allowlist'),
  sentinelAllowIp:       (ip, label) => req('POST', '/api/sentinel/allowlist', { ip, label }),
  sentinelUnallowIp:     (ip) => req('DELETE', `/api/sentinel/allowlist/${encodeURIComponent(ip)}`),

  // S-NFI Factory · cadena de suministro industrial
  factorySummary:       () => req('GET', '/api/factory/summary'),
  factoryAssemblyList:  () => req('GET', '/api/factory/assembly'),
  factoryAssemblyAdd:   (payload) => req('POST', '/api/factory/assembly', payload),
  factoryAssemblyPatch: (id, payload) => req('PATCH', `/api/factory/assembly/${id}`, payload),
  factoryAssemblyDelete:(id) => req('DELETE', `/api/factory/assembly/${id}`),
  factoryLogisticsList:  () => req('GET', '/api/factory/logistics'),
  factoryLogisticsAdd:   (payload) => req('POST', '/api/factory/logistics', payload),
  factoryLogisticsPatch: (id, payload) => req('PATCH', `/api/factory/logistics/${id}`, payload),
  factoryLogisticsDelete:(id) => req('DELETE', `/api/factory/logistics/${id}`),
  factoryInventoryList:  () => req('GET', '/api/factory/inventory'),
  factoryInventoryAdd:   (payload) => req('POST', '/api/factory/inventory', payload),
  factoryInventoryPatch: (id, payload) => req('PATCH', `/api/factory/inventory/${id}`, payload),
  factoryInventoryDelete:(id) => req('DELETE', `/api/factory/inventory/${id}`),
  factoryMaintenanceList:  () => req('GET', '/api/factory/maintenance'),
  factoryMaintenanceAdd:   (payload) => req('POST', '/api/factory/maintenance', payload),
  factoryMaintenancePatch: (id, payload) => req('PATCH', `/api/factory/maintenance/${id}`, payload),
  factoryMaintenanceDelete:(id) => req('DELETE', `/api/factory/maintenance/${id}`),

  // S-NFI Finance · control financiero y valoracion de activos reales
  financeSummary:         () => req('GET', '/api/finance/summary'),
  financeAccountsList:    () => req('GET', '/api/finance/accounts'),
  financeAccountAdd:      (payload) => req('POST', '/api/finance/accounts', payload),
  financeAccountPatch:    (id, payload) => req('PATCH', `/api/finance/accounts/${id}`, payload),
  financeAccountDelete:   (id) => req('DELETE', `/api/finance/accounts/${id}`),
  financeCostCentersList: () => req('GET', '/api/finance/cost-centers'),
  financeCostCenterAdd:   (payload) => req('POST', '/api/finance/cost-centers', payload),
  financeCostCenterPatch: (id, payload) => req('PATCH', `/api/finance/cost-centers/${id}`, payload),
  financeCostCenterDelete:(id) => req('DELETE', `/api/finance/cost-centers/${id}`),
  financeMovementsList:   (params = {}) => req('GET', `/api/finance/movements?${new URLSearchParams(params).toString()}`),
  financeMovementAdd:     (payload) => req('POST', '/api/finance/movements', payload),
  financeMovementPatch:   (id, payload) => req('PATCH', `/api/finance/movements/${id}`, payload),
  financeMovementDelete:  (id) => req('DELETE', `/api/finance/movements/${id}`),
  financeProjection:      (accountId, horizonDays) => req('GET', `/api/finance/projection?${new URLSearchParams({ ...(accountId ? { accountId } : {}), horizonDays: horizonDays || 90 }).toString()}`),
  financeTransfersList:   () => req('GET', '/api/finance/transfers'),
  financeTransferAdd:     (payload) => req('POST', '/api/finance/transfers', payload),
  financeAnalytics:       (months) => req('GET', `/api/finance/analytics?${new URLSearchParams({ months: months || 12 }).toString()}`),
  financeAssetsList:      () => req('GET', '/api/finance/assets'),
  financeAssetAdd:        (payload) => req('POST', '/api/finance/assets', payload),
  financeAssetPatch:      (id, payload) => req('PATCH', `/api/finance/assets/${id}`, payload),
  financeAssetDelete:     (id) => req('DELETE', `/api/finance/assets/${id}`),
  financeExportsList:     () => req('GET', '/api/finance/exports'),
  financeExportCreate:    (fromDate, toDate, reportType) => req('POST', '/api/finance/exports', { fromDate, toDate, reportType }),
  financeLogVerify:       () => req('GET', '/api/finance/log/verify'),

  // S-NFI M&A · inteligencia corporativa para el crecimiento fractal
  mnaSummary:              () => req('GET', '/api/mna/summary'),
  mnaDealsList:            () => req('GET', '/api/mna/deals'),
  mnaDealAdd:              (payload) => req('POST', '/api/mna/deals', payload),
  mnaDealPatch:            (id, payload) => req('PATCH', `/api/mna/deals/${id}`, payload),
  mnaDealDelete:           (id) => req('DELETE', `/api/mna/deals/${id}`),
  mnaValuationGet:         (dealId) => req('GET', `/api/mna/deals/${dealId}/valuation`),
  mnaValuationSet:         (dealId, payload) => req('PUT', `/api/mna/deals/${dealId}/valuation`, payload),
  mnaSynergiesGet:         (dealId) => req('GET', `/api/mna/deals/${dealId}/synergies`),
  mnaSynergiesSet:         (dealId, payload) => req('PUT', `/api/mna/deals/${dealId}/synergies`, payload),
  mnaDiligenceCategoriesList: (dealId) => req('GET', `/api/mna/deals/${dealId}/diligence/categories`),
  mnaDiligenceCategoryAdd:    (dealId, payload) => req('POST', `/api/mna/deals/${dealId}/diligence/categories`, payload),
  mnaDiligenceCategoryDelete: (id) => req('DELETE', `/api/mna/diligence/categories/${id}`),
  mnaDiligenceItemsList:   (dealId) => req('GET', `/api/mna/deals/${dealId}/diligence/items`),
  mnaDiligenceItemAdd:     (dealId, payload) => req('POST', `/api/mna/deals/${dealId}/diligence/items`, payload),
  mnaDiligenceItemPatch:   (id, payload) => req('PATCH', `/api/mna/diligence/items/${id}`, payload),
  mnaDiligenceItemDelete:  (id) => req('DELETE', `/api/mna/diligence/items/${id}`),
  mnaLogVerify:            () => req('GET', '/api/mna/log/verify'),

  // S-NFI F&L · custodia legal (NDAs, contratos, licencias, expediente OEPM)
  flSummary:          () => req('GET', '/api/fl/summary'),
  flNdasList:         () => req('GET', '/api/fl/ndas'),
  flNdaAdd:           (payload) => req('POST', '/api/fl/ndas', payload),
  flNdaPatch:         (id, payload) => req('PATCH', `/api/fl/ndas/${id}`, payload),
  flNdaDelete:        (id) => req('DELETE', `/api/fl/ndas/${id}`),
  flContractsList:    () => req('GET', '/api/fl/contracts'),
  flContractAdd:      (payload) => req('POST', '/api/fl/contracts', payload),
  flContractPatch:    (id, payload) => req('PATCH', `/api/fl/contracts/${id}`, payload),
  flContractDelete:   (id) => req('DELETE', `/api/fl/contracts/${id}`),
  flLicensesList:     () => req('GET', '/api/fl/licenses'),
  flLicenseAdd:       (payload) => req('POST', '/api/fl/licenses', payload),
  flLicensePatch:     (id, payload) => req('PATCH', `/api/fl/licenses/${id}`, payload),
  flLicenseDelete:    (id) => req('DELETE', `/api/fl/licenses/${id}`),
  flOepmList:         () => req('GET', '/api/fl/oepm'),
  flOepmAdd:          (payload) => req('POST', '/api/fl/oepm', payload),
  flOepmPatch:        (id, payload) => req('PATCH', `/api/fl/oepm/${id}`, payload),
  flOepmDelete:       (id) => req('DELETE', `/api/fl/oepm/${id}`),
  flDocsList:         (kind, id) => req('GET', `/api/fl/${kind}/${id}/docs`),
  flDocDelete:        (docId) => req('DELETE', `/api/fl/docs/${docId}`),
  flLogVerify:        () => req('GET', '/api/fl/log/verify'),

  // Pactvm Viridi · cumplimiento bio-ambiental (CIBE, politicas, accesos, Herzog)
  pactvmSummary:           () => req('GET', '/api/pactvm/summary'),
  pactvmCibeList:          () => req('GET', '/api/pactvm/cibe'),
  pactvmCibeAdd:           (payload) => req('POST', '/api/pactvm/cibe', payload),
  pactvmCibePatch:         (id, payload) => req('PATCH', `/api/pactvm/cibe/${id}`, payload),
  pactvmCibeDelete:        (id) => req('DELETE', `/api/pactvm/cibe/${id}`),
  pactvmPoliciesList:      () => req('GET', '/api/pactvm/policies'),
  pactvmPolicyAdd:         (payload) => req('POST', '/api/pactvm/policies', payload),
  pactvmPolicyPatch:       (id, payload) => req('PATCH', `/api/pactvm/policies/${id}`, payload),
  pactvmPolicyDelete:      (id) => req('DELETE', `/api/pactvm/policies/${id}`),
  pactvmAccessRulesList:   () => req('GET', '/api/pactvm/access-rules'),
  pactvmAccessRuleAdd:     (payload) => req('POST', '/api/pactvm/access-rules', payload),
  pactvmAccessRulePatch:   (id, payload) => req('PATCH', `/api/pactvm/access-rules/${id}`, payload),
  pactvmAccessRuleDelete:  (id) => req('DELETE', `/api/pactvm/access-rules/${id}`),
  pactvmHerzogAudits:      () => req('GET', '/api/pactvm/herzog-audits'),
  pactvmLogVerify:         () => req('GET', '/api/pactvm/log/verify'),
  pactvmCountryNodesList:  () => req('GET', '/api/pactvm/country-nodes'),
  pactvmCountryNodeAdd:    (payload) => req('POST', '/api/pactvm/country-nodes', payload),
  pactvmCountryNodePatch: (id, payload) => req('PATCH', `/api/pactvm/country-nodes/${id}`, payload),
  pactvmCountryNodeDelete: (id) => req('DELETE', `/api/pactvm/country-nodes/${id}`),
  pactvmEntryConditionsList:  () => req('GET', '/api/pactvm/entry-conditions'),
  pactvmEntryConditionAdd:    (payload) => req('POST', '/api/pactvm/entry-conditions', payload),
  pactvmEntryConditionPatch: (id, payload) => req('PATCH', `/api/pactvm/entry-conditions/${id}`, payload),
  pactvmEntryConditionDelete: (id) => req('DELETE', `/api/pactvm/entry-conditions/${id}`),

  // CIBE Bunker · tokens firmados Ed25519 (Volumen 3)
  cibeBunkerStatus:    () => req('GET', '/api/pactvm/cibe-bunker/status'),
  cibeBunkerLog:       () => req('GET', '/api/pactvm/cibe-bunker/log'),
  cibeBunkerLogVerify: () => req('GET', '/api/pactvm/cibe-bunker/log/verify'),
  cibeBunkerRevoke:    (jti) => req('POST', '/api/pactvm/cibe-bunker/revoke', { jti }),
  pactvmCibeTokenKey:  (id) => req('POST', `/api/pactvm/cibe/${id}/token-key`),

  // Rack State · consenso distribuido entre racks (Volumen 3)
  rackStatus:       () => req('GET', '/api/rack/status'),
  rackState:        () => req('GET', '/api/rack/state'),
  rackStatePropose: (key, value) => req('POST', '/api/rack/state', { key, value }),
  rackLog:          () => req('GET', '/api/rack/log'),
  rackLogVerify:    () => req('GET', '/api/rack/log/verify'),

  // Grid Interlink · redes electricas transnacionales (Volumen 3)
  gridStatus:         () => req('GET', '/api/grid/status'),
  gridSummary:        () => req('GET', '/api/grid/summary'),
  gridSignals:        (country, limit) => req('GET', `/api/grid/signals?${new URLSearchParams({ country, limit: limit || 60 }).toString()}`),
  gridCountryAdd:     (payload) => req('POST', '/api/grid/countries', payload),
  gridCountryPatch:   (code, payload) => req('PATCH', `/api/grid/countries/${encodeURIComponent(code)}`, payload),
  gridCountryRestart: (code) => req('POST', `/api/grid/countries/${encodeURIComponent(code)}/restart`),
  gridCountryChaos:   (code, mode) => req('POST', `/api/grid/countries/${encodeURIComponent(code)}/chaos`, { mode }),
  gridLogVerify:      () => req('GET', '/api/grid/log/verify'),

  // Notificaciones Admin · errores/inestabilidad
  notifications:        (limit) => req('GET', `/api/notifications${limit ? `?limit=${limit}` : ''}`),
  notificationRead:     (id) => req('POST', `/api/notifications/${id}/read`),
  notificationReadAll:  () => req('POST', '/api/notifications/read-all'),
  notificationDelete:   (id) => req('DELETE', `/api/notifications/${id}`),
  notificationDeleteRead: () => req('DELETE', '/api/notifications'),
});

export function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span class="toast__msg"></span><button class="toast__close" aria-label="Cerrar" title="Cerrar">&times;</button>`;
    el.querySelector('.toast__close').addEventListener('click', () => {
      clearTimeout(toast._t);
      el.classList.remove('show');
    });
    document.body.appendChild(el);
  }
  el.querySelector('.toast__msg').textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

export function requireAuth() {
  if (!getToken()) location.href = '/pages/login.html';
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

// El export de Finance exige Authorization, así que se baja como blob
// autenticado (no un <a href> plano) y se dispara la descarga del PDF.
export async function downloadFinanceExport(id, reportType = 'export') {
  const headers = {};
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(`/api/finance/exports/${id}/download`, { headers });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `finance-${reportType}-${id}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}

// F&L: subida raw de documentos (PDF/DOCX) igual patron que imagenes de Reff
// (fetch con Content-Type del archivo + X-Filename, sin multipart).
export async function uploadFlDoc(kind, entityId, file) {
  const headers = { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name) };
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(`/api/fl/${kind}/${entityId}/docs`, { method: 'POST', headers, body: file });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

export async function downloadFlDoc(docId, filename) {
  const headers = {};
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(`/api/fl/docs/${docId}/download`, { headers });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'documento';
  a.click();
  URL.revokeObjectURL(url);
}
