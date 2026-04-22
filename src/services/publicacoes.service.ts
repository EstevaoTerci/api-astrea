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
import type { Publicacao } from '../models/index.js';
import type { FiltrosPublicacao, ServiceResponse, PaginationMeta } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint REST: POST /api/v2/clipping-service/query
// Descoberto interceptando os XHRs da página /#/main/clippings.
// Payload suporta filtros server-side: status, fromDate/toDate, caseResponsibleId,
// paginação por cursor/page/limit. Shape da resposta:
//   { clippings: [...], totalElements, currentPage, pageSize, totalPages }
// ─────────────────────────────────────────────────────────────────────────────

interface RawClipping {
  id?: number | string;
  releaseDate?: string;
  clippingDate?: string;
  publishDate?: string;
  content?: string;
  description?: string;
  snippet?: string;
  body?: string;
  processNumber?: string;
  lawsuitNumber?: string;
  caseNumber?: string;
  caseId?: number | string;
  caseTitle?: string;
  court?: string;
  courtCode?: string;
  tribunal?: string;
  status?: string;
  treated?: boolean;
  caseResponsibleName?: string;
  caseResponsibleId?: number | string;
  responsibleName?: string;
  responsible?: number | string;
  clippingSearchName?: string;
  [k: string]: unknown;
}

interface ClippingQueryResponse {
  clippings?: RawClipping[];
  items?: RawClipping[];
  totalElements?: number;
  currentPage?: number;
  pageSize?: number;
  totalPages?: number;
  cursor?: string;
}

function toDateOnly(iso?: string): string {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function mapClippingToPublicacao(c: RawClipping): Publicacao {
  const id = String(c.id ?? '');
  const data = toDateOnly(c.releaseDate ?? c.clippingDate ?? c.publishDate);
  const processoNumero = String(
    c.processNumber ?? c.lawsuitNumber ?? c.caseNumber ?? c.caseTitle ?? '',
  );
  const tribunal = c.court ?? c.courtCode ?? c.tribunal ?? undefined;
  const conteudo = String(c.content ?? c.description ?? c.snippet ?? c.body ?? '');
  const lida =
    typeof c.treated === 'boolean'
      ? c.treated
      : typeof c.status === 'string'
        ? c.status.toUpperCase() !== 'RECEIVED'
        : undefined;
  const responsavel = c.caseResponsibleName ?? c.responsibleName ?? c.clippingSearchName;

  return {
    id,
    processoNumero,
    tribunal,
    data,
    conteudo,
    lida,
    responsavel: responsavel ? String(responsavel) : undefined,
  };
}

async function queryClippings(
  page: Page,
  userId: string,
  filtros?: FiltrosPublicacao,
): Promise<{ items: Publicacao[]; totalElements: number }> {
  const pagina = filtros?.pagina ?? 1;
  const limite = filtros?.limite ?? 50;

  // Converter filtro "dias" para fromDate (backend aceita fromDate/toDate)
  let fromDate: string | null = null;
  if (filtros?.dataInicio) {
    fromDate = filtros.dataInicio;
  } else if (filtros?.dias) {
    const d = new Date();
    d.setDate(d.getDate() - filtros.dias);
    fromDate = d.toISOString().slice(0, 10);
  }
  const toDate: string | null = filtros?.dataFim ?? null;

  // Tradução de lida → status no backend
  // lida=true → TREATED? Alguns valores são rejeitados pelo backend. Deixar
  // filtro "lida" em memória por compatibilidade.
  const payload = {
    order: '-releaseDate',
    cursor: '',
    page: pagina - 1,
    limit: limite,
    caseId: null,
    caseTitle: null,
    fromDate,
    toDate,
    endCreateDate: null,
    customerId: null,
    dateFilter: null,
    clippingTypeFilter: null,
    subpoenaStatusFilter: null,
    caseStatusFilter: null,
    status: null,
    clippingSearchName: null,
    state: null,
    userId,
    caseResponsibleId: null,
    dateToShow: 'CLIPPING_DATE',
  };

  const res = await astreaApiPost<ClippingQueryResponse>(
    page,
    '/clipping-service/query',
    payload,
  );

  const raw = res?.clippings ?? res?.items ?? [];
  const mapped = raw.map(mapClippingToPublicacao);
  return { items: mapped, totalElements: res?.totalElements ?? mapped.length };
}

export async function listarPublicacoes(
  filtros?: FiltrosPublicacao,
): Promise<ServiceResponse<Publicacao[]>> {
  try {
    const result = await withBrowserContext(async (page) => {
      await navigateTo(page, WORKSPACE_PAGE_PATH);
      const userId = await getAstreaUserId(page);

      const { items, totalElements } = await queryClippings(page, userId, filtros);

      let filtered = items;

      if (filtros?.lida !== undefined) {
        filtered = filtered.filter((p) => p.lida === filtros.lida);
      }

      if (filtros?.responsavel) {
        const q = filtros.responsavel.toLowerCase();
        filtered = filtered.filter((p) => p.responsavel?.toLowerCase().includes(q));
      }

      const pagina = filtros?.pagina ?? 1;
      const limite = filtros?.limite ?? 50;
      // totalElements vem do backend (global); se houve filtro em memória, o total
      // efetivo é `filtered.length` do slice atual. Reportar o total do backend
      // quando não há filtros em memória; caso contrário, `filtered.length`.
      const total =
        filtros?.lida !== undefined || filtros?.responsavel ? filtered.length : totalElements;

      const meta: PaginationMeta = { pagina, limite, total };
      return { items: filtered, meta };
    });

    return { ok: true, data: result.items, meta: result.meta };
  } catch (err) {
    logger.error({ err }, 'Erro em listarPublicacoes');
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

export async function buscarPublicacoesRecentes(
  dias = 7,
  filtros?: FiltrosPublicacao,
): Promise<ServiceResponse<Publicacao[]>> {
  return listarPublicacoes({ ...filtros, dias });
}
