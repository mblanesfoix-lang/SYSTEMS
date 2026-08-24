import { memo } from 'react';
import type { User, Agent } from '../lib/api';
import logoSnfi from '../assets/logo-snfi.png';

interface HeaderProps {
  user: User;
  activeAgent?: Agent | null;
}

export function HeaderComponent({ user, activeAgent }: HeaderProps) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 32px',
        height: 52,
        minHeight: 52,
        background: 'rgba(246,247,249,0.78)',
        backdropFilter: 'saturate(140%) blur(18px)',
        WebkitBackdropFilter: 'saturate(140%) blur(18px)',
        borderBottom: '1px solid rgba(20,24,32,0.10)',
        flexShrink: 0,
        position: 'sticky',
        top: 0,
        zIndex: 50,
      }}
    >
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <img src={logoSnfi} alt="S-NFI" style={{ height: 20, width: 'auto' }} />
        <span style={{
          fontFamily: "'Syne', 'Inter', system-ui, sans-serif",
          fontSize: '1rem',
          fontWeight: 700,
          letterSpacing: '-0.01em',
          color: '#0e1116',
        }}>
          Elvi-Ra
        </span>
      </div>

      {/* Breadcrumb */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: '0.8rem',
        color: '#5a6170',
      }}>
        <span>Mesa</span>
        <span style={{ opacity: 0.35 }}>/</span>
        <span style={{ color: '#0e1116', fontWeight: 600 }}>RËFF</span>
        {activeAgent && (
          <>
            <span style={{ opacity: 0.35 }}>·</span>
            <span>{activeAgent.name}</span>
          </>
        )}
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{
          fontSize: '0.8rem',
          color: '#5a6170',
        }}>
          {user.displayName}
        </span>
      </div>
    </header>
  );
}

export const Header = memo(HeaderComponent, (prev, next) => {
  return prev.user.id === next.user.id && prev.activeAgent?.id === next.activeAgent?.id;
});
