// Gob Share: selector de enlaces por pais. Mecanica generica: cualquier nodo de
// gob-share-nodes.js con mas de un enlace abrible (portal principal + accesos_directos)
// muestra un popover para elegir; con un solo enlace abre directo; sin enlaces no hace nada.
// Lo usan el mapa (clic en el pais) y la lista del cajon lateral (clic en la fila).
// Un unico popover por pagina. Estilos en /css/gob-share-links.css.

import { getNodeLinks } from './gob-share-nodes.js';

const MARGIN = 12;

let root = null;
let eyebrowEl = null;
let titleEl = null;
let listEl = null;
let isOpen = false;
let lastFocus = null;
let currentAnchorEl = null;

function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function ensureRoot() {
  if (root) return;
  root = make('div', 'gobshare-links');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'false');
  root.hidden = true;

  const head = make('div', 'gobshare-links__head');
  const titles = make('div', 'gobshare-links__titles');
  eyebrowEl = make('span', 'gobshare-links__eyebrow');
  titleEl = make('h2', 'gobshare-links__title');
  titleEl.id = 'gobShareLinksTitle';
  root.setAttribute('aria-labelledby', titleEl.id);
  titles.append(eyebrowEl, titleEl);

  const closeBtn = make('button', 'gobshare-links__close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Cerrar selector de enlaces');
  closeBtn.addEventListener('click', () => closeNodeLinks());
  head.append(titles, closeBtn);

  listEl = make('ul', 'gobshare-links__list');
  root.append(head, listEl);
  document.body.appendChild(root);
}

function renderItem(link) {
  const li = document.createElement('li');
  const a = make('a', 'gobshare-links__item');
  a.href = link.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.append(
    make('span', 'gobshare-links__label', link.label),
    make('span', 'gobshare-links__host', hostOf(link.url)),
    make('span', 'gobshare-links__sr', ' (se abre en una pestaña nueva)'),
  );
  const arrow = make('span', 'gobshare-links__arrow', '→');
  arrow.setAttribute('aria-hidden', 'true');
  a.append(arrow);
  if (link.note) a.append(make('span', 'gobshare-links__note', link.note));
  // El clic abre la pestana de forma nativa (sin window.open: respeta clic central y bloqueadores);
  // se cierra el selector despues para no interrumpir la navegacion del enlace.
  a.addEventListener('click', () => setTimeout(() => closeNodeLinks(), 0));
  li.append(a);
  return li;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function place(anchor) {
  const w = root.offsetWidth;
  const h = root.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  let x;
  let y;
  if (anchor.element) {
    // Fila del cajon (pegado al borde derecho): el selector sale a su izquierda, alineado arriba.
    const r = anchor.element.getBoundingClientRect();
    x = r.left - w - 8;
    y = r.top;
  } else {
    // Clic en el mapa: debajo a la derecha del puntero; si no cabe, se voltea al otro lado.
    const px = anchor.x ?? vw / 2;
    const py = anchor.y ?? vh / 2;
    x = px + 10;
    y = py + 10;
    if (x + w > vw - MARGIN) x = px - w - 10;
    if (y + h > vh - MARGIN) y = py - h - 10;
  }
  root.style.left = `${clamp(x, MARGIN, Math.max(MARGIN, vw - w - MARGIN))}px`;
  root.style.top = `${clamp(y, MARGIN, Math.max(MARGIN, vh - h - MARGIN))}px`;
}

function onOutsidePointerDown(e) {
  if (root.contains(e.target)) return;
  // Pulsar de nuevo la fila que lo abrio no cierra aqui: lo resuelve su propio clic (alternar).
  if (currentAnchorEl && currentAnchorEl.contains(e.target)) return;
  closeNodeLinks({ restoreFocus: false });
}

function onFocusIn(e) {
  if (root.contains(e.target)) return;
  // El foco pasa a la fila que lo abrio justo antes de su clic: se deja para que el clic alterne.
  if (currentAnchorEl && currentAnchorEl.contains(e.target)) return;
  closeNodeLinks({ restoreFocus: false });
}

function onDismiss(e) {
  // El scroll interno de la propia lista no cierra el selector.
  if (e && e.type === 'scroll' && root.contains(e.target)) return;
  closeNodeLinks({ restoreFocus: false });
}

function onKeyDown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeNodeLinks();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  if (!root.contains(document.activeElement)) return;
  const items = [...listEl.querySelectorAll('a')];
  const idx = items.indexOf(document.activeElement);
  let next;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  else if (e.key === 'ArrowDown') next = idx < 0 ? 0 : (idx + 1) % items.length;
  else next = idx <= 0 ? items.length - 1 : idx - 1;
  e.preventDefault();
  items[next].focus();
}

export function isNodeLinksOpen() {
  return isOpen;
}

export function closeNodeLinks({ restoreFocus = true } = {}) {
  if (!isOpen) return;
  isOpen = false;
  root.hidden = true;
  currentAnchorEl = null;
  document.removeEventListener('pointerdown', onOutsidePointerDown, true);
  document.removeEventListener('focusin', onFocusIn, true);
  document.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('resize', onDismiss);
  window.removeEventListener('scroll', onDismiss, true);
  const target = lastFocus;
  lastFocus = null;
  if (restoreFocus && target && target !== document.body && document.contains(target)) {
    target.focus({ preventScroll: true });
  }
}

function showChooser(node, links, anchor) {
  ensureRoot();
  // Pulsar otra vez la misma fila alterna: cierra el selector que ya estaba abierto.
  if (isOpen && anchor.element && anchor.element === currentAnchorEl) {
    closeNodeLinks();
    return;
  }
  if (isOpen) closeNodeLinks({ restoreFocus: false });

  lastFocus = document.activeElement;
  currentAnchorEl = anchor.element || null;
  eyebrowEl.textContent = `${node.id_pais} · ${links.length} enlaces`;
  titleEl.textContent = node.nombre_sistema;
  listEl.replaceChildren(...links.map(renderItem));

  // Se mide oculto (visibility) para colocarlo sin parpadeo antes de mostrarlo.
  root.style.visibility = 'hidden';
  root.hidden = false;
  place(anchor);
  root.style.visibility = '';
  isOpen = true;

  document.addEventListener('pointerdown', onOutsidePointerDown, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', onDismiss);
  window.addEventListener('scroll', onDismiss, true);
  listEl.querySelector('a').focus({ preventScroll: true });
}

// Punto de entrada unico. anchor: { x, y } (coordenadas de viewport del clic) o { element }.
// Devuelve false si el nodo no tiene ningun enlace abrible (el llamador decide el aviso).
export function openNodeLinks(node, anchor = {}) {
  const links = getNodeLinks(node);
  if (links.length === 0) return false;
  if (links.length === 1) {
    window.open(links[0].url, '_blank', 'noopener,noreferrer');
    return true;
  }
  showChooser(node, links, anchor);
  return true;
}
