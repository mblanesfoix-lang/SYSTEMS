import type { CSSProperties } from 'react';
import type { Company } from '../lib/api';
import { STATUS_META } from '../lib/status';

interface Props {
  companies: Company[];
  onEdit: (company: Company) => void;
}

export function CompanyTable({ companies, onEdit }: Props) {
  if (companies.length === 0) {
    return (
      <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
        Sin empresas en esta hoja. Usa "Añadir empresa" para empezar.
      </div>
    );
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-mid)' }}>
          <th style={thStyle}>Empresa</th>
          <th style={thStyle}>Ubicación</th>
          <th style={thStyle}>Estado</th>
          <th style={thStyle}>Sector</th>
          <th style={{ ...thStyle, textAlign: 'right' }}>Tn / año</th>
          <th style={thStyle}>Tareas</th>
        </tr>
      </thead>
      <tbody>
        {companies.map((c) => {
          const pendingTasks = c.tasks.filter((t) => !t.done).length;
          return (
            <tr
              key={c.id}
              onClick={() => onEdit(c)}
              style={{ borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer' }}
              className="card-hover"
            >
              <td style={tdStyle}>
                <div style={{ fontWeight: 600 }}>{c.name}</div>
                {c.notes && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>
                    {c.notes}
                  </div>
                )}
              </td>
              <td style={tdStyle}>{c.city}, {c.country}</td>
              <td style={tdStyle}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_META[c.status].color, display: 'inline-block' }} />
                  {STATUS_META[c.status].label}
                </span>
              </td>
              <td style={tdStyle}>{c.sector || '—'}</td>
              <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                {c.tonnageYear != null ? c.tonnageYear.toLocaleString('es-ES') : '—'}
              </td>
              <td style={tdStyle}>
                {c.tasks.length === 0 ? '—' : (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                    {c.tasks.length - pendingTasks}/{c.tasks.length}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const thStyle: CSSProperties = {
  padding: '10px 16px',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--text-muted)',
};

const tdStyle: CSSProperties = {
  padding: '12px 16px',
};
