// Elvi-Ra · Notificaciones Admin (errores/inestabilidad del sistema)
// Visible solo para role === 'admin'. Monta una campana en el nav con SSE en vivo.
import { api, getToken, getRole, escapeHtml } from './api.js';

const SEVERITY_LABEL = { error: 'Error', warning: 'Aviso' };

// Traduce origin+severity a un titulo simple, legible para humano.
// El label/detail tecnico original se conserva y se ve al expandir la tarjeta.
const ORIGIN_NAME = {
  SYSTEM: 'Sistema',
  SENTINEL: 'Sentinel',
  REFF: 'Rëff',
  'SNFI-U2': 'S-NFI U-2',
  'ELVI-RA': 'Elvi-Ra',
};

function simpleTitle(n) {
  const who = ORIGIN_NAME[n.origin] || n.origin || 'Sistema';
  if (n.severity === 'warning') return `${who} · aviso a revisar`;
  return `${who} no responde como debería`;
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return 'ahora';
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  return `hace ${Math.floor(h / 24)}d`;
}

export function mountAdminNotifications(navEl) {
  if (getRole() !== 'admin' || !getToken()) return;

  const wrap = document.createElement('div');
  wrap.className = 'admin-notif';
  wrap.innerHTML = `
    <button class="admin-notif__bell" id="adminNotifBell" aria-haspopup="true" aria-expanded="false" title="Notificaciones del sistema">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      </svg>
      <span class="admin-notif__badge" id="adminNotifBadge" hidden>0</span>
    </button>
    <div class="admin-notif__dropdown" id="adminNotifDropdown" hidden>
      <div class="admin-notif__header">
        <span>Notificaciones del sistema</span>
        <div class="admin-notif__header-actions">
          <button class="admin-notif__readall" id="adminNotifReadAll">Marcar todo leído</button>
          <button class="admin-notif__close" id="adminNotifClose" aria-label="Cerrar notificaciones" title="Cerrar">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
              <path d="M5 5l14 14M19 5L5 19"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="admin-notif__list" id="adminNotifList"></div>
    </div>
  `;
  navEl.appendChild(wrap);

  const bell      = wrap.querySelector('#adminNotifBell');
  const badge     = wrap.querySelector('#adminNotifBadge');
  const dropdown  = wrap.querySelector('#adminNotifDropdown');
  const list      = wrap.querySelector('#adminNotifList');
  const readAllBtn= wrap.querySelector('#adminNotifReadAll');
  const closeBtn  = wrap.querySelector('#adminNotifClose');

  function closeDropdown() {
    dropdown.hidden = true;
    bell.setAttribute('aria-expanded', 'false');
  }

  let items = [];

  function render() {
    const unread = items.filter(n => !n.read).length;
    if (unread > 0) {
      badge.hidden = false;
      badge.textContent = unread > 99 ? '99+' : String(unread);
      bell.classList.add('admin-notif__bell--alert');
    } else {
      badge.hidden = true;
      bell.classList.remove('admin-notif__bell--alert');
    }
    if (!items.length) {
      list.innerHTML = `<div class="admin-notif__empty">Sin incidencias registradas.</div>`;
      return;
    }
    list.innerHTML = items.slice(0, 30).map(n => `
      <div class="admin-notif__item ${n.read ? '' : 'admin-notif__item--unread'} ${n.expanded ? 'admin-notif__item--open' : ''}" data-id="${n.id}">
        <button class="admin-notif__item-row" data-action="toggle">
          <span class="admin-notif__sev admin-notif__sev--${n.severity || 'error'}">${SEVERITY_LABEL[n.severity] || 'Error'}</span>
          <span class="admin-notif__title">${escapeHtml(simpleTitle(n))}</span>
          <span class="admin-notif__time">${timeAgo(n.ts)}</span>
          <svg class="admin-notif__chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 6l6 6-6 6"/>
          </svg>
        </button>
        <button class="admin-notif__delete" data-action="delete" title="Eliminar">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>
          </svg>
        </button>
        ${n.expanded ? `
          <div class="admin-notif__body">
            <div class="admin-notif__row"><span class="admin-notif__row-key">Origen</span><span>${escapeHtml(n.origin || 'SYSTEM')}</span></div>
            <div class="admin-notif__row"><span class="admin-notif__row-key">Detalle técnico</span><span class="admin-notif__label">${escapeHtml(n.label)}</span></div>
            ${n.detail ? `<pre class="admin-notif__detail">${escapeHtml(n.detail)}</pre>` : ''}
          </div>
        ` : ''}
      </div>
    `).join('');
  }

  function upsert(n) {
    const idx = items.findIndex(x => x.id === n.id);
    if (idx >= 0) items[idx] = n; else items.unshift(n);
    items = items.slice(0, 100);
    render();
  }

  api.notifications(50).then(data => {
    items = data.notifications || [];
    render();
  }).catch(() => {});

  bell.addEventListener('click', () => {
    if (!dropdown.hidden) { closeDropdown(); return; }
    dropdown.hidden = false;
    bell.setAttribute('aria-expanded', 'true');
  });
  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeDropdown();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !dropdown.hidden) closeDropdown();
  });
  document.addEventListener('click', (e) => {
    if (!dropdown.hidden && !wrap.contains(e.target)) closeDropdown();
  });
  list.addEventListener('click', (e) => {
    e.stopPropagation();
    const deleteBtn = e.target.closest('[data-action="delete"]');
    if (deleteBtn) {
      const item = deleteBtn.closest('.admin-notif__item');
      const id = item.dataset.id;
      api.notificationDelete(id).catch(() => {});
      items = items.filter(x => x.id !== id);
      render();
      return;
    }
    const toggleBtn = e.target.closest('[data-action="toggle"]');
    if (!toggleBtn) return;
    const item = toggleBtn.closest('.admin-notif__item');
    const id = item.dataset.id;
    const n = items.find(x => x.id === id);
    if (!n) return;
    n.expanded = !n.expanded;
    if (n.expanded && !n.read) {
      api.notificationRead(id).catch(() => {});
      n.read = true;
    }
    render();
  });
  readAllBtn.addEventListener('click', async () => {
    try { await api.notificationReadAll(); items.forEach(n => n.read = true); render(); } catch {}
  });

  try {
    const es = new EventSource(`/api/notifications/stream?token=${encodeURIComponent(getToken())}`);
    es.onmessage = (ev) => { try { upsert(JSON.parse(ev.data)); } catch {} };
    es.onerror = () => {}; // navegador reintenta solo
    window.addEventListener('beforeunload', () => es.close());
  } catch {}
}
