import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchCompanyImages, uploadCompanyImage, deleteCompanyImage, fetchImageObjectUrl,
  type CompanyImage,
} from '../lib/api';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const MAX_PDF_SIZE = 16 * 1024 * 1024;

const isPdf = (f: CompanyImage) => f.contentType === 'application/pdf';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}

type ThumbState = 'loading' | 'ready' | 'error';

interface Props {
  companyId: number;
}

// Galería de imágenes y PDFs de la ficha de empresa: conversaciones, material
// de interés, investigación. Persistencia en GridFS vía /api/crm.
export function CompanyImages({ companyId }: Props) {
  const [images, setImages] = useState<CompanyImage[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [thumbState, setThumbState] = useState<Record<string, ThumbState>>({});
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const urlsRef = useRef(urls);
  urlsRef.current = urls;

  const viewerImage = viewerIndex != null ? images[viewerIndex] : null;

  async function ensureUrl(img: CompanyImage): Promise<string> {
    const cached = urlsRef.current[img.id];
    if (cached) return cached;
    const url = await fetchImageObjectUrl(img.id);
    setUrls((prev) => ({ ...prev, [img.id]: url }));
    return url;
  }

  async function loadThumb(img: CompanyImage) {
    if (isPdf(img)) return; // los PDF no tienen thumb: preview bajo demanda en el visor
    setThumbState((prev) => ({ ...prev, [img.id]: 'loading' }));
    try {
      await ensureUrl(img);
      setThumbState((prev) => ({ ...prev, [img.id]: 'ready' }));
    } catch {
      setThumbState((prev) => ({ ...prev, [img.id]: 'error' }));
    }
  }

  async function openViewer(index: number) {
    setViewerIndex(index);
    const img = images[index];
    if (img && !urlsRef.current[img.id]) {
      try { await ensureUrl(img); } catch { setError(`No se pudo abrir "${img.filename}"`); }
    }
  }

  async function downloadFile(img: CompanyImage) {
    try {
      const url = await ensureUrl(img);
      const a = document.createElement('a');
      a.href = url;
      a.download = img.filename;
      a.click();
    } catch {
      setError(`No se pudo descargar "${img.filename}"`);
    }
  }

  useEffect(() => {
    let alive = true;
    fetchCompanyImages(companyId)
      .then(({ images: list }) => {
        if (!alive) return;
        setImages(list);
        list.forEach(loadThumb);
      })
      .catch((err: any) => { if (alive) setError(err?.message || 'Error al cargar imágenes'); });
    return () => {
      alive = false;
      Object.values(urlsRef.current).forEach((u) => URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  // Navegación por teclado en el visor: flechas cambian de archivo, Escape cierra.
  useEffect(() => {
    if (viewerIndex == null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setViewerIndex(null);
      if (e.key === 'ArrowRight') setViewerIndex((i) => (i == null ? i : Math.min(i + 1, images.length - 1)));
      if (e.key === 'ArrowLeft') setViewerIndex((i) => (i == null ? i : Math.max(i - 1, 0)));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewerIndex, images.length]);

  useEffect(() => {
    if (viewerIndex == null) return;
    const img = images[viewerIndex];
    if (img && !urlsRef.current[img.id]) {
      ensureUrl(img).catch(() => setError(`No se pudo abrir "${img.filename}"`));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerIndex]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        if (!ACCEPTED.includes(file.type)) {
          setError(`"${file.name}": solo JPG, PNG, WebP o PDF`);
          continue;
        }
        const maxSize = file.type === 'application/pdf' ? MAX_PDF_SIZE : MAX_IMAGE_SIZE;
        if (file.size > maxSize) {
          setError(`"${file.name}": máximo ${maxSize / (1024 * 1024)} MB`);
          continue;
        }
        const { image } = await uploadCompanyImage(companyId, file);
        setImages((prev) => [image, ...prev]);
        loadThumb(image);
      }
    } catch (err: any) {
      setError(err?.message || 'Error al subir imagen');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleDelete(img: CompanyImage) {
    if (!window.confirm(`¿Eliminar "${img.filename}"?`)) return;
    try {
      await deleteCompanyImage(img.id);
      setImages((prev) => prev.filter((i) => i.id !== img.id));
      const url = urls[img.id];
      if (url) {
        URL.revokeObjectURL(url);
        setUrls((prev) => { const next = { ...prev }; delete next[img.id]; return next; });
      }
      setViewerIndex((i) => {
        if (i == null) return i;
        const idx = images.findIndex((x) => x.id === img.id);
        return idx === i ? null : i;
      });
    } catch (err: any) {
      setError(err?.message || 'Error al eliminar imagen');
    }
  }

  const dropHandlers = useMemo(() => ({
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDragOver(true); },
    onDragLeave: () => setDragOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      handleFiles(e.dataTransfer.files);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [companyId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Imágenes y PDFs {images.length > 0 ? `(${images.length})` : ''}
        </span>
        <button
          className="btn-secondary"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          style={{ fontSize: 12, padding: '4px 10px' }}
        >
          {uploading ? 'Subiendo…' : '+ Añadir'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED.join(',')}
          multiple
          hidden
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      <div
        {...dropHandlers}
        style={{
          border: `1px dashed ${dragOver ? 'var(--accent)' : 'var(--border-mid)'}`,
          borderRadius: 6,
          padding: images.length > 0 ? 8 : 20,
          background: dragOver ? 'var(--accent-dim)' : 'transparent',
          transition: 'border-color 120ms ease, background 120ms ease',
        }}
      >
        {images.length === 0 ? (
          <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
            Arrastra archivos aquí o usa "+ Añadir"
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 8 }}>
            {images.map((img, index) => {
              const state = isPdf(img) ? 'ready' : (thumbState[img.id] || 'loading');
              return (
                <div key={img.id} style={{ position: 'relative' }}>
                  <button
                    onClick={() => openViewer(index)}
                    title={`${img.filename} · ${formatSize(img.size)}`}
                    style={{
                      display: 'block', width: '100%', aspectRatio: '1', padding: 0,
                      border: '1px solid var(--border-mid)', borderRadius: 6,
                      overflow: 'hidden', cursor: 'pointer', background: 'var(--surface-2)',
                    }}
                  >
                    {isPdf(img) ? (
                      <span style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                        gap: 4, width: '100%', height: '100%', padding: 6,
                      }}>
                        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: '#ff6b6b' }}>PDF</span>
                        <span style={{
                          fontSize: 9, color: 'var(--text-muted)', maxWidth: '100%',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {img.filename}
                        </span>
                      </span>
                    ) : state === 'ready' && urls[img.id] ? (
                      <img src={urls[img.id]} alt={img.filename} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    ) : state === 'error' ? (
                      <span
                        role="button"
                        onClick={(e) => { e.stopPropagation(); loadThumb(img); }}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', fontSize: 10, color: '#ff6b6b', textAlign: 'center', padding: 6 }}
                      >
                        Error · reintentar
                      </span>
                    ) : (
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}>
                        <span className="spinner" style={{ width: 14, height: 14 }} />
                      </span>
                    )}
                  </button>
                  <button
                    onClick={() => handleDelete(img)}
                    title="Eliminar"
                    style={{
                      position: 'absolute', top: 3, right: 3, width: 18, height: 18,
                      border: 'none', borderRadius: '50%', background: 'rgba(0,0,0,0.55)',
                      color: '#fff', fontSize: 11, lineHeight: '18px', cursor: 'pointer', padding: 0,
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {error && <div style={{ color: '#ff6b6b', fontSize: 12 }}>{error}</div>}

      {viewerImage && (
        <div
          onClick={() => setViewerIndex(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(3,6,10,0.90)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', zIndex: 400,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: '92vw', height: '90vh', display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: '#fff' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {viewerImage.filename}
                </span>
                <span style={{ fontSize: 11, opacity: 0.6 }}>
                  {formatSize(viewerImage.size)} · {formatDate(viewerImage.uploadedAt)} · {viewerIndex! + 1}/{images.length}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button className="btn-secondary" onClick={() => downloadFile(viewerImage)} style={{ fontSize: 12, padding: '5px 12px' }}>
                  Descargar
                </button>
                <button className="btn-secondary" onClick={() => handleDelete(viewerImage)} style={{ fontSize: 12, padding: '5px 12px', borderColor: '#ff6b6b', color: '#ff6b6b' }}>
                  Eliminar
                </button>
                <button
                  onClick={() => setViewerIndex(null)}
                  style={{ border: 'none', background: 'rgba(255,255,255,0.1)', color: '#fff', cursor: 'pointer', fontSize: 16, width: 30, height: 30, borderRadius: 6 }}
                >
                  ×
                </button>
              </div>
            </div>

            <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {viewerIndex! > 0 && (
                <button
                  onClick={() => setViewerIndex((i) => (i == null ? i : Math.max(i - 1, 0)))}
                  style={navArrowStyle('left')}
                  title="Anterior"
                >
                  ‹
                </button>
              )}
              {viewerIndex! < images.length - 1 && (
                <button
                  onClick={() => setViewerIndex((i) => (i == null ? i : Math.min(i + 1, images.length - 1)))}
                  style={navArrowStyle('right')}
                  title="Siguiente"
                >
                  ›
                </button>
              )}

              {isPdf(viewerImage) ? (
                urls[viewerImage.id] ? (
                  <iframe
                    src={urls[viewerImage.id]}
                    title={viewerImage.filename}
                    style={{ width: '100%', height: '100%', border: 'none', borderRadius: 6, background: '#fff' }}
                  />
                ) : (
                  <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>Cargando PDF…</span>
                )
              ) : urls[viewerImage.id] ? (
                <img
                  src={urls[viewerImage.id]}
                  alt={viewerImage.filename}
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 6 }}
                />
              ) : (
                <span className="spinner" />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function navArrowStyle(side: 'left' | 'right'): React.CSSProperties {
  return {
    position: 'absolute',
    [side]: 8,
    top: '50%',
    transform: 'translateY(-50%)',
    border: 'none',
    background: 'rgba(255,255,255,0.12)',
    color: '#fff',
    cursor: 'pointer',
    fontSize: 26,
    lineHeight: 1,
    width: 42,
    height: 42,
    borderRadius: '50%',
    zIndex: 1,
  } as React.CSSProperties;
}
