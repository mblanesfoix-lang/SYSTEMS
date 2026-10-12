import { useEffect, useMemo, useState } from 'react';
import { CommunicationModal } from './CommunicationModal';
import {
  searchCommunications, fetchCommunicationsSummary,
  COMM_CHANNELS, COMM_CHANNEL_LABEL, COMM_DIRECTIONS, COMM_DIRECTION_LABEL,
  type Communication, type CommunicationsSummary, type Company, type Sheet, type CommChannel, type CommDirection,
} from '../lib/api';

interface Props {
  sheets: Sheet[];
  companies: Company[];
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const CHANNEL_COLOR: Record<CommChannel, string> = {
  email: '#2f7fd1',
  llamada: '#e0a23b',
  whatsapp: '#2f9e5f',
  reunion: '#9b6fd6',
  carta: '#8a8a8a',
  otro: '#5a6b7a',
};

// Debounce simple para no lanzar una búsqueda por tecla.
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export function CommunicationsBoard({ sheets, companies }: Props) {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 300);
  const [companyFilter, setCompanyFilter] = useState<number | null>(null);
  const [sheetFilter, setSheetFilter] = useState<number | null>(null);
  const [channelFilter, setChannelFilter] = useState<CommChannel | ''>('');
  const [directionFilter, setDirectionFilter] = useState<CommDirection | ''>('');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');

  const [items, setItems] = useState<Communication[]>([]);
  const [summary, setSummary] = useState<CommunicationsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<{ comm: Communication | null; companyId: number | null } | null>(null);

  function refresh() {
    setLoading(true);
    setError(null);
    Promise.all([
      searchCommunications({
        q: debouncedQuery || undefined,
        sheetId: sheetFilter ?? undefined,
        companyId: companyFilter ?? undefined,
        channel: channelFilter || undefined,
        direction: directionFilter || undefined,
        sort,
      }).then(({ communications }) => setItems(communications)),
      fetchCommunicationsSummary().then(setSummary).catch(() => {}),
    ])
      .catch((e: any) => setError(e?.message || 'Error al cargar comunicaciones'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, companyFilter, sheetFilter, channelFilter, directionFilter, sort]);

  const sortedCompanies = useMemo(
    () => [...companies].sort((a, b) => a.name.localeCompare(b.name, 'es')),
    [companies],
  );

  const kpis = [
    { label: 'Total registradas', value: summary?.total ?? 0 },
    { label: 'Últimos 30 días', value: summary?.last30Days ?? 0 },
    { label: 'Sin prueba adjunta', value: summary?.withoutAttachment ?? 0 },
    { label: 'Empresas contactadas', value: summary?.companiesContacted ?? 0 },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '0 24px 24px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {kpis.map((k) => (
          <div key={k.label} className="card" style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {k.label}
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', marginTop: 4 }}>{k.value}</div>
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 14, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <input
          className="input-field"
          style={{ flex: '1 1 220px', minWidth: 180 }}
          placeholder="Buscar por asunto o notas…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <select
          className="input-field"
          style={{ width: 'auto', minWidth: 170 }}
          value={companyFilter ?? ''}
          onChange={(e) => setCompanyFilter(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">Todas las empresas</option>
          {sortedCompanies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        <select
          className="input-field"
          style={{ width: 'auto', minWidth: 150 }}
          value={sheetFilter ?? ''}
          onChange={(e) => setSheetFilter(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">Todas las hojas</option>
          {sheets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        <select
          className="input-field"
          style={{ width: 'auto', minWidth: 130 }}
          value={channelFilter}
          onChange={(e) => setChannelFilter(e.target.value as CommChannel | '')}
        >
          <option value="">Todos los canales</option>
          {COMM_CHANNELS.map((c) => <option key={c} value={c}>{COMM_CHANNEL_LABEL[c]}</option>)}
        </select>

        <select
          className="input-field"
          style={{ width: 'auto', minWidth: 130 }}
          value={directionFilter}
          onChange={(e) => setDirectionFilter(e.target.value as CommDirection | '')}
        >
          <option value="">Ambas direcciones</option>
          {COMM_DIRECTIONS.map((d) => <option key={d} value={d}>{COMM_DIRECTION_LABEL[d]}</option>)}
        </select>

        <select
          className="input-field"
          style={{ width: 'auto', minWidth: 150 }}
          value={sort}
          onChange={(e) => setSort(e.target.value as 'newest' | 'oldest')}
        >
          <option value="newest">Más nuevas primero</option>
          <option value="oldest">Más antiguas primero</option>
        </select>

        <div style={{ marginLeft: 'auto' }}>
          <button
            className="btn-primary"
            onClick={() => setModal({ comm: null, companyId: companyFilter })}
            disabled={companies.length === 0}
          >
            Registrar comunicación
          </button>
        </div>
      </div>

      {error && <div style={{ color: '#ff6b6b', fontSize: 12 }}>{error}</div>}

      <div className="card" style={{ padding: 0, opacity: loading ? 0.6 : 1 }}>
        {items.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>
            {companies.length === 0
              ? 'Crea antes una empresa en el CRM para poder registrar comunicaciones.'
              : 'Sin comunicaciones registradas con estos filtros.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {items.map((c, i) => (
              <button
                key={c.id}
                onClick={() => setModal({ comm: c, companyId: c.companyId })}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left',
                  padding: '12px 16px', border: 'none', borderTop: i === 0 ? 'none' : '1px solid var(--border-subtle)',
                  background: 'transparent', cursor: 'pointer', color: 'var(--text-primary)', font: 'inherit',
                }}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', background: CHANNEL_COLOR[c.channel], flexShrink: 0,
                }} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <strong style={{ fontSize: 13 }}>{c.companyName ?? 'Empresa eliminada'}</strong>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {COMM_CHANNEL_LABEL[c.channel]} · {COMM_DIRECTION_LABEL[c.direction]}
                    </span>
                  </span>
                  <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.subject}
                  </span>
                </span>
                {c.attachmentCount > 0 && (
                  <span style={{
                    fontSize: 10, color: 'var(--accent)', border: '1px solid var(--accent-border)',
                    borderRadius: 4, padding: '2px 6px', flexShrink: 0,
                  }}>
                    {c.attachmentCount} adj.
                  </span>
                )}
                <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0, minWidth: 130, textAlign: 'right' }}>
                  {formatDateTime(c.occurredAt)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {modal && (
        <CommunicationModal
          communication={modal.comm}
          companyId={modal.companyId}
          companies={companies}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); refresh(); }}
          onDeleted={() => { setModal(null); refresh(); }}
        />
      )}
    </div>
  );
}
