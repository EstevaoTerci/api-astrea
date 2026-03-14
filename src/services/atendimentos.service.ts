import { navigateTo } from '../browser/navigator.js';
import { withBrowserContext, astreaApiPost, ANGULAR_PAGE_PATH } from '../browser/astrea-http.js';
import { logger } from '../utils/logger.js';
import { isRetryablePlaywrightError } from '../utils/retry.js';
import type { Atendimento, CriarAtendimentoInput } from '../models/index.js';
import type { FiltrosAtendimento, ServiceResponse, PaginationMeta } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos internos REST
// ─────────────────────────────────────────────────────────────────────────────

interface ApiAtendimento {
  id?: string | number;
  subject?: string;
  status?: string;
  clientId?: string | number;
  clientName?: string;
  folderId?: string | number;
  folderTitle?: string;
  responsibleId?: string | number;
  responsibleName?: string;
  dateTime?: string;
  date?: string;
  description?: string;
  duration?: number;
  createdAt?: string;
}

interface ApiAtendimentoListResponse {
  content?: ApiAtendimento[];
  items?: ApiAtendimento[];
  data?: ApiAtendimento[];
  totalElements?: number;
  total?: number;
  size?: number;
  page?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapeamento ApiAtendimento → Atendimento
// ─────────────────────────────────────────────────────────────────────────────

function mapApiAtendimentoToAtendimento(a: ApiAtendimento): Atendimento {
  return {
    id: String(a.id ?? ''),
    assunto: a.subject ?? '',
    status: a.status ?? '',
    clienteId: a.clientId != null ? String(a.clientId) : undefined,
    clienteNome: a.clientName ?? undefined,
    casoId: a.folderId != null ? String(a.folderId) : undefined,
    casoTitulo: a.folderTitle ?? undefined,
    responsavelId: a.responsibleId != null ? String(a.responsibleId) : undefined,
    responsavelNome: a.responsibleName ?? undefined,
    dataHora: a.dateTime ?? a.date ?? undefined,
    descricao: a.description ?? undefined,
    duracaoMinutos: a.duration ?? undefined,
    createdAt: a.createdAt ?? undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// listarAtendimentos
// ─────────────────────────────────────────────────────────────────────────────

export async function listarAtendimentos(
  filtros?: FiltrosAtendimento,
): Promise<ServiceResponse<Atendimento[]>> {
  try {
    const result = await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);

      const payload = {
        page: filtros?.pagina ?? 1,
        size: filtros?.limite ?? 50,
        ...(filtros?.clienteId != null ? { clientId: filtros.clienteId } : {}),
        ...(filtros?.casoId != null ? { folderId: filtros.casoId } : {}),
        ...(filtros?.status != null ? { status: filtros.status } : {}),
        ...(filtros?.dataInicio != null ? { startDate: filtros.dataInicio } : {}),
        ...(filtros?.dataFim != null ? { endDate: filtros.dataFim } : {}),
      };

      const res = await astreaApiPost<any>(page, '/consulting/all', payload);

      // Extrair lista de itens — REST pode retornar content (Spring Page) ou items/data
      let rawItems: ApiAtendimento[] = [];
      if (Array.isArray(res)) {
        rawItems = res as ApiAtendimento[];
      } else if (Array.isArray(res?.content)) {
        rawItems = res.content as ApiAtendimento[];
      } else if (Array.isArray(res?.items)) {
        rawItems = res.items as ApiAtendimento[];
      } else if (Array.isArray(res?.data)) {
        rawItems = res.data as ApiAtendimento[];
      } else {
        logger.warn({ res }, 'Resposta inesperada de /consulting/all — retornando vazio');
      }

      const total: number | undefined =
        (res as ApiAtendimentoListResponse)?.totalElements ??
        (res as ApiAtendimentoListResponse)?.total ??
        rawItems.length;

      const pagina = filtros?.pagina ?? 1;
      const limite = filtros?.limite ?? 50;
      const meta: PaginationMeta = { pagina, limite, total };

      return { items: rawItems.map(mapApiAtendimentoToAtendimento), meta };
    });

    return { ok: true, data: result.items, meta: result.meta };
  } catch (err) {
    logger.error({ err }, 'Erro em listarAtendimentos');
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
// criarAtendimento
// ─────────────────────────────────────────────────────────────────────────────

export async function criarAtendimento(
  input: CriarAtendimentoInput,
): Promise<ServiceResponse<Atendimento>> {
  try {
    const atendimento = await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);

      const payload = {
        subject: input.assunto,
        clientId: input.clienteId,
        ...(input.casoId != null ? { folderId: input.casoId } : {}),
        responsibleId: input.responsavelId,
        date: input.data,
        time: input.hora,
        ...(input.descricao != null ? { description: input.descricao } : {}),
        ...(input.duracaoMinutos != null ? { duration: input.duracaoMinutos } : {}),
      };

      const res = await astreaApiPost<any>(page, '/consulting', payload);

      return mapApiAtendimentoToAtendimento(res as ApiAtendimento);
    });

    return { ok: true, data: atendimento };
  } catch (err) {
    logger.error({ err }, 'Erro em criarAtendimento');
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
