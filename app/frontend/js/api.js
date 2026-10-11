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

  // Sentinel · Behavioral Analytics (profiling de comportamiento)
  sentinelBehaviorAlerts:      (params = {}) => req('GET', `/api/sentinel/behavior/alerts?${new URLSearchParams(params).toString()}`),
  sentinelBehaviorHeatmap:     (days = 30) => req('GET', `/api/sentinel/behavior/heatmap?days=${days}`),
  sentinelBehaviorQueue:       () => req('GET', '/api/sentinel/behavior/review-queue'),
  sentinelBehaviorDecide:      (user, decision) => req('POST', `/api/sentinel/behavior/review-queue/${encodeURIComponent(user)}/decide`, { decision }),
  sentinelBehaviorBlockUser:   (user, reason) => req('POST', '/api/sentinel/behavior/block-user', { user, reason }),


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

  // S-NFI Finance · CRM de empresas + archivo documental
  financeCompaniesMeta:    () => req('GET', '/api/finance/companies/meta'),
  financeCompaniesSummary: () => req('GET', '/api/finance/companies-summary'),
  financeCompaniesList:    (params = {}) => req('GET', `/api/finance/companies?${new URLSearchParams(params).toString()}`),
  financeCompanyGet:       (id) => req('GET', `/api/finance/companies/${id}`),
  financeCompanyAdd:       (payload) => req('POST', '/api/finance/companies', payload),
  financeCompanyPatch:     (id, payload) => req('PATCH', `/api/finance/companies/${id}`, payload),
  financeCompanyDelete:    (id) => req('DELETE', `/api/finance/companies/${id}`),
  financeCompanyDocsList:  (id, folder) => req('GET', `/api/finance/companies/${id}/documents${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`),
  financeCompanyDocPatch:  (fileId, payload) => req('PATCH', `/api/finance/companies/documents/${fileId}`, payload),
  financeCompanyDocDelete: (fileId) => req('DELETE', `/api/finance/companies/documents/${fileId}`),
  financeCompanyNoteAdd:   (id, text) => req('POST', `/api/finance/companies/${id}/notes`, { text }),
  financeCompanyNoteDelete:(noteId) => req('DELETE', `/api/finance/companies/notes/${noteId}`),

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

  // S-NFI F&L · Hub fiscal y legal (fl-hub.js). entidad: sociedades | modelos |
  // notificaciones | juntas | apoderamientos | contratos | checklist.
  flHub:                   () => req('GET', '/api/fl/hub'),
  flSummary:               () => req('GET', '/api/fl/summary'),
  flLogVerify:             () => req('GET', '/api/fl/log/verify'),
  flCrear:                 (entidad, payload) => req('POST', `/api/fl/${entidad}`, payload),
  flActualizar:            (entidad, id, payload) => req('PATCH', `/api/fl/${entidad}/${encodeURIComponent(id)}`, payload),
  flArchivar:              (entidad, id) => req('DELETE', `/api/fl/${entidad}/${encodeURIComponent(id)}`),
  flConfirmarReal:         (entidad, id) => req('POST', `/api/fl/${entidad}/${encodeURIComponent(id)}/confirmar`, {}),
  flHistorial:             (entidad, id) => req('GET', `/api/fl/historial/${entidad}/${encodeURIComponent(id)}`),
  flAcuse:                 (id, payload) => req('POST', `/api/fl/notificaciones/${encodeURIComponent(id)}/acuse`, payload),
  flNotifEstado:           (id, payload) => req('POST', `/api/fl/notificaciones/${encodeURIComponent(id)}/estado`, payload),
  flAlertaEstado:          (id, estado) => req('PATCH', `/api/fl/alertas/${encodeURIComponent(id)}`, { estado }),
  flBoletinesSync:         () => req('POST', '/api/fl/boletines/sync', {}),
  flRetirarDemo:           () => req('POST', '/api/fl/demo/retirar', { confirmar: true }),

  // Expediente Fiscal y Juridico Impecable (CRM documental)
  flExpediente:            (filters) => {
    const qs = new URLSearchParams();
    if (filters?.bloque) qs.set('bloque', filters.bloque);
    if (filters?.estado) qs.set('estado', filters.estado);
    if (filters?.q) qs.set('q', filters.q);
    const s = qs.toString();
    return req('GET', `/api/fl/expediente${s ? `?${s}` : ''}`);
  },
  flExpedienteMeta:        () => req('GET', '/api/fl/expediente/meta'),
  flExpedienteSummary:     () => req('GET', '/api/fl/expediente/summary'),
  flExpedienteAlertas:     () => req('GET', '/api/fl/expediente/alertas'),
  flExpedienteRevisar:     () => req('POST', '/api/fl/expediente/alertas/revisar', {}),
  flExpedienteDocGet:      (id) => req('GET', `/api/fl/expediente/documentos/${id}`),
  flExpedienteDocAdd:      (payload) => req('POST', '/api/fl/expediente/documentos', payload),
  flExpedienteDocPatch:    (id, payload) => req('PATCH', `/api/fl/expediente/documentos/${id}`, payload),
  flExpedienteDocDelete:   (id) => req('DELETE', `/api/fl/expediente/documentos/${id}`),
  flExpedienteDocRestore:  (id) => req('POST', `/api/fl/expediente/documentos/${id}/restore`, {}),
  flExpedienteArchivoDel:  (docId) => req('DELETE', `/api/fl/expediente/documentos/${docId}/archivo`),

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

  // Creditos de Carbono · medidor mitigacion/monetizacion
  pactvmCarbonRatio:        () => req('GET', '/api/pactvm/carbon/ratio'),
  pactvmCarbonRatioPatch:   (payload) => req('PATCH', '/api/pactvm/carbon/ratio', payload),
  pactvmCarbonCertConfig:      () => req('GET', '/api/pactvm/carbon/cert-config'),
  pactvmCarbonCertConfigPatch: (payload) => req('PATCH', '/api/pactvm/carbon/cert-config', payload),
  pactvmCarbonClientsList:  () => req('GET', '/api/pactvm/carbon/clients'),
  pactvmCarbonClientAdd:    (payload) => req('POST', '/api/pactvm/carbon/clients', payload),
  pactvmCarbonClientPatch:  (id, payload) => req('PATCH', `/api/pactvm/carbon/clients/${id}`, payload),
  pactvmCarbonClientDelete: (id) => req('DELETE', `/api/pactvm/carbon/clients/${id}`),
  pactvmCarbonSummary:      () => req('GET', '/api/pactvm/carbon/summary'),
  pactvmCarbonEmitCertificate: (payload) => req('POST', '/api/pactvm/carbon/emit-certificate', payload),
  pactvmCarbonTokenize:        (payload) => req('POST', '/api/pactvm/carbon/tokenize', payload),
  pactvmCarbonPackagesList:    (opts = {}) => req('GET', `/api/pactvm/carbon/packages${opts.includeVoided ? '?includeVoided=1' : ''}`),
  pactvmCarbonPackageGet:      (logSeq) => req('GET', `/api/pactvm/carbon/packages/${logSeq}`),
  pactvmCarbonPackagePatch:    (logSeq, payload) => req('PATCH', `/api/pactvm/carbon/packages/${logSeq}`, payload),
  pactvmCarbonPackageDelete:   (logSeq, reason) => req('DELETE', `/api/pactvm/carbon/packages/${logSeq}`, { reason }),
  pactvmCarbonAllowlistGet:    (packageId) => req('GET', `/api/pactvm/carbon/packages/${packageId}/allowlist`),
  pactvmCarbonAllowlistPut:    (packageId, emails) => req('PUT', `/api/pactvm/carbon/packages/${packageId}/allowlist`, { emails }),
  pactvmCarbonAccessCodeIssue: (packageId, minutes) => req('POST', `/api/pactvm/carbon/packages/${packageId}/access-code`, { minutes }),
  pactvmCarbonPackageQr:       (packageId) => req('GET', `/api/pactvm/carbon/packages/${packageId}/qr`),

  // Herzog (Central) · bunker receptor de informacion de SYSTEMS
  herzogSummary:        () => req('GET', '/api/herzog-central/summary'),
  herzogMetricsList:    (opts = {}) => {
    const params = new URLSearchParams();
    if (opts.department) params.set('department', opts.department);
    if (opts.source) params.set('source', opts.source);
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return req('GET', `/api/herzog-central/metrics${qs ? `?${qs}` : ''}`);
  },
  herzogMetricAdd:      (payload) => req('POST', '/api/herzog-central/metrics', payload),
  herzogDocumentsList:  () => req('GET', '/api/herzog-central/documents'),
  herzogDocumentDelete: (id) => req('DELETE', `/api/herzog-central/documents/${id}`),
  herzogNotesList:      () => req('GET', '/api/herzog-central/notes'),
  herzogNoteAdd:        (payload) => req('POST', '/api/herzog-central/notes', payload),
  herzogNoteDelete:     (id) => req('DELETE', `/api/herzog-central/notes/${id}`),

  // S-EAGLE · revision de informacion Herzog (verificar/corregir/compartir)
  seagleSummary:      () => req('GET', '/api/seagle/summary'),
  seagleHerzogFeed:   (department) => req('GET', `/api/seagle/herzog/feed${department ? `?department=${encodeURIComponent(department)}` : ''}`),
  seagleReview:       (payload) => req('POST', '/api/seagle/herzog/review', payload),
  seagleHerzogShare:  (payload) => req('POST', '/api/seagle/herzog/share', payload),
  seagleLogVerify:    () => req('GET', '/api/seagle/log/verify'),

  // Motor Planetario · parametros globales, paises target (T/año), telemetria CUDA-Bio simulada
  pactvmPlanetaryConfig:        () => req('GET', '/api/pactvm/planetary/config'),
  pactvmPlanetaryConfigPatch:   (payload) => req('PATCH', '/api/pactvm/planetary/config', payload),
  pactvmPlanetaryCountriesList: () => req('GET', '/api/pactvm/planetary/countries'),
  pactvmPlanetaryCountryAdd:    (payload) => req('POST', '/api/pactvm/planetary/countries', payload),
  pactvmPlanetaryCountryPatch:  (id, payload) => req('PATCH', `/api/pactvm/planetary/countries/${id}`, payload),
  pactvmPlanetaryCountryDelete: (id) => req('DELETE', `/api/pactvm/planetary/countries/${id}`),
  pactvmPlanetarySummary:       () => req('GET', '/api/pactvm/planetary/summary'),
  pactvmPlanetaryTelemetry:     () => req('GET', '/api/pactvm/planetary/telemetry'),

  // VDR · CRM geoespacial de empresas (ubicacion + actividad en España)
  pactvmVdrCountriesList: () => req('GET', '/api/pactvm/vdr/countries'),
  pactvmVdrCompaniesList: () => req('GET', '/api/pactvm/vdr/companies'),
  pactvmVdrCompanyGet:    (id) => req('GET', `/api/pactvm/vdr/companies/${id}`),
  pactvmVdrCompanyAdd:    (payload) => req('POST', '/api/pactvm/vdr/companies', payload),
  pactvmVdrCompanyPatch:  (id, payload) => req('PATCH', `/api/pactvm/vdr/companies/${id}`, payload),
  pactvmVdrCompanyDelete: (id) => req('DELETE', `/api/pactvm/vdr/companies/${id}`),
  pactvmVdrSummary:       () => req('GET', '/api/pactvm/vdr/summary'),
  pactvmVdrCompanyGlobe:  (id) => req('GET', `/api/pactvm/vdr/companies/${id}/globe`),
  pactvmVdrEsConfigAll:   () => req('GET', '/api/pactvm/vdr/es-config'),
  pactvmVdrEsConfig:      (country) => req('GET', `/api/pactvm/vdr/es-config/${country}`),
  pactvmVdrEsConfigPatch: (country, payload) => req('PATCH', `/api/pactvm/vdr/es-config/${country}`, payload),
  // enlaces temporales de presentacion bajo NDA
  pactvmVdrSharesList:    () => req('GET', '/api/pactvm/vdr/shares'),
  pactvmVdrShareCreate:   (payload) => req('POST', '/api/pactvm/vdr/shares', payload),
  pactvmVdrShareRevoke:   (token) => req('DELETE', `/api/pactvm/vdr/shares/${token}`),

  // S-NFI Resilience (BSS) · continuidad operativa, cadena suministro, backup soberania
  resilienceSummary:          () => req('GET', '/api/resilience/summary'),
  resilienceBssReadingsList:  () => req('GET', '/api/resilience/bss-readings'),
  resilienceBssReadingAdd:    (payload) => req('POST', '/api/resilience/bss-readings', payload),
  resilienceSuppliersList:    () => req('GET', '/api/resilience/suppliers'),
  resilienceSupplierAdd:      (payload) => req('POST', '/api/resilience/suppliers', payload),
  resilienceSupplierPatch:    (id, payload) => req('PATCH', `/api/resilience/suppliers/${id}`, payload),
  resilienceSupplierDelete:   (id) => req('DELETE', `/api/resilience/suppliers/${id}`),
  resilienceSuppliersRecalculate: (payload) => req('POST', '/api/resilience/suppliers/recalculate', payload),
  resilienceBackupStatus:      () => req('GET', '/api/resilience/backup-status'),
  resilienceBackupStatusPatch: (payload) => req('PATCH', '/api/resilience/backup-status', payload),
  resilienceSovereigntyMigrate: (payload) => req('POST', '/api/resilience/sovereignty/migrate', payload),
  resilienceIsolatedMode:         () => req('GET', '/api/resilience/isolated-mode'),
  resilienceIsolatedModeActivate: (payload) => req('POST', '/api/resilience/isolated-mode/activate', payload),
  resilienceIsolatedModeDeactivate: () => req('POST', '/api/resilience/isolated-mode/deactivate'),
  resilienceLogVerify: () => req('GET', '/api/resilience/log/verify'),

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

  // Puerto Maestro · auditoria y control de trafico inter-puertos
  gatewayRequestsList:  (status) => req('GET', `/api/gateway/requests${status ? `?status=${status}` : ''}`),
  gatewayRequestCreate: (payload) => req('POST', '/api/gateway/requests', payload),
  gatewayRequestDecide: (id, decision, reason) => req('POST', `/api/gateway/requests/${id}/decide`, { decision, reason }),
  gatewaySummary:       () => req('GET', '/api/gateway/summary'),
  gatewayLog:           () => req('GET', '/api/gateway/log'),
  gatewayLogVerify:     () => req('GET', '/api/gateway/log/verify'),

  // Notificaciones Admin · errores/inestabilidad
  notifications:        (limit) => req('GET', `/api/notifications${limit ? `?limit=${limit}` : ''}`),
  notificationRead:     (id) => req('POST', `/api/notifications/${id}/read`),
  notificationReadAll:  () => req('POST', '/api/notifications/read-all'),
  notificationDelete:   (id) => req('DELETE', `/api/notifications/${id}`),
  notificationDeleteRead: () => req('DELETE', '/api/notifications'),

  // Consola de Notificaciones · vista unificada admin-only (sistema + trafico Reff)
  notifCenterSummary: () => req('GET', '/api/notif-center/summary'),
  notifCenterFeed:    (source, status) => {
    const qs = new URLSearchParams();
    if (source) qs.set('source', source);
    if (status) qs.set('status', status);
    const q = qs.toString();
    return req('GET', `/api/notif-center/feed${q ? `?${q}` : ''}`);
  },
  notifCenterTrafficApprove: (id) => req('POST', `/api/notif-center/traffic/${id}/approve`),
  notifCenterTrafficDeny:    (id, note) => req('POST', `/api/notif-center/traffic/${id}/deny`, { note }),
  notifCenterTrafficRequireJustification: (id) => req('POST', `/api/notif-center/traffic/${id}/require-justification`),
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

// F&L: ficha PDF de un registro del Hub. GET autenticado -> Blob para
// previsualizar o descargar; el backend anota cada acceso en fl_log.
export async function fetchFlFichaPdf(entidad, id) {
  const headers = {};
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(`/api/fl/${entidad}/${encodeURIComponent(id)}/pdf`, { headers });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  return r.blob();
}

// Herzog: subida raw de documentos (Content-Type del archivo + X-Filename, sin multipart).
export async function uploadHerzogDocument(file, department) {
  const headers = { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name), 'X-Department': department || 'sin-especificar' };
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch('/api/herzog-central/documents', { method: 'POST', headers, body: file });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// Finance CRM: subida raw de documentacion por empresa (mismo patron que Herzog,
// mas cabecera X-Folder para que el archivo caiga ya ordenado en su carpeta).
export async function uploadFinanceCompanyDoc(companyId, file, folder, label) {
  const headers = {
    'Content-Type': file.type || 'application/octet-stream',
    'X-Filename': encodeURIComponent(file.name),
    'X-Folder': folder || 'otros',
  };
  if (label) headers['X-Label'] = encodeURIComponent(label);
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(`/api/finance/companies/${companyId}/documents`, { method: 'POST', headers, body: file });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// La descarga exige Authorization, asi que se baja como blob autenticado y se
// abre en pestana nueva (PDF/imagen) o se fuerza guardado si el navegador no lo
// puede mostrar inline.
export async function openFinanceCompanyDoc(fileId, filename, download = false) {
  const headers = {};
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(`/api/finance/companies/documents/${fileId}`, { headers });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  if (download) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'documento';
    a.click();
  } else {
    window.open(url, '_blank', 'noopener');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Expediente F&L: subida raw (Content-Type del archivo + X-Filename/X-Label),
// mismo patron que uploadFinanceCompanyDoc.
export async function uploadFlExpedienteDoc(docId, file) {
  const headers = {
    'Content-Type': file.type || 'application/octet-stream',
    'X-Filename': encodeURIComponent(file.name),
  };
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(`/api/fl/expediente/documentos/${docId}/archivo`, { method: 'POST', headers, body: file });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// GridFS exige Authorization: se baja como blob y se abre/descarga en cliente.
export async function openFlExpedienteDoc(fileId, filename, download = false) {
  const headers = {};
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(`/api/fl/expediente/archivos/${fileId}`, { headers });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  if (download) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'documento';
    a.click();
  } else {
    window.open(url, '_blank', 'noopener');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
