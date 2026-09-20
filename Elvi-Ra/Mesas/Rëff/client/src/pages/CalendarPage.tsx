import { useEffect, useMemo, useState } from 'react';
import { MeetingModal } from '../components/MeetingModal';
import {
  fetchMeetings, fetchMeetingsSummary, fetchSheets, fetchCompanies,
  MEETING_KIND_LABEL, MEETING_STATUS_META,
  type Company, type Meeting, type MeetingsSummary, type Sheet,
} from '../lib/api';

const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

// Clave YYYY-MM-DD en hora local: agrupa reuniones por casilla del mes sin que
// el desfase UTC mueva una reunión de medianoche al día anterior.
function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Rejilla de 6 semanas que empieza en lunes, incluyendo el relleno de los meses vecinos.
function buildMonthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7; // JS: domingo=0 -> lunes=0
  const start = new Date(year, month, 1 - offset);
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function CalendarPage() {
  const today = new Date();
  const [cursor, setCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [summary, setSummary] = useState<MeetingsSummary | null>(null);
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedDay, setSelectedDay] = useState<string>(dayKey(today));
  const [sheetFilter, setSheetFilter] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<{ meeting: Meeting | null; date: string | null } | null>(null);

  const monthDays = useMemo(() => buildMonthGrid(cursor.getFullYear(), cursor.getMonth()), [cursor]);

  // Carga todas las empresas del usuario (de todas sus hojas) para poder
  // agendar desde el calendario sin pasar por la ficha del CRM.
  useEffect(() => {
    let alive = true;
    fetchSheets()
      .then(async ({ sheets: list }) => {
        if (!alive) return;
        setSheets(list);
        const results = await Promise.all(list.map((s) => fetchCompanies(s.id).catch(() => ({ companies: [] }))));
        if (!alive) return;
        setCompanies(results.flatMap((r) => r.companies));
      })
      .catch((e: any) => { if (alive) setError(e?.message || 'Error al cargar empresas'); });
    return () => { alive = false; };
  }, []);

  function loadMonth() {
    const from = new Date(monthDays[0].getFullYear(), monthDays[0].getMonth(), monthDays[0].getDate(), 0, 0, 0);
    const last = monthDays[monthDays.length - 1];
    const to = new Date(last.getFullYear(), last.getMonth(), last.getDate(), 23, 59, 59);
    return fetchMeetings({
      from: from.toISOString(),
      to: to.toISOString(),
      ...(sheetFilter != null ? { sheetId: sheetFilter } : {}),
    })
      .then(({ meetings: list }) => setMeetings(list))
      .catch((e: any) => setError(e?.message || 'Error al cargar reuniones'));
  }

  useEffect(() => {
    setLoading(true);
    Promise.all([
      loadMonth(),
      fetchMeetingsSummary().then(setSummary).catch(() => {}),
    ]).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, sheetFilter]);

  function refresh() {
    loadMonth();
    fetchMeetingsSummary().then(setSummary).catch(() => {});
  }

  const byDay = useMemo(() => {
    const map = new Map<string, Meeting[]>();
    for (const m of meetings) {
      const key = dayKey(new Date(m.scheduledAt));
      const bucket = map.get(key);
      if (bucket) bucket.push(m); else map.set(key, [m]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    }
    return map;
  }, [meetings]);

  const dayMeetings = byDay.get(selectedDay) ?? [];
  const todayKey = dayKey(new Date());

  function shiftMonth(delta: number) {
    setCursor((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
  }

  function openNewAt(key: string) {
    // Nueva reunión sobre el día seleccionado, a las 10:00 por defecto.
    const [y, m, d] = key.split('-').map(Number);
    setModal({ meeting: null, date: new Date(y, m - 1, d, 10, 0, 0).toISOString() });
  }

  const kpis = [
    { label: 'Próximas reuniones', value: summary?.upcoming ?? 0 },
    { label: 'En los próximos 7 días', value: summary?.next7Days ?? 0 },
    { label: 'Reuniones realizadas', value: summary?.held ?? 0 },
    { label: 'Sin acta registrada', value: summary?.pendingMinutes ?? 0 },
  ];

  return (
    <div className="fade-up" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '24px 24px 0' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', margin: 0 }}>Calendario</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4, marginBottom: 16 }}>
          Agenda reuniones con las empresas del CRM y deja registrado qué se habló en cada una.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, padding: '0 24px 16px' }}>
        {kpis.map((k) => (
          <div key={k.label} className="card" style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {k.label}
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', marginTop: 4 }}>{k.value}</div>
          </div>
        ))}
      </div>

      {summary?.nextMeeting && (
        <div style={{ padding: '0 24px 16px' }}>
          <div className="card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Siguiente
            </span>
            <span style={{ fontSize: 13 }}>
              <strong>{summary.nextMeeting.companyName}</strong> · {summary.nextMeeting.title} ·{' '}
              {formatFullDate(summary.nextMeeting.scheduledAt)} a las {formatTime(summary.nextMeeting.scheduledAt)}
            </span>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 24px 16px', flexWrap: 'wrap' }}>
        <button className="btn-secondary" onClick={() => shiftMonth(-1)}>‹</button>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: '1.05rem', minWidth: 190, textAlign: 'center' }}>
          {MONTHS[cursor.getMonth()]} {cursor.getFullYear()}
        </span>
        <button className="btn-secondary" onClick={() => shiftMonth(1)}>›</button>
        <button
          className="btn-secondary"
          onClick={() => {
            const now = new Date();
            setCursor(new Date(now.getFullYear(), now.getMonth(), 1));
            setSelectedDay(dayKey(now));
          }}
        >
          Hoy
        </button>

        <select
          className="input-field"
          style={{ width: 'auto', minWidth: 180 }}
          value={sheetFilter ?? ''}
          onChange={(e) => setSheetFilter(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">Todas las hojas</option>
          {sheets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        <div style={{ marginLeft: 'auto' }}>
          <button className="btn-primary" onClick={() => openNewAt(selectedDay)} disabled={companies.length === 0}>
            Agendar reunión
          </button>
        </div>
      </div>

      {error && <div style={{ padding: '0 24px 12px', color: '#ff6b6b', fontSize: 12 }}>{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2.2fr) minmax(280px, 1fr)', gap: 16, padding: '0 24px 24px', alignItems: 'start' }}>
        <div className="card" style={{ padding: 12, opacity: loading ? 0.6 : 1 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 6 }}>
            {WEEKDAYS.map((w) => (
              <div key={w} style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: '4px 0' }}>{w}</div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
            {monthDays.map((d) => {
              const key = dayKey(d);
              const list = byDay.get(key) ?? [];
              const outside = d.getMonth() !== cursor.getMonth();
              const isToday = key === todayKey;
              const isSelected = key === selectedDay;
              return (
                <button
                  key={key}
                  onClick={() => setSelectedDay(key)}
                  onDoubleClick={() => openNewAt(key)}
                  title={list.length > 0 ? `${list.length} reunión(es)` : 'Doble clic para agendar'}
                  style={{
                    minHeight: 78,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                    padding: 6,
                    textAlign: 'left',
                    cursor: 'pointer',
                    background: isSelected ? 'var(--accent-dim)' : 'transparent',
                    border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border-subtle)'}`,
                    borderRadius: 'var(--radius-sm)',
                    opacity: outside ? 0.4 : 1,
                    color: 'var(--text-primary)',
                    font: 'inherit',
                  }}
                >
                  <span style={{
                    fontSize: 12,
                    fontWeight: isToday ? 700 : 500,
                    color: isToday ? 'var(--accent)' : 'var(--text-secondary)',
                  }}>
                    {d.getDate()}
                  </span>
                  {list.slice(0, 2).map((m) => (
                    <span
                      key={m.id}
                      style={{
                        fontSize: 10,
                        lineHeight: 1.25,
                        padding: '2px 4px',
                        borderRadius: 3,
                        background: `${MEETING_STATUS_META[m.status].color}22`,
                        borderLeft: `2px solid ${MEETING_STATUS_META[m.status].color}`,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {formatTime(m.scheduledAt)} {m.companyName ?? m.title}
                    </span>
                  ))}
                  {list.length > 2 && (
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>+{list.length - 2} más</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Día seleccionado
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', marginTop: 2, textTransform: 'capitalize' }}>
              {formatFullDate(`${selectedDay}T12:00:00`)}
            </div>
          </div>

          {dayMeetings.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              Sin reuniones registradas este día.
            </div>
          )}

          {dayMeetings.map((m) => (
            <button
              key={m.id}
              onClick={() => setModal({ meeting: m, date: null })}
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
                gap: 4,
              }}
            >
              <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong style={{ fontSize: 13 }}>{m.companyName ?? 'Empresa eliminada'}</strong>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{formatTime(m.scheduledAt)}</span>
              </span>
              <span style={{ fontSize: 12 }}>{m.title}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {MEETING_KIND_LABEL[m.kind]} · {MEETING_STATUS_META[m.status].label}
                {m.durationMin ? ` · ${m.durationMin} min` : ''}
                {m.location ? ` · ${m.location}` : ''}
              </span>
              {m.summary && (
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{m.summary}</span>
              )}
            </button>
          ))}

          <button className="btn-secondary" onClick={() => openNewAt(selectedDay)} disabled={companies.length === 0}>
            Añadir reunión este día
          </button>
          {companies.length === 0 && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Crea antes una empresa en el CRM para poder agendar.
            </span>
          )}
        </div>
      </div>

      {modal && (
        <MeetingModal
          meeting={modal.meeting}
          companies={companies}
          defaultDate={modal.date}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); refresh(); }}
          onDeleted={() => { setModal(null); refresh(); }}
        />
      )}
    </div>
  );
}
