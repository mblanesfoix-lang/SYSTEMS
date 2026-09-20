import { useEffect, useState } from 'react';
import { MeetingModal } from './MeetingModal';
import {
  fetchCompanyMeetings, MEETING_KIND_LABEL, MEETING_STATUS_META,
  type Meeting,
} from '../lib/api';

interface Props {
  companyId: number;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('es-ES', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// Historial de reuniones de la ficha de empresa: lo ya celebrado (con acta) y
// lo que queda agendado. Mismo backend que el Calendario.
export function CompanyMeetings({ companyId }: Props) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<{ meeting: Meeting | null } | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchCompanyMeetings(companyId)
      .then(({ meetings: list }) => { if (alive) setMeetings(list); })
      .catch((e: any) => { if (alive) setError(e?.message || 'Error al cargar reuniones'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [companyId]);

  function handleSaved(saved: Meeting) {
    setMeetings((prev) => {
      const exists = prev.some((m) => m.id === saved.id);
      const next = exists ? prev.map((m) => (m.id === saved.id ? saved : m)) : [saved, ...prev];
      return next.sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt));
    });
    setModal(null);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Reuniones</span>
        <button className="btn-secondary" onClick={() => setModal({ meeting: null })} style={{ padding: '4px 10px', fontSize: 12 }}>
          Agendar
        </button>
      </div>

      {loading && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Cargando…</span>}
      {error && <span style={{ fontSize: 12, color: '#ff6b6b' }}>{error}</span>}

      {!loading && meetings.length === 0 && (
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Sin reuniones registradas con esta empresa.
        </span>
      )}

      {meetings.map((m) => (
        <button
          key={m.id}
          onClick={() => setModal({ meeting: m })}
          style={{
            textAlign: 'left',
            border: '1px solid var(--border-subtle)',
            borderLeft: `3px solid ${MEETING_STATUS_META[m.status].color}`,
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
            <strong style={{ fontSize: 13 }}>{m.title}</strong>
            <span style={{ fontSize: 11, color: MEETING_STATUS_META[m.status].color }}>
              {MEETING_STATUS_META[m.status].label}
            </span>
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {formatWhen(m.scheduledAt)} · {MEETING_KIND_LABEL[m.kind]}
            {m.durationMin ? ` · ${m.durationMin} min` : ''}
            {m.location ? ` · ${m.location}` : ''}
          </span>
          {m.attendees && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Asistentes: {m.attendees}</span>
          )}
          {m.summary && <span style={{ fontSize: 12 }}>{m.summary}</span>}
          {m.nextSteps && (
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Próximos pasos: {m.nextSteps}</span>
          )}
        </button>
      ))}

      {modal && (
        <MeetingModal
          meeting={modal.meeting}
          companyId={companyId}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
          onDeleted={(id) => {
            setMeetings((prev) => prev.filter((m) => m.id !== id));
            setModal(null);
          }}
        />
      )}
    </div>
  );
}
