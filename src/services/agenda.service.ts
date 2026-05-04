import { Page } from 'playwright';
import {
  ANGULAR_PAGE_PATH,
  astreaApiPost,
  getAstreaUserId,
  withBrowserContext,
} from '../browser/astrea-http.js';
import { navigateTo } from '../browser/navigator.js';
import { listarUsuarios } from './usuarios.service.js';
import { logger } from '../utils/logger.js';
import { urlCaso } from '../utils/astrea-urls.js';
import { isRetryablePlaywrightError } from '../utils/retry.js';
import type {
  EventoAgenda,
  StatusEventoAgenda,
  TipoEventoAgenda,
  Usuario,
} from '../models/index.js';
import type { FiltrosAgenda, ServiceResponse } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos internos do payload do Astrea
// ─────────────────────────────────────────────────────────────────────────────

type AstreaActivityType = 'TASK' | 'DEADLINE' | 'EVENT' | 'HEARING';
type AstreaActivityStatus = 'IN_PROGRESS' | 'DONE' | string;
type AstreaQueryStatus = 'ALL' | 'IN_PROGRESS' | 'DONE';

interface AstreaActivity {
  id: number | string;
  type: AstreaActivityType;
  allDay: boolean;
  titleWithName?: string;
  title?: string;
  dateStart?: string;
  dateEnd?: string;
  timeStart?: string;
  timeEnd?: string;
  responsibleId?: number | string;
  ownerId?: number | string;
  involvedIds?: Array<number | string>;
  caseId?: number | string;
  caseTitle?: string;
  lawsuitNumber?: string;
  comments?: string;
  status?: AstreaActivityStatus;
  done?: boolean;
  priority?: 'HIGH' | 'NORMAL' | 'LOW' | string;
  courthouse?: string;
  address?: string;
  courthouseRoom?: string;
}

interface AstreaCalendarCompleteResponse {
  activities?: AstreaActivity[];
  cursors?: Record<string, string>;
}

interface AstreaTasksNoDateResponse {
  activities?: AstreaActivity[];
  cursor?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapeamento de tipos
// ─────────────────────────────────────────────────────────────────────────────

const TIPO_MAP: Record<AstreaActivityType, TipoEventoAgenda> = {
  TASK: 'tarefa',
  DEADLINE: 'prazo',
  EVENT: 'atendimento',
  HEARING: 'audiencia',
};

const TIPO_TO_FLAG: Record<TipoEventoAgenda, keyof AstreaSelectFlags> = {
  prazo: 'deadlineSelected',
  tarefa: 'taskSelected',
  atendimento: 'appointmentSelected',
  audiencia: 'hearingSelected',
};

interface AstreaSelectFlags {
  appointmentSelected: boolean;
  deadlineSelected: boolean;
  hearingSelected: boolean;
  taskSelected: boolean;
}

const PRIORIDADE_MAP: Record<string, string> = {
  HIGH: 'alta',
  NORMAL: 'normal',
  LOW: 'baixa',
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de data
// ─────────────────────────────────────────────────────────────────────────────

/** Converte "YYYYMMDD" ou "YYYY-MM-DD" → "YYYY-MM-DD". "null"/falsy → "". */
function normalizarData(raw?: string): string {
  if (!raw || raw === 'null') return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return raw;
}

/** "YYYY-MM-DD" → "YYYYMMDD". */
function compactarData(iso: string): string {
  return iso.replace(/-/g, '');
}

/** Início da semana (domingo) em "YYYY-MM-DD". */
function inicioSemanaCorrente(): string {
  const hoje = new Date();
  const utc = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate()));
  utc.setUTCDate(utc.getUTCDate() - utc.getUTCDay());
  return utc.toISOString().slice(0, 10);
}

/** Soma N dias a uma data "YYYY-MM-DD". */
function adicionarDias(iso: string, dias: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return dt.toISOString().slice(0, 10);
}

/** ISO 8601 com offset -03:00 → UTC ISO. Astrea espera "YYYY-MM-DDT03:00:00.000Z" para 00:00 BRT. */
function inicioDiaBrtComoUtc(iso: string): string {
  return `${iso}T03:00:00.000Z`;
}

/** Fim do dia BRT como UTC ISO: "YYYY-MM-DDT02:59:59.999Z" do dia seguinte. */
function fimDiaBrtComoUtc(iso: string): string {
  return `${adicionarDias(iso, 1)}T02:59:59.999Z`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapeamento Astrea → EventoAgenda
// ─────────────────────────────────────────────────────────────────────────────

function mapStatus(status?: AstreaActivityStatus, done?: boolean): StatusEventoAgenda {
  if (done === true) return 'concluido';
  if (status === 'DONE') return 'concluido';
  return 'pendente';
}

function mapAtividade(a: AstreaActivity, usuariosPorId: Map<string, Usuario>): EventoAgenda {
  const responsavelId = a.responsibleId != null ? String(a.responsibleId) : '';
  const responsavel = usuariosPorId.get(responsavelId);
  const envolvidosIds = (a.involvedIds ?? [])
    .map((id) => String(id))
    .filter((id) => id !== responsavelId);
  const casoIdStr = a.caseId != null ? String(a.caseId) : undefined;

  const evento: EventoAgenda = {
    id: String(a.id),
    tipo: TIPO_MAP[a.type],
    titulo: a.title ?? '',
    tituloComResponsavel: a.titleWithName ?? a.title ?? '',
    diaTodo: a.allDay,
    dataInicio: normalizarData(a.dateStart),
    dataFim: a.dateEnd ? normalizarData(a.dateEnd) : undefined,
    horaInicio: a.timeStart || undefined,
    horaFim: a.timeEnd || undefined,
    status: mapStatus(a.status, a.done),
    prioridade: a.priority ? PRIORIDADE_MAP[a.priority] ?? a.priority.toLowerCase() : undefined,
    responsavelId,
    responsavelNome: responsavel?.nome,
    envolvidosIds,
    envolvidos: envolvidosIds
      .map((id) => usuariosPorId.get(id)?.nome)
      .filter((n): n is string => Boolean(n)),
    casoId: casoIdStr,
    casoTitulo: a.caseTitle || undefined,
    numeroProcesso: a.lawsuitNumber || undefined,
    urlCaso: casoIdStr ? urlCaso(casoIdStr) : undefined,
    comentarios: a.comments || undefined,
  };

  if (a.type === 'HEARING') {
    evento.forum = a.courthouse || undefined;
    evento.endereco = a.address || undefined;
    evento.sala = a.courthouseRoom || undefined;
  }

  return evento;
}

// ─────────────────────────────────────────────────────────────────────────────
// Construção do payload
// ─────────────────────────────────────────────────────────────────────────────

function flagsParaTipos(tipos: TipoEventoAgenda[] | undefined): AstreaSelectFlags {
  const todos: TipoEventoAgenda[] = ['prazo', 'tarefa', 'atendimento', 'audiencia'];
  const habilitados = new Set(tipos && tipos.length > 0 ? tipos : todos);
  const flags: AstreaSelectFlags = {
    appointmentSelected: false,
    deadlineSelected: false,
    hearingSelected: false,
    taskSelected: false,
  };
  for (const t of habilitados) flags[TIPO_TO_FLAG[t]] = true;
  return flags;
}

function statusFiltro(status?: FiltrosAgenda['status']): AstreaQueryStatus {
  if (status === 'pendentes') return 'IN_PROGRESS';
  if (status === 'concluidos') return 'DONE';
  return 'ALL';
}

// ─────────────────────────────────────────────────────────────────────────────
// listarAgenda
// ─────────────────────────────────────────────────────────────────────────────

export async function listarAgenda(
  filtros?: FiltrosAgenda,
): Promise<ServiceResponse<EventoAgenda[]>> {
  try {
    // Carrega usuários do escritório fora do withBrowserContext (já tem retry/cache próprios).
    const usuariosResult = await listarUsuarios();
    if (!usuariosResult.ok) {
      return usuariosResult;
    }
    const usuarios = usuariosResult.data;
    const usuariosPorId = new Map(usuarios.map((u) => [u.id, u]));

    const inicio = filtros?.inicio ?? inicioSemanaCorrente();
    const fim = filtros?.fim ?? adicionarDias(inicio, 6);

    // userFilter.selected = [] retorna 0 — para "todos", precisamos passar todos os IDs ativos.
    const responsaveisSelecionados = filtros?.responsavelId
      ? [String(filtros.responsavelId)]
      : usuarios.map((u) => u.id).filter((id) => id);

    const flags = flagsParaTipos(filtros?.tipos);
    const status = statusFiltro(filtros?.status);

    const activities = await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);
      const sessionUserId = await getAstreaUserId(page);

      const principal = await fetchCalendarPro(page, {
        sessionUserId,
        inicio,
        fim,
        flags,
        status,
        responsaveisSelecionados,
      });

      // Tarefas sem prazo só fazem sentido quando o usuário pediu explicitamente.
      if (!filtros?.incluirSemPrazo) return principal;
      if (!flags.taskSelected) return principal;

      const semPrazo = await fetchTasksNoDate(page, {
        sessionUserId,
        responsaveisSelecionados: filtros?.responsavelId
          ? [String(filtros.responsavelId)]
          : null,
      });

      const seenIds = new Set(principal.map((a) => String(a.id)));
      for (const t of semPrazo) {
        if (!seenIds.has(String(t.id))) principal.push(t);
      }
      return principal;
    });

    const eventos = activities.map((a) => mapAtividade(a, usuariosPorId));

    // O Astrea já filtra por status na query principal, mas tasks-no-date não respeita.
    // Refinamento client-side garante consistência.
    const filtrados =
      filtros?.status && filtros.status !== 'todos'
        ? eventos.filter((e) =>
            filtros.status === 'pendentes' ? e.status === 'pendente' : e.status === 'concluido',
          )
        : eventos;

    // Ordenação: data crescente; sem data ao final.
    filtrados.sort((a, b) => {
      if (!a.dataInicio && !b.dataInicio) return 0;
      if (!a.dataInicio) return 1;
      if (!b.dataInicio) return -1;
      const cmp = a.dataInicio.localeCompare(b.dataInicio);
      if (cmp !== 0) return cmp;
      return (a.horaInicio ?? '').localeCompare(b.horaInicio ?? '');
    });

    return { ok: true, data: filtrados };
  } catch (err) {
    logger.error({ err }, 'Erro em listarAgenda');
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
// Fetch helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCalendarPro(
  page: Page,
  args: {
    sessionUserId: string;
    inicio: string;
    fim: string;
    flags: AstreaSelectFlags;
    status: AstreaQueryStatus;
    responsaveisSelecionados: string[];
  },
): Promise<AstreaActivity[]> {
  const payload = {
    from: compactarData(args.inicio),
    to: compactarData(args.fim),
    userId: args.sessionUserId,
    cursors: { deadlineCursor: '', eventCursor: '', hearingCursor: '', taskCursor: '' },
    query: {
      cases: [],
      customers: [],
      tasks: [],
      appointments: [],
      deadlines: [],
      hearings: [],
      ...args.flags,
      status: args.status,
      userFilter: {
        selected: args.responsaveisSelecionados,
        type: 'CF_ALL',
        users: [],
      },
      tagIds: [],
      date: inicioDiaBrtComoUtc(args.inicio),
      start: inicioDiaBrtComoUtc(args.inicio),
      end: fimDiaBrtComoUtc(args.fim),
      dateFilterPeriod: 'MANUAL',
      userId: args.sessionUserId,
    },
  };

  const res = await astreaApiPost<AstreaCalendarCompleteResponse>(
    page,
    '/calendar-pro/complete',
    payload,
  );
  return res.activities ?? [];
}

async function fetchTasksNoDate(
  page: Page,
  args: { sessionUserId: string; responsaveisSelecionados: string[] | null },
): Promise<AstreaActivity[]> {
  const responsibleIds =
    args.responsaveisSelecionados && args.responsaveisSelecionados.length === 1
      ? args.responsaveisSelecionados[0]
      : null;

  const all: AstreaActivity[] = [];
  let cursor: string | null = null;
  const PAGE_SIZE = 50;
  const MAX_PAGES = 20;

  for (let i = 0; i < MAX_PAGES; i++) {
    const payload = {
      userId: args.sessionUserId,
      limit: PAGE_SIZE,
      cursor,
      tagId: null,
      responsibleId: responsibleIds,
      ownerId: null,
      involvedId: null,
    };

    const res: AstreaTasksNoDateResponse = await astreaApiPost<AstreaTasksNoDateResponse>(
      page,
      '/calendar-pro/tasks-no-date/cursor',
      payload,
    );
    const items = res.activities ?? [];
    if (items.length === 0) break;
    all.push(...items);
    if (!res.cursor || items.length < PAGE_SIZE) break;
    cursor = res.cursor;
  }

  // Quando há mais de 1 responsável selecionado, o endpoint não permite filtro server-side
  // (aceita só 1 responsibleId). Filtra client-side.
  if (args.responsaveisSelecionados && args.responsaveisSelecionados.length > 1) {
    const set = new Set(args.responsaveisSelecionados);
    return all.filter((a) => a.responsibleId && set.has(String(a.responsibleId)));
  }
  return all;
}
