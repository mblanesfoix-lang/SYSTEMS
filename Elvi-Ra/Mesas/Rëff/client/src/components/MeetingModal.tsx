import { useEffect, useMemo, useState } from 'react';
import {
  MEETING_KINDS, MEETING_KIND_LABEL, MEETING_STATUSES, MEETING_STATUS_META,
  createMeeting, updateMeeting, deleteMeeting,
  type Company, type Meeting, type MeetingKind, type MeetingStatus,
} from '../lib/api';

interface Props {
  meeting: Meeting | null;
  // Empresa fijada (se abre desde la ficha del CRM). Si es null, el modal
  // muestra un selector de empresa alimentado por `companies`.
  companyId?: number | null;
  companies?: Company[];
  defaultDate?: string | null;
  onClose: () => void;
  onSaved: (meeting: Meeting) => void;
  onDeleted?: (id: number) => void;
}

// <input type="datetime-local"> necesita "YYYY-MM-DDTHH:mm" en hora local.
// toISOString() daría UTC y desplazaría la hora mostrada.
function toLocalInput(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function MeetingModal({ meeting, companyId, companies = [], defaultDate, onClose, onSaved, onDeleted }: Props) {
  const [title, setTitle] = useState(meeting?.title ?? '');
  const [kind, setKind] = useState<MeetingKind>(meeting?.kind ?? 'videollamada');
  const [status, setStatus] = useState<MeetingStatus>(meeting?.status ?? 'agendada');
  const [scheduledAt, setScheduledAt] = useState(() => {
    if (meeting) return toLocalInput(meeting.scheduledAt);
    if (defaultDate) return toLocalInput(defaultDate);
    return toLocalInput(null);
  });
  const [durationMin, setDurationMin] = useState(String(meeting?.durationMin ?? 60));
  const [location, setLocation] = useState(meeting?.location ?? '');
  const [attendees, setAttendees] = useState(meeting?.attendees ?? '');
  const [summary, setSummary] = useState(meeting?.summary ?? '');
  const [nextSteps, setNextSteps] = useState(meeting?.nextSteps ?? '');
  const [targetCompany, setTargetCompany] = useState<number | null>(
    meeting?.companyId ?? companyId ?? (companies[0]?.id ?? null),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const companyLocked = companyId != null && !meeting;
  const sortedCompanies = useMemo(
    () => [...companies].sort((a, b) => a.name.localeCompare(b.name, 'es')),
    [companies],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleSubmit() {
    if (!title.trim()) { setError('El título de la reunión es obligatorio'); return; }
    if (!scheduledAt) { setError('Indica fecha y hora'); return; }
    const company = companyId ?? targetCompany;
    if (company == null) { setError('Selecciona la empresa de la reunión'); return; }

    const parsedDuration = Number(durationMin);
    const payload = {
      title: title.trim(),
      kind,
      status,
      // new Date(local) -> ISO en el backend; enviar el valor local tal cual
      // preserva la hora que el usuario ve en pantalla.
      scheduledAt: new Date(scheduledAt).toISOString(),
      durationMin: Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : null,
      location: location.trim() || null,
      attendees: attendees.trim() || null,
      summary: summary.trim() || null,
      nextSteps: nextSteps.trim() || null,
    };

    setSaving(true);
    setError(null);
    try {
      if (meeting) {
        const { meeting: saved } = await updateMeeting(meeting.id, {
          ...payload,
          ...(company !== meeting.companyId ? { companyId: company } : {}),
        });
        onSaved(saved);
      } else {
        const { meeting: saved } = await createMeeting(company, payload);
        onSaved(saved);
      }
    } catch (e: any) {
      setError(e?.message || 'Error al guardar la reunión');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!meeting || !onDeleted) return;
    if (!window.confirm(`¿Eliminar la reunión "${meeting.title}"?`)) return;
    setSaving(true);
    try {
      await deleteMeeting(meeting.id);
      onDeleted(meeting.id);
    } catch (e: any) {
      setError(e?.message || 'Error al eliminar la reunión');
      setSaving(false);
    }
  }

  const fieldLabel = { fontSize: 12, color: 'var(--text-muted)' } as const;
  const fieldWrap = { display: 'flex', flexDirection: 'column' as const, gap: 4 };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(3,6,10,0.72)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 24,
      }}
    >
      <div
        className="card fade-up"
        style={{
          width: 'min(620px, 100%)', maxHeight: '90vh', overflowY: 'auto',
          padding: 24, display: 'flex', flexDirection: 'column', gap: 14,
        }}
      >
        <div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.15rem', margin: 0 }}>
            {meeting ? 'Editar reunión' : 'Agendar reunión'}
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0' }}>
            Queda registrada en el calendario y en el historial de la empresa.
          </p>
        </div>

        <label style={fieldWrap}>
          <span style={fieldLabel}>Título</span>
          <input
            className="input-field"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Reunión comercial, visita técnica, seguimiento..."
            autoFocus
          />
        </label>

        {!companyLocked && (
          <label style={fieldWrap}>
            <span style={fieldLabel}>Empresa</span>
            <select
              className="input-field"
              value={targetCompany ?? ''}
              onChange={(e) => setTargetCompany(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Selecciona una empresa…</option>
              {sortedCompanies.map((c) => (
                <option key={c.id} value={c.id}>{c.name} · {c.city}, {c.country}</option>
              ))}
            </select>
          </label>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={fieldWrap}>
            <span style={fieldLabel}>Fecha y hora</span>
            <input
              className="input-field"
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
          </label>
          <label style={fieldWrap}>
            <span style={fieldLabel}>Duración (min)</span>
            <input
              className="input-field"
              type="number"
              min="5"
              step="5"
              value={durationMin}
              onChange={(e) => setDurationMin(e.target.value)}
            />
          </label>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={fieldWrap}>
            <span style={fieldLabel}>Tipo</span>
            <select className="input-field" value={kind} onChange={(e) => setKind(e.target.value as MeetingKind)}>
              {MEETING_KINDS.map((k) => <option key={k} value={k}>{MEETING_KIND_LABEL[k]}</option>)}
            </select>
          </label>
          <label style={fieldWrap}>
            <span style={fieldLabel}>Estado</span>
            <select className="input-field" value={status} onChange={(e) => setStatus(e.target.value as MeetingStatus)}>
              {MEETING_STATUSES.map((s) => <option key={s} value={s}>{MEETING_STATUS_META[s].label}</option>)}
            </select>
          </label>
        </div>

        <label style={fieldWrap}>
          <span style={fieldLabel}>Lugar o enlace</span>
          <input
            className="input-field"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Oficina Pamplona, Teams, planta Tudela..."
          />
        </label>

        <label style={fieldWrap}>
          <span style={fieldLabel}>Asistentes</span>
          <input
            className="input-field"
            value={attendees}
            onChange={(e) => setAttendees(e.target.value)}
            placeholder="Nombres y cargos, separados por comas"
          />
        </label>

        <label style={fieldWrap}>
          <span style={fieldLabel}>Acta / resumen de lo tratado</span>
          <textarea
            className="input-field"
            rows={3}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Qué se habló, acuerdos, cifras mencionadas..."
          />
        </label>

        <label style={fieldWrap}>
          <span style={fieldLabel}>Próximos pasos</span>
          <textarea
            className="input-field"
            rows={2}
            value={nextSteps}
            onChange={(e) => setNextSteps(e.target.value)}
            placeholder="Compromisos y siguiente contacto"
          />
        </label>

        {error && <div style={{ color: '#ff6b6b', fontSize: 12 }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
          {meeting && onDeleted ? (
            <button
              className="btn-secondary"
              onClick={handleDelete}
              disabled={saving}
              style={{ borderColor: '#ff6b6b', color: '#ff6b6b' }}
            >
              Eliminar
            </button>
          ) : <span />}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancelar</button>
            <button className="btn-primary" onClick={handleSubmit} disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
