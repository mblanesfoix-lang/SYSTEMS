import { api, getUser, getToken, clearSession, requireAuth, toast, escapeHtml } from '/js/api.js';
import { mountThemeToggle } from '/js/theme.js';
import { mountAdminNotifications } from '/js/notifications.js';
import { mountGobShareMap } from '/js/gob-share-map.js';
import { openNodeLinks } from '/js/gob-share-links.js';
import { GOB_SHARE_NODES, getNodeLinks, getNodeSearchText } from '/js/gob-share-nodes.js';
requireAuth();
mountThemeToggle(document.querySelector('nav.nav .row'));
const user = getUser() || '';
document.getElementById('userTag').textContent = user;
mountAdminNotifications(document.querySelector('nav.nav .row'));

const mapEl = document.getElementById('gobShareMap');
const tooltipEl = document.getElementById('gobShareTooltip');
const emptyEl = document.getElementById('gobShareEmpty');
mountGobShareMap(mapEl, { tooltip: tooltipEl, emptyBadge: emptyEl });

const drawerEl = document.getElementById('gobShareDrawer');
const drawerTabEl = document.getElementById('gobShareDrawerTab');
drawerTabEl.addEventListener('click', () => drawerEl.classList.toggle('open'));

const listEl = document.getElementById('gobShareList');
const searchEl = document.getElementById('gobShareSearch');
const nodes = Object.values(GOB_SHARE_NODES).sort((a, b) => a.nombre_sistema.localeCompare(b.nombre_sistema, 'es'));
document.getElementById('gobShareCount').textContent = nodes.length;

function renderGobShareList(filter = '') {
  const q = filter.trim().toLowerCase();
  listEl.innerHTML = '';
  for (const node of nodes) {
    const total = getNodeLinks(node).length;
    if (q && !getNodeSearchText(node).includes(q)) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gobshare-node' + (total ? '' : ' gobshare-node--nolink');
    btn.innerHTML = `<span class="gobshare-node__row"><span class="gobshare-node__country">${escapeHtml(node.nombre_sistema)}</span><span class="gobshare-node__code">${escapeHtml(node.id_pais)}</span></span>` +
      `<span class="gobshare-node__service">${escapeHtml(node.portal_registro_oficial.label)}` +
      (total > 1 ? `<span class="gobshare-node__multi">${total} enlaces</span>` : '') + `</span>`;
    btn.title = total > 1 ? 'Elegir enlace' : total ? 'Abrir portal oficial' : 'Sin URL verificada todavía';
    if (total > 1) btn.setAttribute('aria-haspopup', 'dialog');
    btn.addEventListener('click', () => openNodeLinks(node, { element: btn }));
    listEl.appendChild(btn);
  }
}
renderGobShareList();
searchEl.addEventListener('input', () => renderGobShareList(searchEl.value));

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
