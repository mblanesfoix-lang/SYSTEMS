import { api, getUser, getToken, clearSession, requireAuth, toast, escapeHtml } from '/js/api.js';
import { mountThemeToggle } from '/js/theme.js';
import { mountAdminNotifications } from '/js/notifications.js';
requireAuth();
mountThemeToggle(document.querySelector('nav.nav .row'));
const user = getUser() || '';
document.getElementById('userTag').textContent = user;
mountAdminNotifications(document.querySelector('nav.nav .row'));

let activeTab = 'metrics';
let feed = { metrics: [], documents: [], notes: [] };

async function loadSummary() {
  try {
    const s = await api.seagleSummary();
    document.getElementById('kpiReviewsTotal').textContent = s.reviewsTotal;
    document.getElementById('kpiPendientes').textContent = s.byStatus.pendiente || 0;
    document.getElementById('kpiShared').textContent = s.sharedToHerzog;
  } catch (ex) { toast(ex.message || 'Error al cargar resumen S-EAGLE'); }
}

async function loadFeed() {
  try {
    feed = await api.seagleHerzogFeed();
    renderList();
  } catch (ex) { toast(ex.message || 'Error al cargar datos de Herzog'); }
}

function badge(status) {
  const labels = { pendiente: 'Pendiente', verificado: 'Verificado', corregido: 'Corregido', error: 'Error' };
  return `<span class="seagle-badge seagle-badge--${status}">${labels[status] || status}</span>`;
}

function renderList() {
  const rows = feed[activeTab] || [];
  const listEl = document.getElementById('seagleList');
  if (rows.length === 0) {
    listEl.innerHTML = '<div class="seagle-empty">Sin datos en Herzog para este apartado todavía.</div>';
    return;
  }
  listEl.innerHTML = rows.map((row) => {
    let title, meta;
    if (activeTab === 'metrics') {
      title = `${escapeHtml(row.department)} · ${escapeHtml(row.metric)} = ${escapeHtml(String(row.value))}${row.unit ? ' ' + escapeHtml(row.unit) : ''}`;
      meta = `${row.source === 'auto' ? 'automática' : 'manual'} · ${new Date(row.createdAt).toLocaleString('es-ES')}`;
    } else if (activeTab === 'documents') {
      title = escapeHtml(row.filename);
      meta = `${escapeHtml(row.department || 'sin depto')} · ${(row.size / 1024).toFixed(1)} KB · ${new Date(row.uploadedAt).toLocaleString('es-ES')}`;
    } else {
      title = escapeHtml(row.text.slice(0, 140));
      meta = `${escapeHtml(row.department)} · ${escapeHtml(row.authorId)} · ${new Date(row.createdAt).toLocaleString('es-ES')}`;
    }
    const noteHtml = row.review.note ? `<div class="seagle-item__note">${escapeHtml(row.review.note)}</div>` : '';
    return `<div class="seagle-item" data-source-type="${activeTab === 'documents' ? 'document' : activeTab === 'notes' ? 'note' : 'metric'}" data-source-id="${escapeHtml(String(row.id))}">
          <div class="seagle-item__main">
            <div class="seagle-item__title">${title}</div>
            <div class="seagle-item__meta">${meta}</div>
            ${noteHtml}
          </div>
          <div class="seagle-item__actions" style="flex-direction:column; align-items:flex-end;">
            ${badge(row.review.status)}
            <div style="display:flex; gap:4px; margin-top:6px;">
              <button type="button" class="btn ghost act-verify">Verificar</button>
              <button type="button" class="btn ghost act-correct">Corregir</button>
              <button type="button" class="btn ghost act-error">Error</button>
              <button type="button" class="btn sage act-share">Compartir</button>
            </div>
          </div>
        </div>`;
  }).join('');
}

document.querySelectorAll('.seagle-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seagle-tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activeTab = btn.dataset.tab;
    renderList();
  });
});

document.getElementById('seagleList').addEventListener('click', async (e) => {
  const item = e.target.closest('.seagle-item');
  if (!item) return;
  const sourceType = item.dataset.sourceType;
  const sourceId = item.dataset.sourceId;

  if (e.target.classList.contains('act-verify')) {
    await api.seagleReview({ sourceType, sourceId, status: 'verificado' });
    toast('Marcado como verificado');
    await Promise.all([loadFeed(), loadSummary()]);
  } else if (e.target.classList.contains('act-error')) {
    const note = prompt('Describe el error encontrado:');
    if (note === null) return;
    await api.seagleReview({ sourceType, sourceId, status: 'error', note });
    toast('Marcado con error');
    await Promise.all([loadFeed(), loadSummary()]);
  } else if (e.target.classList.contains('act-correct')) {
    const note = prompt('Texto de la corrección (queda solo en S-EAGLE, sin compartir a Herzog):');
    if (note === null) return;
    await api.seagleReview({ sourceType, sourceId, status: 'corregido', note });
    toast('Corrección registrada');
    await Promise.all([loadFeed(), loadSummary()]);
  } else if (e.target.classList.contains('act-share')) {
    const text = prompt('Nota de corrección a compartir con Herzog (bunker central):');
    if (text === null || !text.trim()) return;
    await api.seagleHerzogShare({ text, sourceType, sourceId, department: 'seagle' });
    toast('Compartido con Herzog');
    await Promise.all([loadFeed(), loadSummary()]);
  }
});

loadSummary();
loadFeed();

// User menu dropdown
const trigger = document.getElementById('userTag');
const dropdown = document.getElementById('userDropdown');
trigger.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = !dropdown.hidden;
  dropdown.hidden = open;
  trigger.setAttribute('aria-expanded', String(!open));
});
document.addEventListener('click', (e) => {
  if (!document.getElementById('userMenu').contains(e.target)) {
    dropdown.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
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
    dropdown.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    ['pwdCurrent','pwdNew','pwdConfirm'].forEach(id => document.getElementById(id).value = '');
  } catch (ex) {
    errEl.textContent = ex.message || 'Error al cambiar contraseña';
    errEl.hidden = false;
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try { await api.logout(); } catch {}
  clearSession();
  location.href = '/pages/login.html';
});
