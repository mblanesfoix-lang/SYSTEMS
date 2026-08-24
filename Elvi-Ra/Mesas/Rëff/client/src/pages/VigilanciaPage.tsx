import { useEffect, useState } from 'react';
import {
  createWatchCompany,
  deleteWatchCompany,
  deleteWatchNews,
  fetchWatchCompanies,
  fetchWatchNews,
  runWatchNow,
  updateWatchCompany,
  type WatchCategory,
  type WatchCompany,
  type WatchNews,
} from '../lib/api';

const CATEGORY_META: Record<WatchCategory, { label: string; color: string }> = {
  residuos_inversion: { label: 'Gestión residual / inversión', color: '#0071e3' },
  asociaciones: { label: 'Asociaciones / integraciones', color: '#5e5ce6' },
  novedades: { label: 'Novedades', color: '#c9a84c' },
};

export function VigilanciaPage() {
  const [companies, setCompanies] = useState<WatchCompany[]>([]);
  const [news, setNews] = useState<WatchNews[]>([]);
  const [loadingNews, setLoadingNews] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [filterCategory, setFilterCategory] = useState<WatchCategory | null>(null);
  const [newName, setNewName] = useState('');
  const [newSector, setNewSector] = useState('');
  const [newCountry, setNewCountry] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  function loadCompanies() {
    fetchWatchCompanies().then(({ companies }) => setCompanies(companies)).catch(() => {});
  }

  function loadNews() {
    setLoadingNews(true);
    fetchWatchNews({ category: filterCategory ?? undefined })
      .then(({ news }) => setNews(news))
      .catch(() => {})
      .finally(() => setLoadingNews(false));
  }

  useEffect(() => { loadCompanies(); }, []);
  useEffect(() => { loadNews(); }, [filterCategory]);

  async function handleAdd() {
    setError(null);
    if (!newName.trim()) {
      setError('Indica el nombre de la empresa a vigilar');
      return;
    }
    try {
      await createWatchCompany({ name: newName.trim(), sector: newSector.trim() || null, country: newCountry.trim() || null });
      setNewName('');
      setNewSector('');
      setNewCountry('');
      loadCompanies();
    } catch (e: any) {
      setError(e?.message || 'Error al añadir empresa');
    }
  }

  async function handleToggleActive(company: WatchCompany) {
    await updateWatchCompany(company.id, { active: !company.active });
    loadCompanies();
  }

  async function handleDelete(company: WatchCompany) {
    await deleteWatchCompany(company.id);
    if (expanded === company.id) setExpanded(null);
    loadCompanies();
    loadNews();
  }

  async function handleDeleteNews(id: number) {
    try {
      await deleteWatchNews(id);
      setNews((prev) => prev.filter((n) => n.id !== id));
    } catch (e: any) {
      setError(e?.message || 'Error al eliminar noticia');
    }
  }

  async function handleRunNow(companyId?: number) {
    setRunning(true);
    try {
      await runWatchNow(companyId);
    } finally {
      setTimeout(() => { setRunning(false); loadNews(); }, 3000);
    }
  }

  function toggleExpanded(id: number) {
    setExpanded((prev) => (prev === id ? null : id));
  }

  const newsByCompany = (id: number) => news.filter((n) => n.companyId === id);

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 1100 }}>
      <div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', margin: 0 }}>Vigilancia</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
          Periódico inteligente: Claude busca en la web cada 6h novedades sobre las empresas vigiladas
          (gestión residual / inversión, asociaciones, novedades generales).
        </p>
      </div>

      <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Empresas vigiladas</div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="input-field" style={{ flex: '1 1 200px' }} placeholder="Nombre empresa" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <input className="input-field" style={{ flex: '1 1 140px' }} placeholder="Sector (opcional)" value={newSector} onChange={(e) => setNewSector(e.target.value)} />
          <input className="input-field" style={{ flex: '1 1 140px' }} placeholder="País (opcional)" value={newCountry} onChange={(e) => setNewCountry(e.target.value)} />
          <button className="btn-primary" onClick={handleAdd}>Añadir</button>
        </div>
        {error && <div style={{ color: '#b3322c', fontSize: 12 }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 'auto', alignSelf: 'center' }}>Filtrar categoría:</span>
          <button
            className={filterCategory === null ? 'btn-primary' : 'btn-secondary'}
            style={{ fontSize: 11, padding: '4px 10px' }}
            onClick={() => setFilterCategory(null)}
          >
            Todas
          </button>
          {(Object.keys(CATEGORY_META) as WatchCategory[]).map((cat) => (
            <button
              key={cat}
              className={filterCategory === cat ? 'btn-primary' : 'btn-secondary'}
              style={{ fontSize: 11, padding: '4px 10px' }}
              onClick={() => setFilterCategory(filterCategory === cat ? null : cat)}
            >
              {CATEGORY_META[cat].label}
            </button>
          ))}
          <button className="btn-secondary" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => handleRunNow()} disabled={running}>
            {running ? 'Buscando…' : 'Buscar ahora (todas)'}
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {companies.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sin empresas en vigilancia todavía.</div>
          )}
          {companies.map((c) => {
            const isOpen = expanded === c.id;
            const companyNews = newsByCompany(c.id);
            return (
              <div key={c.id} style={{ borderRadius: 8, background: 'var(--surface-1)', overflow: 'hidden' }}>
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', cursor: 'pointer' }}
                  onClick={() => toggleExpanded(c.id)}
                >
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block', width: 12 }}>
                    ▶
                  </span>
                  <span
                    title={c.active ? 'Activa' : 'Pausada'}
                    style={{ width: 8, height: 8, borderRadius: '50%', background: c.active ? '#1fa855' : 'var(--text-muted)', flexShrink: 0 }}
                  />
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{c.name}</span>
                  {c.sector && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.sector}</span>}
                  {c.country && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.country}</span>}
                  {!loadingNews && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {companyNews.length} noticia{companyNews.length === 1 ? '' : 's'}</span>
                  )}
                  <div style={{ flex: 1 }} />
                  <button className="btn-secondary" style={{ fontSize: 11, padding: '4px 8px' }} onClick={(e) => { e.stopPropagation(); handleRunNow(c.id); }} disabled={running}>
                    Buscar ahora
                  </button>
                  <button className="btn-secondary" style={{ fontSize: 11, padding: '4px 8px' }} onClick={(e) => { e.stopPropagation(); handleToggleActive(c); }}>
                    {c.active ? 'Pausar' : 'Activar'}
                  </button>
                  <button className="btn-secondary" style={{ fontSize: 11, padding: '4px 8px' }} onClick={(e) => { e.stopPropagation(); handleDelete(c); }}>
                    Eliminar
                  </button>
                </div>

                {isOpen && (
                  <div style={{ padding: '4px 10px 14px 32px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {loadingNews && (
                      <div style={{ display: 'flex', justifyContent: 'center', padding: 12 }}>
                        <span className="spinner" />
                      </div>
                    )}
                    {!loadingNews && companyNews.length === 0 && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sin novedades detectadas todavía.</div>
                    )}
                    {!loadingNews && companyNews.map((item) => {
                      const meta = CATEGORY_META[item.category];
                      return (
                        <div key={item.id} className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color, flexShrink: 0 }} />
                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{meta.label}</span>
                            <div style={{ flex: 1 }} />
                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{new Date(item.detectedAt).toLocaleString('es-ES')}</span>
                            <button
                              className="btn-secondary"
                              style={{ fontSize: 11, padding: '2px 8px' }}
                              onClick={(e) => { e.stopPropagation(); handleDeleteNews(item.id); }}
                              title="Eliminar esta noticia"
                              type="button"
                            >
                              ×
                            </button>
                          </div>
                          <div style={{ fontWeight: 600, fontSize: 14 }}>{item.headline}</div>
                          {item.sourceDate && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{item.sourceDate}</div>}
                          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>{item.summary}</p>
                          {item.url && (
                            <a href={item.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--accent)' }}>
                              Ver fuente ↗
                            </a>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
