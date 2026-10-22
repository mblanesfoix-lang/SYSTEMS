import { api, getUser, requireAuth, clearSession, toast, escapeHtml, uploadHerzogDocument, openAuthenticatedFile } from '/js/api.js';
import { mountThemeToggle } from '/js/theme.js';
import { mountAdminNotifications } from '/js/notifications.js';
import { mountPageSwitch } from '/js/page-switch.js';
requireAuth();
mountThemeToggle(document.querySelector('nav.nav .row'));
document.getElementById('userTag').textContent = getUser() || '';
mountAdminNotifications(document.querySelector('nav.nav .row'));
mountPageSwitch();

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

function showError(msg) {
  const box = document.getElementById('errorBox');
  box.textContent = msg;
  box.style.display = msg ? 'block' : 'none';
}
function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }); } catch { return iso; }
}
function fmtBytes(n) {
  if (!n) return '0 KB';
  const kb = n / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

async function loadSummary() {
  try {
    const s = await api.herzogSummary();
    document.getElementById('kpiMetrics').textContent = s.metricsCount ?? 0;
    document.getElementById('kpiMetricsSub').textContent = s.lastMetricAt ? `última: ${fmtDate(s.lastMetricAt)}` : 'sin datos aún';
    document.getElementById('kpiMetricsSplit').textContent = `${s.autoMetricsCount ?? 0} auto · ${s.manualMetricsCount ?? 0} a mano`;
    document.getElementById('kpiDocs').textContent = s.documentsCount ?? 0;
    document.getElementById('kpiNotes').textContent = s.notesCount ?? 0;
    document.getElementById('kpiDepts').textContent = s.departmentsTracked ?? 0;
  } catch (ex) { showError(ex.message || 'Error al cargar resumen'); }
}

async function loadMetrics() {
  const body = document.getElementById('metBody');
  try {
    const rows = await api.herzogMetricsList({ source: 'manual' });
    if (rows.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="6">Sin métricas a mano aún. Reporta la primera arriba.</td></tr>'; return; }
    body.innerHTML = rows.map(r => `<tr>
          <td>${escapeHtml(r.department)}</td>
          <td class="mono">${escapeHtml(r.metric)}</td>
          <td class="mono">${escapeHtml(String(r.value))}</td>
          <td class="mono">${escapeHtml(r.unit || '—')}</td>
          <td class="mono">${escapeHtml(r.reportedBy || '—')}</td>
          <td class="mono">${fmtDate(r.createdAt)}</td>
        </tr>`).join('');
  } catch (ex) { showError(ex.message || 'Error al cargar métricas'); }
}

async function loadAutoMetrics() {
  const body = document.getElementById('autoMetBody');
  try {
    const rows = await api.herzogMetricsList({ source: 'auto', limit: 500 });
    // Solo la fila mas reciente por department+metric (el poll guarda historial completo)
    const latest = new Map();
    for (const r of rows) {
      const key = `${r.department}::${r.metric}`;
      if (!latest.has(key)) latest.set(key, r);
    }
    const dedup = [...latest.values()].sort((a, b) => a.department.localeCompare(b.department) || a.metric.localeCompare(b.metric));
    if (dedup.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="5">Sin datos aún. Se rellena solo cada 5 min desde U2/Finance/ØPHS/Pactvm.</td></tr>'; return; }
    body.innerHTML = dedup.map(r => `<tr>
          <td>${escapeHtml(r.department)}</td>
          <td class="mono">${escapeHtml(r.metric)}</td>
          <td class="mono">${r.value === null ? '—' : escapeHtml(String(r.value))}</td>
          <td class="mono">${escapeHtml(r.unit || '—')}</td>
          <td class="mono">${fmtDate(r.createdAt)}</td>
        </tr>`).join('');
  } catch (ex) { showError(ex.message || 'Error al cargar variables base'); }
}
document.getElementById('metAddBtn').addEventListener('click', async () => {
  showError('');
  const department = document.getElementById('metDept').value.trim();
  const metric = document.getElementById('metName').value.trim();
  const value = document.getElementById('metValue').value.trim();
  if (!department) return showError('Indica el departamento');
  if (!metric) return showError('Indica el nombre de la métrica');
  if (!value) return showError('Indica el valor');
  try {
    await api.herzogMetricAdd({
      department, metric,
      value: Number.isFinite(Number(value)) ? Number(value) : value,
      unit: document.getElementById('metUnit').value.trim(),
      note: document.getElementById('metNote').value.trim(),
    });
    ['metName','metValue','metUnit','metNote'].forEach(id => document.getElementById(id).value = '');
    loadMetrics(); loadSummary();
  } catch (ex) { showError(ex.message || 'Error al reportar métrica'); }
});

async function loadDocuments() {
  const list = document.getElementById('docList');
  try {
    const docs = await api.herzogDocumentsList();
    if (docs.length === 0) { list.innerHTML = '<p class="mono" style="color:var(--text-muted); font-size:0.75rem;">Sin documentos aún.</p>'; return; }
    list.innerHTML = docs.map(d => `<div class="doc-item" data-id="${d.id}">
          <div>
            <a href="#" class="doc-open" data-name="${escapeHtml(d.filename)}">${escapeHtml(d.filename)}</a>
            <div class="doc-item__meta">${escapeHtml(d.department || '—')} · ${fmtBytes(d.size)} · ${escapeHtml(d.uploadedBy || '—')} · ${fmtDate(d.uploadedAt)}</div>
          </div>
          <button class="btn ghost btn--sm doc-del">Eliminar</button>
        </div>`).join('');
    list.querySelectorAll('.doc-item').forEach(el => {
      const id = el.dataset.id;
      // El enlace plano no envia Authorization: el documento se baja autenticado.
      el.querySelector('.doc-open').addEventListener('click', async (e) => {
        e.preventDefault();
        try { await openAuthenticatedFile(`/api/herzog-central/documents/${id}`, e.currentTarget.dataset.name); } catch (ex) { showError(ex.message); }
      });
      el.querySelector('.doc-del').addEventListener('click', async () => {
        try { await api.herzogDocumentDelete(id); loadDocuments(); loadSummary(); } catch (ex) { showError(ex.message); }
      });
    });
  } catch (ex) { showError(ex.message || 'Error al cargar documentos'); }
}
document.getElementById('docUploadBtn').addEventListener('click', async () => {
  showError('');
  const fileInput = document.getElementById('docFile');
  const file = fileInput.files[0];
  if (!file) return showError('Selecciona un archivo');
  try {
    await uploadHerzogDocument(file, document.getElementById('docDept').value.trim());
    fileInput.value = '';
    document.getElementById('docDept').value = '';
    toast('Documento subido');
    loadDocuments(); loadSummary();
  } catch (ex) { showError(ex.message || 'Error al subir documento'); }
});

async function loadNotes() {
  const list = document.getElementById('noteList');
  try {
    const notes = await api.herzogNotesList();
    if (notes.length === 0) { list.innerHTML = '<p class="mono" style="color:var(--text-muted); font-size:0.75rem;">Sin notas aún.</p>'; return; }
    list.innerHTML = notes.map(n => `<div class="note-item" data-id="${n.id}">
          <div>${escapeHtml(n.text)}</div>
          ${n.tags?.length ? `<div class="note-item__tags">${n.tags.map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
          <div class="note-item__meta">
            <span>${escapeHtml(n.department)} · ${escapeHtml(n.authorId || '—')} · ${fmtDate(n.createdAt)}</span>
            <button class="btn ghost btn--sm note-del">Eliminar</button>
          </div>
        </div>`).join('');
    list.querySelectorAll('.note-item').forEach(el => {
      const id = el.dataset.id;
      el.querySelector('.note-del').addEventListener('click', async () => {
        try { await api.herzogNoteDelete(id); loadNotes(); loadSummary(); } catch (ex) { showError(ex.message); }
      });
    });
  } catch (ex) { showError(ex.message || 'Error al cargar notas'); }
}
document.getElementById('noteAddBtn').addEventListener('click', async () => {
  showError('');
  const text = document.getElementById('noteText').value.trim();
  if (!text) return showError('Escribe una nota');
  try {
    const tags = document.getElementById('noteTags').value.split(',').map(t => t.trim()).filter(Boolean);
    await api.herzogNoteAdd({ department: document.getElementById('noteDept').value.trim(), text, tags });
    ['noteDept','noteText','noteTags'].forEach(id => document.getElementById(id).value = '');
    loadNotes(); loadSummary();
  } catch (ex) { showError(ex.message || 'Error al añadir nota'); }
});

loadSummary();
loadAutoMetrics();
loadMetrics();
loadDocuments();
loadNotes();
setInterval(() => { loadAutoMetrics(); loadSummary(); }, 60000);
