import { Page } from 'playwright';
import { withBrowserContext } from '../browser/astrea-http.js';
import { navigateTo } from '../browser/navigator.js';
import { isRetryablePlaywrightError } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import type {
  CasoProcesso,
  ParteProcesso,
  HistoricoItem,
  ApensoProcesso,
} from '../models/caso-processo.js';
import type { Caso, FiltrosCaso, ServiceResponse, PaginationMeta } from '../types/index.js';

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
  status: string;                 // "Active", "Closed", "Archived"
  caseType: string;               // "C_CASE", "C_LAWSUIT"
  description?: string;
  observation?: string;
  createDate?: number;            // Unix timestamp ms
  openDate?: number;              // Unix timestamp ms (distribuição do processo)

  // Dados processuais (somente quando isLawsuit=true)
  lawsuitNumber?: string;         // Número CNJ
  courtName?: string;             // Ex: "BARRA DE SÃO FRANCISCO"
  courtFormatted?: string;        // Ex: "1ª vara civel BARRA DE SÃO FRANCISCO"
  divisionNumber?: number;
  divisionName?: string;          // Ex: "vara civel"
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
  date: string;                   // ISO-8601
  type: string;                   // "MANUALLY", "DONE_TASK", "APPOINTMENT", "AUTOMATIC", etc.
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

  const caso: CasoProcesso = {
    // Identificação
    id: String(folder.id),
    titulo: folder.title ?? '',
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
    partes: mapPartes(folder),

    // Dados processuais
    ...(folder.isLawsuit
      ? {
          numeroProcesso: folder.lawsuitNumber ?? undefined,
          juizo: folder.courtFormatted ?? undefined,
          vara: folder.divisionNumber
            ? `${folder.divisionNumber}ª ${folder.divisionName ?? 'vara'}`
            : folder.divisionName ?? undefined,
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
    apensos:
      attachedResp ? mapApensos(attachedResp, String(folder.id)) : undefined,

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
        histResult.status === 'fulfilled' ? histResult.value.historicals ?? [] : [];
      if (histResult.status === 'rejected') {
        logger.warn({ err: String(histResult.reason) }, 'Falha ao buscar histórico — continuando sem histórico');
      }

      const attacheds =
        attachedResult.status === 'fulfilled' ? attachedResult.value : null;

      const stats =
        statsResult.status === 'fulfilled' ? statsResult.value : null;

      return buildCasoProcesso(page, folder, historicals, attacheds, stats);
    });

    return { ok: true, data };
  } catch (err) {
    logger.error({ err }, 'Erro em buscarCaso');
    const isNotFound = err instanceof Error && err.message.includes('NOT_FOUND');
    return {
      ok: false,
      error: {
        message: err instanceof Error ? err.message.replace(/^NOT_FOUND:\s*/, '') : 'Erro desconhecido',
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
      await page
        .waitForSelector('table tbody tr', { timeout: 10000 })
        .catch(() => {});

      // Aplica busca textual se houver filtro
      if (filtros?.clienteId) {
        await page.fill('input[placeholder="Digite algo para pesquisar"]', filtros.clienteId).catch(() => {});
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
          (
            await row
              .$eval('td:nth-child(3)', (el) => el.textContent ?? '')
              .catch(() => '')
          )
            ?.replace(/\s+/g, ' ')
            .trim() || undefined;

        const updatedAt =
          (
            await row
              .$eval('td:nth-child(5)', (el) => el.textContent ?? '')
              .catch(() => '')
          )
            ?.replace(/\s+/g, ' ')
            .trim() || undefined;

        casos.push({ id, titulo, clienteNome, updatedAt });
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
      await page
        .waitForSelector('table tbody tr', { timeout: 10000 })
        .catch(() => {});

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
            histResult.status === 'fulfilled' ? histResult.value.historicals ?? [] : [];
          const attacheds =
            attachedResult.status === 'fulfilled' ? attachedResult.value : null;
          const stats =
            statsResult.status === 'fulfilled' ? statsResult.value : null;

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
