import { Page } from 'playwright';
import {
  ANGULAR_PAGE_PATH,
  astreaApiGet,
  astreaApiPost,
  astreaGapiGet,
  astreaGapiPost,
  getAstreaUserId,
  withBrowserContext,
} from '../browser/astrea-http.js';
import { navigateTo } from '../browser/navigator.js';
import { buscarCaso } from './casos.service.js';
import { logger } from '../utils/logger.js';
import { urlCaso, urlContato } from '../utils/astrea-urls.js';
import { isRetryablePlaywrightError } from '../utils/retry.js';
import type {
  Atendimento,
  CasoProcesso,
  CompartilhamentoCaso,
  CriarAtendimentoInput,
  TransformarAtendimentoEmCasoInput,
  TransformarAtendimentoEmProcessoInput,
} from '../models/index.js';
import type { FiltrosAtendimento, PaginationMeta, ServiceResponse } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos internos REST / GAPI
// ─────────────────────────────────────────────────────────────────────────────

interface ApiConsultingCustomer {
  id?: string | number;
  name?: string;
  telephone?: string;
  photo?: string;
  main?: boolean;
}

interface ApiConsultingMessage {
  consultingMessageId?: string | number;
  consultingId?: string | number;
  createdDate?: string | number;
  message?: string;
  authorName?: string;
  shortName?: string;
  type?: string;
  important?: boolean;
}

interface ApiConsultingCaseAttached {
  id?: string | number;
  title?: string;
  type?: string;
}

interface ApiConsulting {
  id?: string | number;
  active?: boolean;
  customers?: ApiConsultingCustomer[];
  createdDate?: string | number;
  ownerId?: string | number;
  responsibleId?: string | number;
  responsibleName?: string;
  caseAttached?: ApiConsultingCaseAttached | null;
  tagIds?: Array<string | number>;
  messages?: ApiConsultingMessage[];
  subject?: string;
}

interface ApiConsultingQueryResponse {
  cursor?: string;
  consultingDTO?: ApiConsulting[];
}

interface ApiConsultingCountResponse {
  count?: number;
  hasAnyConsulting?: boolean;
}

interface ApiContactSummary {
  id?: string | number;
  name?: string;
}

interface AstreaFolderSaveResponse {
  folder?: { id?: string | number };
  response?:
    | string
    | { id?: string | number; title?: string; number?: string; type?: string };
}

type ConversionMode = 'case' | 'lawsuit';
type AstreaSharingType = '0' | '1' | '2';

const SHARING_TYPE_MAP: Record<CompartilhamentoCaso, AstreaSharingType> = {
  publico: '0',
  privado: '1',
  equipe: '2',
};
const DEFAULT_LAWSUIT_CUSTOMER_ROLE = 'Autor';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function toIsoDate(value?: string | number | null): string | undefined {
  if (value == null || value === '') return undefined;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && value.trim() !== '') {
      return new Date(asNumber).toISOString();
    }

    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return undefined;
}

function coerceAstreaId(value?: string | number | null): string | number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value;

  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : value;
}

function mapStatusToConsultingQuery(status?: string): 'Active' | 'Inactive' {
  if (!status) return 'Active';

  const normalized = status.trim().toLowerCase();
  if (normalized === 'inactive' || normalized === 'inativo' || normalized === 'encerrado') {
    return 'Inactive';
  }

  return 'Active';
}

function mapApiAtendimentoToAtendimento(a: ApiConsulting): Atendimento {
  const mainCustomer = a.customers?.find((customer) => customer.main) ?? a.customers?.[0];
  const lastMessage = a.messages?.[0];

  const clienteId = mainCustomer?.id != null ? String(mainCustomer.id) : undefined;
  const casoId = a.caseAttached?.id != null ? String(a.caseAttached.id) : undefined;

  return {
    id: String(a.id ?? ''),
    assunto: a.subject ?? '',
    status: a.active === false ? 'ENCERRADO' : 'EM ANDAMENTO',
    clienteId,
    clienteNome: mainCustomer?.name ?? undefined,
    urlCliente: clienteId ? urlContato(clienteId) : undefined,
    casoId,
    casoTitulo: a.caseAttached?.title ?? undefined,
    urlCaso: casoId ? urlCaso(casoId) : undefined,
    responsavelId: a.responsibleId != null ? String(a.responsibleId) : undefined,
    responsavelNome: a.responsibleName ?? lastMessage?.authorName ?? undefined,
    dataHora: toIsoDate(a.createdDate ?? lastMessage?.createdDate),
    descricao: lastMessage?.message ?? undefined,
    createdAt: toIsoDate(a.createdDate),
  };
}

function buildConsultingQueryPayload(
  filtros: FiltrosAtendimento | undefined,
  limit: number,
  cursor = '',
): Record<string, unknown> {
  return {
    status: mapStatusToConsultingQuery(filtros?.status),
    tagIds: [],
    subject: '',
    consultingId: null,
    customerId: coerceAstreaId(filtros?.clienteId ?? null),
    order: '-createDate',
    caseAttached: null,
    limit,
    createdAt: null,
    dateBegin: filtros?.dataInicio ?? null,
    dateEnd: filtros?.dataFim ?? null,
    cursor,
  };
}

function filterConsultings(items: ApiConsulting[], filtros?: FiltrosAtendimento): ApiConsulting[] {
  if (!filtros?.casoId) return items;
  return items.filter((item) => String(item.caseAttached?.id ?? '') === filtros.casoId);
}

async function fetchConsultingPage(
  page: Page,
  filtros: FiltrosAtendimento | undefined,
  targetPage: number,
  limit: number,
): Promise<{ items: ApiConsulting[]; cursor?: string }> {
  let cursor = '';
  let items: ApiConsulting[] = [];

  for (let currentPage = 1; currentPage <= targetPage; currentPage++) {
    const response = await astreaApiPost<ApiConsultingQueryResponse>(
      page,
      '/consulting/query',
      buildConsultingQueryPayload(filtros, limit, cursor),
    );

    items = response.consultingDTO ?? [];
    cursor = response.cursor ?? '';

    if (currentPage < targetPage && !cursor) {
      return { items: [], cursor: '' };
    }
  }

  return { items: filterConsultings(items, filtros), cursor };
}

async function fetchConsultingCount(
  page: Page,
  filtros: FiltrosAtendimento | undefined,
  limit: number,
): Promise<number | undefined> {
  if (filtros?.casoId) return undefined;

  const response = await astreaApiPost<ApiConsultingCountResponse>(
    page,
    '/consulting/query/count',
    buildConsultingQueryPayload(filtros, limit),
  );

  return response.count;
}

async function loadContactSummary(page: Page, contactId: string): Promise<ApiContactSummary> {
  try {
    return await astreaApiGet<ApiContactSummary>(page, `/contact/${contactId}/details`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('API_ERROR_404')) {
      throw new Error('NOT_FOUND: Contato não encontrado');
    }
    throw err;
  }
}

async function resolveCaseAttachment(
  casoId?: string,
): Promise<{ id: string | number; title: string } | null> {
  if (!casoId) return null;

  const caso = await buscarCaso(casoId);
  if (!caso.ok) {
    throw new Error(
      `${caso.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'API_ERROR'}: ${caso.error.message}`,
    );
  }

  return {
    id: coerceAstreaId(casoId) ?? casoId,
    title: caso.data.titulo,
  };
}

/**
 * Busca o payload-snapshot do atendimento como `getCaseById` retorna.
 * Esse mesmo payload é o ponto de partida para `saveCase`/`saveLawsuit` em
 * modo conversão — basta trocar `fromConsulting` de `false` para `"true"`
 * e aplicar overrides do usuário antes do POST.
 */
async function fetchAtendimentoCasePayload(
  page: Page,
  atendimentoId: string,
  userId: string,
): Promise<Record<string, any>> {
  return astreaGapiGet<Record<string, any>>(
    page,
    `/folders/v1/getCaseById?id=${encodeURIComponent(atendimentoId)}&userId=${encodeURIComponent(userId)}`,
  );
}

function normalizeDateInput(value?: string): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-');
    return `${day}/${month}/${year}`;
  }
  return value;
}

function applyCommonCaseOverrides(
  payload: Record<string, any>,
  input: TransformarAtendimentoEmCasoInput,
  fallbackTagIds: string[],
  userId: string,
): Record<string, any> {
  const nextPayload = { ...payload };

  if (input.titulo != null) nextPayload.title = input.titulo;
  if (input.descricao != null) nextPayload.description = input.descricao;
  if (input.observacoes != null) nextPayload.observation = input.observacoes;
  if (input.responsavelId != null) nextPayload.responsibleId = input.responsavelId;
  if (input.sharingType != null) nextPayload.sharingType = SHARING_TYPE_MAP[input.sharingType];
  if (input.teamId !== undefined) nextPayload.teamId = input.teamId || null;

  nextPayload.userId = userId;
  nextPayload.fromConsulting = true;
  nextPayload.permissionByUser = [];
  nextPayload.tags = input.tagsIds ?? fallbackTagIds;

  if (nextPayload.teamId == null || nextPayload.teamId === '') {
    nextPayload.team = null;
  }

  if (
    nextPayload.sharingType === SHARING_TYPE_MAP.privado ||
    nextPayload.sharingType === SHARING_TYPE_MAP.equipe
  ) {
    nextPayload.owner = nextPayload.responsibleId ?? nextPayload.owner;
  }

  delete nextPayload.permissions;
  delete nextPayload.result;

  return nextPayload;
}

function applyLawsuitOverrides(
  payload: Record<string, any>,
  input: TransformarAtendimentoEmProcessoInput,
): Record<string, any> {
  const nextPayload = { ...payload };
  const lawsuit = { ...(nextPayload.lawsuit ?? {}) };

  if (input.numeroProcesso != null) lawsuit.lawsuitNumber = input.numeroProcesso;
  if (input.instancia != null) lawsuit.instanceNumber = input.instancia;
  if (input.juizoNumero != null) lawsuit.divisionNumber = input.juizoNumero;
  if (input.vara != null) lawsuit.divisionName = input.vara;
  if (input.foro != null) lawsuit.courtName = input.foro;
  if (input.acao != null) lawsuit.lawsuitTypeName = input.acao;
  if (input.distribuidoEm != null) lawsuit.openDate = normalizeDateInput(input.distribuidoEm);

  if (input.urlTribunal != null) nextPayload.urlProcesso = input.urlTribunal;
  if (input.objeto != null) nextPayload.description = input.objeto;
  if (input.valorCausa != null) nextPayload.amount = input.valorCausa;
  if (input.valorCondenacao != null) nextPayload.convictionAmount = input.valorCondenacao;
  if (input.observacoes != null) nextPayload.observation = input.observacoes;

  nextPayload.lawsuit = lawsuit;
  return nextPayload;
}

async function ensurePrimaryCustomerRole(
  page: Page,
  payload: Record<string, any>,
): Promise<Record<string, any>> {
  const customers = Array.isArray(payload.customers) ? [...payload.customers] : [];
  if (customers.length === 0) return payload;

  const primaryCustomerIndex = customers.findIndex((customer) => {
    if (!customer || typeof customer !== 'object') return false;
    if (customer.main === true || customer.isMain === true || customer.principal === true) {
      return true;
    }
    return false;
  });

  const targetIndex = primaryCustomerIndex >= 0 ? primaryCustomerIndex : 0;
  const primaryCustomer = customers[targetIndex];
  if (!primaryCustomer || typeof primaryCustomer !== 'object') return payload;

  const hasRole =
    primaryCustomer.role != null ||
    primaryCustomer.roleId != null ||
    primaryCustomer.roleName != null ||
    primaryCustomer.roleType != null;

  if (hasRole) return payload;

  const role = await astreaGapiGet<{ id?: string | number; name?: string; type?: string | number }>(
    page,
    `/folders/v1/getStakeholderRoleByName?name=${encodeURIComponent(DEFAULT_LAWSUIT_CUSTOMER_ROLE)}`,
  );

  if (!role?.id) {
    throw new Error('API_ERROR: Astrea não retornou role válida para o cliente do processo');
  }

  customers[targetIndex] = {
    ...primaryCustomer,
    role: String(role.id),
    roleId: String(role.id),
    roleName: role.name ?? DEFAULT_LAWSUIT_CUSTOMER_ROLE,
    customerRoleValid: true,
    ...(role.type != null ? { roleType: String(role.type) } : {}),
  };

  return {
    ...payload,
    customers,
  };
}

/**
 * Reconcilia uma transformação após timeout: como o caso/processo herda o ID
 * do atendimento, basta verificar se o folder já existe e não é mais consulting.
 * Retorna o folder.id se reconciliado ou null se a operação ainda não efetivou.
 */
async function reconcileTransformation(
  page: Page,
  atendimentoId: string,
  userId: string,
): Promise<string | null> {
  try {
    const folder = await astreaApiGet<{ caseType?: string; id?: string | number }>(
      page,
      `/folder/${encodeURIComponent(atendimentoId)}?userId=${encodeURIComponent(userId)}&withDetails=true`,
    );
    if (folder?.caseType && folder.caseType !== 'CTE_CONSULTING') {
      return String(folder.id ?? atendimentoId);
    }
    return null;
  } catch {
    return null;
  }
}

async function convertAtendimento(
  atendimentoId: string,
  mode: ConversionMode,
  input: TransformarAtendimentoEmCasoInput | TransformarAtendimentoEmProcessoInput,
): Promise<ServiceResponse<CasoProcesso>> {
  try {
    const folderId = await withBrowserContext(async (page) => {
      // Apenas garante que o Angular está carregado para que `$http` exista e
      // os interceptors injetem o token de sessão nas chamadas REST/GAPI.
      await navigateTo(page, ANGULAR_PAGE_PATH);
      const userId = await getAstreaUserId(page);

      // Idempotência: se a conversão já efetivou em uma tentativa anterior
      // (timeout, retry do consumidor), o folder já existe com o mesmo ID
      // do atendimento e caseType !== CTE_CONSULTING.
      const reconciledId = await reconcileTransformation(page, atendimentoId, userId);
      if (reconciledId) {
        logger.info(
          { atendimentoId, mode, reconciledId },
          'Conversão já efetivada anteriormente — pulando saveCase/saveLawsuit',
        );
        return reconciledId;
      }

      // 1. Buscar payload-snapshot do atendimento (mesma rota usada pelo form Angular).
      const basePayload = await fetchAtendimentoCasePayload(page, atendimentoId, userId);

      // 2. Aplicar overrides do usuário em cima do snapshot.
      const fallbackTagIds = Array.isArray(basePayload.tags)
        ? basePayload.tags
            .map((t: any) => String(t?.id ?? t ?? ''))
            .filter((s: string) => s.length > 0)
        : [];
      const commonPayload = applyCommonCaseOverrides(basePayload, input, fallbackTagIds, userId);
      const payloadWithModeOverrides =
        mode === 'lawsuit'
          ? applyLawsuitOverrides(commonPayload, input as TransformarAtendimentoEmProcessoInput)
          : commonPayload;
      const enrichedPayload =
        mode === 'lawsuit'
          ? await ensurePrimaryCustomerRole(page, payloadWithModeOverrides)
          : payloadWithModeOverrides;

      // 3. O Angular envia `result` com snapshot do estado pré-edit. Replicar
      // pra manter paridade com o payload original (verificado em captura).
      const finalPayload = {
        ...enrichedPayload,
        result: basePayload,
      };

      // 4. POST saveCase ou saveLawsuit com timeout estendido (mutation pesada).
      const method = mode === 'case' ? 'saveCase' : 'saveLawsuit';
      try {
        const result = await astreaGapiPost<AstreaFolderSaveResponse>(
          page,
          `/folders/v1/${method}?userId=${encodeURIComponent(userId)}&alt=json`,
          finalPayload,
          60_000,
        );

        const responseObj = typeof result.response === 'object' ? result.response : undefined;
        const createdFolderId = result.folder?.id ?? responseObj?.id;
        if (!createdFolderId) {
          throw new Error('API_ERROR: Astrea não retornou folder.id após conversão');
        }
        return String(createdFolderId);
      } catch (saveErr) {
        // Timeout/erro durante o save: tentar reconciliar. Como a conversão é
        // in-place (caso/processo herda ID do atendimento), uma simples leitura
        // do folder revela se a operação efetivou no Astrea.
        const isTimeout =
          saveErr instanceof Error && saveErr.message.toLowerCase().includes('timeout');
        if (!isTimeout) throw saveErr;

        logger.warn(
          { atendimentoId, mode, err: String(saveErr) },
          'Timeout em saveCase/saveLawsuit — tentando reconciliar...',
        );
        const reconciled = await reconcileTransformation(page, atendimentoId, userId);
        if (reconciled) {
          logger.info(
            { atendimentoId, mode, reconciled },
            'Reconciliação após timeout: caso/processo já existe no Astrea',
          );
          return reconciled;
        }
        throw saveErr;
      }
    });

    return await buscarCaso(folderId);
  } catch (err) {
    logger.error({ err, atendimentoId, mode }, 'Erro em convertAtendimento');
    const isNotFound = err instanceof Error && err.message.includes('NOT_FOUND');
    return {
      ok: false,
      error: {
        message:
          err instanceof Error ? err.message.replace(/^API_ERROR:\s*/, '') : 'Erro desconhecido',
        code: isNotFound ? 'NOT_FOUND' : 'API_ERROR',
        retryable: !isNotFound && isRetryablePlaywrightError(err),
      },
    };
  }
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

      const pagina = filtros?.pagina ?? 1;
      const limite = filtros?.limite ?? 50;
      const [{ items, cursor }, total] = await Promise.all([
        fetchConsultingPage(page, filtros, pagina, limite),
        fetchConsultingCount(page, filtros, limite),
      ]);
      const meta: PaginationMeta = {
        pagina,
        limite,
        total: total ?? items.length,
        hasNextPage: Boolean(cursor),
      };

      return { items: items.map(mapApiAtendimentoToAtendimento), meta };
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
    const attachedCase = await resolveCaseAttachment(input.casoId);
    const atendimento = await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);

      const currentUserId = input.responsavelId || (await getAstreaUserId(page));
      const contact = await loadContactSummary(page, input.clienteId);
      if (!contact?.name) {
        throw new Error('NOT_FOUND: Contato não encontrado');
      }

      const firstMessage = input.descricao?.trim() || input.assunto.trim();
      const payload = {
        subject: input.assunto.trim(),
        message: firstMessage,
        tagIds: [],
        responsibleId: currentUserId,
        ownerId: currentUserId,
        active: true,
        customers: [
          {
            id: coerceAstreaId(input.clienteId) ?? input.clienteId,
            name: contact.name,
            main: true,
          },
        ],
        caseAttached: attachedCase,
        messages: [
          {
            message: firstMessage,
            userAuthor: currentUserId,
          },
        ],
      };

      const res = await astreaApiPost<ApiConsulting>(page, '/consulting', payload);
      return mapApiAtendimentoToAtendimento(res);
    });

    return { ok: true, data: atendimento };
  } catch (err) {
    logger.error({ err }, 'Erro em criarAtendimento');
    const isNotFound = err instanceof Error && err.message.includes('NOT_FOUND');
    return {
      ok: false,
      error: {
        message:
          err instanceof Error ? err.message.replace(/^NOT_FOUND:\s*/, '') : 'Erro desconhecido',
        code: isNotFound ? 'NOT_FOUND' : 'API_ERROR',
        retryable: !isNotFound && isRetryablePlaywrightError(err),
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// conversões
// ─────────────────────────────────────────────────────────────────────────────

export async function transformarAtendimentoEmCaso(
  atendimentoId: string,
  input: TransformarAtendimentoEmCasoInput = {},
): Promise<ServiceResponse<CasoProcesso>> {
  return convertAtendimento(atendimentoId, 'case', input);
}

export async function transformarAtendimentoEmProcesso(
  atendimentoId: string,
  input: TransformarAtendimentoEmProcessoInput = {},
): Promise<ServiceResponse<CasoProcesso>> {
  return convertAtendimento(atendimentoId, 'lawsuit', input);
}
