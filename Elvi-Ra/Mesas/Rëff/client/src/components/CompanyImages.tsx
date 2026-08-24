import { useEffect, useRef, useState } from 'react';
import {
  fetchCompanyImages, uploadCompanyImage, deleteCompanyImage, fetchImageObjectUrl,
  type CompanyImage,
} from '../lib/api';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const MAX_PDF_SIZE = 16 * 1024 * 1024;

const isPdf = (f: CompanyImage) => f.contentType === 'application/pdf';

interface Props {
  companyId: number;
}

// Galería de imágenes y PDFs de la ficha de empresa: conversaciones, material
// de interés, investigación. Persistencia en GridFS vía /api/crm.
export function CompanyImages({ companyId }: Props) {
  const [images, setImages] = useState<CompanyImage[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<CompanyImage | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const urlsRef = useRef(urls);
  urlsRef.current = urls;

  async function loadThumb(img: CompanyImage) {
    if (isPdf(img)) return; // los PDF no tienen thumb: se abren bajo demanda
    try {
      const url = await fetchImageObjectUrl(img.id);
      setUrls((prev) => ({ ...prev, [img.id]: url }));
    } catch { /* thumb queda en placeholder */ }
  }

  // Abre el PDF en una pestaña nueva vía blob autenticado (cacheado en urls).
  async function openPdf(img: CompanyImage) {
    try {
      let url = urlsRef.current[img.id];
      if (!url) {
        url = await fetchImageObjectUrl(img.id);
        setUrls((prev) => ({ ...prev, [img.id]: url }));
      }
      window.open(url, '_blank', 'noopener');
    } catch {
      setError(`No se pudo abrir "${img.filename}"`);
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
      if (lightbox?.id === img.id) setLightbox(null);
    } catch (err: any) {
      setError(err?.message || 'Error al eliminar imagen');
    }
  }

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

      {images.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 8 }}>
          {images.map((img) => (
            <div key={img.id} style={{ position: 'relative' }}>
              <button
                onClick={() => (isPdf(img) ? openPdf(img) : setLightbox(img))}
                title={img.filename}
                style={{
                  display: 'block', width: '100%', aspectRatio: '1', padding: 0,
                  border: '1px solid var(--border, rgba(0,0,0,0.12))', borderRadius: 6,
                  overflow: 'hidden', cursor: 'pointer', background: 'var(--surface-2, #f2f3f5)',
                }}
              >
                {isPdf(img) ? (
                  <span style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    gap: 4, width: '100%', height: '100%', padding: 6,
                  }}>
                    <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: '#b3322c' }}>PDF</span>
                    <span style={{
                      fontSize: 9, color: 'var(--text-muted)', maxWidth: '100%',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {img.filename}
                    </span>
                  </span>
                ) : urls[img.id] ? (
                  <img src={urls[img.id]} alt={img.filename} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                ) : (
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>…</span>
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
          ))}
        </div>
      )}

      {error && <div style={{ color: '#b3322c', fontSize: 12 }}>{error}</div>}

      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)', zIndex: 400,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out',
          }}
        >
          <div style={{ maxWidth: '90vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {urls[lightbox.id] && (
              <img
                src={urls[lightbox.id]}
                alt={lightbox.filename}
                style={{ maxWidth: '90vw', maxHeight: '84vh', objectFit: 'contain', borderRadius: 6 }}
              />
            )}
            <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, textAlign: 'center' }}>
              {lightbox.filename}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
