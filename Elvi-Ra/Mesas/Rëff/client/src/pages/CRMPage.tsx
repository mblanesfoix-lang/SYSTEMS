import { useEffect, useState } from 'react';
import { SheetTabs } from '../components/SheetTabs';
import { CompanyTable } from '../components/CompanyTable';
import { CompanyModal } from '../components/CompanyModal';
import {
  fetchSheets, createSheet, renameSheet, deleteSheet,
  fetchCompanies, createCompany, updateCompany, deleteCompany,
  type Sheet, type Company, type CompanyInput,
} from '../lib/api';

export function CRMPage() {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [activeSheetId, setActiveSheetId] = useState<number | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalCompany, setModalCompany] = useState<Company | null | 'new'>(null);

  useEffect(() => {
    fetchSheets()
      .then(({ sheets }) => {
        setSheets(sheets);
        if (sheets.length > 0) setActiveSheetId(sheets[0].id);
      })
      .catch((e) => setError(e?.message || 'Error al cargar hojas'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (activeSheetId == null) return;
    fetchCompanies(activeSheetId)
      .then(({ companies }) => setCompanies(companies))
      .catch((e) => setError(e?.message || 'Error al cargar empresas'));
  }, [activeSheetId]);

  function refreshSheetCounts() {
    fetchSheets().then(({ sheets }) => setSheets(sheets)).catch(() => {});
  }

  async function handleCreateSheet(name: string) {
    try {
      const { sheet } = await createSheet(name);
      setSheets((prev) => [...prev, sheet]);
      setActiveSheetId(sheet.id);
    } catch (e: any) {
      setError(e?.message || 'Error al crear hoja');
    }
  }

  async function handleRenameSheet(id: number, name: string) {
    try {
      const { sheet } = await renameSheet(id, name);
      setSheets((prev) => prev.map((s) => (s.id === id ? { ...s, name: sheet.name } : s)));
    } catch (e: any) {
      setError(e?.message || 'Error al renombrar hoja');
    }
  }

  async function handleDeleteSheet(id: number) {
    try {
      await deleteSheet(id);
      const remaining = sheets.filter((s) => s.id !== id);
      setSheets(remaining);
      if (activeSheetId === id) setActiveSheetId(remaining[0]?.id ?? null);
    } catch (e: any) {
      setError(e?.message || 'Error al eliminar hoja');
    }
  }

  async function handleSaveCompany(input: CompanyInput) {
    if (activeSheetId == null) return;
    if (modalCompany === 'new') {
      const { company } = await createCompany(activeSheetId, input);
      setCompanies((prev) => [...prev, company]);
    } else if (modalCompany) {
      const { company } = await updateCompany(modalCompany.id, input);
      setCompanies((prev) => prev.map((c) => (c.id === company.id ? company : c)));
    }
    setModalCompany(null);
    refreshSheetCounts();
  }

  async function handleDeleteCompany() {
    if (!modalCompany || modalCompany === 'new') return;
    await deleteCompany(modalCompany.id);
    setCompanies((prev) => prev.filter((c) => c.id !== modalCompany.id));
    setModalCompany(null);
    refreshSheetCounts();
  }

  if (loading) {
    return (
      <div className="crm-tech" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <span className="spinner" style={{ borderTopColor: '#33ff9c' }} />
      </div>
    );
  }

  return (
    <div className="crm-tech">
      <div className="crm-tech__header">
        <h1 className="crm-tech__title">CRM</h1>
        <p className="crm-tech__subtitle">
          Excel inteligente. Organiza empresas por hojas, define su estado y su ubicación para verlas en el Dashboard.
        </p>
      </div>

      <SheetTabs
        sheets={sheets}
        activeSheetId={activeSheetId}
        onSelect={setActiveSheetId}
        onCreate={handleCreateSheet}
        onRename={handleRenameSheet}
        onDelete={handleDeleteSheet}
      />

      <div className="crm-toolbar">
        <button className="crm-btn" onClick={() => setModalCompany('new')} disabled={activeSheetId == null}>
          + Añadir empresa
        </button>
      </div>

      {error && <div className="crm-error">{error}</div>}

      <div className="crm-panel">
        <CompanyTable companies={companies} onEdit={setModalCompany} />
      </div>

      {modalCompany && (
        <CompanyModal
          company={modalCompany === 'new' ? null : modalCompany}
          onClose={() => setModalCompany(null)}
          onSave={handleSaveCompany}
          onDelete={modalCompany !== 'new' ? handleDeleteCompany : undefined}
        />
      )}
    </div>
  );
}
