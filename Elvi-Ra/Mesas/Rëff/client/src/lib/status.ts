import type { CompanyStatus } from './api';

export const STATUS_META: Record<CompanyStatus, { label: string; color: string }> = {
  estrategico: { label: 'Estratégico', color: '#1fa855' },
  operativo: { label: 'Operativo', color: '#0071e3' },
  pendiente: { label: 'Pendiente', color: '#c9a84c' },
  no_candidato: { label: 'No candidato', color: '#b3322c' },
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
