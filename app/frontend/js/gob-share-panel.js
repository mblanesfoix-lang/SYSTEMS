// Gob Share dentro de la pestaña "Registros oficiales" de F&L: mapa de portales oficiales de
// registro por pais y cajon lateral con la lista de nodos. Se monta la primera vez que se abre
// la pestaña: un canvas dentro de un panel oculto mediria 0 px.
import { escapeHtml } from '/js/api.js';
import { mountGobShareMap } from '/js/gob-share-map.js';
import { openNodeLinks } from '/js/gob-share-links.js';
import { GOB_SHARE_NODES, getNodeLinks, getNodeSearchText } from '/js/gob-share-nodes.js';

let montado = false;

export function mountGobSharePanel(root) {
  if (montado || !root) return;
  montado = true;

  mountGobShareMap(root.querySelector('#gobShareMap'), {
    tooltip: root.querySelector('#gobShareTooltip'),
    emptyBadge: root.querySelector('#gobShareEmpty'),
  });

  const drawerEl = root.querySelector('#gobShareDrawer');
  root.querySelector('#gobShareDrawerTab').addEventListener('click', () => drawerEl.classList.toggle('open'));

  const listEl = root.querySelector('#gobShareList');
  const searchEl = root.querySelector('#gobShareSearch');
  const nodes = Object.values(GOB_SHARE_NODES).sort((a, b) => a.nombre_sistema.localeCompare(b.nombre_sistema, 'es'));
  root.querySelector('#gobShareCount').textContent = nodes.length;

  function renderList(filter = '') {
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
  renderList();
  searchEl.addEventListener('input', () => renderList(searchEl.value));
}
