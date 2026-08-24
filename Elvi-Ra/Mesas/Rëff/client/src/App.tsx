import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { DashboardPage } from './pages/DashboardPage';
import { CRMPage } from './pages/CRMPage';
import { HerzogPage } from './pages/HerzogPage';
import { VigilanciaPage } from './pages/VigilanciaPage';
import { clearElviraSession, clearSession, fetchGuestToken, getStoredUser, getToken, type User } from './lib/api';

export default function App() {
  const [user, setUser] = useState<User | null>(() => getStoredUser());

  useEffect(() => {
    if (user && getToken()) return;
    fetchGuestToken().then((result) => {
      if (result) setUser(result.user);
    });
  }, [user]);

  if (!user || !getToken()) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text-primary)', background: 'var(--surface-0)' }}>
        <span className="spinner" />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar user={user} onLogout={() => {
        clearSession();
        clearElviraSession();
        setUser(null);
        const target = window.parent !== window ? window.parent : window;
        target.location.href = '/pages/login.html';
      }} />
      <div style={{ flex: 1, minWidth: 0, height: '100vh', overflow: 'auto' }}>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/crm" element={<CRMPage />} />
          <Route path="/herzog" element={<HerzogPage />} />
          <Route path="/vigilancia" element={<VigilanciaPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </div>
    </div>
  );
}
