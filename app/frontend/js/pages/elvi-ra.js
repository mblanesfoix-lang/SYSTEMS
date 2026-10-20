import { getUser, clearSession, requireAuth, api, getToken, toast } from '/js/api.js';
import { mountThemeToggle } from '/js/theme.js';
import { mountAdminNotifications } from '/js/notifications.js';
requireAuth();
mountThemeToggle(document.querySelector('.er-nav .controls') || document.querySelector('.er-nav'));
mountAdminNotifications(document.querySelector('.er-nav .controls'));

// Mesa guard
await fetch('/api/me/permissions', { headers: { Authorization: `Bearer ${getToken()}` } })
  .then(r => r.json())
  .then(p => { if (!(p.mesas || []).includes('elvira')) location.href = '/pages/dashboard.html'; })
  .catch(() => {});

document.getElementById('userTag').textContent = getUser() || '';
document.getElementById('brandLogo').addEventListener('click', () => location.href = '/pages/elvira-dashboard.html');
document.getElementById('backBtn').addEventListener('click', () => location.href = '/pages/elvira-dashboard.html');
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

const authHeaders = () => ({ Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' });
async function jfetch(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { ...authHeaders(), ...(init.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

/* ============================================================
   CENTRAL · chat + acciones con consentimiento humano
   ============================================================ */
const chatScroll = document.getElementById('chatScroll');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const typing = document.getElementById('typing');

function scrollBottom() { chatScroll.scrollTop = chatScroll.scrollHeight; }

function addMsg(role, text, ts) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  if (ts) {
    const t = document.createElement('span');
    t.className = 'mono-ts';
    t.textContent = new Date(ts).toLocaleTimeString('es-ES');
    el.appendChild(t);
  }
  chatScroll.appendChild(el);
  scrollBottom();
  return el;
}

function addActionCard(action) {
  const card = document.createElement('div');
  card.className = 'action-card';
  card.innerHTML = `
        <span class="ac-kicker">Propuesta de acción · requiere autorización humana</span>
        <h4></h4>
        <div class="ac-meta"></div>
        <div class="ac-btns">
          <button class="ac-confirm">Autorizar</button>
          <button class="ac-reject">Rechazar</button>
        </div>`;
  card.querySelector('h4').textContent = action.summary;
  card.querySelector('.ac-meta').textContent =
    `${action.type} · ${action.nodeName || action.nodeId} · caduca ${new Date(action.expiresAt).toLocaleTimeString('es-ES')}`;
  card.querySelector('.ac-confirm').addEventListener('click', async () => {
    card.querySelectorAll('button').forEach(b => b.disabled = true);
    try {
      const r = await jfetch(`/api/elvira/central/actions/${action.id}/confirm`, { method: 'POST' });
      card.classList.add('resolved');
      addMsg('assistant', r.message || 'Acción ejecutada.');
      refreshNodes(); refreshLog();
    } catch (ex) {
      addMsg('system', `ERROR: ${ex.message}`);
      card.querySelectorAll('button').forEach(b => b.disabled = false);
    }
  });
  card.querySelector('.ac-reject').addEventListener('click', async () => {
    card.querySelectorAll('button').forEach(b => b.disabled = true);
    try {
      await jfetch(`/api/elvira/central/actions/${action.id}/reject`, { method: 'POST' });
      card.classList.add('resolved');
      addMsg('system', 'Acción rechazada. Registrada en el log inmutable.');
      refreshLog();
    } catch (ex) {
      addMsg('system', `ERROR: ${ex.message}`);
      card.querySelectorAll('button').forEach(b => b.disabled = false);
    }
  });
  chatScroll.appendChild(card);
  scrollBottom();
}

async function send() {
  const text = chatInput.value.trim();
  if (!text || sendBtn.disabled) return;
  chatInput.value = '';
  addMsg('user', text, new Date().toISOString());
  sendBtn.disabled = true;
  typing.hidden = false;
  try {
    const r = await jfetch('/api/elvira/central/chat', { method: 'POST', body: JSON.stringify({ message: text }) });
    if (r.reply) addMsg('assistant', r.reply, new Date().toISOString());
    if (r.action) addActionCard(r.action);
  } catch (ex) {
    addMsg('system', `ERROR: ${ex.message}`);
  } finally {
    sendBtn.disabled = false;
    typing.hidden = true;
    chatInput.focus();
  }
}
sendBtn.addEventListener('click', send);
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

// Historial previo
try {
  const h = await jfetch('/api/elvira/central/history');
  for (const m of (h.messages || []).slice(-40)) addMsg(m.role, m.text, m.ts);
} catch {}

// Orden prellenada desde OPHS (?prefill=Reinicia el ...) — el usuario
// sigue teniendo que pulsar Enviar, ninguna accion se dispara sola.
const prefill = new URLSearchParams(location.search).get('prefill');
if (prefill) {
  chatInput.value = prefill;
  chatInput.focus();
  history.replaceState(null, '', location.pathname);
}

/* ---------- panel lateral: nodos + log ---------- */
const nodesMini = document.getElementById('nodesMini');
const actionLog = document.getElementById('actionLog');

async function refreshNodes() {
  try {
    const { nodes } = await jfetch('/api/elvira/central/nodes');
    nodesMini.innerHTML = '';
    for (const n of nodes) {
      const el = document.createElement('div');
      el.className = 'node-mini';
      el.innerHTML = `
            <div class="nm-head"><span class="nm-name"></span><span class="st-dot st-${n.status}"></span></div>
            <div class="nm-stats"></div>`;
      el.querySelector('.nm-name').textContent = n.name;
      el.querySelector('.nm-stats').textContent =
        `${n.status.toUpperCase()} · ${n.temp_c}°C / obj ${n.target_temp_c}°C · BSS ${n.bss_charge_pct}% · ${n.throughput_kg_h} kg/h`;
      nodesMini.appendChild(el);
    }
  } catch {
    nodesMini.innerHTML = '<p class="mono" style="font-size:0.68rem;color:var(--text-muted);">Systems sin conexión</p>';
  }
}

async function refreshLog() {
  try {
    const { log } = await jfetch('/api/elvira/central/actions');
    actionLog.innerHTML = '';
    if (!log.length) {
      actionLog.innerHTML = '<p class="mono" style="font-size:0.68rem;color:var(--text-muted);margin-top:8px;">Sin acciones registradas</p>';
      return;
    }
    for (const e of log.slice(0, 12)) {
      const el = document.createElement('div');
      el.className = `log-entry ${e.decision}`;
      el.innerHTML = `<div class="le-label"></div><div class="le-hash"></div>`;
      el.querySelector('.le-label').textContent = `#${e.seq} ${e.decision === 'CONFIRMED' ? 'EJECUTADA' : 'RECHAZADA'} · ${e.type} · ${e.nodeId}`;
      el.querySelector('.le-hash').textContent = `${new Date(e.ts).toLocaleString('es-ES')} · ${e.user} · ${e.hash.slice(0, 16)}…`;
      actionLog.appendChild(el);
    }
  } catch {}
}

refreshNodes(); refreshLog();
setInterval(refreshNodes, 15000);
setInterval(refreshLog, 30000);
