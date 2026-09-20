import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { ErrorBoundary } from './components/ErrorBoundary';
import { DashboardPage } from './pages/DashboardPage';
import { CRMPage } from './pages/CRMPage';
import { CalendarPage } from './pages/CalendarPage';
import { VigilanciaPage } from './pages/VigilanciaPage';
import { clearElviraSession, clearSession, fetchGuestToken, getStoredUser, getToken, type User } from './lib/api';

export default function App() {
  const [user, setUser] = useState<User | null>(() => getStoredUser());
  const location = useLocation();

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
        {/* La clave por ruta reinicia el boundary al navegar: un fallo en una
            pantalla no deja bloqueadas las demas. */}
        <ErrorBoundary key={location.pathname} label="esta pantalla">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/crm" element={<CRMPage />} />
          <Route path="/calendario" element={<CalendarPage />} />
          <Route path="/vigilancia" element={<VigilanciaPage />} />
          <Route path="/herzog" element={<Navigate to="/vigilancia" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
        </ErrorBoundary>
      </div>
    </div>
  );
}
