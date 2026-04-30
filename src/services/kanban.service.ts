import { Page } from 'playwright';
import { navigateTo } from '../browser/navigator.js';
import {
  withBrowserContext,
  astreaApiGet,
  astreaApiPost,
  astreaApiPut,
  ANGULAR_PAGE_PATH,
} from '../browser/astrea-http.js';
import { logger } from '../utils/logger.js';
import { urlCaso } from '../utils/astrea-urls.js';
import { isRetryablePlaywrightError } from '../utils/retry.js';
import { listarUsuarios } from './usuarios.service.js';
import type {
  QuadroKanban,
  ColunaKanban,
  TipoColunaKanban,
  AtividadeKanban,
  AtividadesPorColuna,
  QuadroAtividades,
  PrioridadeKanban,
  FiltrosAtividadeKanban,
} from '../models/index.js';
import type { ServiceResponse } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos internos da API REST do Astrea
// ─────────────────────────────────────────────────────────────────────────────

interface RawColumn {
  id: number | string;
  name: string;
  type: TipoColunaKanban;
  color?: string;
}

interface RawKanban {
  id: number | string;
  name: string;
  default?: boolean;
  columns: RawColumn[];
}

interface RawActivity {
  id: number | string;
  type: string;
  title?: string;
  titleWithName?: string;
  done?: boolean;
  dateStart?: string;
  responsibleId?: number | string;
  ownerId?: number | string;
  involvedIds?: Array<number | string>;
  caseId?: number | string;
  caseTitle?: string;
  completeLawsuit?: string;
  commentCount?: number;
  createdDate?: number;
  priority?: string;
  kanbanDetails?: { id?: number | string; columnId?: number | string };
}

interface RawByColumnResponse {
  activities: RawActivity[];
  cursor?: string;
  hasMore?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversores de tipo
// ─────────────────────────────────────────────────────────────────────────────

function mapColuna(c: RawColumn): ColunaKanban {
  return {
    id: String(c.id),
    nome: c.name,
    tipo: c.type,
    cor: c.color || undefined,
  };
}

function mapQuadro(k: RawKanban): QuadroKanban {
  return {
    id: String(k.id),
    nome: k.name,
    padrao: Boolean(k.default),
    colunas: Array.isArray(k.columns) ? k.columns.map(mapColuna) : [],
  };
}

function mapPrioridade(p?: string): PrioridadeKanban | undefined {
  if (!p) return undefined;
  const upper = p.toUpperCase();
  if (upper === 'HIGH') return 'alta';
  if (upper === 'LOW') return 'baixa';
  if (upper === 'MEDIUM' || upper === 'NORMAL') return 'normal';
  return undefined;
}

/** "20260404" → "2026-04-04" */
function dateStartToISO(s?: string): string | undefined {
  if (!s || s.length !== 8) return undefined;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** "2026-04-04" → 20260404 (numérico) */
function isoToYmdNumber(iso: string): number {
  return Number(iso.replace(/-/g, ''));
}

function epochMsToISO(ms?: number): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function mapAtividade(a: RawActivity): AtividadeKanban {
  const casoId = a.caseId != null ? String(a.caseId) : undefined;
  return {
    id: String(a.id),
    tipo: a.type,
    titulo: a.title ?? a.titleWithName ?? '',
    concluida: Boolean(a.done),
    prazo: dateStartToISO(a.dateStart),
    prioridade: mapPrioridade(a.priority),
    responsavelId: a.responsibleId != null ? String(a.responsibleId) : undefined,
    envolvidosIds: Array.isArray(a.involvedIds) ? a.involvedIds.map(String) : undefined,
    casoId,
    casoTitulo: a.caseTitle ?? a.completeLawsuit ?? undefined,
    urlCaso: casoId ? urlCaso(casoId) : undefined,
    comentariosCount: a.commentCount ?? 0,
    quadroId: a.kanbanDetails?.id != null ? String(a.kanbanDetails.id) : '',
    colunaId: a.kanbanDetails?.columnId != null ? String(a.kanbanDetails.columnId) : '',
    criadoEm: epochMsToISO(a.createdDate),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Default de período: mês corrente (em Brasília? aqui usamos UTC simples,
// igual aos outros services). Astrea exige `from`/`to` em YYYYMMDD numérico.
// ─────────────────────────────────────────────────────────────────────────────

function resolverPeriodo(filtros?: FiltrosAtividadeKanban): { from: number; to: number } {
  const now = new Date();

  if (filtros?.dias && filtros.dias > 0) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const end = new Date(start.getTime() + (filtros.dias - 1) * 24 * 60 * 60 * 1000);
    return {
      from: isoToYmdNumber(start.toISOString().slice(0, 10)),
      to: isoToYmdNumber(end.toISOString().slice(0, 10)),
    };
  }

  if (filtros?.prazoInicio && filtros?.prazoFim) {
    return {
      from: isoToYmdNumber(filtros.prazoInicio),
      to: isoToYmdNumber(filtros.prazoFim),
    };
  }

  // Default: mês corrente (1º dia → último dia)
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const firstDay = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  const fromIso = filtros?.prazoInicio ?? firstDay.toISOString().slice(0, 10);
  const toIso = filtros?.prazoFim ?? lastDay.toISOString().slice(0, 10);
  return { from: isoToYmdNumber(fromIso), to: isoToYmdNumber(toIso) };
}

// ─────────────────────────────────────────────────────────────────────────────
// listarQuadros
// ─────────────────────────────────────────────────────────────────────────────

export async function listarQuadros(): Promise<ServiceResponse<QuadroKanban[]>> {
  try {
    const quadros = await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);
      const raw = await astreaApiGet<RawKanban[]>(page, '/kanbans');
      if (!Array.isArray(raw)) return [];
      return raw.map(mapQuadro);
    });

    return { ok: true, data: quadros };
  } catch (err) {
    logger.error({ err }, 'Erro em listarQuadros');
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

// ─────────────────────────────────────────────────────────────────────────────
// listarAtividadesQuadro
// ─────────────────────────────────────────────────────────────────────────────

interface QueryByColumnBody {
  from: number;
  to: number;
  columnId: string;
  limit: number;
  cursor?: string;
  responsibleId?: string;
  involvedIds?: string[];
  types?: string[];
}

async function fetchAllAtividadesDeColuna(
  page: Page,
  quadroId: string,
  body: Omit<QueryByColumnBody, 'cursor'>,
): Promise<RawActivity[]> {
  const all: RawActivity[] = [];
  let cursor: string | undefined;
  // Limite duro de páginas para não rodar infinito por algum bug do backend.
  const MAX_PAGES = 50;

  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await astreaApiPost<RawByColumnResponse>(
      page,
      `/kanbans/${quadroId}/activities/query/by-column`,
      cursor ? { ...body, cursor } : body,
    );
    if (Array.isArray(res?.activities)) all.push(...res.activities);
    if (!res?.hasMore || !res?.cursor) break;
    cursor = res.cursor;
  }

  return all;
}

export async function listarAtividadesQuadro(
  quadroId: string,
  filtros?: FiltrosAtividadeKanban,
): Promise<ServiceResponse<QuadroAtividades>> {
  try {
    const { from, to } = resolverPeriodo(filtros);
    const limit = filtros?.limite ?? 100;

    const result = await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);

      // 1) Busca a lista de quadros para descobrir nome+colunas do quadro alvo
      const quadrosRaw = await astreaApiGet<RawKanban[]>(page, '/kanbans');
      const quadroRaw = Array.isArray(quadrosRaw)
        ? quadrosRaw.find((k) => String(k.id) === quadroId)
        : undefined;

      if (!quadroRaw) {
        const err = new Error(`NOT_FOUND: quadro Kanban ${quadroId} não encontrado`);
        (err as Error & { code?: string }).code = 'NOT_FOUND';
        throw err;
      }

      // 2) Em paralelo, consulta atividades de cada coluna (com paginação por cursor).
      const colunasComAtividades: AtividadesPorColuna[] = await Promise.all(
        quadroRaw.columns.map(async (col) => {
          const body: Omit<QueryByColumnBody, 'cursor'> = {
            from,
            to,
            columnId: String(col.id),
            limit,
            ...(filtros?.responsavelId ? { responsibleId: filtros.responsavelId } : {}),
            ...(filtros?.envolvidosIds && filtros.envolvidosIds.length > 0
              ? { involvedIds: filtros.envolvidosIds }
              : {}),
            ...(filtros?.tipos && filtros.tipos.length > 0 ? { types: filtros.tipos } : {}),
          };
          const raws = await fetchAllAtividadesDeColuna(page, quadroId, body);
          return {
            colunaId: String(col.id),
            colunaNome: col.name,
            colunaTipo: col.type,
            atividades: raws.map(mapAtividade),
          };
        }),
      );

      return {
        quadroId: String(quadroRaw.id),
        quadroNome: quadroRaw.name,
        colunas: colunasComAtividades,
      } satisfies QuadroAtividades;
    });

    // 3) Resolve nomes de responsáveis (best-effort, com cache no service de usuários).
    const usuariosResult = await listarUsuarios();
    if (usuariosResult.ok) {
      const byId = new Map(usuariosResult.data.map((u) => [u.id, u.nome]));
      for (const col of result.colunas) {
        for (const at of col.atividades) {
          if (at.responsavelId && byId.has(at.responsavelId)) {
            at.responsavel = byId.get(at.responsavelId);
          }
        }
      }
    }

    return { ok: true, data: result };
  } catch (err) {
    const code = (err as Error & { code?: string })?.code;
    if (code === 'NOT_FOUND') {
      return {
        ok: false,
        error: {
          message: (err as Error).message,
          code: 'NOT_FOUND',
          retryable: false,
        },
      };
    }
    logger.error({ err, quadroId }, 'Erro em listarAtividadesQuadro');
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

// ─────────────────────────────────────────────────────────────────────────────
// moverAtividade
// ─────────────────────────────────────────────────────────────────────────────

export async function moverAtividade(
  quadroId: string,
  atividadeId: string,
  colunaDestinoId: string,
): Promise<ServiceResponse<{ quadroId: string; atividadeId: string; colunaDestinoId: string }>> {
  try {
    await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);
      // O backend devolve 204 No Content; astreaApiPut resolve com data === ''.
      await astreaApiPut<unknown>(
        page,
        `/kanbans/${quadroId}/activities/${atividadeId}/move`,
        { targetColumnId: colunaDestinoId },
      );
    });

    return { ok: true, data: { quadroId, atividadeId, colunaDestinoId } };
  } catch (err) {
    logger.error({ err, quadroId, atividadeId, colunaDestinoId }, 'Erro em moverAtividade');
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
