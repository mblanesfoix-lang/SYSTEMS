import { useEffect, useState } from 'react';
import {
  runHerzogAudit, fetchHerzogHistory, deleteHerzogAudit,
  fetchSheets, createCompany, deleteCompany,
  fetchCountries, fetchCities,
  type HerzogAudit, type HerzogResult, type HerzogMatchedCompany, type HerzogSource,
  type HerzogVerdict, type HerzogEvalType, type HerzogCategoryKey, type HerzogFlag,
  type Sheet, type CityOption, type CompanyStatus,
} from '../lib/api';

const CATEGORY_LABELS: Record<HerzogCategoryKey, string> = {
  solvenciaFinanciera: 'Solvencia y Salud Financiera',
  infraestructuraOperativa: 'Infraestructura y Mod. Operativo',
  transparenciaCompliance: 'Transparencia y Compliance',
  alineacionEstrategica: 'Alineación Estratégica / Encaje S-NFI',
};

const CATEGORY_ORDER: HerzogCategoryKey[] = [
  'solvenciaFinanciera',
  'infraestructuraOperativa',
  'transparenciaCompliance',
  'alineacionEstrategica',
];

const VERDICT_META: Record<HerzogVerdict, { label: string; color: string }> = {
  ACEPTADO: { label: 'Aceptado', color: '#35d68a' },
  REVISION_MANUAL: { label: 'Revisión manual', color: '#e8b13a' },
  RECHAZADO: { label: 'Rechazado', color: '#ff6b6b' },
};

const EVAL_TYPE_META: Record<HerzogEvalType, { label: string; short: string; hint: string }> = {
  CLIENTE: {
    label: 'A · Cliente',
    short: 'Cliente',
    hint: 'Dónde auditar e implantar Nodos. Pesa capacidad operativa, infraestructura y auditabilidad.',
  },
  FINANCIADOR: {
    label: 'B · Financiador',
    short: 'Financiador',
    hint: 'Capacitado para entrar en el accionariado de S-NFI. Pesa músculo financiero, perfil accionarial y encaje estratégico.',
  },
};

/** Color por nota 1-10, mismo criterio que la lógica de puntuación del dictamen. */
function scoreColor(score: number): string {
  if (score >= 9) return '#35d68a';
  if (score >= 7) return '#6fe0a5';
  if (score >= 5) return '#e8b13a';
  return '#ff6b6b';
}

// Sugiere un estado CRM de partida a partir del veredicto Herzog;
// el usuario lo puede cambiar luego desde el CRM.
function suggestedStatus(verdict: HerzogVerdict): CompanyStatus {
  if (verdict === 'ACEPTADO') return 'estrategico';
  if (verdict === 'REVISION_MANUAL') return 'operativo';
  return 'no_candidato';
}

// Los pesos por tipo tambien viven aqui para poder reconstruir una auditoria
// antigua sin depender del backend.
const FALLBACK_WEIGHTS: Record<HerzogEvalType, Record<HerzogCategoryKey, number>> = {
  CLIENTE: { solvenciaFinanciera: 20, infraestructuraOperativa: 35, transparenciaCompliance: 30, alineacionEstrategica: 15 },
  FINANCIADOR: { solvenciaFinanciera: 40, infraestructuraOperativa: 10, transparenciaCompliance: 25, alineacionEstrategica: 25 },
};

const LEGACY_DIMENSION_MAP: Record<string, HerzogCategoryKey> = {
  corporateViability: 'infraestructuraOperativa',
  snfiAlignment: 'alineacionEstrategica',
  reputationRisk: 'transparenciaCompliance',
  operationalCapacity: 'solvenciaFinanciera',
};

const LEGACY_VERDICT_MAP: Record<string, HerzogVerdict> = {
  APTO: 'ACEPTADO',
  APTO_CON_CONDICIONES: 'REVISION_MANUAL',
  REVISION_MANUAL_REQUERIDA: 'REVISION_MANUAL',
  NO_APTO: 'RECHAZADO',
};

/**
 * Deja cualquier auditoria en la forma que espera la UI. El backend ya
 * normaliza, pero un servidor sin reiniciar todavia sirve el formato viejo
 * (sin `overallScore`), y ahi un `.toFixed()` directo tumbaba toda la pagina:
 * React desmonta el arbol y el usuario ve la pantalla en blanco. Un dato
 * inesperado debe degradar la tarjeta, nunca la aplicacion.
 */
function normalizeResult(raw: any, fallbackType: HerzogEvalType = 'CLIENTE'): HerzogResult {
  const src = raw && typeof raw === 'object' ? raw : {};
  const evalType: HerzogEvalType = src.evalType === 'FINANCIADOR' ? 'FINANCIADOR' : fallbackType;
  const weights = FALLBACK_WEIGHTS[evalType];

  const categories = {} as HerzogResult['categories'];
  for (const key of CATEGORY_ORDER) {
    const fromNew = src.categories?.[key];
    if (fromNew && typeof fromNew.score === 'number') {
      categories[key] = {
        score: fromNew.score,
        weightPct: typeof fromNew.weightPct === 'number' ? fromNew.weightPct : weights[key],
        justification: fromNew.justification ?? '',
      };
      continue;
    }
    // Formato antiguo: dimensiones 1-5, se reescalan a 1-10.
    const legacyKey = Object.keys(LEGACY_DIMENSION_MAP).find((k) => LEGACY_DIMENSION_MAP[k] === key);
    const dim = legacyKey ? src.dimensions?.[legacyKey] : undefined;
    if (dim && typeof dim.score === 'number') {
      categories[key] = {
        score: Math.round(Math.min(10, Math.max(1, dim.score * 2)) * 10) / 10,
        weightPct: weights[key],
        justification: dim.justification ?? '',
      };
    }
  }

  let overall = typeof src.overallScore === 'number' ? src.overallScore : NaN;
  if (!Number.isFinite(overall)) {
    if (typeof src.weightedScorePct === 'number') overall = src.weightedScorePct / 10;
    else if (typeof src.score10 === 'number') overall = src.score10;
    else {
      const entries = Object.values(categories);
      const totalW = entries.reduce((a, c) => a + c.weightPct, 0);
      overall = totalW > 0 ? entries.reduce((a, c) => a + c.score * c.weightPct, 0) / totalW : 0;
    }
    overall = Math.round(overall * 10) / 10;
  }

  const verdict: HerzogVerdict = VERDICT_META[src.verdict as HerzogVerdict]
    ? src.verdict
    : (LEGACY_VERDICT_MAP[src.verdict] ?? 'REVISION_MANUAL');

  const flags: HerzogFlag[] = Array.isArray(src.flags)
    ? src.flags.filter((f: any) => f && typeof f.message === 'string')
    : Array.isArray(src.redFlags)
      ? src.redFlags.map((m: string) => ({ level: 'RED' as const, message: String(m) }))
      : [];

  return {
    evalType,
    taxId: typeof src.taxId === 'string' ? src.taxId : null,
    activity: src.activity ?? '',
    categories,
    variables: Array.isArray(src.variables)
      ? src.variables.filter((v: any) => v && typeof v.score === 'number')
      : [],
    overallScore: overall,
    opacityCount: typeof src.opacityCount === 'number' ? src.opacityCount : 0,
    verdict,
    flags,
    summary: src.summary ?? '',
    recommendation: src.recommendation ?? src.verticalNote ?? '',
    contact: src.contact ?? { methods: [], noDataFound: true },
    firstContact: src.firstContact ?? { channel: '', approach: '' },
  };
}

function ScoreBar({ score }: { score: number }) {
  return (
    <div style={{ height: 4, background: 'rgba(255,255,255,0.10)', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(100, Math.max(0, score * 10))}%`, height: '100%', background: scoreColor(score) }} />
    </div>
  );
}

function FlagList({ flags }: { flags: HerzogFlag[] }) {
  if (!flags || flags.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
        No se han detectado banderas de riesgo en la información verificada.
      </p>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {flags.map((f, i) => {
        const isRed = f.level === 'RED';
        return (
          <div
            key={i}
            style={{
              display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13,
              background: isRed ? 'rgba(255,107,107,0.10)' : 'rgba(232,177,58,0.12)',
              border: `1px solid ${isRed ? 'rgba(255,107,107,0.38)' : 'rgba(232,177,58,0.42)'}`,
              borderRadius: 6, padding: '6px 10px',
            }}
          >
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700,
              color: isRed ? '#ff6b6b' : '#e8b13a', whiteSpace: 'nowrap', paddingTop: 1,
            }}>
              {isRed ? '[!] RED' : '[?] YELLOW'}
            </span>
            <span>{f.message}</span>
          </div>
        );
      })}
    </div>
  );
}

function ResultCard({ result, companyName, sources }: { result: HerzogResult; companyName: string; sources?: HerzogSource[] }) {
  const meta = VERDICT_META[result.verdict] ?? VERDICT_META.REVISION_MANUAL;
  const typeMeta = EVAL_TYPE_META[result.evalType] ?? EVAL_TYPE_META.CLIENTE;

  return (
    <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Cabecera del reporte */}
      <div style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 14 }}>
        <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', letterSpacing: 0.5 }}>
          REPORTE DE ACREDITACIÓN DE EMPRESA
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4 }}>
          {companyName}
          {result.taxId && (
            <span style={{ fontWeight: 400, fontSize: 13, color: 'var(--text-muted)' }}> (CIF: {result.taxId})</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
          Tipo de evaluación: <strong style={{ color: 'var(--text-primary)' }}>{typeMeta.label}</strong>
        </div>
      </div>

      {/* Resultado general */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: meta.color }} />
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Dictamen final</div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{meta.label}</div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 28, fontWeight: 700, color: scoreColor(result.overallScore) }}>
            {result.overallScore.toFixed(1)}<span style={{ fontSize: 13, opacity: 0.5 }}>/10</span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Overall score</div>
        </div>
      </div>

      {result.verdict === 'REVISION_MANUAL' && (
        <div style={{ background: 'rgba(232,177,58,0.12)', border: '1px solid rgba(232,177,58,0.5)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
          Revisión manual requerida — {result.opacityCount > 2
            ? `${result.opacityCount} de 4 categorías sin dato verificable.`
            : 'puntuación intermedia o banderas de riesgo pendientes de validar por un humano.'}
        </div>
      )}

      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        <strong style={{ color: 'var(--text-primary)' }}>Datos opacos:</strong> {result.opacityCount}/4 categorías
      </div>

      {result.activity && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>Perfil de la empresa</div>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>{result.activity}</p>
        </div>
      )}

      {/* Desglose de categorías */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 10 }}>
          Puntuación por desglose de categorías (escala 1-10)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>
          {CATEGORY_ORDER.map((key) => {
            const cat = result.categories?.[key];
            if (!cat) return null;
            return (
              <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{CATEGORY_LABELS[key]}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 700, color: scoreColor(cat.score) }}>
                    {cat.score}<span style={{ fontSize: 10, opacity: 0.5 }}>/10</span>
                  </span>
                </div>
                <ScoreBar score={cat.score} />
                <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>Peso: {cat.weightPct}%</div>
                <div style={{ fontSize: 12, lineHeight: 1.5 }}>{cat.justification}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Variables individuales */}
      {result.variables?.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 10 }}>
            Variables individuales detalladas
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {result.variables.map((v, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13 }}>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700,
                  color: scoreColor(v.score), minWidth: 42, paddingTop: 1,
                }}>
                  {v.score}/10
                </span>
                <div>
                  <div style={{ fontWeight: 600 }}>{v.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{v.justification}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>{result.summary}</p>

      {/* Banderas de riesgo */}
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8 }}>
          Banderas de riesgo (red / yellow flags)
        </div>
        <FlagList flags={result.flags} />
      </div>

      {/* Recomendación */}
      {result.recommendation && (
        <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>
            Recomendación del sistema
          </div>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>{result.recommendation}</p>
        </div>
      )}

      {result.contact && (
        <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>Métodos de contacto</div>
          {result.contact.noDataFound || result.contact.methods.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
              No se han encontrado datos de contacto verificables.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {result.contact.methods.map((m, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, fontSize: 13 }}>
                  <span style={{ textTransform: 'uppercase', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', minWidth: 60, paddingTop: 2 }}>
                    {m.channel}
                  </span>
                  <div>
                    <div style={{ fontWeight: 600 }}>{m.value}</div>
                    {m.note && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{m.note}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {result.firstContact && (
        <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>
            Primera toma de contacto · <span style={{ fontWeight: 400 }}>{result.firstContact.channel}</span>
          </div>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>{result.firstContact.approach}</p>
        </div>
      )}

      {sources && sources.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>
            Fuentes consultadas (búsqueda web)
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
            {sources.map((s, i) => (
              <li key={i}>
                <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                  {s.title || s.url}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CrmActionPanel({
  companyName,
  result,
  matchedCompany,
  onChanged,
}: {
  companyName: string;
  result: HerzogResult;
  matchedCompany: HerzogMatchedCompany | null;
  onChanged: (matched: HerzogMatchedCompany | null) => void;
}) {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheetId, setSheetId] = useState<number | null>(null);
  const [countries, setCountries] = useState<string[]>([]);
  const [country, setCountry] = useState('');
  const [cities, setCities] = useState<CityOption[]>([]);
  const [city, setCity] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (matchedCompany || !expanded) return;
    fetchSheets().then(({ sheets }) => {
      setSheets(sheets);
      if (sheets.length > 0) setSheetId(sheets[0].id);
    }).catch(() => {});
    fetchCountries().then(({ countries }) => setCountries(countries)).catch(() => {});
  }, [expanded, matchedCompany]);

  useEffect(() => {
    if (!country) { setCities([]); return; }
    fetchCities(country).then(({ cities }) => setCities(cities)).catch(() => {});
  }, [country]);

  async function handleAdd() {
    setError(null);
    if (sheetId == null) return setError('Selecciona una hoja del CRM');
    if (!country || !city) return setError('Selecciona país y ciudad');
    const cityOption = cities.find((c) => c.city === city);
    if (!cityOption) return setError('Ciudad inválida');

    setBusy(true);
    try {
      const { company } = await createCompany(sheetId, {
        name: companyName,
        country,
        city,
        lat: cityOption.lat,
        lng: cityOption.lng,
        status: suggestedStatus(result.verdict),
        notes: result.summary,
      });
      onChanged({ id: company.id, sheetId: company.sheetId });
      setExpanded(false);
    } catch (e: any) {
      setError(e?.message || 'Error al añadir al CRM');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!matchedCompany) return;
    if (!window.confirm(`¿Eliminar "${companyName}" del CRM? Esto la quita también del globo.`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteCompany(matchedCompany.id);
      onChanged(null);
    } catch (e: any) {
      setError(e?.message || 'Error al eliminar del CRM');
    } finally {
      setBusy(false);
    }
  }

  if (matchedCompany) {
    return (
      <div className="card" style={{ padding: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 13 }}>
          <strong>{companyName}</strong> ya está en el CRM (aparece en el globo 3D).
        </span>
        <button
          className="btn-secondary"
          onClick={handleDelete}
          disabled={busy}
          style={{ borderColor: 'rgba(255,107,107,0.5)', color: '#ff6b6b' }}
        >
          {busy ? 'Eliminando…' : 'Eliminar del CRM'}
        </button>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 13 }}>
          <strong>{companyName}</strong> no está en el CRM.
        </span>
        {!expanded && (
          <button className="btn-primary" onClick={() => setExpanded(true)}>Añadir al CRM</button>
        )}
      </div>

      {expanded && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Hoja</span>
              <select className="input-field" value={sheetId ?? ''} onChange={(e) => setSheetId(Number(e.target.value))}>
                {sheets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>País</span>
              <select className="input-field" value={country} onChange={(e) => { setCountry(e.target.value); setCity(''); }}>
                <option value="">Selecciona país…</option>
                {countries.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Ciudad</span>
              <select className="input-field" value={city} onChange={(e) => setCity(e.target.value)} disabled={!country}>
                <option value="">Selecciona ciudad…</option>
                {cities.map((c) => <option key={c.city} value={c.city}>{c.city}</option>)}
              </select>
            </label>
          </div>
          {error && <div style={{ color: '#ff6b6b', fontSize: 12 }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn-secondary" onClick={() => setExpanded(false)}>Cancelar</button>
            <button className="btn-primary" onClick={handleAdd} disabled={busy}>
              {busy ? 'Añadiendo…' : 'Confirmar alta'}
            </button>
          </div>
        </>
      )}
      {!expanded && error && <div style={{ color: '#ff6b6b', fontSize: 12 }}>{error}</div>}
    </div>
  );
}

export function HerzogPanel() {
  const [companyName, setCompanyName] = useState('');
  const [evalType, setEvalType] = useState<HerzogEvalType>('CLIENTE');
  const [text, setText] = useState('');
  const [result, setResult] = useState<HerzogResult | null>(null);
  const [auditedName, setAuditedName] = useState('');
  const [sources, setSources] = useState<HerzogSource[]>([]);
  const [matchedCompany, setMatchedCompany] = useState<HerzogMatchedCompany | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HerzogAudit[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  useEffect(() => {
    loadHistory();
  }, []);

  // Toda auditoria pasa por normalizeResult antes de tocar el estado: asi la UI
  // solo maneja una forma, venga del backend nuevo o de uno sin reiniciar.
  function loadHistory() {
    fetchHerzogHistory()
      .then(({ audits }) => setHistory(audits.map((a) => ({
        ...a,
        evalType: a.evalType ?? 'CLIENTE',
        result: normalizeResult(a.result, a.evalType ?? 'CLIENTE'),
      }))))
      .catch(() => {});
  }

  async function handleDeleteAudit(id: number, name: string) {
    if (!window.confirm(`¿Eliminar la auditoría de "${name}" del historial? Esto no afecta al CRM.`)) return;
    setDeletingId(id);
    try {
      await deleteHerzogAudit(id);
      setHistory((prev) => prev.filter((a) => a.id !== id));
      if (expandedId === id) setExpandedId(null);
    } catch (e: any) {
      setError(e?.message || 'Error al eliminar la auditoría');
    } finally {
      setDeletingId(null);
    }
  }

  async function handleAudit() {
    setError(null);
    if (!companyName.trim()) {
      setError('Indica el nombre de la empresa');
      return;
    }
    setLoading(true);
    setResult(null);
    setSources([]);
    setMatchedCompany(null);
    try {
      const { result, sources, matchedCompany } = await runHerzogAudit(
        companyName.trim(),
        text.trim() || companyName.trim(),
        evalType,
      );
      setResult(normalizeResult(result, evalType));
      setAuditedName(companyName.trim());
      setSources(sources);
      setMatchedCompany(matchedCompany);
      loadHistory();
    } catch (e: any) {
      setError(e?.message || 'Error al ejecutar la auditoría');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fade-up" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 900 }}>
      <div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
          Acreditación de empresas para S-NFI. Elige el tipo de evaluación (Cliente o Financiador) e indica la empresa
          candidata — Herzog investiga información pública real por búsqueda web (webs oficiales, registro mercantil,
          noticias, informes anuales, perfiles profesionales), puntúa las 4 categorías con los pesos propios de cada tipo,
          detalla las variables individuales, levanta banderas de riesgo y emite el dictamen final. Puedes añadir texto o
          URLs propias para orientar la investigación.
        </p>
      </div>

      <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Selector de tipo de acreditación A/B */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Tipo de acreditación</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {(Object.keys(EVAL_TYPE_META) as HerzogEvalType[]).map((t) => {
              const active = evalType === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setEvalType(t)}
                  style={{
                    flex: 1, padding: '10px 12px', borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--border-mid)'}`,
                    background: active ? 'rgba(0,113,227,0.08)' : 'transparent',
                    color: 'inherit', font: 'inherit',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{EVAL_TYPE_META[t].label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>
                    {EVAL_TYPE_META[t].hint}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Nombre de la empresa</span>
          <input className="input-field" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Empresa Candidata S.L." />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Información adicional (opcional)</span>
          <textarea
            className="input-field"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            placeholder="Opcional: pega información que ya tengas sobre la empresa o incluye la URL de su web — Herzog la combina con la búsqueda web real. Si lo dejas vacío, Herzog investiga solo a partir del nombre."
          />
        </label>
        {error && <div style={{ color: '#ff6b6b', fontSize: 12 }}>{error}</div>}
        <div>
          <button className="btn-primary" onClick={handleAudit} disabled={loading}>
            {loading ? 'Acreditando…' : 'Ejecutar acreditación'}
          </button>
        </div>
      </div>

      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
          <span className="spinner" />
        </div>
      )}

      {result && (
        <>
          <ResultCard result={result} companyName={auditedName} sources={sources} />
          <CrmActionPanel
            companyName={auditedName}
            result={result}
            matchedCompany={matchedCompany}
            onChanged={setMatchedCompany}
          />
        </>
      )}

      {history.length > 0 && (
        <div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', marginBottom: 12 }}>Historial</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {history.map((audit) => {
              const meta = VERDICT_META[audit.result.verdict] ?? VERDICT_META.REVISION_MANUAL;
              const typeMeta = EVAL_TYPE_META[audit.evalType] ?? EVAL_TYPE_META.CLIENTE;
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
                      <span style={{
                        fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
                        border: '1px solid var(--border-mid)', borderRadius: 4, padding: '1px 5px',
                      }}>
                        {typeMeta.short}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{meta.label}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                      {typeof audit.result.overallScore === 'number' && (
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700 }}>
                          {audit.result.overallScore.toFixed(1)}/10
                        </span>
                      )}
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {new Date(audit.createdAt).toLocaleDateString('es-ES')}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteAudit(audit.id, audit.companyName); }}
                        disabled={deletingId === audit.id}
                        title="Eliminar auditoría del historial"
                        style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#ff6b6b', fontSize: 14, lineHeight: 1, padding: 2 }}
                      >
                        {deletingId === audit.id ? '…' : '🗑'}
                      </button>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{isOpen ? '▲' : '▼'}</span>
                    </div>
                  </div>
                  {isOpen && (
                    <div style={{ padding: '0 12px 16px', display: 'flex', flexDirection: 'column', gap: 12, borderTop: '1px solid var(--border-subtle)' }}>
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>
                          Información sustraída
                        </div>
                        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{audit.inputText}</p>
                      </div>
                      <ResultCard result={audit.result} companyName={audit.companyName} sources={audit.sources} />
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
