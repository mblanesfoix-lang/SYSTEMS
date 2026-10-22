import { api, getUser, getToken, getRole, clearSession, requireAuth, toast, escapeHtml as h } from '/js/api.js';
import { mountThemeToggle } from '/js/theme.js';
import { mountOfficeBg } from '/js/office-bg.js';
import { mountAdminNotifications } from '/js/notifications.js';
import { createComplianceView, formatDate, agoText, remainingText } from '/js/seagle-view.js';
requireAuth();
mountThemeToggle(document.querySelector('nav.nav .row'));
mountOfficeBg();
document.getElementById('userTag').textContent = getUser() || '';
mountAdminNotifications(document.querySelector('nav.nav .row'));

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 30000;
const isAdmin = getRole() === 'admin';

// Apply mesa permissions — redirect if no access to the domain at all
try {
  const perms = await fetch('/api/me/permissions', {
    headers: { Authorization: `Bearer ${getToken()}` }
  }).then(r => r.json());
  const allowed = new Set(perms.mesas || []);
  if (!allowed.has('seagle')) {
    location.href = '/pages/dashboard.html';
  }
  document.querySelectorAll('.tile[data-mesa]').forEach(el => {
    if (!allowed.has(el.dataset.mesa)) el.style.display = 'none';
  });
} catch {}

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
    ['pwdCurrent','pwdNew','pwdConfirm'].forEach(id => document.getElementById(id).value = '');
  } catch (ex) {
    errEl.textContent = ex.message || 'Error al cambiar contraseña';
    errEl.hidden = false;
  }
});

/* ---------- cumplimiento en vivo ---------- */

const view = createComplianceView($('sgView'));
let lastOk = 0;

async function refreshCompliance() {
  try {
    view.update(await api.seagleCompliance());
    lastOk = Date.now();
  } catch {
    // El indicador pasa a "sin conexion"; se reintenta en el siguiente ciclo.
  }
}

setInterval(() => {
  const stale = !lastOk || Date.now() - lastOk > REFRESH_MS * 2;
  $('sgLive').classList.toggle('is-stale', stale);
  $('sgLiveText').textContent = !lastOk ? 'Conectando' : `${stale ? 'Sin conexión' : 'En vivo'} · ${agoText(Date.now() - lastOk)}`;
}, 1000);
refreshCompliance();
setInterval(() => { if (document.visibilityState === 'visible') refreshCompliance(); }, REFRESH_MS);

/* ---------- invitaciones (solo Admin; el servidor lo exige igualmente) ---------- */

const STATE = {
  ACTIVE: ['verde', 'Activa'],
  EXPIRED: ['no_aplica', 'Caducada'],
  REVOKED: ['rojo', 'Revocada'],
  LOCKED: ['rojo', 'Bloqueada'],
};

function scopeText(inv) {
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  const parts = [inv.scope.frameworkIds ? n(inv.scope.frameworkIds.length, 'norma', 'normas') : 'Todas las normas'];
  if (inv.scope.includeZones) parts.push('zonas ATEX');
  if (inv.scope.documentIds.length) parts.push(n(inv.scope.documentIds.length, 'documento', 'documentos'));
  return parts.join(' · ');
}

function inviteRow(inv) {
  const [lv, label] = STATE[inv.state] ?? ['no_aplica', inv.state];
  const active = inv.state === 'ACTIVE';
  return `
    <article class="sg-invite">
      <div>
        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
          <span class="sg-invite__label">${h(inv.label)}</span>
          <span class="sg-chip sg-lv--${lv}">${h(label)}</span>
          ${inv.demo ? '<span class="sg-chip sg-chip--plain sg-lv--ambar">Demostración</span>' : ''}
        </div>
        <span class="sg-invite__emails">${h(inv.emails.join(', '))}</span>
        <span class="sg-invite__emails">${h(scopeText(inv))} · creada por ${h(inv.createdBy)} el ${h(formatDate(inv.createdAt))}</span>
      </div>
      <div class="sg-invite__stats">
        <span><b>${active ? h(remainingText(inv.expiresAt)) : h(formatDate(inv.expiresAt))}</b>${active ? 'quedan' : inv.state === 'REVOKED' ? 'revocada' : 'fin'}</span>
        <span><b>${inv.accessCount}</b>accesos</span>
        <span class="${inv.liveSessions ? 'sg-lv--verde' : ''}"><b style="${inv.liveSessions ? 'color:var(--accent-green)' : ''}">${inv.liveSessions}</b>en línea</span>
        <span><b style="${inv.failedAttempts ? 'color:var(--accent-amber)' : ''}">${inv.failedAttempts}</b>fallos</span>
      </div>
      <div class="sg-invite__actions">
        <button type="button" class="btn btn--ghost sg-btn-sm" data-preview="${h(inv.id)}" data-label="${h(inv.label)}">Vista previa</button>
        ${active ? `<button type="button" class="btn btn--ghost sg-btn-sm" data-revoke="${h(inv.id)}">Revocar</button>` : ''}
      </div>
    </article>`;
}

async function loadInvites() {
  try {
    const list = await api.seagleInvitations();
    $('sgInviteList').innerHTML = list.length
      ? list.map(inviteRow).join('')
      : '<div class="sg-empty">Todavía no hay invitaciones. Crea una para dar acceso de lectura a un inspector.</div>';
  } catch (ex) {
    $('sgInviteList').innerHTML = `<p class="sg-error">${h(ex.message || 'No se pudieron cargar las invitaciones')}</p>`;
  }
}

$('sgInviteList')?.addEventListener('click', async (e) => {
  const preview = e.target.closest('[data-preview]');
  if (preview) { openPreview(preview.dataset.preview, preview.dataset.label); return; }
  const revoke = e.target.closest('[data-revoke]');
  if (!revoke) return;
  // Dos pasos: el primer clic pide confirmacion en el propio boton.
  if (!revoke.dataset.armed) {
    revoke.dataset.armed = '1';
    revoke.textContent = 'Confirmar revocación';
    revoke.classList.add('danger');
    setTimeout(() => {
      if (!revoke.isConnected) return;
      delete revoke.dataset.armed;
      revoke.textContent = 'Revocar';
      revoke.classList.remove('danger');
    }, 4000);
    return;
  }
  revoke.disabled = true;
  try {
    await api.seagleInvitationRevoke(revoke.dataset.revoke);
    toast('Invitación revocada: el inspector pierde el acceso al instante');
  } catch (ex) {
    toast(ex.message || 'No se pudo revocar');
  }
  loadInvites();
});

/* ---------- alta de invitacion ---------- */

const inviteDialog = $('sgInviteDialog');
const previewDialog = $('sgPreviewDialog');
[inviteDialog, previewDialog].forEach((d) => {
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
});

const HOURS = [[2, '2 horas'], [4, '4 horas'], [8, '8 horas'], [24, '1 día'], [48, '2 días'], [72, '3 días']];

async function openInviteForm() {
  const body = $('sgInviteDialogBody');
  body.innerHTML = '<div class="sg-dialog__body"><div class="sg-skel" style="height:320px"></div></div>';
  inviteDialog.showModal();
  let data;
  try {
    data = await api.seagleInspectable();
  } catch (ex) {
    body.innerHTML = `<div class="sg-dialog__body"><p class="sg-error">${h(ex.message || 'No se pudieron cargar las normas')}</p></div>`;
    return;
  }
  const STATUS_SHORT = { vigente: 'vigente', en_preparacion: 'en preparación', no_iniciado: 'sin iniciar', no_aplica: 'no aplica' };
  const docName = new Map(data.frameworks.map((f) => [f.id, f.code]));
  body.innerHTML = `
    <form class="sg-form" id="sgInviteForm" novalidate>
      <div class="sg-dialog__body sg-form">
        <div class="sg-field">
          <label for="sgInvLabel">Organismo o motivo</label>
          <input class="input" id="sgInvLabel" maxlength="120" placeholder="Inspección de Industria · Gobierno de Navarra" required>
        </div>
        <div class="sg-field">
          <label for="sgInvEmails">Correos autorizados</label>
          <textarea id="sgInvEmails" rows="2" placeholder="inspector@organismo.es, otra.persona@organismo.es"></textarea>
          <small>Uno o varios, separados por comas o líneas (máximo 10). Solo estos correos podrán entrar.</small>
        </div>
        <div class="sg-two">
          <div class="sg-field">
            <label for="sgInvHours">Duración del acceso</label>
            <select id="sgInvHours">${HOURS.map(([v, t]) => `<option value="${v}"${v === 8 ? ' selected' : ''}>${t}</option>`).join('')}</select>
          </div>
          <fieldset class="sg-field">
            <legend>Normas visibles</legend>
            <div class="sg-segment" role="radiogroup">
              <label><input type="radio" name="sgInvScope" value="all" checked><span>Todas</span></label>
              <label><input type="radio" name="sgInvScope" value="pick"><span>Elegir</span></label>
            </div>
          </fieldset>
        </div>
        <div class="sg-field" id="sgInvPick" hidden>
          <div class="sg-checklist">
            ${data.frameworks.length ? data.frameworks.map((f) => `
              <label><input type="checkbox" name="sgInvFw" value="${h(f.id)}"> <span><span class="mono">${h(f.code)}</span> ${h(f.title)} <span class="mono">· ${h(STATUS_SHORT[f.status] ?? f.status)}</span></span></label>`).join('')
              : '<p class="sg-muted" style="margin:6px">No hay normas en Herzog LaW. Ábrela una vez para sembrar el catálogo.</p>'}
          </div>
        </div>
        <div class="sg-field">
          <label>Documentos que podrá descargar</label>
          <div class="sg-checklist">
            ${data.documents.length ? data.documents.map((d) => `
              <label><input type="checkbox" name="sgInvDoc" value="${h(d.id)}"> <span>${h(d.filename)} ${d.frameworkId ? `<span class="mono">· ${h(docName.get(d.frameworkId) ?? d.frameworkId)}</span>` : ''}</span></label>`).join('')
              : '<p class="sg-muted" style="margin:6px">No hay documentos subidos en Herzog LaW.</p>'}
          </div>
          <small>Ninguno por defecto: el inspector ve las fichas y solo descarga lo que marques aquí.</small>
        </div>
        <label class="sg-switch"><input type="checkbox" id="sgInvZones" checked> Incluir las zonas ATEX</label>
        <label class="sg-switch"><input type="checkbox" id="sgInvDemo" checked> Marcar como demostración (desmárcalo cuando los datos de Herzog LaW sean los definitivos)</label>
        <p class="sg-error" id="sgInvError" hidden></p>
      </div>
      <div class="sg-dialog__foot">
        <button type="button" class="btn btn--ghost" data-close>Cancelar</button>
        <button type="submit" class="btn" id="sgInvSubmit">Crear invitación</button>
      </div>
    </form>`;

  body.querySelectorAll('input[name="sgInvScope"]').forEach((r) => r.addEventListener('change', () => {
    $('sgInvPick').hidden = body.querySelector('input[name="sgInvScope"]:checked').value !== 'pick';
  }));
  $('sgInvLabel').focus();
  $('sgInviteForm').addEventListener('submit', submitInvite);
}

async function submitInvite(e) {
  e.preventDefault();
  const err = $('sgInvError');
  err.hidden = true;
  const pick = document.querySelector('input[name="sgInvScope"]:checked').value === 'pick';
  const payload = {
    label: $('sgInvLabel').value.trim(),
    emails: $('sgInvEmails').value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean),
    hours: Number($('sgInvHours').value),
    frameworkIds: pick ? [...document.querySelectorAll('input[name="sgInvFw"]:checked')].map((i) => i.value) : null,
    documentIds: [...document.querySelectorAll('input[name="sgInvDoc"]:checked')].map((i) => i.value),
    includeZones: $('sgInvZones').checked,
    demo: $('sgInvDemo').checked,
  };
  const btn = $('sgInvSubmit');
  btn.disabled = true;
  try {
    const created = await api.seagleInvitationCreate(payload);
    showSecret(created);
    loadInvites();
  } catch (ex) {
    err.textContent = ex.message || 'No se pudo crear la invitación';
    err.hidden = false;
    btn.disabled = false;
  }
}

// El enlace y el codigo solo existen en esta respuesta: el servidor guarda sus huellas.
function showSecret(inv) {
  $('sgInviteDialogBody').innerHTML = `
    <div class="sg-dialog__body sg-secret">
      <p style="margin:0">Invitación creada para <strong>${h(inv.label)}</strong>. Válida hasta el ${h(formatDate(inv.expiresAt))} a las ${h(new Date(inv.expiresAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }))}.</p>
      <div class="sg-secret__box">
        <span class="sg-secret__label">1 · Enlace (por correo)</span>
        <div class="sg-secret__value"><code>${h(inv.url)}</code><button type="button" class="btn btn--ghost sg-btn-sm" data-copy="url">Copiar</button></div>
      </div>
      <div class="sg-secret__box">
        <span class="sg-secret__label">2 · Código (por otro canal: teléfono o SMS)</span>
        <div class="sg-secret__value"><span class="sg-secret__code">${h(inv.code)}</span><button type="button" class="btn btn--ghost sg-btn-sm" data-copy="code">Copiar</button></div>
      </div>
      <p class="sg-warn">Guárdalos ahora: no se vuelven a mostrar. Envía el enlace y el código por canales distintos, para que quien intercepte uno no pueda entrar.</p>
    </div>
    <div class="sg-dialog__foot">
      <button type="button" class="btn btn--ghost" id="sgSecretPreview">Vista previa</button>
      <button type="button" class="btn" data-close>Hecho</button>
    </div>`;
  const values = { url: inv.url, code: inv.code };
  $('sgInviteDialogBody').querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(values[b.dataset.copy]);
      b.textContent = 'Copiado';
      setTimeout(() => { b.textContent = 'Copiar'; }, 1800);
    } catch {
      toast('No se pudo copiar: selecciónalo y cópialo a mano');
    }
  }));
  $('sgSecretPreview').addEventListener('click', () => { inviteDialog.close(); openPreview(inv.id, inv.label); });
}

/* ---------- vista previa ---------- */

let previewView = null;
async function openPreview(id, label) {
  $('sgPreviewTitle').textContent = label || 'Invitación';
  $('sgPreviewDemo').hidden = true;
  previewView ??= createComplianceView($('sgPreviewView'));
  previewView.skeleton();
  previewDialog.showModal();
  try {
    const data = await api.seagleInvitationPreview(id);
    $('sgPreviewDemo').hidden = !data.inspection.demo;
    previewView.update(data);
  } catch (ex) {
    $('sgPreviewView').innerHTML = `<p class="sg-error">${h(ex.message || 'No se pudo cargar la vista previa')}</p>`;
  }
}

if (isAdmin) {
  $('sgInvites').hidden = false;
  $('sgInviteShortcut').hidden = false;
  $('sgNewInvite').addEventListener('click', openInviteForm);
  $('sgInviteShortcut').addEventListener('click', openInviteForm);
  loadInvites();
  setInterval(() => { if (document.visibilityState === 'visible' && !inviteDialog.open) loadInvites(); }, REFRESH_MS);
}

// ---- Health check ----
function setMesaStatus(mesa, state, label, detail, error) {
  const card = document.querySelector(`.mesa-status-card[data-mesa="${mesa}"]`);
  if (!card) return;
  const dot = card.querySelector('.mesa-status-dot');
  const lbl = card.querySelector('.mesa-status-label');
  const det = card.querySelector('.mesa-status-detail');
  const err = card.querySelector('.mesa-status-error');
  dot.className = `mesa-status-dot ${state}`;
  lbl.className = `mesa-status-label ${state}`;
  lbl.textContent = label;
  det.textContent = detail || '';
  err.textContent = error || '';
}

async function checkMesa(mesa, url, { okLabel = 'operativo', parse } = {}) {
  const t0 = performance.now();
  try {
    const headers = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(url, { headers });
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const j = await r.json(); if (j.error) msg = j.error; } catch {}
      setMesaStatus(mesa, 'bad', 'error', `${url} · ${ms} ms`, msg);
      return;
    }
    const data = await r.json().catch(() => ({}));
    const extra = parse ? parse(data) : '';
    setMesaStatus(mesa, 'ok', okLabel, `${ms} ms${extra ? ' · ' + extra : ''}`, '');
  } catch (ex) {
    const ms = Math.round(performance.now() - t0);
    setMesaStatus(mesa, 'bad', 'sin conexión', `${url} · ${ms} ms`, ex.message || 'fallo de red');
  }
}

function refreshMesaStatus() {
  checkMesa('seagle', '/api/seagle/summary', {
    parse: d => `${d.invitationsActive ?? 0} invitaciones activas`
  });
}

refreshMesaStatus();
setInterval(refreshMesaStatus, 30000);
