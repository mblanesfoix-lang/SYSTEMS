const API_URL = import.meta.env.VITE_API_URL || '';
const TOKEN_KEY = 'reff_token';
const USER_KEY = 'reff_user';

export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): User | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

// Pide un JWT de Rëff a partir de la sesión activa de Elvi-Ra (mismo origen,
// mismo localStorage). Sin esto, App.tsx nunca tiene user/token y se queda
// en el spinner o referencia un userId obsoleto.
export async function fetchGuestToken(): Promise<{ token: string; user: User } | null> {
  const elviraUser = localStorage.getItem('elvira_user') || '';
  const res = await fetch(`${API_URL}/api/guest-token`, {
    headers: elviraUser ? { 'x-elvira-user': elviraUser } : {},
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data?.token || !data?.user) return null;
  localStorage.setItem(TOKEN_KEY, data.token);
  localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  return data;
}

// Cierra también la sesión de Elvi-Ra (mismo localStorage, mismo origen) para que
// el logout desde Rëff cierre sesión en toda la plataforma.
export function clearElviraSession(): void {
  localStorage.removeItem('elvira_token');
  localStorage.removeItem('elvira_user');
  localStorage.removeItem('elvira_active_sheet');
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body != null) {
    headers.set('Content-Type', 'application/json');
  }
  const token = getToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) clearSession();
    throw new Error((data as any).error || `Error HTTP ${res.status}`);
  }
  return data as T;
}

/* ---------- sheets ---------- */

export interface Sheet {
  id: number;
  name: string;
  position: number;
  companyCount: number;
}

export async function fetchSheets() {
  return request<{ sheets: Sheet[] }>('/api/crm/sheets');
}

export async function createSheet(name: string) {
  return request<{ sheet: Sheet }>('/api/crm/sheets', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function renameSheet(id: number, name: string) {
  return request<{ sheet: Sheet }>(`/api/crm/sheets/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

export async function deleteSheet(id: number) {
  return request<{ ok: true }>(`/api/crm/sheets/${id}`, { method: 'DELETE' });
}

/* ---------- companies ---------- */

export type CompanyStatus = 'estrategico' | 'operativo' | 'pendiente' | 'no_candidato';

export interface CompanyTask {
  id: number;
  title: string;
  done: boolean;
  dueDate: string | null;
  createdAt: string;
}

export interface Company {
  id: number;
  sheetId: number;
  name: string;
  country: string;
  city: string;
  lat: number;
  lng: number;
  status: CompanyStatus;
  sector: string | null;
  tonnageYear: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  tasks: CompanyTask[];
}

export interface CompanyInput {
  name: string;
  country: string;
  city: string;
  lat: number;
  lng: number;
  status?: CompanyStatus;
  sector?: string | null;
  tonnageYear?: number | null;
  notes?: string | null;
}

export async function fetchCompanies(sheetId: number) {
  return request<{ companies: Company[] }>(`/api/crm/sheets/${sheetId}/companies`);
}

export async function createCompany(sheetId: number, input: CompanyInput) {
  return request<{ company: Company }>(`/api/crm/sheets/${sheetId}/companies`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateCompany(id: number, input: Partial<CompanyInput> & { sheetId?: number }) {
  return request<{ company: Company }>(`/api/crm/companies/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteCompany(id: number) {
  return request<{ ok: true }>(`/api/crm/companies/${id}`, { method: 'DELETE' });
}

/* ---------- imágenes por empresa ---------- */

export interface CompanyImage {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  uploadedAt: string | null;
}

export async function fetchCompanyImages(companyId: number) {
  return request<{ images: CompanyImage[] }>(`/api/crm/companies/${companyId}/images`);
}

// Subida raw (sin multipart): el body es el File directamente.
export async function uploadCompanyImage(companyId: number, file: File) {
  const headers = new Headers();
  headers.set('Content-Type', file.type);
  headers.set('X-Filename', encodeURIComponent(file.name));
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(`${API_URL}/api/crm/companies/${companyId}/images`, {
    method: 'POST',
    body: file,
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error || `Error HTTP ${res.status}`);
  return data as { image: CompanyImage };
}

export async function deleteCompanyImage(imageId: string) {
  return request<{ ok: true }>(`/api/crm/images/${imageId}`, { method: 'DELETE' });
}

// Las imágenes exigen Authorization, así que un <img src> directo no sirve:
// se baja el blob autenticado y se sirve como object URL (revocar al desmontar).
export async function fetchImageObjectUrl(imageId: string): Promise<string> {
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(`${API_URL}/api/crm/images/${imageId}`, { headers });
  if (!res.ok) throw new Error('No se pudo cargar la imagen');
  return URL.createObjectURL(await res.blob());
}

export async function addCompanyTask(companyId: number, title: string, dueDate?: string | null) {
  return request<{ task: CompanyTask }>(`/api/crm/companies/${companyId}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ title, dueDate }),
  });
}

export async function updateCompanyTask(taskId: number, input: Partial<Pick<CompanyTask, 'title' | 'done' | 'dueDate'>>) {
  return request<{ task: CompanyTask }>(`/api/crm/tasks/${taskId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteCompanyTask(taskId: number) {
  return request<{ ok: true }>(`/api/crm/tasks/${taskId}`, { method: 'DELETE' });
}

/* ---------- geo ---------- */

export interface CityOption {
  city: string;
  lat: number;
  lng: number;
}

export async function fetchCountries() {
  return request<{ countries: string[] }>('/api/geo/countries');
}

export async function fetchCities(country: string) {
  return request<{ cities: CityOption[] }>(`/api/geo/cities?country=${encodeURIComponent(country)}`);
}

export interface GlobeCity {
  city: string;
  country: string;
  lat: number;
  lng: number;
  companies: { id: number; name: string; status: CompanyStatus; sheetId: number }[];
}

export async function fetchGlobeCities() {
  return request<{ cities: GlobeCity[] }>('/api/geo/globe');
}

/* ---------- Herzog ---------- */

export interface HerzogResult {
  scores: { W: number; I: number; S: number; M: number; E: number; R: number };
  overall: number;
  classification: 'ESTRATEGICO' | 'OPERATIVO' | 'NO_CANDIDATO';
  summary: string;
  highlights: string[];
  risks: string[];
}

export async function runHerzogAudit(companyName: string, text: string) {
  return request<{ result: HerzogResult }>('/api/herzog/audit', {
    method: 'POST',
    body: JSON.stringify({ companyName, text }),
  });
}

export interface HerzogAudit {
  id: number;
  companyName: string;
  inputText: string;
  result: HerzogResult;
  createdAt: string;
}

export async function fetchHerzogHistory() {
  return request<{ audits: HerzogAudit[] }>('/api/herzog/history');
}

/* ---------- Vigilancia (watch) ---------- */

export type WatchCategory = 'residuos_inversion' | 'asociaciones' | 'novedades';

export interface WatchCompany {
  id: number;
  name: string;
  sector: string | null;
  country: string | null;
  active: boolean;
  createdBy: string;
  createdAt: string;
}

export interface WatchNews {
  id: number;
  companyId: number;
  category: WatchCategory;
  headline: string;
  summary: string;
  url: string | null;
  sourceDate: string | null;
  detectedAt: string;
}

export async function fetchWatchCompanies() {
  return request<{ companies: WatchCompany[] }>('/api/watch/companies');
}

export async function createWatchCompany(input: { name: string; sector?: string | null; country?: string | null }) {
  return request<{ company: WatchCompany }>('/api/watch/companies', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateWatchCompany(id: number, input: Partial<{ name: string; sector: string | null; country: string | null; active: boolean }>) {
  return request<{ company: WatchCompany }>(`/api/watch/companies/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteWatchCompany(id: number) {
  return request<{ ok: true }>(`/api/watch/companies/${id}`, { method: 'DELETE' });
}

export async function fetchWatchNews(filters?: { companyId?: number; category?: WatchCategory }) {
  const params = new URLSearchParams();
  if (filters?.companyId !== undefined) params.set('companyId', String(filters.companyId));
  if (filters?.category) params.set('category', filters.category);
  const qs = params.toString();
  return request<{ news: WatchNews[] }>(`/api/watch/news${qs ? `?${qs}` : ''}`);
}

export async function deleteWatchNews(id: number) {
  return request<{ ok: true }>(`/api/watch/news/${id}`, { method: 'DELETE' });
}

export async function runWatchNow(companyId?: number) {
  return request<{ ok: true; message: string }>('/api/watch/run', {
    method: 'POST',
    body: JSON.stringify(companyId !== undefined ? { companyId } : {}),
  });
}
