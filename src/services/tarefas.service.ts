import { Page } from 'playwright';
import { navigateTo } from '../browser/navigator.js';
import {
  withBrowserContext,
  gapiCall,
  getAstreaUserId,
  WORKSPACE_PAGE_PATH,
} from '../browser/astrea-http.js';
import { logger } from '../utils/logger.js';
import { isRetryablePlaywrightError } from '../utils/retry.js';
import type {
  Tarefa,
  CriarTarefaInput,
  AtualizarTarefaInput,
  FiltrosTarefa,
  ServiceResponse,
  PaginationMeta,
} from '../types/index.js';

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
  return {
    id,
    titulo: task.description ?? '',
    status: task.done ? 'concluida' : 'pendente',
    prioridade: mapPriority(task.priority),
    prazo: task.dueDate ?? undefined,
    responsavelId: task.responsibleId ? String(task.responsibleId) : undefined,
    responsavel: task.responsibleName ?? undefined,
    casoId: task.casoId
      ? String(task.casoId)
      : task.caseId
        ? String(task.caseId)
        : undefined,
    listaId: task.currentListId ? String(task.currentListId) : undefined,
    createdAt: task.createDate ?? undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers internos
// ─────────────────────────────────────────────────────────────────────────────

async function getAllTaskLists(page: Page, userId: string): Promise<GcpTaskList[]> {
  const res = await gapiCall<any>(
    page,
    'workspace.taskListService',
    'getAllTaskLists',
    { userId },
  );
  if (Array.isArray(res)) return res as GcpTaskList[];
  if (Array.isArray(res?.items)) return res.items as GcpTaskList[];
  if (Array.isArray(res?.taskLists)) return res.taskLists as GcpTaskList[];
  return [];
}

async function getTasksFromList(page: Page, taskListId: string): Promise<GcpTask[]> {
  const res = await gapiCall<any>(
    page,
    'workspace.taskListService',
    'getTaskListWithAllTasks',
    { taskListId },
  );
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

      const userId = await getAstreaUserId(page);
      const lists = await getAllTaskLists(page, userId);

      const allTasks: Tarefa[] = [];

      for (const list of lists) {
        const listId = String(list.id ?? list.taskListId ?? '');
        if (!listId) continue;

        try {
          const tasks = await getTasksFromList(page, listId);
          for (const t of tasks) {
            allTasks.push(mapGcpTaskToTarefa(t));
          }
        } catch (listErr) {
          logger.warn(
            { listId, err: String(listErr) },
            'Erro ao buscar tarefas da lista — ignorando lista',
          );
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

      if (filtros?.responsavel) {
        const query = filtros.responsavel.toLowerCase();
        filtered = filtered.filter((t) =>
          t.responsavel?.toLowerCase().includes(query),
        );
      }

      if (filtros?.prioridade) {
        filtered = filtered.filter((t) => t.prioridade === filtros.prioridade);
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
          ...(input.casoId ? { casoId: input.casoId } : {}),
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

      // Busca dados atuais da tarefa
      const current = await gapiCall<any>(
        page,
        'workspace.taskListService',
        'loadEditTask',
        {},
        { taskId: id, userId: String(userId) },
      );

      const currentListId =
        current?.currentListId ?? current?.idCurrentTaskList ?? '';
      const currentResponsibleId =
        current?.responsibleId ?? current?.taskInfoDTO?.responsibleId ?? userId;
      const currentOwnerId =
        current?.ownerId ?? current?.taskInfoDTO?.ownerId ?? userId;
      const currentCreateDate =
        current?.createDate ?? current?.taskInfoDTO?.createDate ?? new Date().toISOString();

      // Determinar done a partir do status solicitado
      let done: boolean = current?.done ?? false;
      if (input.status === 'concluida') done = true;
      else if (input.status === 'pendente') done = false;

      const updatedPayload = {
        taskInfoDTO: {
          description: input.titulo ?? current?.description ?? '',
          responsibleId: String(input.responsavelId ?? currentResponsibleId),
          createDate: currentCreateDate,
          ownerId: String(currentOwnerId),
          done,
          taskId: id,
          priority:
            input.prioridade !== undefined ? input.prioridade : (current?.priority ?? 0),
          ...(input.prazo !== undefined
            ? { dueDate: input.prazo }
            : current?.dueDate
              ? { dueDate: current.dueDate }
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
        priority:
          input.prioridade !== undefined ? input.prioridade : (current?.priority ?? 0),
        casoId: current?.casoId,
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
