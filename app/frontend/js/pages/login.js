import { api, setSession, getToken } from '/js/api.js';
if (getToken()) location.href = '/pages/dashboard.html';

const form = document.getElementById('loginForm');
const err = document.getElementById('err');
const btn = document.getElementById('submitBtn');
const userInput = document.getElementById('username');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Verificando';
  const username = userInput.value.trim();
  const password = document.getElementById('password').value;
  try {
    const r = await api.login(username, password);
    setSession(r.token, r.user, r.role);
    sessionStorage.setItem('systemsEntry', '1');
    document.getElementById('loginCard').classList.add('leaving');
    document.getElementById('fadeLayer').classList.add('on');
    setTimeout(() => { location.href = '/pages/dashboard.html'; }, 650);
  } catch (ex) {
    err.textContent = ex.message || 'Error de acceso';
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
});
