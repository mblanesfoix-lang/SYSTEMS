import { useEffect, useState } from 'react';
import { CommunicationModal } from './CommunicationModal';
import {
  fetchCompanyCommunications, COMM_CHANNEL_LABEL, COMM_DIRECTION_LABEL,
  type Communication,
} from '../lib/api';

interface Props {
  companyId: number;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('es-ES', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// Historial de comunicaciones de la ficha de empresa, más reciente primero.
// Mismo backend que el dashboard de Comunicaciones del Calendario.
export function CompanyCommunications({ companyId }: Props) {
  const [items, setItems] = useState<Communication[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<{ comm: Communication | null } | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchCompanyCommunications(companyId)
      .then(({ communications }) => { if (alive) setItems(communications); })
      .catch((e: any) => { if (alive) setError(e?.message || 'Error al cargar comunicaciones'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [companyId]);

  function handleSaved(saved: Communication) {
    setItems((prev) => {
      const exists = prev.some((c) => c.id === saved.id);
      const next = exists ? prev.map((c) => (c.id === saved.id ? saved : c)) : [saved, ...prev];
      return next.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    });
    setModal(null);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Comunicaciones</span>
        <button className="btn-secondary" onClick={() => setModal({ comm: null })} style={{ padding: '4px 10px', fontSize: 12 }}>
          Registrar
        </button>
      </div>

      {loading && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Cargando…</span>}
      {error && <span style={{ fontSize: 12, color: '#ff6b6b' }}>{error}</span>}

      {!loading && items.length === 0 && (
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Sin comunicaciones registradas con esta empresa.
        </span>
      )}

      {items.map((c) => (
        <button
          key={c.id}
          onClick={() => setModal({ comm: c })}
          style={{
            textAlign: 'left',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
            background: 'transparent',
            padding: 10,
            cursor: 'pointer',
            color: 'var(--text-primary)',
            font: 'inherit',
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          }}
        >
          <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <strong style={{ fontSize: 13 }}>{c.subject}</strong>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {COMM_CHANNEL_LABEL[c.channel]} · {COMM_DIRECTION_LABEL[c.direction]}
            </span>
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {formatWhen(c.occurredAt)}
            {c.attachmentCount > 0 ? ` · ${c.attachmentCount} adjunto(s)` : ''}
          </span>
          {c.notes && <span style={{ fontSize: 12 }}>{c.notes}</span>}
        </button>
      ))}

      {modal && (
        <CommunicationModal
          communication={modal.comm}
          companyId={companyId}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
          onDeleted={(id) => {
            setItems((prev) => prev.filter((c) => c.id !== id));
            setModal(null);
          }}
        />
      )}
    </div>
  );
}
