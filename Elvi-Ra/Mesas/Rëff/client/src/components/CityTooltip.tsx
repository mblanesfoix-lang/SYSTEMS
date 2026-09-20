import type { GlobeCity } from '../lib/api';
import { STATUS_META } from '../lib/status';

interface Props {
  city: GlobeCity;
  x: number;
  y: number;
}

export function CityTooltip({ city, x, y }: Props) {
  return (
    <div
      style={{
        position: 'fixed',
        left: x + 16,
        top: y + 16,
        zIndex: 100,
        pointerEvents: 'none',
        background: 'var(--surface-1)',
        border: '1px solid var(--accent-border)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--text-primary)',
        padding: '10px 14px',
        minWidth: 200,
        maxWidth: 280,
        backdropFilter: 'blur(12px)',
        boxShadow: 'var(--shadow-lg), 0 0 30px -12px var(--accent-glow)',
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 2 }}>
        {city.country}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8, fontFamily: 'var(--font-display)' }}>
        {city.city}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {city.companies.map((c) => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: STATUS_META[c.status].color,
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
            <span style={{ opacity: 0.55, fontSize: 11 }}>
              {STATUS_META[c.status].label}
            </span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8, fontSize: 11, opacity: 0.5 }}>
        {city.companies.length} {city.companies.length === 1 ? 'empresa' : 'empresas'}
      </div>
    </div>
  );
}
