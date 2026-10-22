// Selector entre paginas hermanas (Herzog PG / Herzog LaW): oculta el enlace a una
// pagina cuya mesa no tiene el usuario, y el selector entero si queda un solo enlace.
import { api } from '/js/api.js';

export async function mountPageSwitch() {
  const nav = document.querySelector('.page-switch');
  if (!nav) return;
  try {
    const { mesas = [] } = await api('/api/me/permissions');
    const allowed = new Set(mesas);
    for (const link of nav.querySelectorAll('a[data-mesa]')) link.hidden = !allowed.has(link.dataset.mesa);
    if (nav.querySelectorAll('a:not([hidden])').length < 2) nav.hidden = true;
  } catch {
    // Sin permisos legibles se deja el selector como esta: la propia pagina responde 403 si no hay acceso.
  }
}
