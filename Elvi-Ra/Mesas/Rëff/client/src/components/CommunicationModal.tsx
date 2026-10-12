import { useEffect, useMemo, useRef, useState } from 'react';
import {
  COMM_CHANNELS, COMM_CHANNEL_LABEL, COMM_DIRECTIONS, COMM_DIRECTION_LABEL,
  createCommunication, updateCommunication, deleteCommunication,
  fetchCommAttachments, uploadCommAttachment, deleteCommAttachment, fetchCommAttachmentObjectUrl,
  type Company, type CommAttachment, type CommChannel, type CommDirection, type Communication,
} from '../lib/api';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_SIZE = 16 * 1024 * 1024;

interface Props {
  communication: Communication | null;
  companyId?: number | null;
  companies?: Company[];
  onClose: () => void;
  onSaved: (comm: Communication) => void;
  onDeleted?: (id: number) => void;
}

// <input type="datetime-local"> necesita "YYYY-MM-DDTHH:mm" en hora local.
function toLocalInput(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CommunicationModal({ communication, companyId, companies = [], onClose, onSaved, onDeleted }: Props) {
  const [channel, setChannel] = useState<CommChannel>(communication?.channel ?? 'email');
  const [direction, setDirection] = useState<CommDirection>(communication?.direction ?? 'saliente');
  const [subject, setSubject] = useState(communication?.subject ?? '');
  const [notes, setNotes] = useState(communication?.notes ?? '');
  const [occurredAt, setOccurredAt] = useState(() => toLocalInput(communication?.occurredAt ?? null));
  const [targetCompany, setTargetCompany] = useState<number | null>(
    communication?.companyId ?? companyId ?? (companies[0]?.id ?? null),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [attachments, setAttachments] = useState<CommAttachment[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const urlsRef = useRef(urls);
  urlsRef.current = urls;

  const companyLocked = companyId != null && !communication;
  const sortedCompanies = useMemo(
    () => [...companies].sort((a, b) => a.name.localeCompare(b.name, 'es')),
    [companies],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!communication) return;
    let alive = true;
    fetchCommAttachments(communication.id)
      .then(({ attachments: list }) => { if (alive) setAttachments(list); })
      .catch(() => {});
    return () => {
      alive = false;
      Object.values(urlsRef.current).forEach((u) => URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [communication?.id]);

  async function ensureUrl(att: CommAttachment): Promise<string> {
    const cached = urlsRef.current[att.id];
    if (cached) return cached;
    const url = await fetchCommAttachmentObjectUrl(att.id);
    setUrls((prev) => ({ ...prev, [att.id]: url }));
    return url;
  }

  async function openAttachment(att: CommAttachment) {
    try {
      const url = await ensureUrl(att);
      window.open(url, '_blank', 'noopener');
    } catch {
      setError(`No se pudo abrir "${att.filename}"`);
    }
  }

  async function handleDeleteAttachment(att: CommAttachment) {
    if (!window.confirm(`¿Eliminar el adjunto "${att.filename}"?`)) return;
    try {
      await deleteCommAttachment(att.id);
      setAttachments((prev) => prev.filter((a) => a.id !== att.id));
      const url = urls[att.id];
      if (url) {
        URL.revokeObjectURL(url);
        setUrls((prev) => { const next = { ...prev }; delete next[att.id]; return next; });
      }
    } catch (e: any) {
      setError(e?.message || 'Error al eliminar adjunto');
    }
  }

  async function handleFiles(files: FileList | null, commId: number) {
    if (!files || files.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        if (!ACCEPTED.includes(file.type)) {
          setError(`"${file.name}": solo JPG, PNG, WebP o PDF`);
          continue;
        }
        if (file.size > MAX_SIZE) {
          setError(`"${file.name}": máximo ${MAX_SIZE / (1024 * 1024)} MB`);
          continue;
        }
        const { attachment } = await uploadCommAttachment(commId, file);
        setAttachments((prev) => [attachment, ...prev]);
      }
    } catch (e: any) {
      setError(e?.message || 'Error al subir adjunto');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleSubmit() {
    if (!subject.trim()) { setError('El asunto es obligatorio'); return; }
    const company = companyId ?? targetCompany;
    if (company == null) { setError('Selecciona la empresa'); return; }

    const payload = {
      channel,
      direction,
      subject: subject.trim(),
      notes: notes.trim() || null,
      occurredAt: occurredAt ? new Date(occurredAt).toISOString() : new Date().toISOString(),
    };

    setSaving(true);
    setError(null);
    try {
      if (communication) {
        const { communication: saved } = await updateCommunication(communication.id, payload);
        onSaved(saved);
      } else {
        const { communication: saved } = await createCommunication(company, payload);
        // Si el usuario ya había seleccionado archivos antes de guardar, súbelos ahora.
        if (fileRef.current?.files?.length) {
          await handleFiles(fileRef.current.files, saved.id);
        }
        onSaved(saved);
      }
    } catch (e: any) {
      setError(e?.message || 'Error al guardar la comunicación');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!communication || !onDeleted) return;
    if (!window.confirm(`¿Eliminar la comunicación "${communication.subject}"?`)) return;
    setSaving(true);
    try {
      await deleteCommunication(communication.id);
      onDeleted(communication.id);
    } catch (e: any) {
      setError(e?.message || 'Error al eliminar la comunicación');
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
          width: 'min(600px, 100%)', maxHeight: '90vh', overflowY: 'auto',
          padding: 24, display: 'flex', flexDirection: 'column', gap: 14,
        }}
      >
        <div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.15rem', margin: 0 }}>
            {communication ? 'Editar comunicación' : 'Registrar comunicación'}
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0' }}>
            Deja constancia del contacto con la empresa, con prueba adjunta si aplica.
          </p>
        </div>

        {!companyLocked && (
          <label style={fieldWrap}>
            <span style={fieldLabel}>Empresa</span>
            <select
              className="input-field"
              value={targetCompany ?? ''}
              onChange={(e) => setTargetCompany(e.target.value ? Number(e.target.value) : null)}
              disabled={!!communication}
            >
              <option value="">Selecciona una empresa…</option>
              {sortedCompanies.map((c) => (
                <option key={c.id} value={c.id}>{c.name} · {c.city}, {c.country}</option>
              ))}
            </select>
          </label>
        )}

        <label style={fieldWrap}>
          <span style={fieldLabel}>Asunto</span>
          <input
            className="input-field"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Envío de propuesta, confirmación de pedido, seguimiento..."
            autoFocus
          />
        </label>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={fieldWrap}>
            <span style={fieldLabel}>Canal</span>
            <select className="input-field" value={channel} onChange={(e) => setChannel(e.target.value as CommChannel)}>
              {COMM_CHANNELS.map((c) => <option key={c} value={c}>{COMM_CHANNEL_LABEL[c]}</option>)}
            </select>
          </label>
          <label style={fieldWrap}>
            <span style={fieldLabel}>Dirección</span>
            <select className="input-field" value={direction} onChange={(e) => setDirection(e.target.value as CommDirection)}>
              {COMM_DIRECTIONS.map((d) => <option key={d} value={d}>{COMM_DIRECTION_LABEL[d]}</option>)}
            </select>
          </label>
        </div>

        <label style={fieldWrap}>
          <span style={fieldLabel}>Fecha y hora</span>
          <input
            className="input-field"
            type="datetime-local"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
          />
        </label>

        <label style={fieldWrap}>
          <span style={fieldLabel}>Notas</span>
          <textarea
            className="input-field"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Detalle de lo comunicado, referencia, contacto..."
          />
        </label>

        <div style={fieldWrap}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={fieldLabel}>Adjuntos (imagen o PDF, prueba de la comunicación)</span>
            <button
              className="btn-secondary"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              style={{ fontSize: 12, padding: '4px 10px' }}
              type="button"
            >
              {uploading ? 'Subiendo…' : '+ Añadir'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPTED.join(',')}
              multiple
              hidden
              onChange={(e) => {
                if (communication) handleFiles(e.target.files, communication.id);
                // Si es alta nueva, los archivos se suben tras crear la comunicación (ver handleSubmit).
              }}
            />
          </div>

          {!communication && fileRef.current?.files?.length ? (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Los archivos seleccionados se subirán al guardar.
            </span>
          ) : null}

          {attachments.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              {attachments.map((att) => (
                <div
                  key={att.id}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    border: '1px solid var(--border-mid)', borderRadius: 6, padding: '6px 10px', gap: 8,
                  }}
                >
                  <button
                    onClick={() => openAttachment(att)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none',
                      color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12, padding: 0, minWidth: 0, flex: 1, textAlign: 'left',
                    }}
                    title="Abrir"
                  >
                    <span style={{
                      fontSize: 10, fontWeight: 700, color: att.contentType === 'application/pdf' ? '#ff6b6b' : 'var(--accent)',
                    }}>
                      {att.contentType === 'application/pdf' ? 'PDF' : 'IMG'}
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.filename}</span>
                    <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{formatSize(att.size)}</span>
                  </button>
                  <button
                    onClick={() => handleDeleteAttachment(att)}
                    title="Eliminar"
                    style={{ border: 'none', background: 'transparent', color: '#ff6b6b', cursor: 'pointer', fontSize: 12, padding: 0 }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <div style={{ color: '#ff6b6b', fontSize: 12 }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
          {communication && onDeleted ? (
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
