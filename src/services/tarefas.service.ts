import { Page } from 'playwright';
import { navigateTo } from '../browser/navigator.js';
import {
  withBrowserContext,
  gapiCall,
  getAstreaUserId,
  WORKSPACE_PAGE_PATH,
} from '../browser/astrea-http.js';
import { logger } from '../utils/logger.js';
import { urlCaso } from '../utils/astrea-urls.js';
import { isRetryablePlaywrightError } from '../utils/retry.js';
import type { Tarefa, CriarTarefaInput, AtualizarTarefaInput } from '../models/index.js';
import type { FiltrosTarefa, ServiceResponse, PaginationMeta } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos internos GCP
// ─────────────────────────────────────────────────────────────────────────────

interface GcpTaskList {
  id?: string;
  taskListId?: string;
  name?: string;
  title?: string;
}

interface GcpTask {
  id?: string;
  taskId?: string;
  description?: string;
  done?: boolean;
  dueDate?: string;
  responsibleId?: string;
  responsibleName?: string;
  ownerId?: string;
  createDate?: string;
  currentListId?: string;
  priority?: number;
  casoId?: string;
  caseId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapeamento prioridade
// ─────────────────────────────────────────────────────────────────────────────

function mapPriority(priority?: number): string | undefined {
  if (priority === undefined || priority === null) return undefined;
  if (priority === 2) return 'alta';
  if (priority === 1) return 'baixa';
  return 'normal';
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapeamento GcpTask → Tarefa
// ─────────────────────────────────────────────────────────────────────────────

function mapGcpTaskToTarefa(task: GcpTask): Tarefa {
  const id = String(task.taskId ?? task.id ?? '');
  const casoId = task.casoId ? String(task.casoId) : task.caseId ? String(task.caseId) : undefined;
  return {
    id,
    titulo: task.description ?? '',
    status: task.done ? 'concluida' : 'pendente',
    prioridade: mapPriority(task.priority),
    prazo: task.dueDate ?? undefined,
    responsavelId: task.responsibleId ? String(task.responsibleId) : undefined,
    responsavel: task.responsibleName ?? undefined,
    casoId,
    urlCaso: casoId ? urlCaso(casoId) : undefined,
    listaId: task.currentListId ? String(task.currentListId) : undefined,
    createdAt: task.createDate ?? undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers internos
// ─────────────────────────────────────────────────────────────────────────────

async function getAllTaskLists(page: Page, userId: string): Promise<GcpTaskList[]> {
  const res = await gapiCall<any>(page, 'workspace.taskListService', 'getAllTaskLists', { userId });
  if (Array.isArray(res)) return res as GcpTaskList[];
  if (Array.isArray(res?.taskLists)) return res.taskLists as GcpTaskList[];
  if (Array.isArray(res?.result?.taskLists)) return res.result.taskLists as GcpTaskList[];
  if (Array.isArray(res?.items)) return res.items as GcpTaskList[];
  return [];
}

async function getInactiveTasksFromList(
  page: Page,
  taskListId: string,
  userId: string,
): Promise<GcpTask[]> {
  const res = await gapiCall<any>(
    page,
    'workspace.taskListService',
    'getAllOrderedDeactiveTasks',
    {
      taskListId,
      userId,
      orderBy: 'DUE_DATE',
      isReverse: 'false',
      limit: 200,
      offset: 0,
      cursor: '',
    },
  );
  const arr = res?.inactiveTasks ?? res?.result?.inactiveTasks;
  if (Array.isArray(arr)) return arr as GcpTask[];
  return [];
}

async function getTasksFromList(
  page: Page,
  taskListId: string,
  userId: string,
): Promise<GcpTask[]> {
  const res = await gapiCall<any>(page, 'workspace.taskListService', 'getTaskListWithAllTasks', {
    taskListId,
    userId,
    orderBy: 'DUE_DATE',
    isReverse: 'false',
  });
  const active = res?.activeTasks ?? res?.result?.activeTasks;
  if (Array.isArray(active)) return active as GcpTask[];
  if (Array.isArray(res?.tasks)) return res.tasks as GcpTask[];
  if (Array.isArray(res?.taskList)) return res.taskList as GcpTask[];
  if (Array.isArray(res?.items)) return res.items as GcpTask[];
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// listarTarefas
// ─────────────────────────────────────────────────────────────────────────────

export async function listarTarefas(filtros?: FiltrosTarefa): Promise<ServiceResponse<Tarefa[]>> {
  try {
    const result = await withBrowserContext(async (page) => {
      await navigateTo(page, WORKSPACE_PAGE_PATH);

      const sessionUserId = await getAstreaUserId(page);
      const userId = filtros?.responsavelId ?? sessionUserId;
      const lists = await getAllTaskLists(page, userId);

      const allTasks: Tarefa[] = [];
      const seenIds = new Set<string>();

      const pushTasks = (tasks: GcpTask[]) => {
        for (const t of tasks) {
          const tarefa = mapGcpTaskToTarefa(t);
          if (tarefa.id && seenIds.has(tarefa.id)) continue;
          if (tarefa.id) seenIds.add(tarefa.id);
          allTasks.push(tarefa);
        }
      };

      for (const list of lists) {
        const listId = String(list.id ?? list.taskListId ?? '');
        if (!listId) continue;

        try {
          pushTasks(await getTasksFromList(page, listId, userId));
        } catch (listErr) {
          logger.warn(
            { listId, err: String(listErr) },
            'Erro ao buscar tarefas ativas da lista — ignorando lista',
          );
        }

        if (filtros?.incluirConcluidas) {
          try {
            pushTasks(await getInactiveTasksFromList(page, listId, userId));
          } catch (listErr) {
            logger.warn(
              { listId, err: String(listErr) },
              'Erro ao buscar tarefas concluídas da lista — ignorando lista',
            );
          }
        }
      }

      // Aplicar filtros
      let filtered = allTasks;

      if (filtros?.status) {
        filtered = filtered.filter((t) => t.status === filtros.status);
      }

      if (filtros?.casoId || filtros?.processoId) {
        const targetId = filtros.casoId ?? filtros.processoId;
        filtered = filtered.filter((t) => t.casoId === targetId);
      }

      if (filtros?.responsavelId) {
        filtered = filtered.filter((t) => t.responsavelId === filtros.responsavelId);
      }

      if (filtros?.responsavel) {
        const query = filtros.responsavel.toLowerCase();
        filtered = filtered.filter((t) => t.responsavel?.toLowerCase().includes(query));
      }

      if (filtros?.prioridade) {
        filtered = filtered.filter((t) => t.prioridade === filtros.prioridade);
      }

      if (filtros?.prazoInicio || filtros?.prazoFim || filtros?.dias) {
        let start: Date | null = null;
        let end: Date | null = null;

        if (filtros.prazoInicio) {
          start = new Date(`${filtros.prazoInicio}T00:00:00.000Z`);
        }
        if (filtros.prazoFim) {
          end = new Date(`${filtros.prazoFim}T23:59:59.999Z`);
        }
        if (filtros.dias && !start && !end) {
          const now = new Date();
          start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
          end = new Date(start.getTime() + filtros.dias * 24 * 60 * 60 * 1000 - 1);
        } else if (filtros.dias && start && !end) {
          end = new Date(start.getTime() + filtros.dias * 24 * 60 * 60 * 1000 - 1);
        }

        filtered = filtered.filter((t) => {
          if (!t.prazo) return false;
          const d = new Date(t.prazo);
          if (Number.isNaN(d.getTime())) return false;
          if (start && d < start) return false;
          if (end && d > end) return false;
          return true;
        });
      }

      const pagina = filtros?.pagina ?? 1;
      const limite = filtros?.limite ?? 50;
      const paged = filtered.slice((pagina - 1) * limite, pagina * limite);
      const meta: PaginationMeta = { pagina, limite, total: filtered.length };

      return { items: paged, meta };
    });

    return { ok: true, data: result.items, meta: result.meta };
  } catch (err) {
    logger.error({ err }, 'Erro em listarTarefas');
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
// criarTarefa
// ─────────────────────────────────────────────────────────────────────────────

export async function criarTarefa(input: CriarTarefaInput): Promise<ServiceResponse<Tarefa>> {
  try {
    const tarefa = await withBrowserContext(async (page) => {
      await navigateTo(page, WORKSPACE_PAGE_PATH);

      const userId = await getAstreaUserId(page);
      const lists = await getAllTaskLists(page, userId);

      let listId: string;
      if (input.listaId) {
        listId = input.listaId;
      } else {
        const first = lists[0];
        if (!first) throw new Error('API_ERROR: nenhuma lista de tarefas encontrada');
        listId = String(first.id ?? first.taskListId ?? '');
      }

      const createDate = new Date().toISOString();

      const payload = {
        taskInfoDTO: {
          description: input.titulo,
          responsibleId: String(input.responsavelId),
          createDate,
          ownerId: String(userId),
          ...(input.prazo ? { dueDate: input.prazo } : {}),
          ...(input.prioridade !== undefined ? { priority: input.prioridade } : {}),
          ...(input.casoId ? { caseId: input.casoId } : {}),
        },
        idCurrentTaskList: listId,
        idUser: String(userId),
        responsibleId: String(input.responsavelId),
      };

      const res = await gapiCall<any>(
        page,
        'workspace.taskListService',
        'saveTaskWithList',
        {},
        payload,
      );

      // Build a Tarefa from the response — response may return the saved task or just metadata
      const savedTask: GcpTask = {
        taskId: res?.taskId ?? res?.id ?? res?.result?.taskId ?? undefined,
        description: input.titulo,
        done: false,
        dueDate: input.prazo,
        responsibleId: input.responsavelId,
        ownerId: userId,
        createDate,
        currentListId: listId,
        priority: input.prioridade,
        casoId: input.casoId,
        ...(res && typeof res === 'object' ? res : {}),
      };

      return mapGcpTaskToTarefa(savedTask);
    });

    return { ok: true, data: tarefa };
  } catch (err) {
    logger.error({ err }, 'Erro em criarTarefa');
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
// atualizarTarefa
// ─────────────────────────────────────────────────────────────────────────────

export async function atualizarTarefa(
  id: string,
  input: AtualizarTarefaInput,
): Promise<ServiceResponse<Tarefa>> {
  try {
    const tarefa = await withBrowserContext(async (page) => {
      await navigateTo(page, WORKSPACE_PAGE_PATH);

      const userId = await getAstreaUserId(page);

      // Busca dados atuais com version (necessária pro saveTaskWithList atualizar
      // em vez de inserir; loadEditTask não devolve version, getTaskWithComments sim).
      const current = await gapiCall<any>(
        page,
        'workspace.taskListService',
        'getTaskWithComments',
        { taskId: id, userId: String(userId) },
      );

      if (current?.version === undefined || current?.version === null) {
        throw new Error(`API_ERROR: tarefa ${id} sem version no response do backend`);
      }

      const currentListId =
        current?.currentTaskList ?? current?.currentListId ?? current?.idCurrentTaskList ?? '';
      const currentResponsibleId = current?.responsibleId ?? userId;
      const currentOwnerId = current?.ownerId ?? userId;
      const currentCreateDate = current?.createDate ?? new Date().toISOString();
      const currentCaseId = current?.caseId ?? current?.casoId;

      // Determinar done a partir do status solicitado
      let done: boolean = current?.done ?? false;
      if (input.status === 'concluida') done = true;
      else if (input.status === 'pendente') done = false;

      const overrideCasoId = (input as { casoId?: string }).casoId;

      const updatedPayload = {
        taskInfoDTO: {
          // id + version são o que faz o backend reconhecer como update.
          // Enviar 'taskId' em vez de 'id' faz o save virar insert (cria duplicata).
          id,
          version: current.version,
          description: input.titulo ?? current?.description ?? '',
          responsibleId: String(input.responsavelId ?? currentResponsibleId),
          createDate: currentCreateDate,
          ownerId: String(currentOwnerId),
          done,
          priority: input.prioridade !== undefined ? input.prioridade : (current?.priority ?? 0),
          ...(input.prazo !== undefined
            ? { dueDate: input.prazo }
            : current?.dueDate
              ? { dueDate: current.dueDate }
              : {}),
          ...(overrideCasoId
            ? { caseId: overrideCasoId }
            : currentCaseId
              ? { caseId: currentCaseId }
              : {}),
        },
        idCurrentTaskList: String(currentListId),
        idUser: String(userId),
        responsibleId: String(input.responsavelId ?? currentResponsibleId),
      };

      const res = await gapiCall<any>(
        page,
        'workspace.taskListService',
        'saveTaskWithList',
        {},
        updatedPayload,
      );

      const updatedTask: GcpTask = {
        taskId: id,
        description: input.titulo ?? current?.description ?? '',
        done,
        dueDate: input.prazo ?? current?.dueDate,
        responsibleId: String(input.responsavelId ?? currentResponsibleId),
        ownerId: currentOwnerId,
        createDate: currentCreateDate,
        currentListId: String(currentListId),
        priority: input.prioridade !== undefined ? input.prioridade : (current?.priority ?? 0),
        caseId: overrideCasoId ?? (currentCaseId ? String(currentCaseId) : undefined),
        ...(res && typeof res === 'object' ? res : {}),
      };

      return mapGcpTaskToTarefa(updatedTask);
    });

    return { ok: true, data: tarefa };
  } catch (err) {
    logger.error({ err, id }, 'Erro em atualizarTarefa');
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
// buscarTarefasPorProcesso
// ─────────────────────────────────────────────────────────────────────────────

export async function buscarTarefasPorProcesso(
  processoId: string,
): Promise<ServiceResponse<Tarefa[]>> {
  try {
    const tarefas = await withBrowserContext(async (page) => {
      await navigateTo(page, WORKSPACE_PAGE_PATH);

      const res = await gapiCall<any>(
        page,
        'workspace.taskListService',
        'getTasksByCase',
        {},
        { caseId: processoId },
      );

      let rawTasks: GcpTask[] = [];
      if (Array.isArray(res)) rawTasks = res as GcpTask[];
      else if (Array.isArray(res?.tasks)) rawTasks = res.tasks as GcpTask[];
      else if (Array.isArray(res?.items)) rawTasks = res.items as GcpTask[];

      return rawTasks.map(mapGcpTaskToTarefa);
    });

    return { ok: true, data: tarefas };
  } catch (err) {
    logger.error({ err, processoId }, 'Erro em buscarTarefasPorProcesso');
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
