import { api, getUser, getRole, getToken, clearSession, requireAuth, toast } from '/js/api.js';
import { mountThemeToggle } from '/js/theme.js';
import { mountAdminNotifications } from '/js/notifications.js';
requireAuth();
mountThemeToggle(document.querySelector('nav.nav .row'));
document.getElementById('userTag').textContent = getUser() || '';
mountAdminNotifications(document.querySelector('nav.nav .row'));
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

function showError(msg) {
  const box = document.getElementById('errorBox');
  box.textContent = msg;
  box.style.display = 'flex';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function geoLabel(geo) {
  if (!geo) return '—';
  return [geo.city, geo.country].filter(Boolean).join(', ') || '—';
}

function riskBadge(risk) {
  if (!risk) return '<span class="risk-badge BAJO">BAJO</span>';
  const color = risk.level === 'ALTO' ? 'var(--accent-red)' : risk.level === 'MEDIO' ? 'var(--accent-amber)' : 'var(--accent-green2)';
  const title = escapeHtml((risk.reasons || []).join(' · ') || 'sin señales de riesgo');
  return `<span class="risk-badge ${risk.level}" title="${title}">${risk.level} · ${risk.score}</span>
        <span class="risk-bar-wrap"><span class="risk-bar" style="width:${risk.score}%;background:${color};"></span></span>`;
}

/* ---- Peticiones importantes ---- */
async function loadReqFeed() {
  try {
    const blocked = document.getElementById('reqFilter').value;
    const from = document.getElementById('reqFrom').value;
    const to = document.getElementById('reqTo').value;
    const params = {};
    if (blocked) params.blocked = blocked;
    if (from) params.from = from;
    if (to) params.to = to;
    const { events } = await api.sentinelLogHuman(params);
    const feed = document.getElementById('reqFeed');
    const empty = document.getElementById('reqEmpty');
    if (!events.length) {
      feed.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    feed.innerHTML = events.map(e => `
          <div class="req-item ${e.blocked ? 'blocked' : ''}">
            <div class="req-item__icon">${e.blocked ? '⛔' : '✓'}</div>
            <div class="req-item__body">
              <div class="req-item__msg">${escapeHtml(e.message)}</div>
              <div class="req-item__meta">
                <span>${fmtTime(e.ts)}</span>
                <span>IP ${escapeHtml(e.ip)}</span>
                ${e.mesa ? `<span>${escapeHtml(e.mesa)}</span>` : ''}
                ${e.sensitive ? '<span>ruta sensible</span>' : ''}
              </div>
            </div>
            ${e.blocked ? `<div class="req-item__actions"><button class="btn-mini danger" data-quickblock="${escapeHtml(e.ip)}">Bloquear IP</button></div>` : ''}
          </div>
        `).join('');
    feed.querySelectorAll('[data-quickblock]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await api.sentinelBlockIp(btn.dataset.quickblock, 'bloqueo desde feed de peticiones');
          toast(`IP ${btn.dataset.quickblock} bloqueada`);
          loadReqFeed();
          loadIpTable();
        } catch (ex) { toast(ex.message || 'Error'); }
      });
    });
    document.getElementById('reqUpdatedAt').textContent = `actualizado ${fmtTime(new Date())}`;
  } catch (ex) {
    showError('Error cargando peticiones: ' + (ex.message || ex));
  }
}
document.getElementById('reqFilterApply').addEventListener('click', loadReqFeed);

document.getElementById('reqExportBtn').addEventListener('click', async () => {
  try {
    const blocked = document.getElementById('reqFilter').value;
    const from = document.getElementById('reqFrom').value;
    const to = document.getElementById('reqTo').value;
    const params = {};
    if (blocked) params.blocked = blocked;
    if (from) params.from = from;
    if (to) params.to = to;
    const report = await api.sentinelLogExport(params);
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const rango = (from || to) ? `${from || 'inicio'}_a_${to || 'hoy'}` : 'completo';
    a.href = url; a.download = `sentinel-traza-${rango}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (ex) { toast(ex.message || 'Error generando traza'); }
});

/* ---- IPs sospechosas: fusiona cola de revision + top IPs por volumen ---- */
async function loadIpTable() {
  try {
    const [queue, stats, allowlist] = await Promise.all([api.sentinelReviewQueue(), api.sentinelIpStats(), api.sentinelAllowlist()]);
    const allowedIps = new Set(allowlist.map(a => a.ip));
    const byIp = new Map();
    stats.forEach(s => byIp.set(s.ip, { ip: s.ip, geo: s.geo, total: s.total, blocked: s.blocked, lastSeen: s.lastSeen, decision: null, risk: null, reason: null, autoBlocked: false }));
    queue.forEach(q => {
      const row = byIp.get(q.ip) || { ip: q.ip, geo: q.geo, total: 0, blocked: 0, lastSeen: q.updatedAt };
      row.decision = q.decision;
      row.risk = q.risk;
      row.reason = q.reason;
      row.autoBlocked = q.autoBlocked;
      row.updatedAt = q.updatedAt;
      byIp.set(q.ip, row);
    });
    allowlist.forEach(a => {
      const row = byIp.get(a.ip) || { ip: a.ip, geo: null, total: 0, blocked: 0, lastSeen: a.updatedAt };
      byIp.set(a.ip, row);
    });
    const rows = [...byIp.values()].map(r => ({ ...r, allowed: allowedIps.has(r.ip) })).sort((a, b) => {
      const score = r => r.allowed ? -1 : (r.risk ? r.risk.score : 0);
      return score(b) - score(a);
    });

    const pending = queue.filter(q => q.decision === 'PENDING').length;
    document.getElementById('kpiQueue').textContent = pending;
    document.getElementById('queueCount').textContent = `${rows.length} IPs registradas`;
    lastPendingCount = pending;
    updateSummary();

    const body = document.getElementById('ipBody');
    const empty = document.getElementById('ipEmpty');
    if (!rows.length) {
      body.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    window.__ipRows = new Map(rows.map(r => [r.ip, r]));
    body.innerHTML = rows.map(r => `
          <tr>
            <td class="mono">${escapeHtml(r.ip)}</td>
            <td>${escapeHtml(geoLabel(r.geo))}</td>
            <td>${r.allowed ? '<span class="tag ok">DE CONFIANZA</span>' : riskBadge(r.risk)}</td>
            <td class="mono">${r.total}${r.blocked > 0 ? ` <span class="tag blocked">${r.blocked} bloq.</span>` : ''}</td>
            <td>${r.allowed ? '<span class="tag ok">nunca se bloquea</span>' : (r.decision ? `<span class="tag ${r.decision === 'BLOCKED' ? 'blocked' : r.decision === 'ALLOWED' ? 'ok' : 'pending'}">${escapeHtml(r.decision)}</span>${r.autoBlocked ? ' <span class="tag blocked">AUTO</span>' : ''}` : '<span class="tag ok">sin incidencias</span>')}</td>
            <td class="mono">${fmtTime(r.lastSeen || r.updatedAt)}</td>
            <td>
              ${r.allowed
            ? `<button class="btn-mini" data-unallow="${escapeHtml(r.ip)}">Quitar confianza</button>`
            : `<button class="btn-mini danger" data-block="${escapeHtml(r.ip)}">Bloquear</button>
                   ${r.decision === 'BLOCKED' ? `<button class="btn-mini ok" data-allow="${escapeHtml(r.ip)}">Desbloquear</button>` : ''}
                   <button class="btn-mini ok" data-trust="${escapeHtml(r.ip)}">Marcar como mía</button>`}
              <button class="btn-mini" data-investigate="${escapeHtml(r.ip)}">Investigar</button>
            </td>
          </tr>
          <tr id="detail-row-${escapeHtml(r.ip)}" style="display:none;">
            <td colspan="7" style="padding:0;border-bottom:1px solid var(--border);">
              <div class="ip-detail" id="detail-${escapeHtml(r.ip)}"></div>
            </td>
          </tr>
        `).join('');

    body.querySelectorAll('[data-block]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await api.sentinelBlockIp(btn.dataset.block, 'bloqueo manual desde tabla de IPs');
          toast(`IP ${btn.dataset.block} bloqueada`);
          loadIpTable();
          loadReqFeed();
        } catch (ex) { toast(ex.message || 'Error'); }
      });
    });
    body.querySelectorAll('[data-allow]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await api.sentinelDecide(btn.dataset.allow, 'ALLOWED');
          toast(`IP ${btn.dataset.allow} desbloqueada`);
          loadIpTable();
        } catch (ex) { toast(ex.message || 'Error'); }
      });
    });
    body.querySelectorAll('[data-trust]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ip = btn.dataset.trust;
        const label = prompt(`¿De quién es la IP ${ip}? (opcional, ej. "Mi conexión de casa")`, '') || '';
        try {
          await api.sentinelAllowIp(ip, label);
          toast(`IP ${ip} marcada de confianza. No volverá a aparecer como problemática.`);
          loadIpTable();
          loadReqFeed();
        } catch (ex) { toast(ex.message || 'Error'); }
      });
    });
    body.querySelectorAll('[data-unallow]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ip = btn.dataset.unallow;
        if (!confirm(`Quitar a ${ip} de la lista de confianza? Sentinel volverá a vigilarla como a cualquier otra IP.`)) return;
        try {
          await api.sentinelUnallowIp(ip);
          toast(`IP ${ip} ya no es de confianza`);
          loadIpTable();
        } catch (ex) { toast(ex.message || 'Error'); }
      });
    });
    body.querySelectorAll('[data-investigate]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ip = btn.dataset.investigate;
        const row = document.getElementById(`detail-row-${ip}`);
        const box = document.getElementById(`detail-${ip}`);
        const isOpen = row.style.display !== 'none';
        if (isOpen) { row.style.display = 'none'; box.classList.remove('open'); return; }
        row.style.display = 'table-row';
        box.classList.add('open');
        box.innerHTML = 'Cargando historial...';
        try {
          const report = await api.sentinelIpReport(ip);
          const rowData = window.__ipRows?.get(ip) || {};
          const log = report.log || [];
          const totalBlocked = log.filter(e => e.blocked).length;
          const sensitiveHits = log.filter(e => e.sensitive).length;
          const firstSeen = log.length ? log[0].ts : null;
          const lastSeen = log.length ? log[log.length - 1].ts : null;
          const geo = rowData.geo || log.find(e => e.geo)?.geo || null;
          const risk = rowData.risk;
          const pathCounts = {};
          log.forEach(e => { pathCounts[e.path] = (pathCounts[e.path] || 0) + 1; });
          const topPaths = Object.entries(pathCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
          const recentEvents = log.slice(-40).reverse();

          const riskClass = risk ? (risk.level === 'ALTO' ? 'red' : risk.level === 'MEDIO' ? 'amber' : 'green') : '';
          const blockRate = log.length ? Math.round((totalBlocked / log.length) * 100) : 0;

          box.innerHTML = `
                <div class="ip-detail__stats">
                  <div class="ip-detail__stat"><div class="ip-detail__stat-label">Total peticiones</div><div class="ip-detail__stat-value">${report.totalRequests ?? log.length}</div></div>
                  <div class="ip-detail__stat"><div class="ip-detail__stat-label">Bloqueadas</div><div class="ip-detail__stat-value ${totalBlocked > 0 ? 'red' : 'green'}">${totalBlocked} <span style="font-size:0.6rem;color:var(--text-muted);">(${blockRate}%)</span></div></div>
                  <div class="ip-detail__stat"><div class="ip-detail__stat-label">Rutas sensibles</div><div class="ip-detail__stat-value ${sensitiveHits > 0 ? 'amber' : ''}">${sensitiveHits}</div></div>
                  <div class="ip-detail__stat"><div class="ip-detail__stat-label">Riesgo Sentinel</div><div class="ip-detail__stat-value ${riskClass}">${risk ? `${risk.score}/100 · ${risk.level}` : (rowData.allowed ? 'DE CONFIANZA' : 'sin datos')}</div></div>
                  <div class="ip-detail__stat"><div class="ip-detail__stat-label">Ubicación</div><div class="ip-detail__stat-value" style="font-size:0.8rem;">${escapeHtml(geoLabel(geo))}</div></div>
                  <div class="ip-detail__stat"><div class="ip-detail__stat-label">Primera / última actividad</div><div class="ip-detail__stat-value" style="font-size:0.72rem;">${fmtTime(firstSeen)} → ${fmtTime(lastSeen)}</div></div>
                </div>

                ${risk?.reasons?.length ? `
                  <div class="ip-detail__section-title">Motivos del riesgo</div>
                  <ul class="ip-detail__reasons">${risk.reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
                ` : ''}

                ${report.review?.reason ? `
                  <div class="ip-detail__section-title">Motivo en cola de revisión</div>
                  <div class="ip-detail__line">${escapeHtml(report.review.reason)}${report.review.autoBlocked ? ' <span class="tag blocked">AUTO</span>' : ''}</div>
                ` : ''}

                ${topPaths.length ? `
                  <div class="ip-detail__section-title">Rutas más visitadas</div>
                  <div class="ip-detail__line">${topPaths.map(([p, c]) => `<span class="mono">${escapeHtml(p)}</span> (${c})`).join(' &nbsp;·&nbsp; ')}</div>
                ` : ''}

                <div class="ip-detail__section-title">Últimos eventos (${recentEvents.length} de ${log.length})</div>
                <div class="ip-detail__timeline">
                  ${recentEvents.length ? recentEvents.map(e => `
                    <div class="ip-detail__event ${e.blocked ? 'blocked' : ''}">
                      <span class="mono">${fmtTime(e.ts)}</span>
                      <span class="mono">${escapeHtml(e.method)}</span>
                      <span class="ip-detail__event-path">${escapeHtml(e.path)}</span>
                      <span class="ip-detail__event-status">${e.statusCode ?? '—'}${e.blocked ? ' ⛔' : ''}</span>
                    </div>
                  `).join('') : '<div class="ip-detail__event">Sin eventos registrados.</div>'}
                </div>

                <div style="margin-top:14px;"><button class="btn-mini" data-download="${ip}">Descargar informe completo (JSON)</button></div>
              `;
          box.querySelector('[data-download]').addEventListener('click', () => {
            const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `sentinel-informe-${ip}.json`;
            a.click();
            URL.revokeObjectURL(url);
          });
        } catch (ex) {
          box.innerHTML = `Error cargando informe: ${escapeHtml(ex.message || ex)}`;
        }
      });
    });
  } catch (ex) {
    showError('Error cargando tabla de IPs: ' + (ex.message || ex));
  }
}

/* ---- Manual block ---- */
document.getElementById('manualBlockBtn').addEventListener('click', async () => {
  const ip = document.getElementById('manualBlockIp').value.trim();
  const reason = document.getElementById('manualBlockReason').value.trim();
  const msg = document.getElementById('manualBlockMsg');
  if (!ip) {
    msg.textContent = 'Introduce una IP valida.';
    msg.style.color = 'var(--accent-red)';
    msg.style.display = 'block';
    return;
  }
  try {
    await api.sentinelBlockIp(ip, reason);
    msg.textContent = `IP ${ip} bloqueada.`;
    msg.style.color = 'var(--accent-green2)';
    msg.style.display = 'block';
    document.getElementById('manualBlockIp').value = '';
    document.getElementById('manualBlockReason').value = '';
    loadIpTable();
  } catch (ex) {
    msg.textContent = ex.message || 'Error al bloquear.';
    msg.style.color = 'var(--accent-red)';
    msg.style.display = 'block';
  }
});

/* ---- Manual trust (allowlist) ---- */
document.getElementById('manualTrustBtn').addEventListener('click', async () => {
  const ip = document.getElementById('manualTrustIp').value.trim();
  const label = document.getElementById('manualTrustLabel').value.trim();
  const msg = document.getElementById('manualTrustMsg');
  if (!ip) {
    msg.textContent = 'Introduce una IP valida.';
    msg.style.color = 'var(--accent-red)';
    msg.style.display = 'block';
    return;
  }
  try {
    await api.sentinelAllowIp(ip, label);
    msg.textContent = `IP ${ip} marcada de confianza. Sentinel no volverá a bloquearla.`;
    msg.style.color = 'var(--accent-green2)';
    msg.style.display = 'block';
    document.getElementById('manualTrustIp').value = '';
    document.getElementById('manualTrustLabel').value = '';
    loadIpTable();
  } catch (ex) {
    msg.textContent = ex.message || 'Error al marcar de confianza.';
    msg.style.color = 'var(--accent-red)';
    msg.style.display = 'block';
  }
});

/* ---- Verify chain (avanzado) ---- */
async function loadChain() {
  try {
    const result = await api.sentinelVerifyChain();
    const dot = document.getElementById('chainDot');
    const text = document.getElementById('chainText');
    const kpi = document.getElementById('kpiChain');
    const kpiSub = document.getElementById('kpiChainSub');
    const box = document.getElementById('chainBrokenBox');
    if (result.valid) {
      dot.style.background = 'var(--accent-green)';
      dot.style.boxShadow = '0 0 8px var(--accent-green)';
      text.textContent = `Integra · ${result.totalEntries} entradas`;
      kpi.textContent = 'INTEGRA';
      kpi.className = 'kpi-val ok';
      kpiSub.textContent = `${result.totalEntries} entradas verificadas`;
      box.style.display = 'none';
    } else {
      dot.style.background = 'var(--accent-red)';
      dot.style.boxShadow = '0 0 8px var(--accent-red)';
      text.textContent = `Necesita atención · registro ${result.brokenAtSeq}`;
      kpi.textContent = 'REVISAR';
      kpi.className = 'kpi-val danger';
      kpiSub.textContent = `registro ${result.brokenAtSeq} de ${result.totalEntries}`;
      document.getElementById('chainExplanation').textContent = result.explanation || `El registro ${result.brokenAtSeq} no encaja con el anterior.`;
      // Mismo criterio que el servidor para re-sellar: rol Admin.
      box.style.display = getRole() === 'admin' ? 'block' : 'none';
    }
  } catch (ex) {
    showError('Error verificando cadena: ' + (ex.message || ex));
  }
}

document.getElementById('btnReanchor').addEventListener('click', async (ev) => {
  if (!confirm('Esto re-sella la cadena forense desde el punto roto. El historial no se borra, solo se vuelve a anclar para que pueda verificarse de nuevo. Con muchos registros puede tardar un par de minutos. ¿Continuar?')) return;
  const btn = ev.currentTarget;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Re-sellando… no cierres la página';
  try {
    const result = await api.sentinelReanchorChain();
    if (!result.reanchored) toast('La cadena ya estaba íntegra');
    else {
      toast(`Cadena re-sellada desde el registro ${result.fixedFrom} (${result.resealed} registros)`
        + (result.contentMismatch ? ` · ${result.contentMismatch} con contenido distinto de su sello anterior: revisar` : '')
        + (result.valid ? '' : ' · aún queda un tramo por verificar: vuelve a pulsar'));
    }
    await loadChain();
  } catch (ex) {
    showError('Error re-sellando cadena: ' + (ex.message || ex));
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

/* ---- Forensic log (avanzado) ---- */
async function loadLog(filters = {}) {
  try {
    const { events } = await api.sentinelLog(filters);
    const body = document.getElementById('logBody');
    const empty = document.getElementById('logEmpty');
    if (!events.length) {
      body.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    body.innerHTML = events.map(e => `
          <tr>
            <td class="mono">${e.seq}</td>
            <td class="mono">${fmtTime(e.ts)}</td>
            <td class="mono">${escapeHtml(e.ip)}</td>
            <td class="mono">${escapeHtml(e.method)}</td>
            <td class="mono">${escapeHtml(e.path)}</td>
            <td>${escapeHtml(e.mesa || '—')}</td>
            <td class="mono">${e.statusCode ?? '—'}</td>
            <td>
              ${e.blocked ? '<span class="tag blocked">BLOQUEADO</span>' : '<span class="tag ok">OK</span>'}
              ${e.sensitive ? '<span class="tag sensitive">SENSIBLE</span>' : ''}
            </td>
          </tr>
        `).join('');
  } catch (ex) {
    showError('Error cargando log forense: ' + (ex.message || ex));
  }
}

document.getElementById('filterApply').addEventListener('click', () => {
  const ip = document.getElementById('filterIp').value.trim();
  const blocked = document.getElementById('filterBlocked').value;
  const sensitive = document.getElementById('filterSensitive').value;
  const filters = {};
  if (ip) filters.ip = ip;
  if (blocked) filters.blocked = blocked;
  if (sensitive) filters.sensitive = sensitive;
  loadLog(filters);
});

/* ---- Timeline totals (sin grafico, solo KPIs) ---- */
async function loadTimelineTotals() {
  try {
    const { timeline } = await api.sentinelTimeline(60);
    const total60 = timeline.reduce((a, b) => a + b.total, 0);
    const blocked60 = timeline.reduce((a, b) => a + b.blocked, 0);
    const sensitive60 = timeline.reduce((a, b) => a + b.sensitive, 0);
    document.getElementById('kpiTotal60').textContent = total60;
    document.getElementById('kpiBlocked60').textContent = blocked60;
    document.getElementById('kpiSensitive60').textContent = sensitive60;
    updateSummary({ total60, blocked60 });
  } catch (ex) {
    showError('Error cargando totales: ' + (ex.message || ex));
  }
}

/* ---- Resumen en claro: una frase, sin tecnicismos ---- */
let lastPendingCount = 0;
let lastTotal60 = 0;
let lastBlocked60 = 0;
function updateSummary(data) {
  if (data) { lastTotal60 = data.total60 ?? 0; lastBlocked60 = data.blocked60 ?? 0; }
  const box = document.getElementById('senSummary');
  const icon = document.getElementById('senSummaryIcon');
  const title = document.getElementById('senSummaryTitle');
  const text = document.getElementById('senSummaryText');
  const pending = lastPendingCount;
  const blocked = lastBlocked60;
  const total = lastTotal60;

  if (pending > 0) {
    box.className = 'sen-summary alert';
    icon.textContent = '🔴';
    title.textContent = `Hay ${pending} IP${pending === 1 ? '' : 's'} esperando tu decisión`;
    text.textContent = 'Sentinel detectó actividad fuera de lo normal y no actuó por su cuenta — revisa la tabla de abajo y decide si bloquear o permitir.';
  } else if (blocked > 0) {
    box.className = 'sen-summary attention';
    icon.textContent = '🟠';
    title.textContent = `Sentinel bloqueó ${blocked} petición${blocked === 1 ? '' : 'es'} en la última hora`;
    text.textContent = 'Ya está resuelto — no hace falta que hagas nada. Si quieres ver el detalle, está en "Peticiones importantes" más abajo.';
  } else {
    box.className = 'sen-summary';
    icon.textContent = '🟢';
    title.textContent = 'Todo tranquilo — nada que requiera tu atención';
    text.textContent = total > 0
      ? `${total} peticiones en la última hora, todas normales: tus propias pestañas del sistema comprobando que todo funciona.`
      : 'Sin actividad registrada en la última hora.';
  }
}

/* ---- Navegador de trafico (live) ---- */
let livePaused = false;
let lastLiveSeq = null;

document.getElementById('livePauseBtn').addEventListener('click', () => {
  livePaused = !livePaused;
  document.getElementById('livePauseBtn').textContent = livePaused ? 'Reanudar' : 'Pausar';
  document.getElementById('liveStatus').textContent = livePaused ? 'en pausa' : 'en directo · cada 5s';
});
document.getElementById('liveFilterIp').addEventListener('change', () => { lastLiveSeq = null; loadLiveFeed(); });
document.getElementById('liveFilterBlocked').addEventListener('change', () => { lastLiveSeq = null; loadLiveFeed(); });
document.getElementById('liveLimit').addEventListener('change', () => { lastLiveSeq = null; loadLiveFeed(); });

async function loadLiveFeed() {
  if (livePaused) return;
  try {
    const ip = document.getElementById('liveFilterIp').value.trim();
    const blocked = document.getElementById('liveFilterBlocked').value;
    const limit = document.getElementById('liveLimit').value;
    const filters = { limit };
    if (ip) filters.ip = ip;
    if (blocked) filters.blocked = blocked;
    const { events } = await api.sentinelLog(filters);
    const body = document.getElementById('liveBody');
    const empty = document.getElementById('liveEmpty');
    if (!events.length) {
      body.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    const newestSeq = events[0]?.seq ?? null;
    body.innerHTML = events.map(e => `
          <tr data-ip="${escapeHtml(e.ip)}" class="${e.blocked ? 'row-blocked' : ''} ${lastLiveSeq != null && e.seq > lastLiveSeq ? 'is-new' : ''}">
            <td class="mono">${fmtTime(e.ts)}</td>
            <td class="mono">${escapeHtml(e.ip)}</td>
            <td>${escapeHtml(geoLabel(e.geo))}</td>
            <td class="mono">${escapeHtml(e.path)}</td>
            <td>${escapeHtml(e.mesa || '—')}</td>
            <td class="mono">${e.statusCode ?? '—'}</td>
            <td>
              ${e.blocked ? '<span class="tag blocked">BLOQUEADO</span>' : '<span class="tag ok">OK</span>'}
              ${e.sensitive ? '<span class="tag sensitive">SENSIBLE</span>' : ''}
            </td>
            <td>
              <div class="live-row-actions">
                <button class="btn-mini danger" data-live-block="${escapeHtml(e.ip)}">Bloquear</button>
                <button class="btn-mini ok" data-live-trust="${escapeHtml(e.ip)}">Marcar como mía</button>
              </div>
            </td>
          </tr>
        `).join('');
    body.querySelectorAll('[data-live-block]').forEach(btn => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          await api.sentinelBlockIp(btn.dataset.liveBlock, 'bloqueo desde navegador de trafico');
          toast(`IP ${btn.dataset.liveBlock} bloqueada`);
          loadLiveFeed(); loadIpTable(); loadReqFeed();
        } catch (ex) { toast(ex.message || 'Error'); }
      });
    });
    body.querySelectorAll('[data-live-trust]').forEach(btn => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const ip = btn.dataset.liveTrust;
        const label = prompt(`¿De quién es la IP ${ip}? (opcional)`, '') || '';
        try {
          await api.sentinelAllowIp(ip, label);
          toast(`IP ${ip} marcada de confianza. No volverá a salir como problemática.`);
          loadLiveFeed(); loadIpTable(); loadReqFeed();
        } catch (ex) { toast(ex.message || 'Error'); }
      });
    });
    body.querySelectorAll('tr[data-ip]').forEach(tr => {
      tr.addEventListener('click', () => {
        document.getElementById('liveFilterIp').value = tr.dataset.ip;
        loadLiveFeed();
      });
    });
    if (newestSeq != null) lastLiveSeq = newestSeq;
  } catch (ex) {
    showError('Error cargando navegador de trafico: ' + (ex.message || ex));
  }
}

/* ---- Canvas timeline: barras peticiones/bloqueadas/sensibles por minuto ---- */
async function loadLiveCanvas() {
  if (livePaused) return;
  try {
    const { timeline } = await api.sentinelTimeline(60);
    const canvas = document.getElementById('liveCanvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!timeline.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '11px monospace';
      ctx.fillText('Sin datos en los ultimos 60 minutos', 10, h / 2);
      return;
    }
    const maxTotal = Math.max(...timeline.map(b => b.total), 1);
    const padBottom = 16, padTop = 6;
    const usableH = h - padBottom - padTop;
    const barW = w / timeline.length;
    timeline.forEach((b, i) => {
      const x = i * barW;
      const totalH = (b.total / maxTotal) * usableH;
      const blockedH = (b.blocked / maxTotal) * usableH;
      const sensitiveH = (b.sensitive / maxTotal) * usableH;
      ctx.fillStyle = 'rgba(0,152,199,0.55)';
      ctx.fillRect(x + 1, h - padBottom - totalH, Math.max(barW - 2, 1), totalH);
      ctx.fillStyle = 'rgba(200,122,0,0.85)';
      ctx.fillRect(x + 1, h - padBottom - sensitiveH, Math.max(barW - 2, 1), sensitiveH);
      ctx.fillStyle = 'rgba(216,3,0,0.95)';
      ctx.fillRect(x + 1, h - padBottom - blockedH, Math.max(barW - 2, 1), blockedH);
    });
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(0, h - padBottom);
    ctx.lineTo(w, h - padBottom);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '9px monospace';
    ctx.fillText(fmtTime(timeline[0].minute), 2, h - 3);
    ctx.fillText(fmtTime(timeline[timeline.length - 1].minute), w - 46, h - 3);
  } catch (ex) {
    showError('Error cargando grafico de trafico: ' + (ex.message || ex));
  }
}

/* ---- Racks fisicos · estado distribuido Raft (Volumen 3) ---- */
function rackMsg(text, ok) {
  const el = document.getElementById('rackMsg');
  el.textContent = text;
  el.style.color = ok ? 'var(--accent-green2)' : 'var(--accent-red)';
  el.style.display = 'block';
}

async function loadRack() {
  try {
    const [st, kv] = await Promise.all([api.rackStatus(), api.rackState()]);
    document.getElementById('rkId').textContent = st.rackId;
    const role = document.getElementById('rkRole');
    role.textContent = st.role.toUpperCase();
    role.style.color = st.role === 'leader' ? 'var(--accent-green2)' : st.role === 'candidate' ? 'var(--accent-amber)' : 'var(--text-primary)';
    document.getElementById('rkTerm').textContent = st.term;
    document.getElementById('rkMode').textContent = st.mode;
    document.getElementById('rkQuorum').textContent = `${st.quorum}/${st.clusterSize}`;
    document.getElementById('rkCommit').textContent = `${st.commitIndex} (aplicado ${st.lastApplied})`;
    document.getElementById('rkLeader').textContent = st.leaderId || '—';
    document.getElementById('rackBadge').textContent = st.mode === 'standalone'
      ? 'standalone · primer rack, quorum 1'
      : `${st.peers.filter(p => p.reachable).length + 1}/${st.clusterSize} racks visibles`;

    const peersWrap = document.getElementById('rackPeersWrap');
    if (st.peers.length) {
      peersWrap.style.display = 'block';
      document.getElementById('rackPeersBody').innerHTML = st.peers.map(p => `<tr>
            <td class="mono">${escapeHtml(p.url)}</td>
            <td>${p.reachable ? '<span class="tag ok">SI</span>' : '<span class="tag blocked">NO</span>'}</td>
            <td class="mono">${p.matchIndex}</td>
            <td class="mono">${p.lastSeen ? fmtTime(p.lastSeen) : '—'}</td>
            <td class="mono" style="font-size:0.64rem;">${escapeHtml(p.lastError || '—')}</td>
          </tr>`).join('');
    } else {
      peersWrap.style.display = 'none';
    }

    const body = document.getElementById('rackStateBody');
    const entries = Object.entries(kv.state || {});
    if (!entries.length) { body.innerHTML = '<tr><td colspan="5" class="empty-row">Sin claves comprometidas todavía.</td></tr>'; return; }
    body.innerHTML = entries.sort((a, b) => a[0].localeCompare(b[0])).map(([key, m]) => `<tr>
          <td class="mono">${escapeHtml(key)}</td>
          <td class="mono">${escapeHtml(JSON.stringify(m.value))}</td>
          <td class="mono">${m.index}</td>
          <td class="mono">${escapeHtml(m.actor || 'raft')}</td>
          <td class="mono">${m.updatedAt ? fmtTime(m.updatedAt) : '—'}</td>
        </tr>`).join('');
  } catch (ex) {
    document.getElementById('rackBadge').textContent = 'sin conexión';
    document.getElementById('rackStateBody').innerHTML = `<tr><td colspan="5" class="empty-row">Rack State no disponible: ${escapeHtml(ex.message || ex)}</td></tr>`;
  }
}

document.getElementById('rackProposeBtn').addEventListener('click', async () => {
  const key = document.getElementById('rackKey').value.trim();
  const raw = document.getElementById('rackValue').value.trim();
  if (!key || !raw) return rackMsg('Clave y valor requeridos.', false);
  let value;
  try { value = JSON.parse(raw); } catch { value = raw; }
  try {
    const r = await api.rackStatePropose(key, value);
    rackMsg(r.committed ? `Comprometido y replicado (index ${r.index}, term ${r.term}).` : r.note, true);
    document.getElementById('rackKey').value = '';
    document.getElementById('rackValue').value = '';
    loadRack();
  } catch (ex) { rackMsg(ex.message || 'Error al proponer', false); }
});

document.getElementById('rackVerifyBtn').addEventListener('click', async () => {
  try {
    const r = await api.rackLogVerify();
    rackMsg(r.valid ? `Log de racks íntegro · ${r.totalEntries} entradas.` : `Log ROTO en seq ${r.brokenAtSeq}.`, r.valid);
  } catch (ex) { rackMsg(ex.message || 'Error al verificar', false); }
});

/* ---- Profiling de comportamiento a largo plazo (Behavioral Analytics) ---- */
function behMsg(text, ok) {
  const el = document.getElementById('manualBlockUserMsg');
  el.textContent = text;
  el.style.color = ok ? 'var(--accent-green2)' : 'var(--accent-red)';
  el.style.display = 'block';
}

async function loadBehaviorAlerts() {
  try {
    const { events, total } = await api.sentinelBehaviorAlerts({ limit: 50 });
    document.getElementById('behBadge').textContent = `${total} alerta(s) registradas`;
    const body = document.getElementById('behAlertsBody');
    const empty = document.getElementById('behAlertsEmpty');
    if (!events.length) {
      body.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    body.innerHTML = events.map(e => `<tr>
          <td class="mono">${fmtDateTime(e.ts)}</td>
          <td><span class="level-badge ${e.level}">${escapeHtml(e.level)}</span></td>
          <td class="mono">${escapeHtml(e.type)}</td>
          <td class="mono">${escapeHtml(e.user)}</td>
          <td>${escapeHtml(e.reason || '—')}</td>
        </tr>`).join('');
  } catch (ex) {
    showError('Error cargando alertas de comportamiento: ' + (ex.message || ex));
  }
}

async function loadBehaviorQueue() {
  try {
    const queue = await api.sentinelBehaviorQueue();
    const body = document.getElementById('behQueueBody');
    const empty = document.getElementById('behQueueEmpty');
    if (!queue.length) {
      body.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    body.innerHTML = queue.map(q => `<tr>
          <td class="mono">${escapeHtml(q.user)}</td>
          <td>${q.decision === 'BLOCKED' ? '<span class="tag blocked">BLOQUEADO</span>' : q.decision === 'ALLOWED' ? '<span class="tag ok">PERMITIDO</span>' : '<span class="tag pending">PENDIENTE</span>'}</td>
          <td style="max-width:320px;">${escapeHtml(q.reason || '—')}</td>
          <td class="mono">${fmtTime(q.updatedAt)}</td>
          <td>
            <div style="display:flex;gap:6px;">
              <button class="btn-mini ok" data-beh-allow="${escapeHtml(q.user)}">Permitir</button>
              <button class="btn-mini danger" data-beh-block="${escapeHtml(q.user)}">Bloquear</button>
            </div>
          </td>
        </tr>`).join('');
    body.querySelectorAll('[data-beh-allow]').forEach(btn => btn.addEventListener('click', async () => {
      try { await api.sentinelBehaviorDecide(btn.dataset.behAllow, 'ALLOWED'); toast('Usuario permitido'); loadBehaviorQueue(); }
      catch (ex) { showError(ex.message || 'Error'); }
    }));
    body.querySelectorAll('[data-beh-block]').forEach(btn => btn.addEventListener('click', async () => {
      try { await api.sentinelBehaviorDecide(btn.dataset.behBlock, 'BLOCKED'); toast('Usuario bloqueado'); loadBehaviorQueue(); }
      catch (ex) { showError(ex.message || 'Error'); }
    }));
  } catch (ex) {
    showError('Error cargando cola de usuarios: ' + (ex.message || ex));
  }
}

async function loadBehaviorHeatmap() {
  try {
    const { users, mesas, cells } = await api.sentinelBehaviorHeatmap(30);
    const table = document.getElementById('behHeatmapTable');
    const empty = document.getElementById('behHeatmapEmpty');
    if (!users.length || !mesas.length) {
      table.querySelector('tbody').innerHTML = '';
      table.classList.remove('heatmap');
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    table.classList.add('heatmap');
    const byKey = {};
    let max = 1;
    cells.forEach(c => { byKey[`${c.user}::${c.mesa}`] = c; if (c.total > max) max = c.total; });
    const head = `<thead><tr><th>Usuario</th>${mesas.map(m => `<th>${escapeHtml(m)}</th>`).join('')}</tr></thead>`;
    const rows = users.map(u => {
      const cellsHtml = mesas.map(m => {
        const c = byKey[`${u}::${m}`];
        if (!c) return '<td>—</td>';
        const intensity = Math.min(c.total / max, 1);
        const bg = `rgba(0,152,199,${0.08 + intensity * 0.35})`;
        return `<td><span class="heatmap-cell" style="background:${bg};" title="${c.total} peticiones${c.sensitive ? ` · ${c.sensitive} sensibles` : ''}">${c.total}</span></td>`;
      }).join('');
      return `<tr><td class="mono">${escapeHtml(u)}</td>${cellsHtml}</tr>`;
    }).join('');
    table.innerHTML = head + `<tbody>${rows}</tbody>`;
  } catch (ex) {
    showError('Error cargando heatmap: ' + (ex.message || ex));
  }
}

document.getElementById('manualBlockUserBtn').addEventListener('click', async () => {
  const user = document.getElementById('manualBlockUser').value.trim();
  const reason = document.getElementById('manualBlockUserReason').value.trim();
  if (!user) { behMsg('Introduce un usuario', false); return; }
  try {
    await api.sentinelBehaviorBlockUser(user, reason);
    behMsg(`Usuario ${user} bloqueado.`, true);
    document.getElementById('manualBlockUser').value = '';
    document.getElementById('manualBlockUserReason').value = '';
    loadBehaviorQueue();
  } catch (ex) { behMsg(ex.message || 'Error al bloquear', false); }
});

async function refreshBehavior() {
  await Promise.all([loadBehaviorAlerts(), loadBehaviorQueue(), loadBehaviorHeatmap()]);
}

/* ---- init + polling ---- */
async function refreshAll() {
  await Promise.all([loadTimelineTotals(), loadChain(), loadIpTable(), loadReqFeed(), loadLog(), loadLiveFeed(), loadLiveCanvas(), loadRack(), refreshBehavior()]);
}
refreshAll();
setInterval(() => { loadLiveFeed(); loadLiveCanvas(); }, 5000);
setInterval(() => { loadTimelineTotals(); loadIpTable(); loadReqFeed(); loadRack(); refreshBehavior(); }, 30000);
