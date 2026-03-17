import { Page } from 'playwright';
import {
  ANGULAR_PAGE_PATH,
  astreaApiPost,
  gapiCall,
  getAstreaUserId,
  withBrowserContext,
} from '../browser/astrea-http.js';
import { navigateTo } from '../browser/navigator.js';
import { buscarCaso } from './casos.service.js';
import { logger } from '../utils/logger.js';
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

interface AstreaFolderSaveResponse {
  folder?: { id?: string | number };
  response?: { id?: string | number; title?: string; number?: string };
}

interface AstreaCaseFormData {
  caseData: Record<string, any>;
  selectedTagIds: string[];
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

async function goToAngularState(
  page: Page,
  stateName: string,
  params: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    async ({ stateName, params }) => {
      const injector = (window as any).angular?.element(document.body)?.injector?.();
      const $state = injector?.get('$state');
      if (!$state) throw new Error('STATE_UNAVAILABLE: Angular $state não disponível');
      await $state.go(stateName, params);
    },
    { stateName, params },
  );
}

async function waitForConversionForm(page: Page, mode: ConversionMode): Promise<void> {
  const selector =
    mode === 'case'
      ? '#case-add-edit'
      : 'button[ng-click="save(myform.$invalid)"], button[ng-click="save(myForm.$invalid)"]';

  await page.waitForSelector(selector, { timeout: 15_000 });
  await page.waitForFunction(
    (targetMode) => {
      const selector =
        targetMode === 'case'
          ? '#case-add-edit'
          : 'button[ng-click="save(myform.$invalid)"], button[ng-click="save(myForm.$invalid)"]';
      const saveBtn = document.querySelector(selector);
      const ng = (window as any).angular;
      const scope = saveBtn ? ng?.element(saveBtn)?.scope?.() : null;
      const ctrl = scope?.$ctrl ?? scope;
      return !!ctrl?.case;
    },
    mode,
    { timeout: 15_000 },
  );
}

async function extractCaseFormData(page: Page, mode: ConversionMode): Promise<AstreaCaseFormData> {
  return page.evaluate((targetMode) => {
    const selector =
      targetMode === 'case'
        ? '#case-add-edit'
        : 'button[ng-click="save(myform.$invalid)"], button[ng-click="save(myForm.$invalid)"]';
    const saveBtn = document.querySelector(selector);
    if (!saveBtn) throw new Error('FORM_UNAVAILABLE: botão de salvar não encontrado');

    const ng = (window as any).angular;
    const scope = ng?.element(saveBtn)?.scope?.();
    const ctrl = scope?.$ctrl ?? scope;
    if (!ctrl?.case) throw new Error('FORM_UNAVAILABLE: payload do formulário não encontrado');

    const caseData = JSON.parse(JSON.stringify(ctrl.case));
    const selectedTagIds = (ctrl.tagsToSelect ?? [])
      .filter((tag: { selected?: boolean }) => tag.selected)
      .map((tag: { id?: string | number }) => String(tag.id ?? ''))
      .filter(Boolean);

    return { caseData, selectedTagIds };
  }, mode);
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

  const role = await gapiCall<Record<string, any>>(
    page,
    'folders.caseService',
    'getStakeholderRoleByName',
    { name: DEFAULT_LAWSUIT_CUSTOMER_ROLE },
  );

  if (!role?.id) {
    throw new Error('API_ERROR: Astrea não retornou role válida para o cliente do processo');
  }

  customers[targetIndex] = {
    ...primaryCustomer,
    role: String(role.id),
    roleId: String(role.id),
    roleName: role.name ?? DEFAULT_LAWSUIT_CUSTOMER_ROLE,
    ...(role.type != null ? { roleType: String(role.type) } : {}),
  };

  return {
    ...payload,
    customers,
  };
}

async function convertAtendimento(
  atendimentoId: string,
  mode: ConversionMode,
  input: TransformarAtendimentoEmCasoInput | TransformarAtendimentoEmProcessoInput,
): Promise<ServiceResponse<CasoProcesso>> {
  try {
    const folderId = await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);

      const userId = await getAstreaUserId(page);
      const stateName =
        mode === 'case' ? 'main.folders-case-add-edit' : 'main.folders-lawsuit-add-edit';
      const stateParams =
        mode === 'case'
          ? { id: atendimentoId, fromConsulting: true, folderDetail: true }
          : {
              id: atendimentoId,
              turnIntoLawsuit: true,
              fromConsulting: true,
              folderDetail: true,
            };

      await goToAngularState(page, stateName, stateParams);
      await waitForConversionForm(page, mode);

      const { caseData, selectedTagIds } = await extractCaseFormData(page, mode);
      const commonPayload = applyCommonCaseOverrides(caseData, input, selectedTagIds, userId);
      const payloadWithModeOverrides =
        mode === 'lawsuit'
          ? applyLawsuitOverrides(commonPayload, input as TransformarAtendimentoEmProcessoInput)
          : commonPayload;
      const finalPayload =
        mode === 'lawsuit'
          ? await ensurePrimaryCustomerRole(page, payloadWithModeOverrides)
          : payloadWithModeOverrides;

      const method = mode === 'case' ? 'saveCase' : 'saveLawsuit';
      const result = await gapiCall<AstreaFolderSaveResponse>(
        page,
        'folders.caseService',
        method,
        { userId },
        finalPayload,
      );

      const createdFolderId = result.folder?.id ?? result.response?.id;
      if (!createdFolderId) {
        throw new Error('API_ERROR: Astrea não retornou folder.id após conversão');
      }

      return String(createdFolderId);
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
