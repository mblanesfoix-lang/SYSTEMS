import { useEffect, useState } from 'react';
import { runHerzogAudit, fetchHerzogHistory, type HerzogAudit, type HerzogResult } from '../lib/api';

const SCORE_LABELS: Record<keyof HerzogResult['scores'], string> = {
  W: 'Residuo',
  I: 'Infraestructura',
  S: 'Escalabilidad',
  M: 'Compat. OEM',
  E: 'Impacto económico',
  R: 'Estratégico',
};

const CLASSIFICATION_META: Record<HerzogResult['classification'], { label: string; color: string }> = {
  ESTRATEGICO: { label: 'Estratégico', color: '#1fa855' },
  OPERATIVO: { label: 'Operativo', color: '#0071e3' },
  NO_CANDIDATO: { label: 'No candidato', color: '#b3322c' },
};

function ResultCard({ result }: { result: HerzogResult }) {
  const meta = CLASSIFICATION_META[result.classification];
  return (
    <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: meta.color }} />
          <span style={{ fontWeight: 600, fontSize: 14 }}>{meta.label}</span>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 24, fontWeight: 700 }}>{result.overall}<span style={{ fontSize: 12, opacity: 0.5 }}>/100</span></div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
        {(Object.keys(result.scores) as Array<keyof HerzogResult['scores']>).map((key) => (
          <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700 }}>{result.scores[key]}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
              {key} · {SCORE_LABELS[key]}
            </div>
          </div>
        ))}
      </div>

      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>{result.summary}</p>

      {result.highlights?.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>Puntos clave</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {result.highlights.map((h, i) => <li key={i}>{h}</li>)}
          </ul>
        </div>
      )}

      {result.risks?.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>Riesgos</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {result.risks.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

export function HerzogPage() {
  const [companyName, setCompanyName] = useState('');
  const [text, setText] = useState('');
  const [result, setResult] = useState<HerzogResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HerzogAudit[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  useEffect(() => {
    fetchHerzogHistory().then(({ audits }) => setHistory(audits)).catch(() => {});
  }, []);

  async function handleAudit() {
    setError(null);
    if (!companyName.trim() || !text.trim()) {
      setError('Indica nombre de empresa y texto a auditar');
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const { result } = await runHerzogAudit(companyName.trim(), text.trim());
      setResult(result);
      fetchHerzogHistory().then(({ audits }) => setHistory(audits)).catch(() => {});
    } catch (e: any) {
      setError(e?.message || 'Error al ejecutar la auditoría');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 900 }}>
      <div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', margin: 0 }}>Herzog</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
          Auditoría científica. Pega información textual sobre una empresa y Claude evalúa Residuo, Infraestructura, Escalabilidad,
          Compatibilidad OEM, Impacto económico y valor Estratégico.
        </p>
      </div>

      <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Nombre de la empresa</span>
          <input className="input-field" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Empresa Candidata S.L." />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Información a auditar</span>
          <textarea
            className="input-field"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            placeholder="Pega aquí información sobre la empresa: actividad, residuos generados, infraestructura, ubicación, datos económicos, etc."
          />
        </label>
        {error && <div style={{ color: '#b3322c', fontSize: 12 }}>{error}</div>}
        <div>
          <button className="btn-primary" onClick={handleAudit} disabled={loading}>
            {loading ? 'Auditando…' : 'Ejecutar auditoría'}
          </button>
        </div>
      </div>

      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
          <span className="spinner" />
        </div>
      )}

      {result && <ResultCard result={result} />}

      {history.length > 0 && (
        <div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', marginBottom: 12 }}>Historial</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {history.map((audit) => {
              const meta = CLASSIFICATION_META[audit.result.classification];
              const isOpen = expandedId === audit.id;
              return (
                <div key={audit.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                  <div
                    onClick={() => setExpandedId(isOpen ? null : audit.id)}
                    style={{ padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color }} />
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{audit.companyName}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{meta.label}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700 }}>{audit.result.overall}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {new Date(audit.createdAt).toLocaleDateString('es-ES')}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{isOpen ? '▲' : '▼'}</span>
                    </div>
                  </div>
                  {isOpen && (
                    <div style={{ padding: '0 12px 16px', display: 'flex', flexDirection: 'column', gap: 12, borderTop: '1px solid var(--border-color, rgba(0,0,0,0.08))' }}>
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>
                          Información sustraída
                        </div>
                        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{audit.inputText}</p>
                      </div>
                      <ResultCard result={audit.result} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
