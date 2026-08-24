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
  { to: '/herzog', label: 'Herzog', hint: 'Auditoría científica' },
  { to: '/vigilancia', label: 'Vigilancia', hint: 'Feed inteligente 24/7' },
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
        background: 'var(--surface-1)',
        borderRight: '1px solid var(--border-subtle)',
        color: 'var(--text-primary)',
      }}
    >
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
            style={({ isActive }) => ({
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              padding: '10px 12px',
              textDecoration: 'none',
              color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
              background: isActive ? 'var(--accent-dim)' : 'transparent',
              borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
              transition: 'background 160ms ease, color 160ms ease',
            })}
          >
            <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>{item.label}</span>
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
