// Entry page served at /reff: exchanges the Elvi-Ra session token for a Rëff
// token, stores it under the keys the React client expects (reff_token /
// reff_user) and enters the SPA. Without a session (or with an expired one) it
// sends the user to the Elvi-Ra login.
(async () => {
  const elviraToken = localStorage.getItem('elvira_token') || '';
  if (!elviraToken) { location.replace('/pages/login.html'); return; }
  try {
    const r = await fetch('/reff/api/guest-token', { headers: { Authorization: 'Bearer ' + elviraToken } });
    if (r.status === 401) { location.replace('/pages/login.html'); return; }
    if (!r.ok) throw new Error('guest-token HTTP ' + r.status);
    const { token, user } = await r.json();
    if (token) localStorage.setItem('reff_token', token);
    if (user) localStorage.setItem('reff_user', JSON.stringify(user));
  } catch(e) { console.warn('[reff-wrapper] guest-token failed', e); }
  location.replace('/reff/app/dashboard');
})();
