import crypto from 'node:crypto';
import { getReffDb, nextSeq } from './mongo.js';
import { callLlm, llmStatus } from './llm.js';

const CRON_SCHEDULE = process.env.WATCH_CRON_SCHEDULE || '0 */6 * * *';
// Varias búsquedas web por consulta: más margen que una llamada normal a la IA.
const WATCH_TIMEOUT_MS = 120_000;
// La vigilancia corre sola, sin usuario: su consumo se imputa al sistema.
const WATCH_USAGE_USER = 'sistema';

export const WATCH_CATEGORIES = ['residuos_inversion', 'asociaciones', 'novedades'] as const;
export type WatchCategory = typeof WATCH_CATEGORIES[number];

const CATEGORY_PROMPT: Record<WatchCategory, string> = {
  residuos_inversion:
    'Busca noticias recientes sobre cómo "{name}" gestiona sus residuos orgánicos y sus inversiones en tratamiento de residuos, economía circular o valorización de subproductos.',
  asociaciones:
    'Busca noticias recientes sobre empresas asociadas, filiales, joint ventures, adquisiciones o integraciones de "{name}" (ej. creación de subempresas, alianzas anunciadas públicamente).',
  novedades:
    'Busca novedades corporativas recientes y relevantes sobre "{name}" (resultados, proyectos, anuncios, regulación que le afecte).',
};

export interface WatchCompanyDoc {
  _id: number;
  name: string;
  sector: string | null;
  country: string | null;
  active: boolean;
  created_by: string;
  created_at: string;
}

export interface WatchNewsDoc {
  _id: number;
  company_id: number;
  category: WatchCategory;
  headline: string;
  summary: string;
  url: string | null;
  source_date: string | null;
  dedupe_hash: string;
  detected_at: string;
}

interface ParsedItem {
  headline: string;
  summary: string;
  url: string | null;
  sourceDate: string | null;
}

function parseItems(text: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  const blocks = text.split(/\n(?=TITULAR:)/i);
  for (const block of blocks) {
    const headline = block.match(/TITULAR:\s*(.+)/i)?.[1]?.trim();
    if (!headline) continue;
    const summary = block.match(/RESUMEN:\s*(.+)/i)?.[1]?.trim() || '';
    const url = block.match(/URL:\s*(\S+)/i)?.[1]?.trim() || null;
    const sourceDate = block.match(/FECHA:\s*(\S+)/i)?.[1]?.trim() || null;
    if (/^(sin novedades|ninguna|no hay)/i.test(headline)) continue;
    items.push({ headline, summary, url: url && url !== 'N/A' ? url : null, sourceDate: sourceDate && sourceDate !== 'N/A' ? sourceDate : null });
  }
  return items;
}

function dedupeHash(companyId: number, category: WatchCategory, item: ParsedItem): string {
  const key = item.url || `${item.headline}`;
  return crypto.createHash('sha256').update(`${companyId}:${category}:${key}`).digest('hex');
}

async function searchCategory(company: WatchCompanyDoc, category: WatchCategory): Promise<void> {
  // Sin IA con búsqueda web la vigilancia espera, sin errores, hasta que la haya.
  if (!llmStatus().webSearch) return;

  const instruction = CATEGORY_PROMPT[category].replace('{name}', company.name);

  const system = `Eres el módulo de vigilancia informativa de Rëff (S-NFI). Usa la herramienta de búsqueda web para encontrar noticias REALES y RECIENTES (últimos 30 días si es posible).
Responde solo con bloques en este formato exacto, uno por noticia encontrada (máximo 5):

TITULAR: <titular corto>
RESUMEN: <resumen 2-3 frases>
URL: <url fuente o N/A>
FECHA: <fecha publicación AAAA-MM-DD o N/A>

Si no encuentras nada relevante, responde exactamente: TITULAR: Sin novedades`;

  try {
    const result = await callLlm({
      system,
      prompt: instruction,
      maxTokens: 1500,
      webSearch: { maxUses: 4 },
      timeoutMs: WATCH_TIMEOUT_MS,
      user: WATCH_USAGE_USER,
      operation: 'reff-watch',
    });

    const items = parseItems(result.parts.join('\n'));
    if (items.length === 0) return;

    const db = getReffDb();
    const news = db.collection<WatchNewsDoc>('watch_news');
    const now = new Date().toISOString();

    for (const item of items) {
      const hash = dedupeHash(company._id, category, item);
      const id = await nextSeq('watch_news');
      try {
        await news.insertOne({
          _id: id,
          company_id: company._id,
          category,
          headline: item.headline,
          summary: item.summary,
          url: item.url,
          source_date: item.sourceDate,
          dedupe_hash: hash,
          detected_at: now,
        });
      } catch (err: any) {
        if (err?.code !== 11000) throw err; // 11000 = duplicado (ya visto), se ignora
      }
    }
  } catch (err) {
    console.error(`[Rëff][watch] Error buscando "${company.name}" / ${category}:`, (err as Error).message);
  }
}

export async function runWatchCycle(companyId?: number): Promise<void> {
  const db = getReffDb();
  const filter = companyId ? { _id: companyId, active: true } : { active: true };
  const companies = await db.collection<WatchCompanyDoc>('watch_companies').find(filter as never).toArray();

  for (const company of companies) {
    for (const category of WATCH_CATEGORIES) {
      await searchCategory(company, category);
    }
  }
}

let cronStarted = false;

export function startWatchCron(): void {
  if (cronStarted) return;
  cronStarted = true;

  import('node-cron').then(({ default: cron }) => {
    cron.schedule(CRON_SCHEDULE, () =>
      runWatchCycle().catch((err) => console.error('[Rëff][watch] Ciclo cron falló:', err)),
    { name: 'reff-watch', noOverlap: true });
    console.log(`[Rëff][watch] Cron activo (${CRON_SCHEDULE})`);
  }).catch((err) => {
    console.error('[Rëff][watch] No se pudo cargar node-cron:', err.message);
  });
}
