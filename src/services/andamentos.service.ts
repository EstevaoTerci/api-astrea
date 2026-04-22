import { Page } from 'playwright';
import {
  astreaApiPost,
  getAstreaUserId,
  withBrowserContext,
  WORKSPACE_PAGE_PATH,
} from '../browser/astrea-http.js';
import { navigateTo } from '../browser/navigator.js';
import { isRetryablePlaywrightError } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import type { Andamento } from '../models/index.js';
import type { FiltrosAndamento, ServiceResponse, PaginationMeta } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint REST: POST /api/v2/historical/query-history
// Descoberto interceptando os XHRs da página /#/main/folders/history/[,ID].
// Shape da resposta: { cursor, historicals: [{id, date, type, description,
// responsible, responsibleName, caseId, caseTitle, ...}] }
// ─────────────────────────────────────────────────────────────────────────────

interface RawHistorical {
  id?: number | string;
  date?: string;
  type?: string;
  description?: string;
  descriptionTranslation?: string;
  responsible?: number | string;
  responsibleName?: string;
  caseId?: number | string;
  caseTitle?: string;
  caseType?: string;
  isLawsuit?: boolean;
  [k: string]: unknown;
}

interface HistoryQueryResponse {
  cursor?: string;
  historicals?: RawHistorical[];
  count?: number;
  total?: number;
}

interface HistoryCountResponse {
  count?: number;
  total?: number;
  totalElements?: number;
}

function toDateOnly(iso?: string): string {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function mapHistoricalToAndamento(h: RawHistorical): Andamento {
  return {
    id: String(h.id ?? ''),
    processoId: String(h.caseId ?? ''),
    data: toDateOnly(h.date),
    descricao: String(h.description ?? h.descriptionTranslation ?? ''),
    tipo: h.type ?? undefined,
    responsavel: h.responsibleName ? String(h.responsibleName) : undefined,
    responsavelId: h.responsible ? String(h.responsible) : undefined,
    casoTitulo: h.caseTitle ? String(h.caseTitle) : undefined,
  };
}

function buildPayload(
  currentUserId: string,
  filtros?: FiltrosAndamento,
  overrides?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  let beginDate: string | null = null;
  let endDate: string | null = null;

  if (filtros?.dataInicio) beginDate = filtros.dataInicio;
  if (filtros?.dataFim) endDate = filtros.dataFim;

  if (!beginDate && !endDate && filtros?.dias) {
    const d = new Date();
    d.setDate(d.getDate() - filtros.dias);
    beginDate = d.toISOString().slice(0, 10);
  }

  const limite = filtros?.limite ?? 50;

  return {
    type: filtros?.tipo ?? 'ALL',
    instance: null,
    beginDate,
    endDate,
    caseId: null,
    description: null,
    tagIds: [],
    order: '-date',
    limit: limite,
    currentUserId,
    cursor: '',
    ...(overrides ?? {}),
  };
}

function aplicarFiltrosMemoria(
  items: Andamento[],
  filtros?: FiltrosAndamento,
): Andamento[] {
  let filtered = items;
  if (filtros?.responsavelId) {
    filtered = filtered.filter((a) => a.responsavelId === filtros.responsavelId);
  }
  if (filtros?.responsavel) {
    const q = filtros.responsavel.toLowerCase();
    filtered = filtered.filter((a) => a.responsavel?.toLowerCase().includes(q));
  }
  return filtered;
}

async function queryHistory(
  page: Page,
  payload: Record<string, unknown>,
): Promise<Andamento[]> {
  const res = await astreaApiPost<HistoryQueryResponse>(
    page,
    '/historical/query-history',
    payload,
  );
  const raw = res?.historicals ?? [];
  return raw.map(mapHistoricalToAndamento);
}

async function countHistory(
  page: Page,
  payload: Record<string, unknown>,
): Promise<number | undefined> {
  try {
    const res = await astreaApiPost<HistoryCountResponse>(
      page,
      '/historical/count',
      payload,
    );
    return res?.count ?? res?.total ?? res?.totalElements;
  } catch {
    return undefined;
  }
}

export async function listarAndamentos(
  processoId: string,
  filtros?: FiltrosAndamento,
): Promise<ServiceResponse<Andamento[]>> {
  try {
    const data = await withBrowserContext(async (page) => {
      await navigateTo(page, WORKSPACE_PAGE_PATH);
      const currentUserId = await getAstreaUserId(page);

      const payload = buildPayload(currentUserId, filtros, { caseId: processoId });
      const items = await queryHistory(page, payload);
      const filtered = aplicarFiltrosMemoria(items, filtros);

      const pagina = filtros?.pagina ?? 1;
      const limite = filtros?.limite ?? 50;

      // Quando há filtros que aplicamos em memória, o total real é filtered.length.
      // Caso contrário, conta total via /historical/count.
      let total = filtered.length;
      if (!filtros?.responsavel && !filtros?.responsavelId) {
        const backendTotal = await countHistory(page, payload);
        if (typeof backendTotal === 'number' && backendTotal >= filtered.length) {
          total = backendTotal;
        }
      }

      const meta: PaginationMeta = { pagina, limite, total };
      return { items: filtered, meta };
    });

    return { ok: true, data: data.items, meta: data.meta };
  } catch (err) {
    logger.error({ err }, 'Erro em listarAndamentos');
    return {
      ok: false,
      error: {
        message: err instanceof Error ? err.message : 'Erro desconhecido',
        code: 'API_ERROR',
        retryable: isRetryablePlaywrightError(err),
      },
    };
  }
}

/**
 * Retorna andamentos recentes do escritório (sem restrição de caso), aceita
 * filtros por janela de data, tipo e responsável.
 */
export async function buscarAndamentosRecentes(
  filtros?: FiltrosAndamento,
): Promise<ServiceResponse<Andamento[]>> {
  try {
    const data = await withBrowserContext(async (page) => {
      await navigateTo(page, WORKSPACE_PAGE_PATH);
      const currentUserId = await getAstreaUserId(page);

      const diasDefault = filtros?.dias ?? 30;
      const payload = buildPayload(currentUserId, { ...filtros, dias: diasDefault });
      const items = await queryHistory(page, payload);
      const filtered = aplicarFiltrosMemoria(items, filtros);

      const pagina = filtros?.pagina ?? 1;
      const limite = filtros?.limite ?? 50;

      let total = filtered.length;
      if (!filtros?.responsavel && !filtros?.responsavelId) {
        const backendTotal = await countHistory(page, payload);
        if (typeof backendTotal === 'number' && backendTotal >= filtered.length) {
          total = backendTotal;
        }
      }

      const meta: PaginationMeta = { pagina, limite, total };
      return { items: filtered, meta };
    });

    return { ok: true, data: data.items, meta: data.meta };
  } catch (err) {
    logger.error({ err }, 'Erro em buscarAndamentosRecentes');
    return {
      ok: false,
      error: {
        message: err instanceof Error ? err.message : 'Erro desconhecido',
        code: 'API_ERROR',
        retryable: isRetryablePlaywrightError(err),
      },
    };
  }
}
