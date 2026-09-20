import type { Company } from '../lib/api';
import { STATUS_META } from '../lib/status';

interface Props {
  companies: Company[];
  onEdit: (company: Company) => void;
}

export function CompanyTable({ companies, onEdit }: Props) {
  if (companies.length === 0) {
    return (
      <div className="crm-empty">
        Sin empresas en esta hoja. Usa "Añadir empresa" para empezar.
      </div>
    );
  }

  return (
    <table className="crm-table">
      <thead>
        <tr>
          <th>Empresa</th>
          <th>Ubicación</th>
          <th>Estado</th>
          <th>Sector</th>
          <th style={{ textAlign: 'right' }}>Tn / año</th>
          <th>Tareas</th>
        </tr>
      </thead>
      <tbody>
        {companies.map((c) => {
          const pendingTasks = c.tasks.filter((t) => !t.done).length;
          return (
            <tr key={c.id} onClick={() => onEdit(c)}>
              <td>
                <div className="crm-table__name">{c.name}</div>
                {c.notes && <div className="crm-table__notes">{c.notes}</div>}
              </td>
              <td>{c.city}, {c.country}</td>
              <td>
                <span className="crm-table__status" style={{ color: STATUS_META[c.status].color }}>
                  <span className="crm-table__dot" style={{ background: STATUS_META[c.status].color }} />
                  {STATUS_META[c.status].label}
                </span>
              </td>
              <td>{c.sector || '—'}</td>
              <td className="crm-table__mono" style={{ textAlign: 'right' }}>
                {c.tonnageYear != null ? c.tonnageYear.toLocaleString('es-ES') : '—'}
              </td>
              <td>
                {c.tasks.length === 0 ? '—' : (
                  <span className="crm-table__mono">
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
