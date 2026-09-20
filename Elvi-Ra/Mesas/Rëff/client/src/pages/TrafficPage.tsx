import { useEffect, useState } from 'react';
import {
  ackTrafficRequest,
  approveTrafficRequest,
  createTrafficRequest,
  denyTrafficRequest,
  fetchTrafficRequests,
  getStoredUser,
  justifyTrafficRequest,
  requireTrafficJustification,
  type TrafficRequest,
  type TrafficStatus,
} from '../lib/api';

const RESOLUTION_MESSAGE: Record<TrafficStatus, (r: TrafficRequest) => string> = {
  pendiente: () => '',
  aprobada: () => 'Tu solicitud fue aprobada. Puerto abierto 60s, información transferida.',
  denegada: (r) => `Tu solicitud fue denegada${r.resolutionNote ? `: ${r.resolutionNote}` : ''}.`,
  justificacion_requerida: () => 'Tu solicitud requiere un motivo de negocio antes de tramitarse.',
};

const STATUS_META: Record<TrafficStatus, { label: string; color: string }> = {
  pendiente: { label: 'Pendiente', color: '#e8b13a' },
  aprobada: { label: 'Aprobada', color: '#35d68a' },
  denegada: { label: 'Denegada', color: '#ff6b6b' },
  justificacion_requerida: { label: 'Justificación requerida', color: '#4a9eff' },
};

const POLL_MS = 15000;

export function TrafficPage() {
  const currentUserId = getStoredUser()?.id ?? null;
  const [requests, setRequests] = useState<TrafficRequest[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [filterStatus, setFilterStatus] = useState<TrafficStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [justifyDraft, setJustifyDraft] = useState<Record<number, string>>({});
  const [denyDraft, setDenyDraft] = useState<Record<number, string>>({});

  const [newModule, setNewModule] = useState('');
  const [newResource, setNewResource] = useState('');
  const [newAction, setNewAction] = useState('');

  function load() {
    fetchTrafficRequests(filterStatus ?? undefined)
      .then(({ requests, isAdmin }) => { setRequests(requests); setIsAdmin(isAdmin); })
      .catch((e) => setError(e?.message || 'Error al cargar solicitudes'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    setLoading(true);
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatus]);

  async function handleCreate() {
    setError(null);
    if (!newModule.trim() || !newResource.trim() || !newAction.trim()) {
      setError('Módulo, recurso y acción son obligatorios');
      return;
    }
    try {
      await createTrafficRequest({ module: newModule.trim(), resource: newResource.trim(), action: newAction.trim() });
      setNewModule('');
      setNewResource('');
      setNewAction('');
      load();
    } catch (e: any) {
      setError(e?.message || 'Error al crear solicitud');
    }
  }

  async function handleApprove(id: number) {
    setBusyId(id);
    try {
      await approveTrafficRequest(id);
      load();
    } catch (e: any) {
      setError(e?.message || 'Error al aprobar');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDeny(id: number) {
    setBusyId(id);
    try {
      await denyTrafficRequest(id, denyDraft[id]);
      setDenyDraft((prev) => ({ ...prev, [id]: '' }));
      load();
    } catch (e: any) {
      setError(e?.message || 'Error al denegar');
    } finally {
      setBusyId(null);
    }
  }

  async function handleRequireJustification(id: number) {
    setBusyId(id);
    try {
      await requireTrafficJustification(id);
      load();
    } catch (e: any) {
      setError(e?.message || 'Error al pedir justificación');
    } finally {
      setBusyId(null);
    }
  }

  async function handleSubmitJustification(id: number) {
    const text = justifyDraft[id]?.trim();
    if (!text) return;
    setBusyId(id);
    try {
      await justifyTrafficRequest(id, text);
      setJustifyDraft((prev) => ({ ...prev, [id]: '' }));
      load();
    } catch (e: any) {
      setError(e?.message || 'Error al enviar justificación');
    } finally {
      setBusyId(null);
    }
  }

  async function handleAck(id: number) {
    try {
      await ackTrafficRequest(id);
      setRequests((prev) => prev.map((r) => (r.id === id ? { ...r, requesterSeen: true } : r)));
    } catch (e: any) {
      setError(e?.message || 'Error al reconocer la notificación');
    }
  }

  const pendingCount = requests.filter((r) => r.status === 'pendiente').length;
  const unseenMine = currentUserId
    ? requests.filter((r) => r.requesterId === currentUserId && !r.requesterSeen && r.status !== 'pendiente')
    : [];

  return (
    <div className="fade-up" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 1100 }}>
      <div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', margin: 0 }}>
          Consola Maestra &amp; Control de Tráfico
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
          Notificaciones de interconexión y acciones en 1 clic. {pendingCount} pendiente{pendingCount === 1 ? '' : 's'}.
          {!isAdmin && ' Solo un admin puede aprobar, denegar o pedir justificación.'}
        </p>
      </div>

      {unseenMine.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {unseenMine.map((r) => (
            <div
              key={r.id}
              className="card"
              style={{
                padding: '12px 16px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                border: `1px solid ${STATUS_META[r.status].color}`,
                background: 'var(--surface-1)',
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_META[r.status].color, flexShrink: 0 }} />
              <span style={{ fontSize: 13, flex: 1 }}>
                {RESOLUTION_MESSAGE[r.status](r)} <span style={{ color: 'var(--text-muted)' }}>({r.resource})</span>
              </span>
              <button className="btn-secondary" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => handleAck(r.id)}>
                Entendido
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Nueva solicitud de interconexión</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="input-field" style={{ flex: '1 1 160px' }} placeholder="Módulo (ej. Rëff-Lab)" value={newModule} onChange={(e) => setNewModule(e.target.value)} />
          <input className="input-field" style={{ flex: '1 1 220px' }} placeholder="Recurso (ej. Informe Elvi-Ra Analytics)" value={newResource} onChange={(e) => setNewResource(e.target.value)} />
          <input className="input-field" style={{ flex: '1 1 160px' }} placeholder="Acción (ej. Exportar)" value={newAction} onChange={(e) => setNewAction(e.target.value)} />
          <button className="btn-primary" onClick={handleCreate}>Solicitar</button>
        </div>
        {error && <div style={{ color: '#ff6b6b', fontSize: 12 }}>{error}</div>}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className={filterStatus === null ? 'btn-primary' : 'btn-secondary'} style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => setFilterStatus(null)}>
          Todas
        </button>
        {(Object.keys(STATUS_META) as TrafficStatus[]).map((s) => (
          <button
            key={s}
            className={filterStatus === s ? 'btn-primary' : 'btn-secondary'}
            style={{ fontSize: 11, padding: '4px 10px' }}
            onClick={() => setFilterStatus(filterStatus === s ? null : s)}
          >
            {STATUS_META[s].label}
          </button>
        ))}
      </div>

      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
          <span className="spinner" />
        </div>
      )}

      {!loading && requests.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sin solicitudes de tráfico todavía.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {requests.map((r) => {
          const meta = STATUS_META[r.status];
          const busy = busyId === r.id;
          return (
            <div key={r.id} className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color, flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{meta.label}</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{new Date(r.createdAt).toLocaleString('es-ES')}</span>
              </div>

              <div style={{ fontSize: 14 }}>
                <strong>{r.requesterName}</strong> ha solicitado <strong>{r.action}</strong> desde <strong>{r.module}</strong>: {r.resource}
              </div>

              {r.justification && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', background: 'var(--surface-1)', padding: '8px 10px', borderRadius: 6 }}>
                  Justificación: {r.justification}
                </div>
              )}

              {r.resolutionNote && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Motivo: {r.resolutionNote}</div>
              )}

              {r.status === 'aprobada' && r.portOpenedAt && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  Puerto abierto {new Date(r.portOpenedAt).toLocaleTimeString('es-ES')} · cierre automático {r.portClosedAt ? new Date(r.portClosedAt).toLocaleTimeString('es-ES') : '—'} · resuelto por {r.resolvedBy}
                </div>
              )}

              {r.status === 'denegada' && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Denegada por {r.resolvedBy}</div>
              )}

              {isAdmin && r.status === 'pendiente' && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button className="btn-primary" style={{ fontSize: 12 }} disabled={busy} onClick={() => handleApprove(r.id)}>
                    APROBAR_Y_EMITIR
                  </button>
                  <input
                    className="input-field"
                    style={{ flex: '1 1 180px', fontSize: 12 }}
                    placeholder="Motivo de denegación (opcional)"
                    value={denyDraft[r.id] || ''}
                    onChange={(e) => setDenyDraft((prev) => ({ ...prev, [r.id]: e.target.value }))}
                  />
                  <button className="btn-secondary" style={{ fontSize: 12 }} disabled={busy} onClick={() => handleDeny(r.id)}>
                    DENEGAR_PETICIÓN
                  </button>
                  <button className="btn-secondary" style={{ fontSize: 12 }} disabled={busy} onClick={() => handleRequireJustification(r.id)}>
                    REQUERIR_JUSTIFICACIÓN
                  </button>
                </div>
              )}

              {r.status === 'justificacion_requerida' && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input
                    className="input-field"
                    style={{ flex: '1 1 240px', fontSize: 12 }}
                    placeholder="Motivo de negocio"
                    value={justifyDraft[r.id] || ''}
                    onChange={(e) => setJustifyDraft((prev) => ({ ...prev, [r.id]: e.target.value }))}
                  />
                  <button className="btn-primary" style={{ fontSize: 12 }} disabled={busy} onClick={() => handleSubmitJustification(r.id)}>
                    Enviar justificación
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
