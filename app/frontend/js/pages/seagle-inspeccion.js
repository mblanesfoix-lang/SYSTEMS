// Pantalla publica del inspector (S-EAGLE). Sin sesion de SYSTEMS: el inspector entra con el
// enlace de su invitacion y el codigo de 6 digitos, y recibe una sesion propia de solo
// lectura. El token del enlace vive en el fragmento (#t=) y se retira de la barra de
// direcciones al leerlo; viaja al servidor siempre en el cuerpo, nunca en la URL.
import { escapeHtml as h } from '/js/api.js';
import { mountThemeToggle } from '/js/theme.js';
import { createComplianceView, formatDate, agoText, remainingText } from '/js/seagle-view.js';

const REFRESH_MS = 15000;
const STALE_MS = 45000;
// sessionStorage: muere al cerrar la pestaña y no la comparten otras pestañas.
const LINK_KEY = 'seagleInspectLink';
const SESSION_KEY = 'seagleInspectSession';

const $ = (id) => document.getElementById(id);
const store = {
  get(key) { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* modo privado */ } },
  drop(key) { try { sessionStorage.removeItem(key); } catch { /* modo privado */ } },
};

const ICONS = {
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17h.01"/></svg>',
};

const ENDED = {
  NOT_FOUND: ['Enlace no válido', 'Este enlace de inspección no existe. Comprueba que lo has copiado completo o pide uno nuevo a S-NFI.'],
  EXPIRED: ['Acceso caducado', 'El plazo de esta invitación ha terminado. Si necesitas seguir, pide una invitación nueva a S-NFI.'],
  REVOKED: ['Acceso retirado', 'La Dirección de S-NFI ha retirado este acceso.'],
  LOCKED: ['Acceso bloqueado', 'Se han superado los intentos permitidos con este enlace. Por seguridad ha quedado bloqueado; pide una invitación nueva a S-NFI.'],
  NO_LINK: ['Enlace incompleto', 'Abre la página desde el enlace completo que te ha enviado S-NFI.'],
};

let linkToken = null;
let view = null;
let timer = null;
let lastOk = 0;
let session = null;

/* ---------- red ---------- */

async function request(method, path, { body, auth } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && session) headers.Authorization = `Bearer ${session.token}`;
  const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'omit' });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

/* ---------- puerta de acceso ---------- */

function showCard(html, { warn = false } = {}) {
  $('sgiBoard').hidden = true;
  $('sgiGate').hidden = false;
  ['sgiLive', 'sgiSession', 'sgiLogout'].forEach((id) => { $(id).hidden = true; });
  const card = $('sgiCard');
  card.className = `sgi-card${warn ? ' sgi-card--warn' : ''}`;
  card.innerHTML = html;
}

function showEnded(reason, { retry = false } = {}) {
  const [title, text] = ENDED[reason] ?? ['Sesión terminada', 'Tu sesión ha terminado.'];
  showCard(`
    <div class="sgi-card__mark">${ICONS.alert}</div>
    <span class="sg-eyebrow">S-NFI · Ventana de inspección</span>
    <h1>${h(title)}</h1>
    <p>${h(text)}</p>
    ${retry ? '<button type="button" class="btn sgi-submit" id="sgiRetry" style="margin-top:22px">Volver a entrar</button>' : ''}`, { warn: true });
  if (retry) $('sgiRetry').addEventListener('click', checkLink);
}

function showForm(expiresAt) {
  showCard(`
    <div class="sgi-card__mark">${ICONS.lock}</div>
    <span class="sg-eyebrow">S-NFI · Ventana de inspección</span>
    <h1>Acceso de inspección</h1>
    <p>Introduce el correo al que se envió la invitación y el código de 6 cifras que te ha facilitado S-NFI.</p>
    <form class="sgi-form" id="sgiForm" novalidate>
      <div>
        <label for="sgiEmail">Correo</label>
        <input class="input" id="sgiEmail" type="email" autocomplete="email" required>
      </div>
      <div>
        <label for="sgiCode">Código</label>
        <input class="input sgi-code" id="sgiCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required>
      </div>
      <p class="sg-error" id="sgiError" hidden></p>
      <button class="btn sgi-submit" type="submit" id="sgiSubmit">Entrar</button>
    </form>
    <p class="sgi-note">Acceso de solo lectura autorizado por la Dirección de S-NFI. Cada acceso queda registrado de forma inmutable. Enlace válido hasta el ${h(formatDate(expiresAt))} a las ${h(new Date(expiresAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }))}.</p>`);

  const code = $('sgiCode');
  code.addEventListener('input', () => { code.value = code.value.replace(/\D/g, '').slice(0, 6); });
  $('sgiEmail').focus();
  $('sgiForm').addEventListener('submit', onUnlock);
}

async function onUnlock(e) {
  e.preventDefault();
  const email = $('sgiEmail').value.trim();
  const code = $('sgiCode').value.trim();
  const err = $('sgiError');
  err.hidden = true;
  if (!email || !/^\d{6}$/.test(code)) {
    err.textContent = 'Escribe tu correo y el código de 6 cifras.';
    err.hidden = false;
    return;
  }
  const btn = $('sgiSubmit');
  btn.disabled = true;
  btn.textContent = 'Comprobando…';
  try {
    const { status, data } = await request('POST', '/api/seagle-inspect/unlock', { body: { token: linkToken, email, code } });
    if (status === 200) {
      session = { token: data.sessionToken, expiresAt: data.expiresAt, label: data.label };
      store.set(SESSION_KEY, session);
      startBoard();
      return;
    }
    if (data.status && ENDED[data.status]) { showEnded(data.status); return; }
    err.textContent = data.error || 'No se ha podido comprobar el acceso.';
    err.hidden = false;
  } catch {
    err.textContent = 'Sin conexión con S-NFI. Inténtalo de nuevo.';
    err.hidden = false;
  }
  btn.disabled = false;
  btn.textContent = 'Entrar';
}

async function checkLink() {
  if (!linkToken) { showEnded('NO_LINK'); return; }
  showCard('<p class="sg-muted">Comprobando el enlace…</p>');
  try {
    const { status, data } = await request('POST', '/api/seagle-inspect/status', { body: { token: linkToken } });
    if (status === 200) showForm(data.expiresAt);
    else showEnded(data.status ?? 'NOT_FOUND');
  } catch {
    showEnded('NOT_FOUND');
  }
}

/* ---------- panel ---------- */

function startBoard() {
  $('sgiGate').hidden = true;
  $('sgiBoard').hidden = false;
  ['sgiLive', 'sgiSession', 'sgiLogout'].forEach((id) => { $(id).hidden = false; });
  $('sgiLabel').textContent = session.label || 'Cumplimiento';
  view ??= createComplianceView($('sgiView'), { onDownload: download });
  refresh();
}

function endSession(reason) {
  clearTimeout(timer);
  timer = null;
  session = null;
  store.drop(SESSION_KEY);
  // Revocada, caducada o bloqueada: el enlace ya no sirve. Sesion terminada sin mas: se puede volver a entrar.
  if (ENDED[reason]) showEnded(reason);
  else showEnded('SESSION', { retry: Boolean(linkToken) });
}

async function refresh() {
  clearTimeout(timer);
  if (!session) return;
  try {
    const { status, data } = await request('GET', '/api/seagle-inspect/view', { auth: true });
    if (status === 401) { endSession(data.status); return; }
    if (status === 200) {
      lastOk = Date.now();
      $('sgiLabel').textContent = data.inspection.label;
      $('sgiDemo').hidden = !data.inspection.demo;
      $('sgiFootUser').textContent = `Sesión de ${data.session.email}`;
      session.expiresAt = data.session.expiresAt;
      view.update(data);
    }
  } catch {
    // Sin red: el indicador pasa a "sin conexion" y se reintenta en el siguiente ciclo.
  }
  timer = setTimeout(refresh, REFRESH_MS);
}

function tick() {
  if (!session) return;
  const live = $('sgiLive');
  const stale = !lastOk || Date.now() - lastOk > STALE_MS;
  live.classList.toggle('is-stale', stale);
  $('sgiLiveText').textContent = !lastOk ? 'Conectando' : stale ? `Sin conexión · ${agoText(Date.now() - lastOk)}` : `En vivo · ${agoText(Date.now() - lastOk)}`;
  const left = remainingText(session.expiresAt);
  $('sgiSession').textContent = `Sesión: ${left}`;
  if (left === 'caducada') endSession('SESSION');
}

async function download(doc, button) {
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = 'Descargando…';
  try {
    const r = await fetch(`/api/seagle-inspect/documents/${encodeURIComponent(doc.id)}`, {
      headers: { Authorization: `Bearer ${session.token}` }, cache: 'no-store', credentials: 'omit',
    });
    if (r.status === 401) { endSession((await r.json().catch(() => ({}))).status); return; }
    if (!r.ok) throw new Error('descarga');
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = doc.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch {
    button.textContent = 'No disponible';
    setTimeout(() => { button.innerHTML = original; button.disabled = false; }, 2500);
    return;
  }
  button.innerHTML = original;
  button.disabled = false;
}

/* ---------- arranque ---------- */

mountThemeToggle($('sgiActions'));

$('sgiLogout').addEventListener('click', async () => {
  try { await request('POST', '/api/seagle-inspect/logout', { auth: true }); } catch { /* la sesion se olvida igual */ }
  endSession('SESSION');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session) refresh();
});
setInterval(tick, 1000);

const fromHash = new URLSearchParams(location.hash.slice(1)).get('t');
if (fromHash) {
  // Otro enlace en la misma pestaña: la sesion anterior era de otra invitacion.
  if (store.get(LINK_KEY) !== fromHash) store.drop(SESSION_KEY);
  store.set(LINK_KEY, fromHash);
  history.replaceState(null, '', location.pathname);
}
linkToken = fromHash || store.get(LINK_KEY);
session = store.get(SESSION_KEY);

if (session?.token && new Date(session.expiresAt).getTime() > Date.now()) startBoard();
else checkLink();
