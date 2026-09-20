import type { CompanyStatus } from './api';

export const STATUS_META: Record<CompanyStatus, { label: string; color: string }> = {
  estrategico: { label: 'Estratégico', color: '#35d68a' },
  operativo: { label: 'Operativo', color: '#4a9eff' },
  pendiente: { label: 'Pendiente', color: '#e8b13a' },
  no_candidato: { label: 'No candidato', color: '#ff6b6b' },
};

// Priority order used to pick the "dominant" status when several companies
// share a city marker on the globe (most relevant status wins).
export const STATUS_PRIORITY: CompanyStatus[] = ['estrategico', 'operativo', 'pendiente', 'no_candidato'];

export const STATUS_OPTIONS: CompanyStatus[] = ['estrategico', 'operativo', 'pendiente', 'no_candidato'];

export function dominantStatus(statuses: CompanyStatus[]): CompanyStatus {
  for (const s of STATUS_PRIORITY) {
    if (statuses.includes(s)) return s;
  }
  return 'pendiente';
}
