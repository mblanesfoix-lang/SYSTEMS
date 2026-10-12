import { NavLink } from 'react-router-dom';
import logoSnfi from '../assets/logo-snfi.png';
import type { User } from '../lib/api';
import { clearSession } from '../lib/api';

interface Props {
  user: User;
  onLogout: () => void;
}

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', hint: 'Globo 3D' },
  { to: '/crm', label: 'CRM', hint: 'Hojas y empresas' },
  { to: '/calendario', label: 'Direccion de enlace y exterior', hint: 'Calendario y comunicaciones' },
  { to: '/vigilancia', label: 'Vigilancia', hint: 'Herzog + feed inteligente 24/7' },
];

export function Sidebar({ user, onLogout }: Props) {
  return (
    <aside
      style={{
        width: 220,
        flexShrink: 0,
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'linear-gradient(180deg, var(--surface-1) 0%, var(--surface-0) 100%)',
        borderRight: '1px solid var(--border-subtle)',
        color: 'var(--text-primary)',
        position: 'relative',
        zIndex: 2,
      }}
    >
      {/* Filo de acento: separa la navegacion del lienzo sin una linea dura. */}
      <div
        aria-hidden
        style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, width: 1,
          background: 'linear-gradient(180deg, transparent, var(--accent-border) 22%, var(--accent-border) 78%, transparent)',
          opacity: 0.55, pointerEvents: 'none',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 20px 16px' }}>
        <img src={logoSnfi} alt="S-NFI" style={{ height: 22, width: 'auto' }} />
        <span style={{ fontFamily: 'var(--font-display)', fontSize: '1.05rem', fontWeight: 700, letterSpacing: '-0.01em' }}>
          Rëff
        </span>
      </div>

      <div style={{
        padding: '0 20px 16px',
        fontSize: 11,
        opacity: 0.6,
        color: 'var(--text-muted)',
        borderBottom: '1px solid var(--border-subtle)',
        paddingBottom: 16,
      }}>
        CRM inteligente
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '16px 12px', flex: 1 }}>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className="nav-link"
            style={({ isActive }) => ({
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm)',
              textDecoration: 'none',
              color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
              background: isActive ? 'var(--accent-dim)' : 'transparent',
              border: `1px solid ${isActive ? 'var(--accent-border)' : 'transparent'}`,
              boxShadow: isActive ? '0 0 22px -10px var(--accent-glow)' : 'none',
              transition: 'background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast)',
            })}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>{item.label}</span>
            </span>
            <span style={{ fontSize: 11, opacity: 0.6 }}>{item.hint}</span>
          </NavLink>
        ))}
      </nav>

      <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border-subtle)' }}>
        <div style={{ fontSize: 13, marginBottom: 8, color: 'var(--text-primary)' }}>{user.displayName}</div>
        <button
          onClick={() => {
            clearSession();
            onLogout();
          }}
          style={{
            background: 'transparent',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-secondary)',
            padding: '6px 12px',
            fontSize: 12,
            cursor: 'pointer',
            width: '100%',
          }}
        >
          Cerrar sesión
        </button>
      </div>
    </aside>
  );
}
