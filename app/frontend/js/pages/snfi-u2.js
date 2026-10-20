import { api, getToken, requireAuth, toast } from '/js/api.js';
import { mountThemeToggle } from '/js/theme.js';
import { mountAdminNotifications } from '/js/notifications.js';
requireAuth();
mountThemeToggle(document.querySelector('nav.nav .row'));
mountAdminNotifications(document.querySelector('nav.nav .row'));

// Mesa guard
await fetch('/api/me/permissions', { headers: { Authorization: `Bearer ${getToken()}` } })
  .then(r => r.json())
  .then(p => { if (!(p.mesas || []).includes('snfiu2')) location.href = '/pages/dashboard.html'; })
  .catch(() => {});

const token = getToken();

api.me().then(u => {
  document.getElementById('userTag').textContent = u.user || '—';
}).catch(() => {});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try { await api.logout(); } catch (_) {}
  localStorage.removeItem('elvira_token');
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

/* ═══════════════════════════════════════════
   3D GLOBE — WebGL energy sphere
═══════════════════════════════════════════ */
(function initGlobe() {
  const canvas = document.getElementById('globeCanvas');
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (!gl) return;

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = rect.width  * dpr;
    canvas.height = rect.height * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();
  window.addEventListener('resize', resize);

  const VS = `
        attribute vec3 a_pos;
        attribute float a_alpha;
        uniform mat4 u_mvp;
        uniform float u_time;
        varying float v_alpha;
        varying float v_lat;
        void main() {
          v_alpha = a_alpha;
          v_lat = a_pos.y;
          gl_PointSize = 2.6;
          gl_Position = u_mvp * vec4(a_pos, 1.0);
        }`;
  const FS = `
        precision mediump float;
        varying float v_alpha;
        varying float v_lat;
        uniform float u_waste;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          if (dot(c,c) > 0.25) discard;
          // green for normal, red tinge when waste active
          vec3 col = mix(vec3(0.0, 0.66, 0.47), vec3(0.85, 0.01, 0.0), u_waste * 0.4);
          gl_FragColor = vec4(col, v_alpha * 0.7);
        }`;

  function compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, compileShader(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compileShader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  // Generate sphere points
  const N = 1800;
  const positions = [];
  const alphas = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = golden * i;
    positions.push(r * Math.cos(theta), y, r * Math.sin(theta));
    alphas.push(0.4 + Math.random() * 0.6);
  }

  // Grid lines (lat/lon)
  const linePositions = [];
  const lineAlphas = [];
  for (let lat = -80; lat <= 80; lat += 20) {
    const y = Math.sin(lat * Math.PI / 180);
    const r = Math.cos(lat * Math.PI / 180);
    const segs = 64;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      linePositions.push(r * Math.cos(a), y, r * Math.sin(a));
      lineAlphas.push(0.2);
    }
  }
  for (let lon = 0; lon < 360; lon += 30) {
    const segs = 64;
    for (let i = 0; i <= segs; i++) {
      const lat = -90 + (i / segs) * 180;
      const y = Math.sin(lat * Math.PI / 180);
      const r = Math.cos(lat * Math.PI / 180);
      const a = lon * Math.PI / 180;
      linePositions.push(r * Math.cos(a), y, r * Math.sin(a));
      lineAlphas.push(0.15);
    }
  }

  function makeBuffer(data) {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    return buf;
  }

  const posBuf  = makeBuffer(positions);
  const alphBuf = makeBuffer(alphas);
  const lposBuf = makeBuffer(linePositions);
  const lalphBuf = makeBuffer(lineAlphas);

  const aPosLoc   = gl.getAttribLocation(prog, 'a_pos');
  const aAlphaLoc = gl.getAttribLocation(prog, 'a_alpha');
  const uMvpLoc   = gl.getUniformLocation(prog, 'u_mvp');
  const uTimeLoc  = gl.getUniformLocation(prog, 'u_time');
  const uWasteLoc = gl.getUniformLocation(prog, 'u_waste');

  function mat4Mul(a, b) {
    const r = new Float32Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[i*4+k]*b[k*4+j];
      r[i*4+j] = s;
    }
    return r;
  }
  function perspective(fov, asp, near, far) {
    const f = 1.0 / Math.tan(fov / 2);
    const r = new Float32Array(16);
    r[0]=f/asp; r[5]=f;
    r[10]=(far+near)/(near-far); r[11]=-1;
    r[14]=(2*far*near)/(near-far);
    return r;
  }
  function rotY(a) {
    const c=Math.cos(a), s=Math.sin(a);
    const r=new Float32Array(16);
    r[0]=c; r[2]=s; r[5]=1; r[8]=-s; r[10]=c; r[15]=1;
    return r;
  }
  function rotX(a) {
    const c=Math.cos(a), s=Math.sin(a);
    const r=new Float32Array(16);
    r[0]=1; r[5]=c; r[6]=-s; r[9]=s; r[10]=c; r[15]=1;
    return r;
  }
  function translate(tx, ty, tz) {
    const r=new Float32Array(16);
    r[0]=1; r[5]=1; r[10]=1; r[15]=1;
    r[12]=tx; r[13]=ty; r[14]=tz;
    return r;
  }

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  let wasteLevel = 0;
  let targetWaste = 0;
  window.__setGlobeWaste = (v) => { targetWaste = v ? 1 : 0; };

  let t0 = performance.now();
  function draw() {
    requestAnimationFrame(draw);
    const t = (performance.now() - t0) / 1000;
    wasteLevel += (targetWaste - wasteLevel) * 0.02;

    const asp = canvas.width / canvas.height;
    const proj = perspective(0.8, asp, 0.1, 100);
    const tr   = translate(0, 0, -2.4);
    const rx   = rotX(0.32);
    const ry   = rotY(t * 0.12);
    const mvp  = mat4Mul(mat4Mul(proj, tr), mat4Mul(ry, rx));

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.uniformMatrix4fv(uMvpLoc, false, mvp);
    gl.uniform1f(uTimeLoc, t);
    gl.uniform1f(uWasteLoc, wasteLevel);

    // Draw grid lines
    gl.bindBuffer(gl.ARRAY_BUFFER, lposBuf);
    gl.enableVertexAttribArray(aPosLoc);
    gl.vertexAttribPointer(aPosLoc, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, lalphBuf);
    gl.enableVertexAttribArray(aAlphaLoc);
    gl.vertexAttribPointer(aAlphaLoc, 1, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.LINE_STRIP, 0, linePositions.length / 3);

    // Draw sphere points
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.enableVertexAttribArray(aPosLoc);
    gl.vertexAttribPointer(aPosLoc, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, alphBuf);
    gl.enableVertexAttribArray(aAlphaLoc);
    gl.vertexAttribPointer(aAlphaLoc, 1, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, N);
  }
  draw();
})();

/* ═══════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════ */
const today = new Date();
document.getElementById('loadingYear').textContent = today.getFullYear();

function showError(msg) {
  const b = document.getElementById('errorBox');
  b.textContent = msg;
  b.style.display = 'flex';
}
function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Formato decimal ES: coma en vez de punto, evita confusion con miles
function fmtEs(num, decimals = 1) {
  return num.toFixed(decimals).replace('.', ',');
}

// Animated counter
function animateNumber(el, target, decimals = 0, suffix = '') {
  const start = parseFloat(el.dataset.current || '0') || 0;
  const dur = 800;
  const t0 = performance.now();
  function step(now) {
    const p = Math.min((now - t0) / dur, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    const val = start + (target - start) * ease;
    el.textContent = fmtEs(val, decimals) + suffix;
    if (p < 1) requestAnimationFrame(step);
    else { el.dataset.current = target; el.classList.add('counted'); }
  }
  requestAnimationFrame(step);
}

/* ═══════════════════════════════════════════
   MODE SWITCH
═══════════════════════════════════════════ */
let currentMode = 'live';
let historicLoaded = false;
let generacionLoaded = false;
let renewablesLoaded = false;
let renewHistLoaded = false;
let curtailmentLoaded = false;

function switchMode(mode) {
  currentMode = mode;
  if (mode !== 'live') document.getElementById('errorBox').style.display = 'none';
  document.getElementById('panelLive').style.display          = mode === 'live'          ? '' : 'none';
  document.getElementById('panelHistoric').style.display      = mode === 'historic'      ? '' : 'none';
  document.getElementById('panelGeneracion').style.display    = mode === 'generacion'    ? '' : 'none';
  document.getElementById('panelRenewables').style.display    = mode === 'renewables'    ? '' : 'none';
  document.getElementById('panelCurtailment').style.display   = mode === 'curtailment'   ? '' : 'none';
  document.getElementById('tabLive').classList.toggle('active',          mode === 'live');
  document.getElementById('tabHistoric').classList.toggle('active',      mode === 'historic');
  document.getElementById('tabGeneracion').classList.toggle('active',    mode === 'generacion');
  document.getElementById('tabRenewables').classList.toggle('active',    mode === 'renewables');
  document.getElementById('tabCurtailment').classList.toggle('active',   mode === 'curtailment');
  if (mode === 'live') liveRetryCount = 0;
  if (mode === 'historic'     && !historicLoaded)     loadHistoric();
  if (mode === 'generacion'   && !generacionLoaded)   loadGeneracion();
  if (mode === 'renewables'   && !renewablesLoaded)   { loadRenewables(); loadRenewablesHistoric(); }
  if (mode === 'curtailment'  && !curtailmentLoaded)  loadCurtailment();
}
document.querySelectorAll('.mode-tab[data-mode]').forEach((tab) => {
  tab.addEventListener('click', () => switchMode(tab.dataset.mode));
});

/* ═══════════════════════════════════════════
   FETCH BLINDADO — timeout + reintentos + guard JSON
   Nunca deja pasar "Unexpected end of JSON input" al UI:
   body vacio/no-JSON se trata como fallo de red y reintenta.
═══════════════════════════════════════════ */
async function fetchJson(url, opts = {}, { retries = 2, retryDelayMs = 1500, timeoutMs = 15000 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(timer);
      const raw = await r.text();
      let data = null;
      if (raw) {
        try { data = JSON.parse(raw); }
        catch { lastErr = new Error('Respuesta no valida del servidor'); }
      }
      if (data === null) {
        if (r.ok) { lastErr = lastErr || new Error('Respuesta vacia del servidor'); }
        else { lastErr = new Error(`HTTP ${r.status}`); }
      } else {
        return { ok: r.ok, status: r.status, data };
      }
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === 'AbortError' ? new Error('Timeout de conexion') : e;
    }
    if (attempt < retries) await new Promise(res => setTimeout(res, retryDelayMs * (attempt + 1)));
  }
  throw lastErr || new Error('Fallo de red desconocido');
}

/* ═══════════════════════════════════════════
   LIVE PANEL
═══════════════════════════════════════════ */
let liveData = null;
let liveRefreshTimer = null;
let liveRetryCount = 0;
const LIVE_MAX_RETRIES = 3;

function renderStatusPill(snap, updatedAt) {
  const dot    = document.getElementById('statusDot');
  const text   = document.getElementById('statusText');
  const time   = document.getElementById('statusTime');
  const badge  = document.getElementById('heroBadgeDot');

  if (snap.en_desperdicio_ahora) {
    dot.className  = 'status-dot warn';
    badge.className = 'mole-badge__dot warn';
    text.textContent = 'Desperdicio activo — precio negativo/cero ahora mismo';
    window.__setGlobeWaste && window.__setGlobeWaste(true);
  } else {
    dot.className  = 'status-dot live';
    badge.className = 'mole-badge__dot';
    text.textContent = 'Sistema en equilibrio · monitorizando';
    window.__setGlobeWaste && window.__setGlobeWaste(false);
  }
  time.textContent = updatedAt ? 'act. ' + fmtDateTime(updatedAt) : '';
}

function renderLiveKpis(snap) {
  const precio = snap.precio_actual_eur_mwh;
  const isNeg  = precio !== null && precio < 0;

  const pEl = document.getElementById('kpiPrecioVal');
  pEl.className = 'kpi-val' + (isNeg ? ' negative' : (precio !== null && precio > 1 ? ' positive' : ''));
  if (precio !== null) animateNumber(pEl, precio, 2, ' €');
  else pEl.textContent = '—';
  document.getElementById('kpiPrecio').classList.toggle('alert', isNeg);

  const pvpcEl = document.getElementById('kpiPvpcVal');
  if (pvpcEl) {
    pvpcEl.className = 'kpi-val';
    if (snap.pvpc_actual_eur_mwh != null) animateNumber(pvpcEl, snap.pvpc_actual_eur_mwh, 2, ' €');
    else pvpcEl.textContent = '—';
  }

  const demEl = document.getElementById('kpiDemandaVal');
  if (demEl) {
    demEl.className = 'kpi-val';
    if (snap.demanda_actual_mw != null) animateNumber(demEl, snap.demanda_actual_mw, 0, ' MW');
    else demEl.textContent = '—';
  }

  const negEl = document.getElementById('kpiNegVal');
  negEl.className = 'kpi-val' + ((snap.intervalos_desperdiciados > 0) ? ' negative' : '');
  if (snap.intervalos_desperdiciados != null) animateNumber(negEl, snap.intervalos_desperdiciados, 0, '');
  else negEl.textContent = '—';

  const gwhEl = document.getElementById('kpiGwhVal');
  gwhEl.className = 'kpi-val';
  if (snap.exceso_gwh_hoy != null) animateNumber(gwhEl, snap.exceso_gwh_hoy, 3, ' GWh');
  else gwhEl.textContent = '—';

  const pctEl = document.getElementById('kpiPctVal');
  pctEl.className = 'kpi-val';
  if (snap.pct_horas_desperdiciadas != null) animateNumber(pctEl, snap.pct_horas_desperdiciadas, 1, '%');
  else pctEl.textContent = '—';
}

// Shared chart state for hover redraw
let _chartIntervals = [];
let _chartHoverIdx  = -1;

function drawChart(canvas, ctx, intervals, hoverIdx, dpr, W, H, pad) {
  const prices = intervals.map(i => i.precio_eur_mwh ?? 0);
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;
  const minP = Math.min(...prices, -5);
  const maxP = Math.max(...prices, 10);
  const range = maxP - minP || 1;

  const toX = i => pad.left + (i / (prices.length - 1 || 1)) * cW;
  const toY = v => pad.top + cH - ((v - minP) / range) * cH;

  ctx.clearRect(0, 0, W, H);

  // Background gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, 'rgba(0,168,120,0.03)');
  bgGrad.addColorStop(1, 'rgba(0,168,120,0)');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  const zY = toY(0);

  // Zero line
  ctx.save();
  ctx.setLineDash([3, 5]);
  ctx.strokeStyle = 'rgba(20,24,32,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad.left, zY); ctx.lineTo(pad.left + cW, zY); ctx.stroke();
  ctx.restore();

  // 1 EUR umbral
  const umbY = toY(1);
  ctx.save();
  ctx.setLineDash([2, 6]);
  ctx.strokeStyle = 'rgba(200,122,0,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad.left, umbY); ctx.lineTo(pad.left + cW, umbY); ctx.stroke();
  ctx.restore();

  // Fill under negative
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(toX(0), zY);
  for (let i = 0; i < prices.length; i++) ctx.lineTo(toX(i), toY(prices[i]));
  ctx.lineTo(toX(prices.length - 1), zY);
  ctx.closePath();
  ctx.fillStyle = 'rgba(216,3,0,0.07)';
  ctx.fill();
  ctx.restore();

  // Fill above
  ctx.save();
  const fillGrad = ctx.createLinearGradient(0, pad.top, 0, pad.top + cH);
  fillGrad.addColorStop(0, 'rgba(0,168,120,0.12)');
  fillGrad.addColorStop(1, 'rgba(0,168,120,0)');
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(0));
  for (let i = 0; i < prices.length; i++) {
    ctx.lineTo(toX(i), Math.min(toY(prices[i]), toY(0)));
  }
  ctx.lineTo(toX(prices.length - 1), toY(0));
  ctx.closePath();
  ctx.fillStyle = fillGrad;
  ctx.fill();
  ctx.restore();

  // Price line
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < prices.length; i++) {
    i === 0 ? ctx.moveTo(toX(0), toY(prices[0])) : ctx.lineTo(toX(i), toY(prices[i]));
  }
  ctx.strokeStyle = '#00a878';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();

  // Negative segments
  for (let i = 0; i < prices.length - 1; i++) {
    if (prices[i] < 0 || prices[i+1] < 0) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(toX(i), toY(prices[i]));
      ctx.lineTo(toX(i+1), toY(prices[i+1]));
      ctx.strokeStyle = '#d80300';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.restore();
    }
  }

  // Y axis ticks
  ctx.fillStyle = 'rgba(20,24,32,0.35)';
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.textAlign = 'right';
  const ticks = [...new Set([minP, 0, Math.round(maxP / 2), maxP].map(v => Math.round(v)))];
  for (const t of ticks) {
    ctx.fillText(t, pad.left - 5, toY(t) + 3.5);
    ctx.save();
    ctx.strokeStyle = 'rgba(20,24,32,0.06)';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(pad.left, toY(t));
    ctx.lineTo(pad.left + cW, toY(t));
    ctx.stroke();
    ctx.restore();
  }

  // Hover crosshair + dot
  if (hoverIdx >= 0 && hoverIdx < prices.length) {
    const hx = toX(hoverIdx);
    const hy = toY(prices[hoverIdx]);
    const isNeg = prices[hoverIdx] < 0;
    const isLow = prices[hoverIdx] <= 1;
    const dotColor = isNeg ? '#d80300' : (isLow ? 'rgba(200,122,0,0.9)' : '#00a878');

    // Vertical crosshair
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(20,24,32,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, pad.top);
    ctx.lineTo(hx, pad.top + cH);
    ctx.stroke();
    ctx.restore();

    // Horizontal hair to Y axis
    ctx.save();
    ctx.setLineDash([2, 5]);
    ctx.strokeStyle = 'rgba(20,24,32,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, hy);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.restore();

    // Dot on line
    ctx.save();
    ctx.beginPath();
    ctx.arc(hx, hy, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = dotColor;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // Inner dot
    ctx.save();
    ctx.beginPath();
    ctx.arc(hx, hy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();
    ctx.restore();
  }

  return { toX, toY, prices, minP, maxP };
}

function renderPriceChart(intervals) {
  // Interval bar track
  const grid = document.getElementById('intervalGrid');
  grid.innerHTML = '';
  for (const iv of intervals) {
    const bar = document.createElement('div');
    bar.className = 'iv-bar';
    const p = iv.precio_eur_mwh;
    if (p < 0) {
      bar.style.background = '#d80300';
      bar.style.height = '100%';
      bar.style.opacity = '0.8';
    } else if (p <= 1) {
      bar.style.background = 'rgba(200,122,0,0.7)';
      bar.style.height = '100%';
    } else {
      const maxP = 130;
      bar.style.background = 'var(--accent-green)';
      bar.style.height = Math.min((p / maxP) * 100, 100) + '%';
      bar.style.opacity = '0.5';
    }
    grid.appendChild(bar);
  }

  _chartIntervals = intervals;
  _chartHoverIdx  = -1;

  const canvas = document.getElementById('priceChart');
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(canvas.getBoundingClientRect().width || canvas.parentElement.clientWidth || 600, 200);
  const H = 200;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const pad = { top: 18, bottom: 22, left: 40, right: 14 };
  drawChart(canvas, ctx, intervals, -1, dpr, W, H, pad);

  // Build / reuse tooltip element
  let tip = document.getElementById('priceTooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'priceTooltip';
    tip.className = 'price-tooltip';
    tip.innerHTML = `
          <div class="price-tooltip__hora" id="tipHora"></div>
          <div class="price-tooltip__precio" id="tipPrecio"></div>
          <div class="price-tooltip__tag" id="tipTag"></div>`;
    canvas.parentElement.appendChild(tip);
  }

  // Remove old listeners by replacing canvas clone trick — simpler: use named fn stored on canvas
  if (canvas._mmHandler) canvas.removeEventListener('mousemove', canvas._mmHandler);
  if (canvas._mlHandler) canvas.removeEventListener('mouseleave', canvas._mlHandler);

  canvas._mmHandler = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const cW = W - pad.left - pad.right;
    if (mx < pad.left || mx > pad.left + cW) {
      if (_chartHoverIdx !== -1) {
        _chartHoverIdx = -1;
        ctx.clearRect(0, 0, W, H); ctx.save(); ctx.scale(dpr, dpr);
        drawChart(canvas, ctx, intervals, -1, dpr, W, H, pad);
        ctx.restore();
        tip.style.opacity = '0';
      }
      return;
    }
    const idx = Math.round(((mx - pad.left) / cW) * (intervals.length - 1));
    const clampedIdx = Math.max(0, Math.min(idx, intervals.length - 1));

    if (clampedIdx !== _chartHoverIdx) {
      _chartHoverIdx = clampedIdx;
      // Redraw
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawChart(canvas, ctx, intervals, clampedIdx, dpr, W, H, pad);
    }

    // Update tooltip content
    const iv = intervals[clampedIdx];
    const precio = iv.precio_eur_mwh;
    const isNeg = precio < 0;
    const isLow = precio <= 1;
    const hora = fmtTime(iv.datetime);
    document.getElementById('tipHora').textContent = fmtDate(iv.datetime) + ' · ' + hora;
    const tipPrecioEl = document.getElementById('tipPrecio');
    tipPrecioEl.textContent = fmtEs(precio, 2) + ' EUR/MWh';
    tipPrecioEl.className = 'price-tooltip__precio' + (isNeg ? ' neg' : isLow ? ' low' : '');
    document.getElementById('tipTag').textContent =
      isNeg ? 'Precio negativo · desperdicio activo' :
      isLow ? 'Umbral · exceso renovable' :
      'Precio de mercado';
    tip.className = 'price-tooltip' + (isNeg ? ' warn' : isLow ? ' caution' : '');

    // Position tooltip: flip side if near right edge
    const prices = intervals.map(i => i.precio_eur_mwh ?? 0);
    const minP = Math.min(...prices, -5);
    const maxP = Math.max(...prices, 10);
    const range = maxP - minP || 1;
    const cH = H - pad.top - pad.bottom;
    const toX = i => pad.left + (i / (prices.length - 1 || 1)) * cW;
    const toY = v => pad.top + cH - ((v - minP) / range) * cH;
    const hx = toX(clampedIdx);
    const hy = toY(precio);
    const OFFSET = 14;
    const tipW = 180;
    const left = hx + OFFSET + tipW > W ? hx - OFFSET - tipW : hx + OFFSET;
    const top  = Math.max(pad.top, Math.min(hy - 36, H - 90));
    tip.style.left = left + 'px';
    tip.style.top  = top + 'px';
    tip.style.opacity = '1';
  };

  canvas._mlHandler = () => {
    tip.style.opacity = '0';
    if (_chartHoverIdx !== -1) {
      _chartHoverIdx = -1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawChart(canvas, ctx, intervals, -1, dpr, W, H, pad);
    }
  };

  canvas.addEventListener('mousemove', canvas._mmHandler);
  canvas.addEventListener('mouseleave', canvas._mlHandler);
}

function renderWeekStrip(history) {
  const wrap = document.getElementById('weekStrip');
  if (!history.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';

  const maxGwh = Math.max(...history.map(d => d.exceso_gwh || 0), 0.001);
  const container = document.getElementById('weekBars');
  container.innerHTML = '';
  const todayStr = new Date().toISOString().split('T')[0];

  for (const d of history) {
    const col = document.createElement('div');
    col.className = 'week-col';
    const hPct = Math.max((d.exceso_gwh / maxGwh) * 100, d.exceso_gwh > 0 ? 4 : 0);
    const bar = document.createElement('div');
    bar.className = 'week-bar' +
      (d.date === todayStr ? ' today' : '') +
      (d.intervalos_negativos > 0 ? ' neg' : '');
    bar.style.height = hPct + '%';
    bar.title = `${d.date}: ${fmtEs(d.exceso_gwh||0, 3)} GWh`;

    const lbl = document.createElement('div');
    lbl.className = 'week-label';
    const dt = new Date(d.date + 'T12:00:00');
    lbl.textContent = dt.toLocaleDateString('es-ES', { weekday: 'short' }).slice(0, 3);

    col.appendChild(bar); col.appendChild(lbl);
    container.appendChild(col);
  }
}

async function loadLive() {
  document.getElementById('liveLoading').style.display = 'flex';
  document.getElementById('chartWrap').style.display   = 'none';
  document.getElementById('weekStrip').style.display   = 'none';

  try {
    const { ok, data } = await fetchJson('/api/snfi-u2/live', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!ok) { showError(data?.error || 'Error consultando REE'); return; }

    liveData = data;

    if (data.snapshot) {
      liveRetryCount = 0;
      renderStatusPill(data.snapshot, data.last_updated);
      renderLiveKpis(data.snapshot);

      if (data.snapshot.intervals?.length) {
        document.getElementById('chartWrap').style.display = '';
        document.getElementById('chartUpdatedAt').textContent =
          'actualizado ' + fmtDateTime(data.last_updated);
        requestAnimationFrame(() => renderPriceChart(data.snapshot.intervals));
      }
    } else {
      liveRetryCount++;
      if (liveRetryCount <= LIVE_MAX_RETRIES) {
        document.getElementById('statusDot').className  = 'status-dot idle';
        document.getElementById('statusText').textContent =
          `Primer ciclo en curso · reintento ${liveRetryCount}/${LIVE_MAX_RETRIES}...`;
        setTimeout(loadLive, 15000);
      } else {
        showError('No se pudo obtener datos de REE tras varios intentos. La API puede estar caida o sin datos para hoy. Refresca la pagina para reintentar.');
        document.getElementById('statusDot').className  = 'status-dot warn';
        document.getElementById('statusText').textContent = 'Error de conexion con REE';
      }
      return;
    }

    if (data.history_days?.length > 1) renderWeekStrip(data.history_days);

  } catch (e) {
    showError('Error de red: ' + e.message);
  } finally {
    document.getElementById('liveLoading').style.display = 'none';
  }
}

function startLiveRefresh() {
  stopLiveRefresh();
  liveRefreshTimer = setInterval(() => {
    if (currentMode === 'live') loadLive();
  }, 69 * 1000);
}
function stopLiveRefresh() {
  if (liveRefreshTimer) { clearInterval(liveRefreshTimer); liveRefreshTimer = null; }
}

/* ═══════════════════════════════════════════
   HISTORICO PANEL
═══════════════════════════════════════════ */
let historicData  = null;
let activeYear    = null;
const MONTHS_ES   = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

function renderHistoricKpis(data) {
  const anos  = data.anos || [];
  const valid = anos.filter(a => a.exceso_gwh != null);

  const totEl = document.getElementById('kpiTotalVal');
  totEl.className = 'kpi-val';
  if (data.total_gwh_acumulados) animateNumber(totEl, data.total_gwh_acumulados, 0, ' GWh');
  else totEl.textContent = '—';

  const hEl = document.getElementById('kpiHorasVal');
  hEl.className = 'kpi-val';
  if (data.total_horas_acumuladas) animateNumber(hEl, data.total_horas_acumuladas, 0, ' h');
  else hEl.textContent = '—';

  let peak = null;
  for (const a of valid) if (!peak || a.exceso_gwh > peak.exceso_gwh) peak = a;
  const peakEl = document.getElementById('kpiPeakVal');
  peakEl.className = 'kpi-val';
  peakEl.textContent = peak ? peak.year : '—';

  const complete = valid.filter(a => a.completo);
  const trendEl = document.getElementById('kpiTrendVal');
  trendEl.className = 'kpi-val';
  if (complete.length >= 2) {
    const last = complete[complete.length - 1];
    const prev = complete[complete.length - 2];
    const pct = prev.exceso_gwh > 0
      ? Math.round((last.exceso_gwh - prev.exceso_gwh) / prev.exceso_gwh * 100) : 0;
    trendEl.textContent = (pct >= 0 ? '+' : '') + pct + '%';
    trendEl.style.color = pct >= 0 ? '#d80300' : 'var(--accent-green2)';
  } else {
    trendEl.textContent = 'N/D';
  }
}

function renderYearCards(data) {
  const anos   = data.anos || [];
  const maxGwh = data.max_gwh_ano || 1;
  const grid   = document.getElementById('hstCards');
  grid.innerHTML = '';

  for (const a of anos) {
    const hasData = a.exceso_gwh != null;
    const card = document.createElement('div');
    card.className = 'hst-card' + (activeYear === a.year ? ' active' : '');
    card.dataset.year = a.year;

    const yearDiv = document.createElement('div');
    yearDiv.className = 'hst-card__year';
    yearDiv.textContent = a.year;

    const gwhDiv = document.createElement('div');
    gwhDiv.className = 'hst-card__gwh';
    gwhDiv.textContent = hasData
      ? a.exceso_gwh.toLocaleString('es-ES', { maximumFractionDigits: 1 }) + ' GWh'
      : (a.error ? 'Error' : '—');

    const lblDiv = document.createElement('div');
    lblDiv.className = 'hst-card__label';
    lblDiv.textContent = 'desperdiciados';

    const barWrap = document.createElement('div');
    barWrap.className = 'hst-card__bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'hst-card__bar';
    bar.style.width = hasData ? Math.max((a.exceso_gwh / maxGwh) * 100, 2).toFixed(1) + '%' : '0%';
    barWrap.appendChild(bar);

    card.appendChild(yearDiv);
    card.appendChild(gwhDiv);
    card.appendChild(lblDiv);
    card.appendChild(barWrap);

    if (!a.completo && hasData) {
      const tag = document.createElement('div');
      tag.className = 'hst-card__tag partial';
      tag.textContent = 'en curso';
      card.appendChild(tag);
    } else if (a.completo) {
      const tag = document.createElement('div');
      tag.className = 'hst-card__tag';
      tag.textContent = 'completo';
      card.appendChild(tag);
    }

    if (hasData) {
      card.addEventListener('click', () => {
        activeYear = a.year;
        document.querySelectorAll('.hst-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        renderDrill(a);
      });
    } else {
      card.style.opacity = '0.45';
      card.style.cursor = 'default';
    }

    grid.appendChild(card);
  }

  grid.style.display = 'grid';
}

function renderDrill(ano) {
  const drill = document.getElementById('hstDrill');
  drill.style.display = 'block';

  document.getElementById('hstDrillYear').textContent = ano.year;

  const gwhEl = document.getElementById('hstDrillGwh');
  gwhEl.textContent = '—';
  if (ano.exceso_gwh != null) animateNumber(gwhEl, ano.exceso_gwh, 1, ' GWh');

  const hEl = document.getElementById('hstDrillHoras');
  hEl.textContent = '—';
  if (ano.horas_precio_cero != null) animateNumber(hEl, ano.horas_precio_cero, 0, ' h');

  document.getElementById('hstDrillPeriodo').textContent =
    ano.periodo ? ano.periodo.start + ' a ' + ano.periodo.end : '—';
  document.getElementById('hstDrillEstado').textContent =
    ano.completo ? 'Completo' : 'En curso';

  const barsWrap = document.getElementById('hstMonthBars');
  barsWrap.innerHTML = '';

  const mensual = ano.mensual || [];
  const maxM = Math.max(...mensual.map(m => m.exceso_gwh || 0), 1);

  for (let m = 1; m <= 12; m++) {
    const key   = `${ano.year}-${String(m).padStart(2,'0')}`;
    const found = mensual.find(x => x.mes === key);
    const val   = found ? (found.exceso_gwh || 0) : 0;
    const hPct  = maxM > 0 ? Math.max((val / maxM) * 100, val > 0 ? 4 : 0) : 0;

    const col = document.createElement('div');
    col.className = 'hst-drill__m-col';

    const valLbl = document.createElement('div');
    valLbl.className = 'hst-drill__m-val';
    valLbl.textContent = val > 0 ? fmtEs(val, 1) : '';

    const barWrap = document.createElement('div');
    barWrap.className = 'hst-drill__m-bar-wrap';

    const bar = document.createElement('div');
    bar.className = 'hst-drill__m-bar' + (val === 0 ? ' zero' : '');
    bar.style.height = Math.max(hPct, val > 0 ? 4 : 8) + '%';
    bar.title = `${MONTHS_ES[m-1]} ${ano.year}: ${fmtEs(val, 2)} GWh`;
    barWrap.appendChild(bar);

    const lbl = document.createElement('div');
    lbl.className = 'hst-drill__m-lbl';
    lbl.textContent = MONTHS_ES[m-1];

    col.appendChild(valLbl);
    col.appendChild(barWrap);
    col.appendChild(lbl);
    barsWrap.appendChild(col);
  }

  // scroll drill into view
  drill.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function loadHistoric() {
  historicLoaded = true;
  document.getElementById('loadingBox').style.display   = 'flex';
  document.getElementById('errorBox').style.display     = 'none';
  document.getElementById('hstCards').style.display     = 'none';
  document.getElementById('hstDrill').style.display     = 'none';

  try {
    const { ok, data } = await fetchJson(`/api/snfi-u2/historic?from=2020&to=${today.getFullYear()}`, {
      headers: { Authorization: `Bearer ${token}` }
    }, { timeoutMs: 60000 });
    if (!ok) {
      historicLoaded = false;
      showError(data?.error || 'Error consultando REE');
      return;
    }

    historicData = data;
    renderHistoricKpis(data);
    renderYearCards(data);

    // Auto-select most recent year with data
    const valid = (data.anos || []).filter(a => a.exceso_gwh != null && a.exceso_gwh > 0);
    if (valid.length) {
      const last = valid[valid.length - 1];
      activeYear = last.year;
      document.querySelectorAll('.hst-card').forEach(c => {
        if (parseInt(c.dataset.year) === activeYear) c.classList.add('active');
      });
      renderDrill(last);
    }
  } catch (e) {
    historicLoaded = false;
    showError('Error de red: ' + e.message);
  } finally {
    document.getElementById('loadingBox').style.display = 'none';
  }
}

/* ═══════════════════════════════════════════
   RENEWABLES PANEL
═══════════════════════════════════════════ */
function fmtMw(v) {
  if (v == null) return '—';
  if (v >= 1000) return fmtEs(v / 1000, 1) + ' GW';
  return Math.round(v) + ' MW';
}

function drawMixBar(container, label, value, total, color) {
  const pct = total > 0 && value != null ? Math.min(100, (value / total) * 100) : 0;
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:12px;';
  row.innerHTML = `
        <span style="width:100px;font-size:.65rem;letter-spacing:.02em;color:var(--text-muted);flex-shrink:0;">${label}</span>
        <div style="flex:1;height:6px;background:var(--border);position:relative;border-radius:1px;">
          <div style="position:absolute;inset:0;width:${pct.toFixed(1)}%;background:${color};transition:width .6s ease;border-radius:1px;"></div>
        </div>
        <span style="width:72px;text-align:right;font-size:.75rem;font-family:'IBM Plex Mono',monospace;color:var(--text-primary);">${fmtMw(value)}</span>
        <span style="width:40px;text-align:right;font-size:.65rem;color:var(--text-muted);">${fmtEs(pct, 1)}%</span>
      `;
  container.appendChild(row);
}

function renderRenewablesSnapshot(data) {
  const s = data.snapshot || {};
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('loading');
    el.textContent = v;
  };

  set('rvEolica',  fmtMw(s.eolica_mw));
  set('rvSolar',   fmtMw(s.solar_mw));
  set('rvHidro',   fmtMw(s.hidro_mw));
  set('rvNuclear', fmtMw(s.nuclear_mw));
  set('rvDemanda', fmtMw(s.demanda_mw));
  set('rvPctRenov', s.pct_renovable != null ? fmtEs(s.pct_renovable, 1) + ' %' : '—');
  set('rvPctCo2',   s.pct_libre_co2 != null ? fmtEs(s.pct_libre_co2, 1) + ' %' : '—');

  // Status bar
  const dot  = document.getElementById('renewDot');
  const txt  = document.getElementById('renewStatusText');
  const time = document.getElementById('renewTime');
  if (dot)  { dot.className = 'status-dot live'; }
  if (txt)  txt.textContent = `Mix renovable: ${s.pct_renovable != null ? fmtEs(s.pct_renovable, 1) + '%' : '—'} · Libre CO2: ${s.pct_libre_co2 != null ? fmtEs(s.pct_libre_co2, 1) + '%' : '—'}`;
  if (time) time.textContent = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString('es-ES') : '';

  // Mix bars
  const container = document.getElementById('mixBars');
  if (container) {
    container.innerHTML = '';
    const total = s.total_generacion_mw || 1;
    drawMixBar(container, 'Eolica',     s.eolica_mw,     total, 'var(--accent-green)');
    drawMixBar(container, 'Solar FV',   s.solar_mw,      total, '#f5c518');
    drawMixBar(container, 'Hidraul.',   s.hidro_mw,      total, '#3ab4f2');
    drawMixBar(container, 'Nuclear',    s.nuclear_mw,    total, '#9b5de5');
    drawMixBar(container, 'C.Comb.',    s.ciclo_comb_mw, total, '#ff6b6b');
  }

  // Sparkline chart
  renderRenewablesChart(data);
}

function renderRenewablesChart(data) {
  const canvas = document.getElementById('rvChart');
  if (!canvas) return;
  const series = data.series || {};
  const prevSeries = series.demanda_prevista   || [];
  const progSeries = series.demanda_programada || [];
  const realSeries = series.demanda_real       || [];

  const refSeries = realSeries.length ? realSeries : prevSeries;
  const labels = refSeries.map(v => new Date(v.datetime).getHours() + 'h');

  const dateEl = document.getElementById('rvChartDate');
  if (dateEl) dateEl.textContent = data.date || '—';

  const allVals = [...prevSeries, ...progSeries, ...realSeries].map(v => v.value || 0);
  if (!allVals.length) return;
  const minV = Math.min(...allVals) * 0.97;
  const maxV = Math.max(...allVals, 1) * 1.02;
  const range = maxV - minV || 1;

  const W = canvas.offsetWidth || 800;
  const H = 180;
  canvas.width  = W;
  canvas.height = H;
  const pad = { top: 10, right: 10, bottom: 24, left: 58 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const toX = (i, n) => pad.left + (i / (n - 1 || 1)) * cW;
  const toY = v => pad.top + cH - ((v - minV) / range) * cH;

  // Grid lines
  ctx.strokeStyle = 'rgba(20,24,32,.07)';
  ctx.lineWidth = 1;
  [0, 0.25, 0.5, 0.75, 1].forEach(f => {
    const y = pad.top + cH * (1 - f);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cW, y); ctx.stroke();
    ctx.fillStyle = 'rgba(20,24,32,.3)';
    ctx.font = '9px IBM Plex Mono';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round((minV + range * f) / 1000) + ' GW', pad.left - 4, y + 3);
  });

  // Hour labels
  ctx.fillStyle = 'rgba(20,24,32,.3)';
  ctx.font = '9px IBM Plex Mono';
  ctx.textAlign = 'center';
  const step = Math.ceil(labels.length / 8);
  labels.forEach((l, i) => {
    if (i % step === 0) {
      ctx.fillText(l, toX(i, labels.length), H - 6);
    }
  });

  const drawLine = (arr, color, dash = []) => {
    if (!arr.length) return;
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash(dash);
    arr.forEach((p, i) => {
      const x = toX(i, arr.length);
      const y = toY(p.value || 0);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  };

  drawLine(prevSeries, 'rgba(200,122,0,.65)', [4, 3]);
  drawLine(progSeries, 'rgba(58,130,242,.75)');
  drawLine(realSeries, 'rgba(0,168,120,.95)');

  // Legend
  const legend = document.getElementById('rvLegend');
  if (legend) {
    legend.innerHTML = [
      ['Prevista',    'rgba(200,122,0,.65)'],
      ['Programada',  'rgba(58,130,242,.75)'],
      ['Real',        'rgba(0,168,120,.95)'],
    ].map(([l, c]) => `<span style="display:flex;align-items:center;gap:5px;font-size:.65rem;color:var(--text-muted);">
          <span style="width:20px;height:2px;background:${c};display:inline-block;"></span>${l}</span>`).join('');
  }
}

/* ═══════════════════════════════════════════
   CURTAILMENT ESTIMADO (no oficial)
   La pestana oficial (/curtailment, indicadores ERNI) devuelve 503 con
   token personal. Esta consume /curtailment-estimado, que construye la
   cifra con precio SPOT + generacion renovable, ambos accesibles.
═══════════════════════════════════════════ */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const nfmt = (n, d = 0) => (n == null || Number.isNaN(Number(n)))
  ? '—'
  : Number(n).toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });

async function loadCurtailment() {
  curtailmentLoaded = true;
  const qs = new URLSearchParams();
  const from = document.getElementById('curtFrom').value;
  const to   = document.getElementById('curtTo').value;
  const umbral = document.getElementById('curtUmbralInput').value.trim();
  const tasa   = document.getElementById('curtTasaInput').value.trim();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  if (umbral !== '') qs.set('umbral', umbral);
  if (tasa !== '') qs.set('tasa', tasa);

  const nBody = document.getElementById('curtNeighbourBody');
  const mBody = document.getElementById('curtMonthlyBody');
  nBody.innerHTML = '<tr class="empty-row"><td colspan="6">Cargando…</td></tr>';
  mBody.innerHTML = '<tr class="empty-row"><td colspan="4">Cargando…</td></tr>';

  try {
    const { ok, data } = await fetchJson(`/api/snfi-u2/curtailment-estimado?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!ok) {
      const msg = esc(data?.error || 'no disponible');
      nBody.innerHTML = `<tr class="empty-row"><td colspan="6">${msg}</td></tr>`;
      mBody.innerHTML = `<tr class="empty-row"><td colspan="4">${msg}</td></tr>`;
      return;
    }

    const es = data.espana || {};
    document.getElementById('curtEsGwh').textContent = `${nfmt(es.curtailment_estimado_gwh, 1)} GWh`;
    document.getElementById('curtEsPct').textContent = es.pct_sobre_renovable != null
      ? `${nfmt(es.pct_sobre_renovable, 2)} % de la renovable generada` : '';
    document.getElementById('curtHoras').textContent = nfmt(es.horas_precio_hundido);
    document.getElementById('curtUmbral').textContent =
      `precio SPOT ≤ ${nfmt(data.parametros?.umbral_eur_mwh, 0)} €/MWh`;
    document.getElementById('curtRenov').textContent = nfmt(es.renovable_total_gwh, 0);

    const media = data.media_vecinos || {};
    document.getElementById('curtMedia').textContent = media.pct_ponderado_por_generacion != null
      ? `${nfmt(media.pct_ponderado_por_generacion, 2)} %` : '—';
    document.getElementById('curtMediaSub').textContent = media.pct_aritmetico != null
      ? `aritmética ${nfmt(media.pct_aritmetico, 2)} % · ${media.paises_con_dato} países` : '';
    document.getElementById('curtMediaNota').textContent = media.nota || '';

    const vecinos = data.comparativa_vecinos || [];
    nBody.innerHTML = vecinos.length ? vecinos.map((v) => `
          <tr${v.esEstimacionPropia ? ' style="background:rgba(47,224,160,0.06);"' : ''}>
            <td><strong>${esc(v.label)}</strong>${v.esEstimacionPropia ? ' <span style="color:#2fe0a0;font-size:0.7rem;">en vivo</span>' : ''}</td>
            <td class="mono">${esc(v.tso)}</td>
            <td>${esc(v.frontera)}</td>
            <td class="mono num">${v.pctCurtailmentRenovable != null ? nfmt(v.pctCurtailmentRenovable, 2) + ' %' : '—'}</td>
            <td class="mono num">${v.genRenovableTwhYear != null ? nfmt(v.genRenovableTwhYear, 1) : '—'}</td>
            <td style="font-size:0.7rem;color:#86868b;">${esc(v.source)}</td>
          </tr>`).join('') : '<tr class="empty-row"><td colspan="6">Sin datos</td></tr>';

    const mensual = es.mensual || [];
    mBody.innerHTML = mensual.length ? mensual.map((m) => `
          <tr${m.completo === false ? ' style="opacity:0.55;"' : ''}>
            <td class="mono">${esc(m.mes)}${m.completo === false
          ? ` <span style="color:#e2a63a;font-size:0.68rem;" title="La API no devolvio el mes entero">incompleto ${m.dias_con_dato}/${m.dias_del_mes} d</span>`
          : ''}</td>
            <td class="mono num">${nfmt(m.renovable_gwh, 1)}</td>
            <td class="mono num">${nfmt(m.horas_precio_hundido)}</td>
            <td class="mono num">${nfmt(m.curtailment_estimado_gwh, 2)}</td>
          </tr>`).join('') : '<tr class="empty-row"><td colspan="4">Sin datos</td></tr>';

    document.getElementById('curtMetodologia').innerHTML =
      `<strong>Metodología:</strong> ${esc(data.metodologia || '')}<br>` +
      `<strong>Fuente:</strong> ${esc(data.fuente || '')}<br>` +
      `<strong>Aviso:</strong> ${esc(data.aviso || '')}`;
  } catch (e) {
    console.error('[curtailment-estimado]', e.message);
    const msg = esc(e.message || 'error de red');
    nBody.innerHTML = `<tr class="empty-row"><td colspan="6">${msg}</td></tr>`;
    mBody.innerHTML = `<tr class="empty-row"><td colspan="4">${msg}</td></tr>`;
  }
}

// Rango por defecto: ultimo ano movil
(() => {
  const hoy = new Date();
  const haceAnio = new Date(hoy.getTime() - 365 * 24 * 3600 * 1000);
  const iso = (d) => d.toISOString().split('T')[0];
  const f = document.getElementById('curtFrom');
  const t = document.getElementById('curtTo');
  if (f && !f.value) f.value = iso(haceAnio);
  if (t && !t.value) t.value = iso(hoy);
  const btn = document.getElementById('curtRecalcBtn');
  if (btn) btn.addEventListener('click', () => loadCurtailment());
})();

async function loadRenewables() {
  renewablesLoaded = true;
  try {
    const { ok, data } = await fetchJson('/api/snfi-u2/renewables', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!ok) { console.warn('[renewables]', data?.error); return; }
    renderRenewablesSnapshot(data);
  } catch (e) {
    console.error('[renewables]', e.message);
    const dot = document.getElementById('renewDot');
    const txt = document.getElementById('renewStatusText');
    if (dot) dot.className = 'status-dot';
    if (txt) txt.textContent = 'Error cargando mix renovable';
  }
}

async function loadRenewablesHistoric() {
  renewHistLoaded = true;
  const yearNow = new Date().getFullYear();
  document.getElementById('rvHistYear').textContent = yearNow;
  try {
    const { ok, data } = await fetchJson(`/api/snfi-u2/renewables-historic?from=2022&to=${yearNow}`, {
      headers: { Authorization: `Bearer ${token}` }
    }, { timeoutMs: 60000 });
    if (!ok) { console.warn('[renewables-historic]', data?.error); return; }

    document.getElementById('rvHistLoading').style.display = 'none';
    document.getElementById('rvHistWrap').style.display    = '';

    const tbody = document.getElementById('rvHistBody');
    tbody.innerHTML = '';
    (data.anos || []).forEach(y => {
      const tr = document.createElement('tr');
      tr.style.cssText = 'border-bottom:1px solid var(--border);';
      const fmt    = (v) => v != null ? Math.round(v).toLocaleString('es-ES') : '—';
      const fmtPct = (v) => v != null ? fmtEs(v, 1) + ' %' : '—';
      const fmtEur = (v) => v != null ? fmtEs(v, 2) : '—';
      const incomplete = !y.completo ? '<span style="color:var(--text-muted);font-size:.6rem;"> (en curso)</span>' : '';
      tr.innerHTML = `
            <td style="padding:7px 8px;font-weight:600;">${y.year}${incomplete}</td>
            <td style="text-align:right;padding:7px 8px;color:rgba(0,210,120,.9);">${fmt(y.eolica_avg_mwh)}</td>
            <td style="text-align:right;padding:7px 8px;color:rgba(245,197,24,.9);">${fmt(y.solar_fv_avg_mwh)}</td>
            <td style="text-align:right;padding:7px 8px;color:rgba(255,180,0,.8);">${fmt(y.solar_t_avg_mwh)}</td>
            <td style="text-align:right;padding:7px 8px;color:rgba(58,180,242,.9);">${fmt(y.hidro_avg_mwh)}</td>
            <td style="text-align:right;padding:7px 8px;font-weight:600;color:var(--accent-green);">${fmtPct(y.pct_renovable_medio)}</td>
            <td style="text-align:right;padding:7px 8px;color:rgba(155,93,229,.9);">${fmtPct(y.pct_libre_co2_medio)}</td>
            <td style="text-align:right;padding:7px 8px;">${fmtEur(y.precio_spot_medio_eur_mwh)}</td>
            <td style="text-align:right;padding:7px 8px;color:var(--accent-green2);">${fmtEur(y.pvpc_medio_eur_mwh)}</td>
            <td style="text-align:right;padding:7px 8px;color:#d80300;">${fmt(y.dias_precio_cero)}</td>
          `;
      tbody.appendChild(tr);
    });

    // Historico chart
    renderRenewablesHistChart(data.anos || []);
  } catch (e) {
    document.getElementById('rvHistLoading').style.display = 'none';
    console.error('[renewables-historic]', e.message);
  }
}

function renderRenewablesHistChart(anos) {
  const canvas = document.getElementById('rvHistChart');
  if (!canvas || !anos.length) return;
  const labels = anos.map(a => String(a.year));
  const eolica  = anos.map(a => a.eolica_avg_mwh   || 0);
  const solar   = anos.map(a => (a.solar_fv_avg_mwh || 0) + (a.solar_t_avg_mwh || 0));
  const hidro   = anos.map(a => a.hidro_avg_mwh     || 0);
  const demanda = anos.map(a => a.total_gen_avg_mwh  || 0);

  const W = canvas.offsetWidth || 600;
  const H = 160;
  canvas.width  = W;
  canvas.height = H;
  const pad = { top: 10, right: 10, bottom: 28, left: 55 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const maxV = Math.max(...demanda, 1);
  const n = labels.length;

  const drawBar = (idx, value, color, barW, offsetX) => {
    const x = pad.left + (idx / n) * cW + offsetX;
    const barH = (value / maxV) * cH;
    ctx.fillStyle = color;
    ctx.fillRect(x, pad.top + cH - barH, barW, barH);
  };

  const barW = Math.max(4, (cW / n) * 0.22);

  // Grid
  ctx.strokeStyle = 'rgba(20,24,32,.07)';
  ctx.lineWidth = 1;
  [0.25, 0.5, 0.75, 1].forEach(f => {
    const y = pad.top + cH * (1 - f);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cW, y); ctx.stroke();
    ctx.fillStyle = 'rgba(20,24,32,.35)';
    ctx.font = '9px IBM Plex Mono';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxV * f / 1000) + ' GW', pad.left - 4, y + 3);
  });

  labels.forEach((l, i) => {
    const colW = cW / n;
    drawBar(i, eolica[i],  'rgba(0,210,120,.85)',  barW, colW * 0.05);
    drawBar(i, solar[i],   'rgba(245,197,24,.85)', barW, colW * 0.28);
    drawBar(i, hidro[i],   'rgba(58,180,242,.85)', barW, colW * 0.51);

    // Gen total line point
    const x = pad.left + (i / (n - 1 || 1)) * cW;
    const y = pad.top + cH - (demanda[i] / maxV) * cH;
    ctx.fillStyle = 'rgba(20,24,32,.4)';
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = 'rgba(20,24,32,.4)';
    ctx.font = '10px IBM Plex Mono';
    ctx.textAlign = 'center';
    ctx.fillText(l, pad.left + (i / n) * cW + colW * 0.15, H - 8);
  });

  // Gen total line
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(20,24,32,.2)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  anos.forEach((a, i) => {
    const x = pad.left + (i / (n - 1 || 1)) * cW;
    const y = pad.top + cH - ((a.total_gen_avg_mwh || 0) / maxV) * cH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);
}

/* ═══════════════════════════════════════════
   GENERACION PANEL
═══════════════════════════════════════════ */
const GEN_COLORS = {
  eolica:    'rgba(0,210,120,.9)',
  solar_fv:  'rgba(245,197,24,.9)',
  solar_t:   'rgba(255,180,0,.7)',
  hidro:     'rgba(58,180,242,.9)',
  nuclear:   'rgba(155,93,229,.9)',
  ciclo:     'rgba(255,107,107,.8)',
  carbon:    'rgba(120,120,120,.6)',
  cogener:   'rgba(180,100,50,.7)',
  otras:     'rgba(100,200,150,.6)',
};

function fmtMwh(v) {
  if (v == null) return '—';
  if (Math.abs(v) >= 1000000) return fmtEs(v / 1000000, 2) + ' TWh';
  if (Math.abs(v) >= 1000) return fmtEs(v / 1000, 1) + ' GWh';
  return Math.round(v) + ' MWh';
}

function fmtMwhSplit(v) {
  if (v == null) return { num: '—', unit: 'MWh' };
  if (Math.abs(v) >= 1000000) return { num: fmtEs(v / 1000000, 2), unit: 'TWh' };
  if (Math.abs(v) >= 1000) return { num: fmtEs(v / 1000, 1), unit: 'GWh' };
  return { num: String(Math.round(v)), unit: 'MWh' };
}

function drawGenMixBar(container, label, value, total, color) {
  const pct = total > 0 && value != null ? Math.min(100, Math.max(0, (value / total) * 100)) : 0;
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:12px;';
  row.innerHTML = `
        <span style="width:110px;font-size:.63rem;letter-spacing:.02em;color:var(--text-muted);flex-shrink:0;">${label}</span>
        <div style="flex:1;height:6px;background:var(--border);position:relative;border-radius:1px;">
          <div style="position:absolute;inset:0;width:${pct.toFixed(1)}%;background:${color};transition:width .7s cubic-bezier(.34,1.56,.64,1);border-radius:1px;"></div>
        </div>
        <span style="width:82px;text-align:right;font-size:.74rem;font-family:'IBM Plex Mono',monospace;color:var(--text-primary);">${fmtMwh(value)}</span>
        <span style="width:44px;text-align:right;font-size:.63rem;color:var(--text-muted);">${value < 0 ? '<span style="color:#d80300">' : ''}${fmtEs(pct, 1)}%${value < 0 ? '</span>' : ''}</span>
      `;
  container.appendChild(row);
}

function drawDemandaChart(prevSeries, progSeries, realSeries) {
  const canvas = document.getElementById('genDemChart');
  if (!canvas) return;
  const all = [...prevSeries, ...progSeries, ...realSeries];
  if (!all.length) return;

  const W = canvas.offsetWidth || 800;
  const H = 180;
  canvas.width  = W;
  canvas.height = H;
  const pad = { top: 10, right: 10, bottom: 24, left: 58 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const vals = all.map(v => v.value || 0);
  const minV = Math.min(...vals) * 0.97;
  const maxV = Math.max(...vals, 1) * 1.02;
  const range = maxV - minV || 1;

  const toX = (i, n) => pad.left + (i / (n - 1 || 1)) * cW;
  const toY = v => pad.top + cH - ((v - minV) / range) * cH;

  // Grid
  ctx.strokeStyle = 'rgba(20,24,32,.07)';
  ctx.lineWidth = 1;
  [0, 0.25, 0.5, 0.75, 1].forEach(f => {
    const y = pad.top + cH * (1 - f);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cW, y); ctx.stroke();
    ctx.fillStyle = 'rgba(20,24,32,.3)';
    ctx.font = '9px IBM Plex Mono';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round((minV + range * f) / 1000) + ' GW', pad.left - 4, y + 3);
  });

  const drawLine = (series, color, dash = []) => {
    if (!series.length) return;
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.setLineDash(dash);
    series.forEach((p, i) => {
      const x = toX(i, series.length);
      const y = toY(p.value || 0);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  };

  drawLine(prevSeries, 'rgba(200,122,0,.65)', [4, 3]);
  drawLine(progSeries, 'rgba(58,130,242,.75)', []);
  drawLine(realSeries, 'rgba(0,168,120,.95)',  []);

  // Hour labels
  const n = Math.max(prevSeries.length, progSeries.length, realSeries.length);
  const src = prevSeries.length ? prevSeries : (realSeries.length ? realSeries : progSeries);
  ctx.fillStyle = 'rgba(20,24,32,.3)';
  ctx.font = '9px IBM Plex Mono';
  ctx.textAlign = 'center';
  const step = Math.ceil(src.length / 8);
  src.forEach((p, i) => {
    if (i % step === 0) {
      const x = toX(i, src.length);
      const h = new Date(p.datetime).getHours();
      ctx.fillText(h + 'h', x, H - 6);
    }
  });
}

async function loadGeneracion() {
  generacionLoaded = true;
  try {
    const { ok, data } = await fetchJson('/api/snfi-u2/generacion', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!ok) { console.warn('[generacion]', data?.error); return; }

    const s = data.snapshot || {};
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('loading');
      el.textContent = v;
    };
    const setSplit = (id, v) => {
      const { num, unit } = fmtMwhSplit(v);
      set(id, num);
      const unitEl = document.getElementById(id + 'Unit');
      if (unitEl) unitEl.textContent = unit;
    };

    setSplit('genEolica',   s.eolica_mwh);
    setSplit('genSolarFv',  s.solar_fv_mwh);
    setSplit('genSolarT',   s.solar_term_mwh);
    setSplit('genHidro',    s.hidro_mwh);
    setSplit('genNuclear',  s.nuclear_mwh);
    setSplit('genCiclo',    s.ciclo_comb_mwh);
    set('genPctRenov', s.pct_renovable != null ? fmtEs(s.pct_renovable, 1) + ' %' : '—');
    set('genPctCo2',   s.pct_libre_co2 != null ? fmtEs(s.pct_libre_co2, 1) + ' %' : '—');

    // Status bar
    const dot  = document.getElementById('genDot');
    const txt  = document.getElementById('genStatusText');
    const time = document.getElementById('genTime');
    if (dot)  dot.className = 'status-dot live';
    if (txt)  txt.textContent = `Renovable: ${s.pct_renovable != null ? fmtEs(s.pct_renovable, 1) + '%' : '—'} · Libre CO2: ${s.pct_libre_co2 != null ? fmtEs(s.pct_libre_co2, 1) + '%' : '—'} · Gen. total: ${fmtMwh(s.total_gen_mwh)}`;
    if (time) time.textContent = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString('es-ES') : '';

    const dateEl = document.getElementById('genMixDate');
    if (dateEl) dateEl.textContent = data.date || '—';

    // Mix bars — todas las tecnologias
    const container = document.getElementById('genMixBars');
    if (container) {
      container.innerHTML = '';
      const total = s.total_gen_mwh || 1;
      const techs = [
        ['Eolica',        s.eolica_mwh,           GEN_COLORS.eolica],
        ['Solar FV',      s.solar_fv_mwh,          GEN_COLORS.solar_fv],
        ['Solar Termica', s.solar_term_mwh,         GEN_COLORS.solar_t],
        ['Hidraulica',    s.hidro_mwh,              GEN_COLORS.hidro],
        ['Nuclear',       s.nuclear_mwh,            GEN_COLORS.nuclear],
        ['Ciclo Comb.',   s.ciclo_comb_mwh,         GEN_COLORS.ciclo],
        ['Carbon',        s.carbon_mwh,             GEN_COLORS.carbon],
        ['Cogeneracion',  s.cogeneracion_mwh,       GEN_COLORS.cogener],
        ['Otras Renov.',  s.otras_renov_mwh,        GEN_COLORS.otras],
        ['Resid. Renov.', s.residuos_renov_mwh,     'rgba(80,200,100,.5)'],
        ['Resid. No-R.',  s.residuos_norenov_mwh,   'rgba(180,80,80,.5)'],
      ];
      techs.forEach(([label, val, color]) => {
        if (val != null) drawGenMixBar(container, label, val, total, color);
      });
    }

    // Demanda
    const demDate = document.getElementById('genDemDate');
    const prevSeries = data.series_demanda?.prevista   || [];
    const progSeries = data.series_demanda?.programada || [];
    const realSeries = data.series_demanda?.real       || [];

    const lastPrev = prevSeries[prevSeries.length - 1]?.value;
    const lastProg = progSeries[progSeries.length - 1]?.value;
    const lastReal = realSeries[realSeries.length - 1]?.value;

    const setDem = (id, v) => {
      const el = document.getElementById(id);
      if (el && v != null) { el.textContent = Math.round(v).toLocaleString('es-ES') + ' MW'; }
    };
    setDem('genDemPrev',  lastPrev || s.demanda_prevista_mw);
    setDem('genDemProg',  lastProg || s.demanda_programada_mw);
    setDem('genDemReal',  lastReal || s.demanda_real_mw);

    const deltaEl = document.getElementById('genDemDelta');
    if (deltaEl) {
      const prev = lastPrev || s.demanda_prevista_mw;
      const real = lastReal || s.demanda_real_mw;
      if (prev != null && real != null) {
        const delta = real - prev;
        deltaEl.textContent = (delta >= 0 ? '+' : '') + Math.round(delta).toLocaleString('es-ES') + ' MW';
        deltaEl.style.color = delta > 200 ? '#d80300' : (delta < -200 ? 'var(--accent-green2)' : 'var(--text-primary)');
      } else {
        deltaEl.textContent = '—';
      }
    }

    if (demDate) demDate.textContent = data.date || '—';
    requestAnimationFrame(() => drawDemandaChart(prevSeries, progSeries, realSeries));

  } catch (e) {
    console.error('[generacion]', e.message);
    const dot = document.getElementById('genDot');
    if (dot) dot.className = 'status-dot warn';
    const txt = document.getElementById('genStatusText');
    if (txt) txt.textContent = 'Error cargando datos de generacion';
  }
}

// Auto-refresh generacion cada 1.15 min si panel activo
setInterval(() => {
  if (currentMode === 'generacion') loadGeneracion();
}, 69 * 1000);

// Auto-refresh renovables cada 1.15 min si panel activo
setInterval(() => {
  if (currentMode === 'renewables') loadRenewables();
}, 69 * 1000);

/* ═══════════════════════════════════════════
   INIT
═══════════════════════════════════════════ */
loadLive();
startLiveRefresh();
