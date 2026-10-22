// Herzog LaW: etiquetas y utilidades compartidas por las pestanas.
import { escapeHtml } from '/js/api.js';

export const STATUS_LABEL = {
  no_iniciado: 'Sin iniciar',
  en_preparacion: 'En preparación',
  vigente: 'Vigente',
  no_aplica: 'No aplica',
};
export const STATUS_TONE = { no_iniciado: 'is-dim', en_preparacion: 'is-warn', vigente: 'is-ok', no_aplica: 'is-dim' };
export const PRIORITY_LABEL = { alta: 'Prioridad alta', media: 'Prioridad media', vigilar: 'Vigilar' };
export const NATURE_LABEL = { obligatoria: 'Obligatoria', voluntaria: 'Voluntaria', indirecta: 'Afecta a clientes' };
export const KIND_LABEL = { iso: 'ISO', ue: 'Unión Europea', local: 'Local', titulo: 'Títulos del Estado', otro: 'Otros' };
export const JURISDICTION_LABEL = { UE: 'UE', ES: 'España', DZ: 'Argelia', INT: 'Internacional' };

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function showError(message) {
  const box = document.getElementById('errorBox');
  box.textContent = message || '';
  box.style.display = message ? 'block' : 'none';
}

/** Fecha 'AAAA-MM-DD' en formato legible, sin desplazarla por la zona horaria. */
export function fmtDay(day) {
  if (!day) return 'Sin fecha';
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  return parsed.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function timeAgo(iso) {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `hace ${days} d` : new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtBytes(n) {
  if (!n) return '0 KB';
  const kb = n / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

export const fmtEur = (n) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
export const fmtNum = (n, digits = 2) => new Intl.NumberFormat('es-ES', { maximumFractionDigits: digits }).format(n);

/** Pastilla de vencimiento; vacia si no hay fecha. */
export function expiryPill(expiry) {
  if (!expiry || expiry.state === 'sin_fecha') return '';
  if (expiry.state === 'vencido') return `<span class="law-pill is-bad">Vencido hace ${Math.abs(expiry.days)} d</span>`;
  if (expiry.state === 'critico') return `<span class="law-pill is-bad">${expiry.days === 0 ? 'Vence hoy' : `Vence en ${expiry.days} d`}</span>`;
  if (expiry.state === 'proximo') return `<span class="law-pill is-warn">Vence en ${expiry.days} d</span>`;
  return '';
}

export function statusPill(status) {
  return `<span class="law-pill ${STATUS_TONE[status] || 'is-dim'}">${escapeHtml(STATUS_LABEL[status] || status)}</span>`;
}

export function priorityMark(priority) {
  return `<span class="law-prio is-${escapeHtml(priority)}" title="${escapeHtml(PRIORITY_LABEL[priority] || priority)}"><i></i><i></i><i></i><span>${escapeHtml(PRIORITY_LABEL[priority] || priority)}</span></span>`;
}

/** Zona ATEX: gravedad visual segun lo probable que sea la atmosfera explosiva. */
export function zoneTone(zone) {
  if (zone === '20' || zone === '0') return 'z-hi';
  if (zone === '21' || zone === '1') return 'z-mid';
  if (zone === '22' || zone === '2') return 'z-lo';
  return '';
}

export function progressBar(pct) {
  return `<div class="law-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="law-bar__fill${pct === 100 ? ' is-done' : ''}" style="width:${pct}%"></div></div>`;
}
