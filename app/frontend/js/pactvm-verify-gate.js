// Restricted public verification card (/api/pactvm-verify/:id): unlocks the
// package summary with an authorised email and the temporary code. The package
// id comes from data-package-id on #gateCard.
(function () {
  var card = document.getElementById('gateCard');
  var btn = document.getElementById('gateBtn');
  var err = document.getElementById('gateError');
  if (!card || !btn) return;
  var packageId = card.dataset.packageId;
  function fmt(n, d) {
    d = d || 2;
    n = Number(n || 0);
    return n.toLocaleString('es-ES', { maximumFractionDigits: d });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  btn.addEventListener('click', function () {
    var email = document.getElementById('gateEmail').value.trim();
    var code = document.getElementById('gateCode').value.trim();
    err.hidden = true;
    if (!email || !code) { err.textContent = 'Indica correo y código.'; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'Verificando…';
    fetch('/api/pactvm-verify/' + packageId + '/unlock', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, code: code }),
    }).then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = 'Verificar acceso';
        if (!res.ok) { err.textContent = res.data.error || 'Acceso denegado.'; err.hidden = false; return; }
        var d = res.data;
        document.getElementById('gateCard').outerHTML =
          '<div class="card">' +
          '<div class="brand">CIBE/ICEB International Certification Standard</div>' +
          '<div class="icon">✓</div>' +
          '<div class="status">' + esc(String(d.status || '').replace(/_/g, ' ')) + '</div>' +
          '<div class="sub">' + esc(d.type === 'certificado' ? 'Certificado de Activo Soberano' : 'Tokenización RWA') + '</div>' +
          '<div class="rows">' +
          '<div class="row"><span class="k">Cliente</span><span class="v">' + esc(d.clientName || '—') + '</span></div>' +
          '<div class="row"><span class="k">Periodo</span><span class="v mono">' + esc(d.period) + '</span></div>' +
          '<div class="row"><span class="k">T CO₂e</span><span class="v">' + fmt(d.co2eTotal) + '</span></div>' +
          '<div class="row"><span class="k">T CO₂e ponderado (GWP)</span><span class="v">' + fmt(d.co2eWeightedTotal) + '</span></div>' +
          '<div class="row"><span class="k">T DBO₅</span><span class="v">' + fmt(d.dbo5Total) + '</span></div>' +
          '<div class="row"><span class="k">Emitido</span><span class="v">' + esc(new Date(d.issuedAt).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })) + '</span></div>' +
          '</div>' +
          '<div class="hash-box"><span class="k">Merkle Root (SHA-256)</span><span class="hash">' + esc(d.merkleRoot) + '</span></div>' +
          '<div class="pkg-id">' + esc(d.packageId) + '</div>' +
          '<div class="footer">Acceso verificado por correo · sesión no persistente · Pactvm Viridi</div>' +
          '</div>';
      }).catch(function () {
        btn.disabled = false; btn.textContent = 'Verificar acceso';
        err.textContent = 'Error de red. Reintenta.'; err.hidden = false;
      });
  });
})();
