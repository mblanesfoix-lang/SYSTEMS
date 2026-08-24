import { useEffect, useState } from 'react';
import {
  fetchCountries, fetchCities, addCompanyTask, updateCompanyTask, deleteCompanyTask,
  type Company, type CompanyInput, type CompanyStatus, type CityOption,
} from '../lib/api';
import { STATUS_META, STATUS_OPTIONS } from '../lib/status';
import { CompanyImages } from './CompanyImages';

interface Props {
  company: Company | null;
  onClose: () => void;
  onSave: (input: CompanyInput) => Promise<void>;
  onDelete?: () => void;
}

export function CompanyModal({ company, onClose, onSave, onDelete }: Props) {
  const [name, setName] = useState(company?.name || '');
  const [countries, setCountries] = useState<string[]>([]);
  const [country, setCountry] = useState(company?.country || '');
  const [cities, setCities] = useState<CityOption[]>([]);
  const [city, setCity] = useState(company?.city || '');
  const [status, setStatus] = useState<CompanyStatus>(company?.status || 'pendiente');
  const [sector, setSector] = useState(company?.sector || '');
  const [tonnageYear, setTonnageYear] = useState(company?.tonnageYear?.toString() || '');
  const [notes, setNotes] = useState(company?.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tasks, setTasks] = useState(company?.tasks || []);
  const [newTaskTitle, setNewTaskTitle] = useState('');

  useEffect(() => {
    fetchCountries().then(({ countries }) => setCountries(countries)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!country) {
      setCities([]);
      return;
    }
    fetchCities(country).then(({ cities }) => setCities(cities)).catch(() => {});
  }, [country]);

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) return setError('El nombre es obligatorio');
    if (!country || !city) return setError('Selecciona país y ciudad');

    const cityOption = cities.find((c) => c.city === city);
    if (!cityOption) return setError('Ciudad inválida');

    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        country,
        city,
        lat: cityOption.lat,
        lng: cityOption.lng,
        status,
        sector: sector.trim() || null,
        tonnageYear: tonnageYear ? Number(tonnageYear) : null,
        notes: notes.trim() || null,
      });
    } catch (err: any) {
      setError(err?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  async function handleAddTask() {
    if (!company || !newTaskTitle.trim()) return;
    try {
      const { task } = await addCompanyTask(company.id, newTaskTitle.trim());
      setTasks((prev) => [...prev, task]);
      setNewTaskTitle('');
    } catch (err: any) {
      setError(err?.message || 'Error al añadir tarea');
    }
  }

  async function handleToggleTask(taskId: number, done: boolean) {
    try {
      const { task } = await updateCompanyTask(taskId, { done });
      setTasks((prev) => prev.map((t) => (t.id === taskId ? task : t)));
    } catch (err: any) {
      setError(err?.message || 'Error al actualizar tarea');
    }
  }

  async function handleDeleteTask(taskId: number) {
    try {
      await deleteCompanyTask(taskId);
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
    } catch (err: any) {
      setError(err?.message || 'Error al eliminar tarea');
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        className="card fade-up"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560, maxHeight: '88vh', overflowY: 'auto', background: 'var(--surface-1)',
          padding: 28, display: 'flex', flexDirection: 'column', gap: 16,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: '1.1rem' }}>
            {company ? 'Editar empresa' : 'Nueva empresa'}
          </h2>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--text-muted)' }}>×</button>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Nombre de la empresa</span>
          <input className="input-field" value={name} onChange={(e) => setName(e.target.value)} placeholder="S-NFI Candidate S.L." />
        </label>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
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

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Estado</span>
            <select className="input-field" value={status} onChange={(e) => setStatus(e.target.value as CompanyStatus)}>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Toneladas / año</span>
            <input className="input-field" type="number" min="0" value={tonnageYear} onChange={(e) => setTonnageYear(e.target.value)} placeholder="0" />
          </label>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sector</span>
          <input className="input-field" value={sector} onChange={(e) => setSector(e.target.value)} placeholder="Agroalimentario, hostelería, distribución..." />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Notas</span>
          <textarea className="input-field" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Información relevante sobre la empresa..." />
        </label>

        {company && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Tareas</span>
            {tasks.map((t) => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={t.done} onChange={(e) => handleToggleTask(t.id, e.target.checked)} />
                <span style={{ flex: 1, fontSize: 13, textDecoration: t.done ? 'line-through' : 'none', opacity: t.done ? 0.5 : 1 }}>{t.title}</span>
                <button onClick={() => handleDeleteTask(t.id)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14 }}>×</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="input-field"
                value={newTaskTitle}
                onChange={(e) => setNewTaskTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddTask(); }}
                placeholder="Nueva tarea..."
              />
              <button className="btn-secondary" onClick={handleAddTask}>Añadir</button>
            </div>
          </div>
        )}

        {company && <CompanyImages companyId={company.id} />}

        {error && <div style={{ color: '#b3322c', fontSize: 12 }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
          {company && onDelete ? (
            <button
              className="btn-secondary"
              onClick={() => { if (window.confirm(`¿Eliminar "${company.name}"?`)) onDelete(); }}
              style={{ borderColor: '#b3322c', color: '#b3322c' }}
            >
              Eliminar
            </button>
          ) : <span />}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-secondary" onClick={onClose}>Cancelar</button>
            <button className="btn-primary" onClick={handleSubmit} disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
