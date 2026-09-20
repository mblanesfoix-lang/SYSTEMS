import { useState } from 'react';
import type { Sheet } from '../lib/api';

interface Props {
  sheets: Sheet[];
  activeSheetId: number | null;
  onSelect: (id: number) => void;
  onCreate: (name: string) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
}

export function SheetTabs({ sheets, activeSheetId, onSelect, onCreate, onRename, onDelete }: Props) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');

  function startEdit(sheet: Sheet) {
    setEditingId(sheet.id);
    setEditValue(sheet.name);
  }

  function commitEdit() {
    if (editingId != null && editValue.trim()) {
      onRename(editingId, editValue.trim());
    }
    setEditingId(null);
  }

  function handleCreate() {
    const name = window.prompt('Nombre de la nueva hoja:');
    if (name && name.trim()) onCreate(name.trim());
  }

  return (
    <div className="crm-tabs">
      {sheets.map((sheet) => {
        const active = sheet.id === activeSheetId;
        return (
          <div
            key={sheet.id}
            onClick={() => onSelect(sheet.id)}
            onDoubleClick={() => startEdit(sheet)}
            className={`crm-tab${active ? ' crm-tab--active' : ''}`}
          >
            {editingId === sheet.id ? (
              <input
                autoFocus
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEdit();
                  if (e.key === 'Escape') setEditingId(null);
                }}
                onClick={(e) => e.stopPropagation()}
                className="crm-tab__edit"
              />
            ) : (
              <span>{sheet.name}</span>
            )}
            <span className="crm-tab__count">{sheet.companyCount}</span>
            {sheets.length > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`¿Eliminar la hoja "${sheet.name}" y todas sus empresas?`)) onDelete(sheet.id);
                }}
                className="crm-tab__delete"
                title="Eliminar hoja"
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      <button onClick={handleCreate} className="crm-tab__add" title="Nueva hoja">
        +
      </button>
    </div>
  );
}
