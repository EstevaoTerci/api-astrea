import { Page } from 'playwright';
import {
  astreaGapiGet,
  astreaGapiPost,
  getAstreaUserId as getUserIdFromHelper,
  withBrowserContext,
} from '../browser/astrea-http.js';
import { navigateTo } from '../browser/navigator.js';
import { isRetryablePlaywrightError } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { urlCaso, urlContato } from '../utils/astrea-urls.js';
import { buscarCliente } from './clientes.service.js';
import type {
  CasoProcesso,
  ParteProcesso,
  HistoricoItem,
  ApensoProcesso,
  Caso,
  CompartilhamentoCaso,
  CriarCasoInput,
  CriarProcessoInput,
  ProcessoResumo,
} from '../models/index.js';
import type {
  FiltrosCaso,
  FiltrosProcesso,
  ServiceResponse,
  PaginationMeta,
} from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constantes  –  APIs REST internas do Astrea
// Mapeadas via playwright-mcp em 21/02/2026
// ─────────────────────────────────────────────────────────────────────────────

const ASTREA_API = 'https://app.astrea.net.br/api/v2';

/**
 * Qualquer rota do Astrea que carregue o AngularJS é suficiente.
 * Garante que o $http do Angular com interceptors de sessão está disponível.
 */
const ANGULAR_PAGE_PATH = '/#/main/contacts';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos internos da API REST do Astrea  (folder, historical, tags, etc.)
// ─────────────────────────────────────────────────────────────────────────────

interface AstreaCustomer {
  contactId?: number;
  contactName?: string;
  stakeholderRoleName?: string;
  stakeholderRoleId?: number;
  roleType?: number;
}

interface AstreaCustomerSimple {
  name?: string;
  id?: number;
  role?: number;
  main?: boolean;
  roleName?: string;
  roleType?: number;
  title?: number;
}

interface AstreaUser {
  id?: number;
  name?: string;
  nickname?: string;
}

interface AstreaFolderDetail {
  id: number;
  title: string;
  isLawsuit: boolean;
  status: string; // "Active", "Closed", "Archived"
  caseType: string; // "C_CASE", "C_LAWSUIT"
  description?: string;
  observation?: string;
  createDate?: number; // Unix timestamp ms
  openDate?: number; // Unix timestamp ms (distribuição do processo)

  // Dados processuais (somente quando isLawsuit=true)
  lawsuitNumber?: string; // Número CNJ
  courtName?: string; // Ex: "BARRA DE SÃO FRANCISCO"
  courtFormatted?: string; // Ex: "1ª vara civel BARRA DE SÃO FRANCISCO"
  divisionNumber?: number;
  divisionName?: string; // Ex: "vara civel"
  lawsuitInstanceNumber?: number; // 1 = 1ª instância
  urlLawsuit?: string;
  automaticLawsuit?: boolean;

  // Partes
  customer?: AstreaCustomer;
  customers?: AstreaCustomerSimple[];
  stakeholders?: AstreaCustomer[];

  // Responsáveis
  responsible?: AstreaUser;
  responsibleId?: number;
  owner?: AstreaUser;
  ownerId?: number;
  involveds?: AstreaUser[];

  // Financeiro
  amount?: number;
  convictionAmount?: number;
  demandAmount?: number;
  provisionAmount?: number;

  // Classificação
  tagIds?: number[];

  // Equipe
  team?: { id?: number; name?: string };
  teamId?: number;

  // Miscelânea
  attachedsCount?: number;
  caseSharingType?: number;
  customerCanSeePrivate?: boolean;
  active?: boolean;
  important?: boolean;
  notUpdatedFolder?: boolean;
  canDeleteCase?: boolean;
  showLawsuitDetailsAtOpen?: boolean;
  caseVersion?: number;
  customerInvited?: boolean;
}

interface AstreaHistoricalItem {
  id: number;
  date: string; // ISO-8601
  type: string; // "MANUALLY", "DONE_TASK", "APPOINTMENT", "AUTOMATIC", etc.
  description: string;
  descriptionTranslation?: string;
  idParent?: number;
  responsible?: number;
  responsibleName?: string;
  caseId?: number;
  doneTask?: boolean;
  commentCount?: number;
  important?: boolean;
  tagDtos?: Array<{ id?: string; label?: string }>;
  urlDocuments?: string[];
}

interface AstreaHistoricalResponse {
  cursor?: string;
  historicals: AstreaHistoricalItem[];
}

interface AstreaTag {
  id: string;
  label: string;
  color?: string;
  active?: boolean;
}

interface AstreaTagsResponse {
  items: AstreaTag[];
}

interface AstreaAttachedsResponse {
  [caseId: string]: {
    root?: {
      id?: number;
      textView?: string;
      title?: string;
      lawsuitNumber?: string;
      courtTxt?: string;
      status?: string;
      currentInstance?: number;
      caseType?: string;
    };
    nodes?: Array<{
      id?: number;
      textView?: string;
      title?: string;
      lawsuitNumber?: string;
      status?: string;
    }>;
  };
}

interface AstreaStatsResponse {
  documents?: number;
  consultings?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: chamadas autenticadas à API via AngularJS $http
//
// O app do Astrea usa AngularJS com interceptors que adicionam o token de
// sessão automaticamente em cada request. Ao executar $http via page.evaluate,
// os interceptors são acionados — sem necessidade de gerenciar tokens manualmente.
// ─────────────────────────────────────────────────────────────────────────────

async function astreaApiGet<T>(page: Page, url: string): Promise<T> {
  return page.evaluate(
    ([apiUrl]) =>
      new Promise<T>((resolve, reject) => {
        const http = (window as any).angular.element(document.body).injector().get('$http');
        http
          .get(apiUrl)
          .then((r: any) => resolve(r.data as T))
          .catch((err: any) => {
            const msg = `API_ERROR_${err.status}: ${JSON.stringify(err.data?.errorMessage ?? err.data ?? err.status)}`;
            reject(new Error(msg));
          });
      }),
    [url] as [string],
  );
}

/**
 * Obtém o userId logado do $rootScope do AngularJS.
 */
async function getAstreaUserId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = (window as any).angular.element(document.body).scope()?.$root;
    return String(root?.userInfo?.id ?? '');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache de tags (carregado uma vez por sessão de browser context)
// ─────────────────────────────────────────────────────────────────────────────

let tagsCache: Map<string, string> | null = null;

async function resolveTagLabels(page: Page, tagIds: number[]): Promise<string[]> {
  if (!tagIds?.length) return [];

  if (!tagsCache) {
    try {
      const tagsResponse = await astreaApiGet<AstreaTagsResponse>(
        page,
        `${ASTREA_API}/tags/get-all-tags`,
      );
      tagsCache = new Map(tagsResponse.items.map((t) => [t.id, t.label]));
    } catch {
      logger.warn('Falha ao carregar tags — retornando IDs brutos');
      return tagIds.map(String);
    }
  }

  return tagIds.map((id) => tagsCache!.get(String(id)) ?? String(id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapeamento API → CasoProcesso
// ─────────────────────────────────────────────────────────────────────────────

function formatTimestamp(ts?: number): string | undefined {
  if (!ts) return undefined;
  return new Date(ts).toISOString();
}

function formatBrl(value?: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return `R$ ${value.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
}

function mapStatus(s?: string): string | undefined {
  if (!s) return undefined;
  const map: Record<string, string> = {
    Active: 'Ativo',
    Closed: 'Encerrado',
    Archived: 'Arquivado',
    Suspended: 'Suspenso',
  };
  return map[s] ?? s;
}

function mapInstanceLabel(n?: number): string | undefined {
  if (!n) return undefined;
  const labels: Record<number, string> = { 1: '1ª Instância', 2: '2ª Instância', 3: 'Superior' };
  return labels[n] ?? `${n}ª Instância`;
}

function mapPartes(folder: AstreaFolderDetail): ParteProcesso[] {
  const partes: ParteProcesso[] = [];

  // Cliente(s) principal(is)
  for (const c of folder.customers ?? []) {
    partes.push({
      contatoId: c.id ? String(c.id) : undefined,
      nome: c.name ?? '',
      papel: c.roleName ?? 'Cliente',
      isClientePrincipal: c.main,
    });
  }

  // Stakeholders (réu, terceiro, etc.)
  for (const s of folder.stakeholders ?? []) {
    partes.push({
      contatoId: s.contactId ? String(s.contactId) : undefined,
      nome: s.contactName ?? '',
      papel: s.stakeholderRoleName ?? 'Parte',
    });
  }

  return partes;
}

function mapHistorical(items: AstreaHistoricalItem[]): HistoricoItem[] {
  return items.map((h) => {
    const dateObj = new Date(h.date);
    return {
      tipo: h.type ?? 'UNKNOWN',
      data: dateObj.toLocaleDateString('pt-BR'),
      descricao: h.description ?? '',
      responsavel: h.responsibleName ?? undefined,
      casoProcessoId: h.caseId ? String(h.caseId) : undefined,
    };
  });
}

function mapApensos(attachedResp: AstreaAttachedsResponse, currentId: string): ApensoProcesso[] {
  const apensos: ApensoProcesso[] = [];
  for (const [, value] of Object.entries(attachedResp)) {
    // Skip the current case's own root
    const nodes = value.nodes ?? [];
    for (const node of nodes) {
      apensos.push({
        id: node.id ? String(node.id) : undefined,
        titulo: node.title ?? undefined,
        numeroProcesso: node.lawsuitNumber ?? undefined,
        status: node.status ? mapStatus(node.status) : undefined,
      });
    }
    // If the root itself is different from the current case, include it
    if (value.root && String(value.root.id) !== currentId) {
      apensos.push({
        id: value.root.id ? String(value.root.id) : undefined,
        titulo: value.root.title ?? undefined,
        numeroProcesso: value.root.lawsuitNumber ?? undefined,
        status: value.root.status ? mapStatus(value.root.status) : undefined,
      });
    }
  }
  return apensos;
}

async function buildCasoProcesso(
  page: Page,
  folder: AstreaFolderDetail,
  historicals: AstreaHistoricalItem[],
  attachedResp: AstreaAttachedsResponse | null,
  stats: AstreaStatsResponse | null,
): Promise<CasoProcesso> {
  const etiquetas = await resolveTagLabels(page, folder.tagIds ?? []);

  const casoId = String(folder.id);
  const caso: CasoProcesso = {
    // Identificação
    id: casoId,
    titulo: folder.title ?? '',
    url: urlCaso(casoId),
    isProcesso: folder.isLawsuit,

    // Classificação e status
    etiquetas: etiquetas.length > 0 ? etiquetas : undefined,
    status: mapStatus(folder.status),

    // Responsabilidade
    responsavel: folder.responsible?.name ?? undefined,
    criadoPor: folder.owner?.name ?? undefined,
    criadoEm: formatTimestamp(folder.createDate),

    // Partes
    clienteId: folder.customer?.contactId ? String(folder.customer.contactId) : undefined,
    clienteNome: folder.customer?.contactName ?? undefined,
    urlCliente: folder.customer?.contactId ? urlContato(String(folder.customer.contactId)) : undefined,
    partes: mapPartes(folder),

    // Dados processuais
    ...(folder.isLawsuit
      ? {
          numeroProcesso: folder.lawsuitNumber ?? undefined,
          juizo: folder.courtFormatted ?? undefined,
          vara: folder.divisionNumber
            ? `${folder.divisionNumber}ª ${folder.divisionName ?? 'vara'}`
            : (folder.divisionName ?? undefined),
          tribunal: folder.courtName ?? undefined,
          instancia: mapInstanceLabel(folder.lawsuitInstanceNumber),
          distribuidoEm: formatTimestamp(folder.openDate),
          valorCausa: formatBrl(folder.amount),
          valorCondenacao: formatBrl(folder.convictionAmount),
        }
      : {}),

    // Histórico
    historico: mapHistorical(historicals),

    // Apensos
    apensos: attachedResp ? mapApensos(attachedResp, String(folder.id)) : undefined,

    // Contadores
    totalDocumentos: stats?.documents ?? folder.attachedsCount ?? undefined,
    totalAtendimentos: stats?.consultings ?? undefined,
  };

  return caso;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service: buscarCaso  –  Retorna dados completos de um caso/processo por ID
//
// GET /api/casos/:id
//
// Fluxo:
//  1. GET  /api/v2/folder/{id}?userId={userId}&withDetails=true  → metadados
//  2. GET  /api/v2/historical/{id}/resume?limit=200              → histórico
//  3. GET  /api/v2/tags/get-all-tags                             → resolve etiquetas
//  4. GET  /api/v2/case/{id}/attacheds/user/{userId}             → apensos
//  5. GET  /api/v2/statistics/case/{id}?userId={userId}          → contadores
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Busca detalhes completos de um único caso por ID, paralelizando as chamadas
 * secundárias (histórico, apensos, estatísticas) após obter os metadados.
 */
export async function buscarCaso(id: string): Promise<ServiceResponse<CasoProcesso>> {
  try {
    const data = await withBrowserContext(async (page) => {
      // Garante AngularJS carregado
      await navigateTo(page, ANGULAR_PAGE_PATH);

      const userId = await getAstreaUserId(page);
      if (!userId) throw new Error('SESSION_EXPIRED: Não foi possível obter userId');

      // 1. Metadados do caso/processo (necessário antes das demais para validar existência)
      const folder = await astreaApiGet<AstreaFolderDetail>(
        page,
        `${ASTREA_API}/folder/${id}?userId=${userId}&withDetails=true`,
      ).catch((err: unknown) => {
        if (err instanceof Error && err.message.includes('API_ERROR_404')) {
          throw new Error('NOT_FOUND: Caso/processo não encontrado');
        }
        throw err;
      });

      // 2-4. Chamadas secundárias em paralelo (não-críticas)
      const [histResult, attachedResult, statsResult] = await Promise.allSettled([
        astreaApiGet<AstreaHistoricalResponse>(
          page,
          `${ASTREA_API}/historical/${id}/resume?limit=200`,
        ),
        astreaApiGet<AstreaAttachedsResponse>(
          page,
          `${ASTREA_API}/case/${id}/attacheds/user/${userId}`,
        ),
        astreaApiGet<AstreaStatsResponse>(
          page,
          `${ASTREA_API}/statistics/case/${id}?userId=${userId}`,
        ),
      ]);

      const historicals =
        histResult.status === 'fulfilled' ? (histResult.value.historicals ?? []) : [];
      if (histResult.status === 'rejected') {
        logger.warn(
          { err: String(histResult.reason) },
          'Falha ao buscar histórico — continuando sem histórico',
        );
      }

      const attacheds = attachedResult.status === 'fulfilled' ? attachedResult.value : null;

      const stats = statsResult.status === 'fulfilled' ? statsResult.value : null;

      return buildCasoProcesso(page, folder, historicals, attacheds, stats);
    });

    return { ok: true, data };
  } catch (err) {
    logger.error({ err }, 'Erro em buscarCaso');
    const isNotFound = err instanceof Error && err.message.includes('NOT_FOUND');
    return {
      ok: false,
      error: {
        message:
          err instanceof Error ? err.message.replace(/^NOT_FOUND:\s*/, '') : 'Erro desconhecido',
        code: isNotFound ? 'NOT_FOUND' : 'SCRAPE_ERROR',
        retryable: !isNotFound,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Service: listarCasos  –  Lista de casos (busca textual ou paginação simples)
//
// GET /api/casos?clienteId=...&status=...
//
// Utiliza DOM scraping da tabela em /#/main/folders/[,,]
// já que a API de busca (case-list/search, case/query) não funciona
// de forma confiável via $http direto.
// ─────────────────────────────────────────────────────────────────────────────

export async function listarCasos(filtros?: FiltrosCaso): Promise<ServiceResponse<Caso[]>> {
  try {
    const data = await withBrowserContext(async (page) => {
      await navigateTo(page, '/#/main/folders/[,,]');

      // Aguarda a tabela carregar
      await page.waitForSelector('table tbody tr', { timeout: 10000 }).catch(() => {});

      // Aplica busca textual se houver filtro
      if (filtros?.clienteId) {
        await page
          .fill('input[placeholder="Digite algo para pesquisar"]', filtros.clienteId)
          .catch(() => {});
        await page.waitForTimeout(2000);
      }

      const rowHandles = await page.$$('table tbody tr');
      const casos: Caso[] = [];

      for (const row of rowHandles) {
        const titleLink = await row.$('td:nth-child(2) a');
        if (!titleLink) continue;

        const titulo = (await titleLink.textContent())?.replace(/\s+/g, ' ').trim() ?? '';
        if (!titulo) continue;

        const href = (await titleLink.getAttribute('href')) ?? '';
        const idMatch = href.match(/folders\/detail\/(\d+)/);
        const id = idMatch?.[1] ?? '';

        const clienteNome =
          (await row.$eval('td:nth-child(3)', (el) => el.textContent ?? '').catch(() => ''))
            ?.replace(/\s+/g, ' ')
            .trim() || undefined;

        const updatedAt =
          (await row.$eval('td:nth-child(5)', (el) => el.textContent ?? '').catch(() => ''))
            ?.replace(/\s+/g, ' ')
            .trim() || undefined;

        casos.push({ id, titulo, url: id ? urlCaso(id) : undefined, clienteNome, updatedAt });
      }

      let filtered = casos;
      if (filtros?.status) filtered = filtered.filter((c) => c.status === filtros.status);
      if (filtros?.area) filtered = filtered.filter((c) => c.area === filtros.area);

      const pagina = filtros?.pagina ?? 1;
      const limite = filtros?.limite ?? 50;
      const paged = filtered.slice((pagina - 1) * limite, pagina * limite);
      const meta: PaginationMeta = { pagina, limite, total: filtered.length };

      return { items: paged, meta };
    });

    return { ok: true, data: data.items, meta: data.meta };
  } catch (err) {
    logger.error({ err }, 'Erro em listarCasos');
    return {
      ok: false,
      error: {
        message: err instanceof Error ? err.message : 'Erro desconhecido',
        code: 'SCRAPE_ERROR',
        retryable: isRetryablePlaywrightError(err),
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Service: listarProcessos  –  Enumeração leve de casos/processos do escritório
//
// GET /api/processos
//
// Estratégia híbrida: extrai do Angular scope (dados completos com isLawsuit,
// lawsuitNumber, customer, responsible) e cai para DOM scrape se o scope não
// estiver no shape esperado. Filtros aplicados client-side para isolar a tool
// do estado da UI.
// ─────────────────────────────────────────────────────────────────────────────

interface RawFolderListItem {
  id?: number | string;
  title?: string;
  subject?: string;
  name?: string;
  lawsuitNumber?: string;
  processNumber?: string;
  isLawsuit?: boolean;
  caseType?: string;
  status?: string;
  customer?: { id?: number | string; name?: string; contactName?: string };
  customerName?: string;
  customers?: Array<{ id?: number | string; name?: string; main?: boolean }>;
  responsible?: { id?: number | string; name?: string };
  responsibleId?: number | string;
  responsibleName?: string;
}

function inferTipo(raw: RawFolderListItem): 'caso' | 'processo' {
  if (raw.isLawsuit === true) return 'processo';
  if (raw.isLawsuit === false) return 'caso';
  const ct = String(raw.caseType ?? '').toUpperCase();
  if (ct.includes('LAWSUIT')) return 'processo';
  return 'caso';
}

function inferClientePrincipal(raw: RawFolderListItem): string | undefined {
  if (raw.customer?.name) return raw.customer.name;
  if (raw.customer?.contactName) return raw.customer.contactName;
  if (raw.customerName) return raw.customerName;
  if (Array.isArray(raw.customers) && raw.customers.length > 0) {
    const principal = raw.customers.find((c) => c.main === true) ?? raw.customers[0];
    return principal?.name;
  }
  return undefined;
}

function statusBuckets(status?: FiltrosProcesso['status']): Set<string> | null {
  if (!status || status === 'todos') return null;
  if (status === 'arquivado') return new Set(['Archived']);
  return new Set(['Active', 'Suspended']);
}

export async function listarProcessos(
  filtros?: FiltrosProcesso,
): Promise<ServiceResponse<ProcessoResumo[]>> {
  try {
    const data = await withBrowserContext(async (page) => {
      await navigateTo(page, '/#/main/folders/[,,]');

      // A tabela renderiza com delay; aguardar pelo menos uma linha aumenta a
      // chance do controller ter populado o array de itens.
      await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(() => {});

      // 1. Tenta extrair do Angular scope (dados ricos)
      let rawItems: RawFolderListItem[] | null = await page.evaluate(() => {
        const ng = (window as any).angular;
        if (!ng) return null;
        const candidates = document.querySelectorAll(
          '[ng-controller], au-folder-list, au-case-list, [class*="folder-list"], [class*="case-list"]',
        );
        for (const el of candidates) {
          let scope: any = null;
          try {
            scope = ng.element(el).isolateScope?.() || ng.element(el).scope?.();
          } catch {
            continue;
          }
          if (!scope) continue;
          const ctrl = scope.$ctrl ?? scope.vm ?? scope;
          const arr = ctrl?.folders ?? ctrl?.cases ?? ctrl?.items ?? ctrl?.results;
          if (Array.isArray(arr) && arr.length > 0 && arr[0]?.id != null) {
            return arr.map((f: any) => ({
              id: f.id,
              title: f.title ?? f.subject ?? f.name,
              lawsuitNumber: f.lawsuitNumber ?? f.processNumber,
              isLawsuit: f.isLawsuit,
              caseType: f.caseType,
              status: f.status,
              customer: f.customer
                ? {
                    id: f.customer.id,
                    name: f.customer.name,
                    contactName: f.customer.contactName,
                  }
                : undefined,
              customerName: f.customerName,
              customers: Array.isArray(f.customers)
                ? f.customers.map((c: any) => ({ id: c.id, name: c.name, main: c.main }))
                : undefined,
              responsible: f.responsible
                ? { id: f.responsible.id, name: f.responsible.name }
                : undefined,
              responsibleId: f.responsibleId,
              responsibleName: f.responsibleName,
            }));
          }
        }
        return null;
      });

      // 2. Fallback DOM: extrai IDs/títulos e dispara getFolder por ID para enriquecer.
      // Em volume alto, evite — mas é o único caminho se o scope mudou.
      if (!rawItems || rawItems.length === 0) {
        logger.warn(
          'listarProcessos: Angular scope vazio — caindo para DOM scrape + folder fetch',
        );
        const rows = await page.$$('table tbody tr');
        const fromDom: RawFolderListItem[] = [];
        for (const row of rows) {
          const titleLink = await row.$('td a[href*="folders"]');
          if (!titleLink) continue;
          const href = (await titleLink.getAttribute('href')) ?? '';
          const idMatch = href.match(/folders\/(?:detail\/)?(\d+)/);
          const id = idMatch?.[1];
          if (!id) continue;
          const titulo = (await titleLink.textContent())?.replace(/\s+/g, ' ').trim() ?? '';
          fromDom.push({ id, title: titulo });
        }

        const userId = await getAstreaUserId(page);
        const enriched: RawFolderListItem[] = [];
        for (const item of fromDom) {
          try {
            const folder = await astreaApiGet<AstreaFolderDetail>(
              page,
              `${ASTREA_API}/folder/${item.id}?userId=${userId}&withDetails=true`,
            );
            enriched.push({
              id: String(folder.id),
              title: folder.title,
              lawsuitNumber: folder.lawsuitNumber,
              isLawsuit: folder.isLawsuit,
              caseType: folder.caseType,
              status: folder.status,
              customer: folder.customer
                ? {
                    id: folder.customer.contactId,
                    contactName: folder.customer.contactName,
                  }
                : undefined,
              customers: folder.customers?.map((c) => ({
                id: c.id,
                name: c.name,
                main: c.main,
              })),
              responsible: folder.responsible,
              responsibleId: folder.responsibleId,
            });
          } catch (e) {
            logger.warn({ id: item.id, err: String(e) }, 'Falha ao enriquecer folder no fallback');
          }
        }
        rawItems = enriched;
      }

      const itens: ProcessoResumo[] = (rawItems ?? []).map((raw) => {
        const id = String(raw.id ?? '');
        const tipo = inferTipo(raw);
        return {
          id,
          titulo: (raw.title ?? raw.subject ?? raw.name ?? '').trim(),
          numeroProcesso:
            tipo === 'processo' ? (raw.lawsuitNumber ?? raw.processNumber ?? undefined) : undefined,
          clientePrincipalNome: inferClientePrincipal(raw),
          responsavelNome: raw.responsible?.name ?? raw.responsibleName ?? undefined,
          tipo,
          status: mapStatus(raw.status),
          url: urlCaso(id),
          /** Status bruto preservado para o filtro client-side abaixo. */
          ...({ _rawStatus: raw.status, _responsavelId: raw.responsible?.id ?? raw.responsibleId } as Record<string, unknown>),
        };
      });

      // Filtros client-side
      const buckets = statusBuckets(filtros?.status ?? 'ativo');
      const tipoFilter = filtros?.tipo && filtros.tipo !== 'todos' ? filtros.tipo : null;
      const respFilter = filtros?.responsavelId ? String(filtros.responsavelId) : null;

      const filtrados = itens.filter((item) => {
        const raw = item as unknown as { _rawStatus?: string; _responsavelId?: string | number };
        if (buckets && !buckets.has(String(raw._rawStatus ?? 'Active'))) return false;
        if (tipoFilter && item.tipo !== tipoFilter) return false;
        if (respFilter && String(raw._responsavelId ?? '') !== respFilter) return false;
        return true;
      });

      // Limpa campos internos antes de retornar
      for (const item of filtrados) {
        delete (item as unknown as Record<string, unknown>)._rawStatus;
        delete (item as unknown as Record<string, unknown>)._responsavelId;
      }

      const pagina = filtros?.pagina ?? 1;
      const limite = filtros?.limite ?? 50;
      const paged = filtrados.slice((pagina - 1) * limite, pagina * limite);
      const meta: PaginationMeta = {
        pagina,
        limite,
        total: filtrados.length,
        hasNextPage: pagina * limite < filtrados.length,
      };

      return { items: paged, meta };
    });

    return { ok: true, data: data.items, meta: data.meta };
  } catch (err) {
    logger.error({ err }, 'Erro em listarProcessos');
    return {
      ok: false,
      error: {
        message: err instanceof Error ? err.message : 'Erro desconhecido',
        code: 'SCRAPE_ERROR',
        retryable: isRetryablePlaywrightError(err),
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Service: buscarCasosPorCliente  –  Todos os casos de um cliente
//
// GET /api/clientes/:id/casos
//
// Fluxo:
//  1. Navega para SPA usando $state.go('main.contacts-detail.folders', ...)
//     → aba "Processos" do contato
//  2. Scrape tabela DOM → extrai os IDs de cada caso (href dos links)
//  3. Para cada ID, chama buscarCaso() via API para dados completos
// ─────────────────────────────────────────────────────────────────────────────

export async function buscarCasosPorCliente(
  clienteId: string,
): Promise<ServiceResponse<CasoProcesso[]>> {
  try {
    const data = await withBrowserContext(async (page) => {
      // Garante que AngularJS está carregado
      await navigateTo(page, ANGULAR_PAGE_PATH);

      const userId = await getAstreaUserId(page);
      if (!userId) throw new Error('SESSION_EXPIRED: Não foi possível obter userId');

      // ── Passo 1: Navega para a aba "Processos" do contato via ui-router ──
      logger.debug({ clienteId }, 'Navegando para aba Processos do contato...');

      await page.evaluate(
        ([contactId]) =>
          new Promise<void>((resolve, reject) => {
            try {
              const $state = (window as any).angular
                .element(document.body)
                .injector()
                .get('$state');
              $state
                .go('main.contacts-detail.folders', { contactId })
                .then(() => resolve())
                .catch((e: any) => reject(new Error(String(e))));
            } catch (e) {
              reject(e);
            }
          }),
        [clienteId] as [string],
      );

      // Aguarda a tabela de processos/casos carregar
      await page.waitForTimeout(3000);
      await page.waitForSelector('table tbody tr', { timeout: 10000 }).catch(() => {});

      // ── Passo 2: Extrai IDs dos casos a partir dos links na tabela ──
      const caseIds: string[] = await page.evaluate(() => {
        const links = document.querySelectorAll('table tbody tr td:nth-child(2) a');
        const ids: string[] = [];
        for (const link of links) {
          const href = link.getAttribute('href') ?? '';
          const match = href.match(/folders\/detail\/(\d+)/);
          if (match?.[1]) ids.push(match[1]);
        }
        return ids;
      });

      if (caseIds.length === 0) {
        logger.debug({ clienteId }, 'Nenhum caso encontrado para o cliente');
        return { casos: [] as CasoProcesso[], meta: { pagina: 1, limite: 50, total: 0 } };
      }

      logger.debug({ clienteId, count: caseIds.length }, 'Casos encontrados, buscando detalhes...');

      // ── Passo 3: Para cada caso, busca dados completos via API ──
      const casos: CasoProcesso[] = [];

      for (const caseId of caseIds) {
        try {
          // Metadados
          const folder = await astreaApiGet<AstreaFolderDetail>(
            page,
            `${ASTREA_API}/folder/${caseId}?userId=${userId}&withDetails=true`,
          );

          // Histórico, apensos e estatísticas em paralelo
          const [histResult, attachedResult, statsResult] = await Promise.allSettled([
            astreaApiGet<AstreaHistoricalResponse>(
              page,
              `${ASTREA_API}/historical/${caseId}/resume?limit=200`,
            ),
            astreaApiGet<AstreaAttachedsResponse>(
              page,
              `${ASTREA_API}/case/${caseId}/attacheds/user/${userId}`,
            ),
            astreaApiGet<AstreaStatsResponse>(
              page,
              `${ASTREA_API}/statistics/case/${caseId}?userId=${userId}`,
            ),
          ]);

          const historicals =
            histResult.status === 'fulfilled' ? (histResult.value.historicals ?? []) : [];
          const attacheds = attachedResult.status === 'fulfilled' ? attachedResult.value : null;
          const stats = statsResult.status === 'fulfilled' ? statsResult.value : null;

          const caso = await buildCasoProcesso(page, folder, historicals, attacheds, stats);
          casos.push(caso);
        } catch (e) {
          logger.warn({ caseId, err: String(e) }, 'Falha ao buscar detalhes do caso — pulando');
        }
      }

      const meta: PaginationMeta = { pagina: 1, limite: caseIds.length, total: casos.length };
      return { casos, meta };
    });

    return { ok: true, data: data.casos, meta: data.meta };
  } catch (err) {
    logger.error({ err }, 'Erro em buscarCasosPorCliente');
    const isNotFound = err instanceof Error && err.message.includes('NOT_FOUND');
    return {
      ok: false,
      error: {
        message: err instanceof Error ? err.message : 'Erro desconhecido',
        code: isNotFound ? 'NOT_FOUND' : 'SCRAPE_ERROR',
        retryable: !isNotFound && isRetryablePlaywrightError(err),
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Service: criarCaso / criarProcesso  –  Cadastro direto (sem atendimento)
//
// POST /api/casos
// POST /api/casos/processo
//
// Usa o endpoint GAPI `_ah/api/folders/v1/saveCase` (CTE_CASE) ou `saveLawsuit`
// (CTE_LAWSUIT). Não depende de DOM scraping nem state navigation Angular.
// Estrutura do payload validada via captura em 2026-05-11 — veja
// `memory/reference_astrea_savecase.md`.
// ─────────────────────────────────────────────────────────────────────────────

const SHARING_TYPE_MAP_DIRECT: Record<CompartilhamentoCaso, number> = {
  publico: 0,
  privado: 1,
  equipe: 2,
};

const DEFAULT_PROCESSO_PAPEL_CLIENTE = 'Autor';

interface AstreaFolderSaveDirectResponse {
  folder?: { id?: string | number };
  response?:
    | string
    | { id?: string | number; title?: string; number?: string; type?: string };
}

function todayCreateDate(): string {
  // Astrea registra a data de criação como meia-noite local em UTC. Em São Paulo
  // (BRT, UTC-3), meia-noite local = 03:00 UTC do mesmo dia.
  const now = new Date();
  const localMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 0, 0, 0),
  );
  return localMidnight.toISOString();
}

function normalizeDistribuidoEm(value?: string): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-');
    return `${day}/${month}/${year}`;
  }
  return value;
}

async function resolveClienteParaPayload(
  cliente: string,
): Promise<{ id: string; nome: string }> {
  const result = await buscarCliente(cliente);
  if (!result.ok) {
    throw new Error(
      result.error.code === 'NOT_FOUND'
        ? 'NOT_FOUND: Cliente não encontrado'
        : `API_ERROR: ${result.error.message}`,
    );
  }
  return { id: result.data.id, nome: result.data.nome };
}

export async function criarCaso(input: CriarCasoInput): Promise<ServiceResponse<CasoProcesso>> {
  try {
    const clienteResolvido = await resolveClienteParaPayload(input.cliente);

    const folderId = await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);
      const userId = input.responsavelId || (await getUserIdFromHelper(page));

      const sharingType = SHARING_TYPE_MAP_DIRECT[input.sharingType ?? 'publico'];
      const isPrivateOrTeam = sharingType !== SHARING_TYPE_MAP_DIRECT.publico;

      const payload: Record<string, any> = {
        title: input.titulo,
        caseType: 'CTE_CASE',
        status: 'Active',
        createDate: todayCreateDate(),
        sharingType,
        owner: isPrivateOrTeam ? userId : userId,
        responsibleId: userId,
        responsibleName: '',
        customerId: null,
        customers: [
          {
            main: true,
            id: Number.isSafeInteger(Number(clienteResolvido.id))
              ? Number(clienteResolvido.id)
              : clienteResolvido.id,
            name: clienteResolvido.nome,
            customerValid: true,
          },
        ],
        stakeholders: [
          { mainStakeholder: true, contactError: false, stakeholderRoleError: false },
        ],
        permissions: [{ userId: null, userName: '', permission: '0' }],
        permissionByUser: [[userId, 0]],
        tags: input.tagsIds ?? [],
        fromConsulting: '',
        team: null,
      };

      if (input.descricao != null) payload.description = input.descricao;
      if (input.observacoes != null) payload.observation = input.observacoes;
      if (input.teamId) {
        payload.teamId = input.teamId;
      }

      const result = await astreaGapiPost<AstreaFolderSaveDirectResponse>(
        page,
        `/folders/v1/saveCase?userId=${encodeURIComponent(userId)}&alt=json`,
        payload,
        60_000,
      );

      const responseObj = typeof result.response === 'object' ? result.response : undefined;
      const createdId = result.folder?.id ?? responseObj?.id;
      if (!createdId) {
        throw new Error('API_ERROR: Astrea não retornou folder.id após criação do caso');
      }
      return String(createdId);
    });

    return await buscarCaso(folderId);
  } catch (err) {
    logger.error({ err }, 'Erro em criarCaso');
    const isNotFound = err instanceof Error && err.message.includes('NOT_FOUND');
    const isValidation = err instanceof Error && err.message.includes('VALIDATION_ERROR');
    return {
      ok: false,
      error: {
        message:
          err instanceof Error
            ? err.message.replace(/^(NOT_FOUND|API_ERROR|VALIDATION_ERROR):\s*/, '')
            : 'Erro desconhecido',
        code: isNotFound ? 'NOT_FOUND' : isValidation ? 'VALIDATION_ERROR' : 'API_ERROR',
        retryable: !isNotFound && !isValidation && isRetryablePlaywrightError(err),
      },
    };
  }
}

export async function criarProcesso(
  input: CriarProcessoInput,
): Promise<ServiceResponse<CasoProcesso>> {
  try {
    const clienteResolvido = await resolveClienteParaPayload(input.cliente);

    const folderId = await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);
      const userId = input.responsavelId || (await getUserIdFromHelper(page));

      // 1. Resolve a role do cliente (Autor por default).
      const papelNome = input.papelCliente ?? DEFAULT_PROCESSO_PAPEL_CLIENTE;
      const role = await astreaGapiGet<{ id?: string | number; name?: string }>(
        page,
        `/folders/v1/getStakeholderRoleByName?name=${encodeURIComponent(papelNome)}`,
      );
      if (!role?.id) {
        throw new Error(`VALIDATION_ERROR: Papel "${papelNome}" não encontrado no Astrea`);
      }

      const sharingType = SHARING_TYPE_MAP_DIRECT[input.sharingType ?? 'publico'];

      const payload: Record<string, any> = {
        title: input.titulo,
        caseType: 'CTE_LAWSUIT',
        status: 'Active',
        createDate: todayCreateDate(),
        sharingType,
        owner: userId,
        responsibleId: userId,
        responsibleName: '',
        currentInstanceNumber: input.instancia ?? 1,
        isFromFolder: true,
        customerId: null,
        customers: [
          {
            main: true,
            id: Number.isSafeInteger(Number(clienteResolvido.id))
              ? Number(clienteResolvido.id)
              : clienteResolvido.id,
            name: clienteResolvido.nome,
            roleName: role.name ?? papelNome,
            role: String(role.id),
            customerRoleValid: true,
          },
        ],
        stakeholders: [],
        permissions: [{ userId: null, userName: '', permission: '0' }],
        permissionByUser: [[userId, 0]],
        lawsuit: {
          instanceNumber: input.instancia ?? 1,
          lawsuitNumber: input.numeroProcesso ?? '',
        },
        tags: input.tagsIds ?? [],
        fromConsulting: '',
        team: null,
      };

      // Campos opcionais do processo
      const lawsuit = payload.lawsuit as Record<string, any>;
      if (input.juizoNumero != null) lawsuit.divisionNumber = input.juizoNumero;
      if (input.vara != null) lawsuit.divisionName = input.vara;
      if (input.foro != null) lawsuit.courtName = input.foro;
      if (input.acao != null) lawsuit.lawsuitTypeName = input.acao;
      if (input.distribuidoEm != null) lawsuit.openDate = normalizeDistribuidoEm(input.distribuidoEm);

      if (input.urlTribunal != null) payload.urlProcesso = input.urlTribunal;
      if (input.objeto != null) payload.description = input.objeto;
      if (input.valorCausa != null) payload.amount = input.valorCausa;
      if (input.valorCondenacao != null) payload.convictionAmount = input.valorCondenacao;
      if (input.observacoes != null) payload.observation = input.observacoes;
      if (input.descricao != null && payload.description == null)
        payload.description = input.descricao;
      if (input.teamId) payload.teamId = input.teamId;

      const result = await astreaGapiPost<AstreaFolderSaveDirectResponse>(
        page,
        `/folders/v1/saveLawsuit?userId=${encodeURIComponent(userId)}&alt=json`,
        payload,
        60_000,
      );

      const responseObj = typeof result.response === 'object' ? result.response : undefined;
      const createdId = result.folder?.id ?? responseObj?.id;
      if (!createdId) {
        throw new Error('API_ERROR: Astrea não retornou folder.id após criação do processo');
      }
      return String(createdId);
    });

    return await buscarCaso(folderId);
  } catch (err) {
    logger.error({ err }, 'Erro em criarProcesso');
    const isNotFound = err instanceof Error && err.message.includes('NOT_FOUND');
    const isValidation = err instanceof Error && err.message.includes('VALIDATION_ERROR');
    return {
      ok: false,
      error: {
        message:
          err instanceof Error
            ? err.message.replace(/^(NOT_FOUND|API_ERROR|VALIDATION_ERROR):\s*/, '')
            : 'Erro desconhecido',
        code: isNotFound ? 'NOT_FOUND' : isValidation ? 'VALIDATION_ERROR' : 'API_ERROR',
        retryable: !isNotFound && !isValidation && isRetryablePlaywrightError(err),
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Service: vincularClienteCaso  –  Adiciona cliente como parte de um caso/processo
//
// POST /api/casos/:id/clientes
//
// Permite adicionar um cliente cadastrado completo como cliente adicional de um
// processo já existente (tipicamente sincronizado do tribunal com nome
// anonimizado). Não remove os clientes originais — apenas faz append no array
// `customers` e reenvia via saveCase/saveLawsuit.
//
// Idempotente: chamar 2x com mesmo (casoId, clienteId) é no-op na segunda.
// ─────────────────────────────────────────────────────────────────────────────

export interface VincularClienteCasoInput {
  casoId: string;
  clienteId: string;
  /** Papel da nova parte. Default: copia do primeiro customer existente. */
  papel?: string;
  /** Quando true, novo cliente vira o principal (e remove `main: true` dos outros). */
  isClientePrincipal?: boolean;
}

export interface VincularClienteCasoResult {
  /** True quando o cliente já estava vinculado e nada foi alterado. */
  alreadyLinked: boolean;
  /** Lista atualizada de partes do caso/processo. */
  partes: ParteProcesso[];
  /** ID do caso/processo (mesmo do input). */
  casoId: string;
}

interface AstreaCaseByIdPayload {
  id?: string | number;
  caseType?: string;
  caseVersion?: number;
  version?: number;
  customers?: Array<{
    id?: string | number;
    name?: string;
    main?: boolean;
    role?: string | number;
    roleId?: string | number;
    roleName?: string;
    roleType?: string | number;
    customerValid?: boolean;
    customerRoleValid?: boolean;
    [key: string]: unknown;
  }>;
  stakeholders?: unknown[];
  [key: string]: unknown;
}

function coerceClienteId(raw: string): string | number {
  const num = Number(raw);
  return Number.isSafeInteger(num) && String(num) === raw ? num : raw;
}

export async function vincularClienteCaso(
  input: VincularClienteCasoInput,
): Promise<ServiceResponse<VincularClienteCasoResult>> {
  try {
    const result = await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);
      const userId = await getUserIdFromHelper(page);

      // 1. Snapshot atual do caso/processo (com customers, version, caseVersion).
      const basePayload = await astreaGapiGet<AstreaCaseByIdPayload>(
        page,
        `/folders/v1/getCaseById?id=${encodeURIComponent(input.casoId)}&userId=${encodeURIComponent(userId)}`,
      ).catch((err: unknown) => {
        if (err instanceof Error && err.message.includes('API_ERROR_404')) {
          throw new Error('NOT_FOUND: Caso/processo não encontrado');
        }
        throw err;
      });

      const customers = Array.isArray(basePayload.customers) ? [...basePayload.customers] : [];
      const clienteIdStr = String(input.clienteId);

      // 2. Idempotência: cliente já vinculado?
      const yaPresente = customers.find((c) => String(c.id ?? '') === clienteIdStr);
      if (yaPresente) {
        return {
          alreadyLinked: true,
          partes: mapPartes({ customers, stakeholders: basePayload.stakeholders } as unknown as AstreaFolderDetail),
          casoId: input.casoId,
        };
      }

      // 3. Resolver nome do cliente.
      const clienteResult = await buscarCliente(input.clienteId);
      if (!clienteResult.ok) {
        if (clienteResult.error.code === 'NOT_FOUND') {
          throw new Error('VALIDATION_ERROR: Cliente não encontrado');
        }
        throw new Error(`API_ERROR: ${clienteResult.error.message}`);
      }
      const clienteNome = clienteResult.data.nome;

      // 4. Determinar role da nova parte.
      const isLawsuit = String(basePayload.caseType ?? '').toUpperCase().includes('LAWSUIT');
      const refCustomer = customers[0];

      const novoCustomer: Record<string, unknown> = {
        id: coerceClienteId(clienteIdStr),
        name: clienteNome,
        main: input.isClientePrincipal === true,
        customerValid: true,
      };

      if (isLawsuit) {
        if (input.papel) {
          const role = await astreaGapiGet<{ id?: string | number; name?: string; type?: string | number }>(
            page,
            `/folders/v1/getStakeholderRoleByName?name=${encodeURIComponent(input.papel)}`,
          );
          if (!role?.id) {
            throw new Error(`VALIDATION_ERROR: Papel "${input.papel}" não encontrado no Astrea`);
          }
          novoCustomer.role = String(role.id);
          novoCustomer.roleId = String(role.id);
          novoCustomer.roleName = role.name ?? input.papel;
          novoCustomer.customerRoleValid = true;
          if (role.type != null) novoCustomer.roleType = String(role.type);
        } else if (refCustomer) {
          // Copia role do primeiro cliente — comportamento default pedido.
          if (refCustomer.role != null) novoCustomer.role = refCustomer.role;
          if (refCustomer.roleId != null) novoCustomer.roleId = refCustomer.roleId;
          if (refCustomer.roleName != null) novoCustomer.roleName = refCustomer.roleName;
          if (refCustomer.roleType != null) novoCustomer.roleType = refCustomer.roleType;
          novoCustomer.customerRoleValid = true;
        }
      } else if (input.papel) {
        // Caso (não-processo) com papel custom — Astrea aceita `roleName` livre.
        novoCustomer.roleName = input.papel;
      }

      // 5. Montar novo array de customers (com flag main exclusiva se vier).
      const nextCustomers = customers.map((c) =>
        input.isClientePrincipal === true ? { ...c, main: false } : c,
      );
      nextCustomers.push(novoCustomer);

      // 6. Repostar via saveCase ou saveLawsuit. Mantém o payload original
      // intacto (id, caseVersion, version) — Astrea trata isso como edição
      // do caso existente, não criação.
      const method = isLawsuit ? 'saveLawsuit' : 'saveCase';
      const finalPayload: Record<string, unknown> = {
        ...basePayload,
        customers: nextCustomers,
        userId,
      };

      const saveResp = await astreaGapiPost<AstreaFolderSaveDirectResponse>(
        page,
        `/folders/v1/${method}?userId=${encodeURIComponent(userId)}&alt=json`,
        finalPayload,
        60_000,
      );

      const responseObj = typeof saveResp.response === 'object' ? saveResp.response : undefined;
      const savedId = saveResp.folder?.id ?? responseObj?.id ?? basePayload.id;
      if (!savedId) {
        throw new Error('API_ERROR: Astrea não retornou folder.id após save');
      }

      // 7. Refetch via REST detalhado para obter partes formatadas com nomes
      // estáveis (mapPartes usa stakeholders.contactName que não estão no
      // payload-snapshot do getCaseById).
      const folder = await astreaApiGet<AstreaFolderDetail>(
        page,
        `${ASTREA_API}/folder/${input.casoId}?userId=${userId}&withDetails=true`,
      );

      return {
        alreadyLinked: false,
        partes: mapPartes(folder),
        casoId: String(savedId),
      };
    });

    return { ok: true, data: result };
  } catch (err) {
    logger.error({ err }, 'Erro em vincularClienteCaso');
    const message = err instanceof Error ? err.message : 'Erro desconhecido';
    const isNotFound = message.includes('NOT_FOUND');
    const isValidation = message.includes('VALIDATION_ERROR');
    return {
      ok: false,
      error: {
        message: message.replace(/^(NOT_FOUND|API_ERROR|VALIDATION_ERROR):\s*/, ''),
        code: isNotFound ? 'NOT_FOUND' : isValidation ? 'VALIDATION_ERROR' : 'API_ERROR',
        retryable: !isNotFound && !isValidation && isRetryablePlaywrightError(err),
      },
    };
  }
}
