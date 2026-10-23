import { api, getUser, getRole, requireAuth, clearSession, toast, escapeHtml } from '/js/api.js';
import { mountThemeToggle } from '/js/theme.js';
import { mountOfficeBg } from '/js/office-bg.js';
requireAuth();
mountThemeToggle(document.querySelector('nav.nav .row'));
mountOfficeBg();
document.getElementById('userTag').textContent = getUser() || '';
document.getElementById('logoutBtn').addEventListener('click', async () => {
  try { await api.logout(); } catch {}
  clearSession();
  location.href = '/pages/login.html';
});

// User menu dropdown
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
    ['pwdCurrent', 'pwdNew', 'pwdConfirm'].forEach(id => document.getElementById(id).value = '');
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

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 50;

const RESULT_BADGE = {
  ok: { cls: 'ok', label: 'Correcta' },
  error: { cls: 'warn', label: 'Con error' },
  denegada: { cls: 'bad', label: 'Bloqueada' },
};

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'medium' }) : '—');
const fmtBytes = (n) => {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
};
const hostPort = (e) => (e.port ? `${e.host}:${e.port}` : e.host);

function resultBadge(result) {
  const b = RESULT_BADGE[result] || { cls: '', label: result || '—' };
  return `<span class="badge ${b.cls}">${escapeHtml(b.label)}</span>`;
}

/* ---------- lista blanca ---------- */

function renderPolicy(policy) {
  const rows = policy.destinations.map((d) => `
    <tr>
      <td>${escapeHtml(d.label)}${d.via === 'controlador' ? '<span class="cell-sub">conexión directa del controlador de la base; no pasa por la compuerta</span>' : ''}</td>
      <td class="mono">${escapeHtml(d.origin)}</td>
      <td><span class="badge ${d.category === 'tercero' ? 'warn' : 'ok'}">${d.category === 'tercero' ? 'Tercero' : 'Propio'}</span></td>
      <td>${d.mesas.includes('*') ? 'Todas' : escapeHtml(d.mesas.join(', '))}</td>
      <td class="mono">${escapeHtml(d.source)}</td>
    </tr>`);
  $('policyBody').innerHTML = rows.join('') || '<tr class="empty-row"><td colspan="5">Sin destinos permitidos</td></tr>';
  const llm = policy.externalLlmMesas.length ? policy.externalLlmMesas.join(', ') : 'ninguna';
  const web = policy.publicWebMesas.length ? policy.publicWebMesas.join(', ') : 'ninguna';
  $('policyNote').textContent = `Mesas que pueden enviar datos a un proveedor de IA externo: ${llm}. `
    + `Mesas que pueden descargar páginas públicas que cita un usuario: ${web}. `
    + `Tiempo máximo por salida: ${policy.timeoutMs / 1000} s.`;
}

async function loadPolicy() {
  try { renderPolicy(await api.pactvmEgressPolicy()); }
  catch (ex) { showError(ex.message || 'Error al cargar la lista blanca'); }
}

$('policyExportBtn').addEventListener('click', async () => {
  try {
    const policy = await api.pactvmEgressPolicy();
    const url = URL.createObjectURL(new Blob([JSON.stringify(policy, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pactvm-lista-blanca-salidas.json';
    a.click();
    URL.revokeObjectURL(url);
  } catch (ex) { toast(ex.message || 'No se pudo exportar'); }
});

/* ---------- resumen e integridad ---------- */

async function loadSummary() {
  try {
    const s = await api.pactvmEgressSummary();
    $('kpiCalls').textContent = s.calls;
    $('kpiDenied').textContent = s.denied;
    $('kpiThird').textContent = s.thirdParties;
  } catch (ex) { showError(ex.message || 'Error al cargar el resumen'); }
}

async function verifyChain() {
  const cell = $('kpiIntegrity');
  cell.textContent = 'Comprobando…';
  try {
    const v = await api.pactvmEgressVerify();
    cell.textContent = v.valid
      ? `Íntegra · ${v.totalEntries} entradas`
      : `ROTA en la entrada ${v.brokenAtSeq}`;
    cell.style.color = v.valid ? 'var(--accent-green-text)' : 'var(--amg-red)';
  } catch (ex) {
    cell.textContent = '—';
    showError(ex.message || 'Error al verificar la cadena');
  }
}
$('verifyBtn').addEventListener('click', verifyChain);

/* ---------- registro ---------- */

let nextBefore = null;

function detailOf(e) {
  if (e.kind === 'resumen') {
    const range = e.from === e.to ? fmtDate(e.from) : `${fmtDate(e.from)} a ${fmtDate(e.to)}`;
    const status = e.lastStatus ? ` · último HTTP ${e.lastStatus}` : '';
    return `${e.calls} consultas automáticas · ${fmtBytes(e.bytesIn)} recibidos${status}<span class="cell-sub">${escapeHtml(range)}${e.lastReason ? ` · ${escapeHtml(e.lastReason)}` : ''}</span>`;
  }
  const what = [e.method, e.path].filter(Boolean).join(' ');
  const status = e.status ? `HTTP ${e.status}` : '';
  const size = e.bytesIn !== null || e.bytesOut ? `↑ ${fmtBytes(e.bytesOut)} ↓ ${fmtBytes(e.bytesIn)}` : '';
  const extra = [status, size, e.durationMs !== null && e.durationMs !== undefined ? `${e.durationMs} ms` : ''].filter(Boolean).join(' · ');
  return `${escapeHtml(what || e.protocol)}${extra ? `<span class="cell-sub">${escapeHtml(extra)}</span>` : ''}${e.reason ? `<span class="cell-sub">${escapeHtml(e.reason)}</span>` : ''}`;
}

function rowOf(e, pending = false) {
  const when = e.kind === 'resumen' ? e.to : (e.at || e.createdAt);
  return `
    <tr>
      <td class="mono">${pending ? 'en curso' : fmtDate(when)}${pending ? '' : `<span class="cell-sub">#${e.seq}</span>`}</td>
      <td>${escapeHtml(e.mesa)}</td>
      <td>${escapeHtml(e.user || 'sistema')}</td>
      <td class="mono">${escapeHtml(hostPort(e))}<span class="cell-sub">${escapeHtml(e.category === 'propio' ? 'propio' : e.category === 'tercero' ? 'tercero' : 'sin regla')}</span></td>
      <td>${resultBadge(e.result)}</td>
      <td>${detailOf(e)}</td>
    </tr>`;
}

async function loadLog({ append = false } = {}) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  const result = $('filterResult').value;
  if (result) params.set('result', result);
  if (append && nextBefore) params.set('before', String(nextBefore));
  try {
    const page = await api.pactvmEgressList(`?${params}`);
    const pending = append || result ? [] : page.pending.map((e) => rowOf(e, true));
    const rows = pending.concat(page.entries.map((e) => rowOf(e)));
    if (append) $('logBody').insertAdjacentHTML('beforeend', rows.join(''));
    else $('logBody').innerHTML = rows.join('') || '<tr class="empty-row"><td colspan="6">Todavía no hay salidas registradas</td></tr>';
    nextBefore = page.nextBefore;
    $('moreBtn').hidden = !nextBefore;
  } catch (ex) { showError(ex.message || 'Error al cargar el registro'); }
}

$('filterResult').addEventListener('change', () => { nextBefore = null; loadLog(); });
$('moreBtn').addEventListener('click', () => loadLog({ append: true }));

// El registro revela las máquinas internas y quién llamó a qué: solo el Admin (el backend también lo exige).
if (getRole() === 'admin') {
  loadPolicy();
  loadSummary();
  loadLog();
  verifyChain();
} else {
  showError('Solo el Admin puede ver las salidas a la red.');
  document.querySelectorAll('main .card, main .kpi-grid').forEach((el) => el.remove());
}
