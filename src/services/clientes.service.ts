import { Page } from 'playwright';
import { withBrowserContext } from '../browser/astrea-http.js';
import { navigateTo } from '../browser/navigator.js';
import { isRetryablePlaywrightError } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import type { Cliente, ClienteResumido, FiltrosCliente, ServiceResponse, PaginationMeta, DocumentoContato } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/** Base URL da API interna do Astrea */
const ASTREA_API = 'https://app.astrea.net.br/api/v2';

/**
 * Qualquer rota do Astrea que carregue o AngularJS é suficiente.
 * Após login, navegamos aqui para garantir que o $http do Angular está disponível.
 */
const ANGULAR_PAGE_PATH = '/#/main/contacts';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos da API interna do Astrea (Mapeados via playwright-mcp em 21/02/2026)
//
// Endpoint de lista:   POST https://app.astrea.net.br/api/v2/contact/all
// Endpoint de detalhe: GET  https://app.astrea.net.br/api/v2/contact/{id}/details
// ─────────────────────────────────────────────────────────────────────────────

interface AstreaPhone {
  typeEnum?: string;
  number?: string;    // campo em /details
  telephone?: string; // campo em /all (lista)
  operator?: string;
}

interface AstreaEmail {
  typeEnum?: string;
  address?: string;   // campo em /details
  email?: string;     // campo em /all (lista)
}

interface AstreaWebSite {
  url?: string;
}

interface AstreaAddress {
  typeEnum?: string;
  value?: string;
  street?: string;
  number?: string;
  city?: string;
  state?: string;
  zipCode?: string;
}

interface AstreaContactDetails {
  id: number;
  name: string;
  nickname?: string;
  contactKind?: string;
  classification?: number;
  telephones?: AstreaPhone[];
  emails?: AstreaEmail[];
  webSites?: AstreaWebSite[];
  addresses?: AstreaAddress[];
  taxDocumentNumber?: string;
  birthDate?: string;
  clientOrigin?: string;
  isDeceased?: boolean;
  jobAndCompany?: string;
  createdAt?: number;
  tagsDTO?: Array<{ name?: string }>;
}

interface AstreaContactListItem {
  id: number;
  name: string;
  classificationName?: string;
  telephones?: AstreaPhone[];
  emails?: AstreaEmail[];
  addresses?: Array<{ display?: string }>;
  contactKind?: string;
  createdAt?: string;
  tags?: Array<{ name?: string }>;
}

interface AstreaContactListResponse {
  cursor?: string;
  contacts: AstreaContactListItem[];
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

async function astreaApiPost<T>(page: Page, url: string, body: unknown): Promise<T> {
  return page.evaluate(
    ([apiUrl, payload]) =>
      new Promise<T>((resolve, reject) => {
        const http = (window as any).angular.element(document.body).injector().get('$http');
        http
          .post(apiUrl, payload)
          .then((r: any) => resolve(r.data as T))
          .catch((err: any) => {
            const msg = `API_ERROR_${err.status}: ${JSON.stringify(err.data?.errorMessage ?? err.data ?? err.status)}`;
            reject(new Error(msg));
          });
      }),
    [url, body] as [string, unknown],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapeamento API → tipo Cliente
// ─────────────────────────────────────────────────────────────────────────────

function mapContactDetails(d: AstreaContactDetails): Cliente {
  // Telefone: preferir celular, fallback para qualquer número
  const telefone =
    d.telephones?.find((t) => t.typeEnum?.includes('CELLULAR'))?.number ??
    d.telephones?.[0]?.number ??
    undefined;

  const email = d.emails?.[0]?.address ?? undefined;

  // URL do Drive: primeiro webSite com URL preenchida (campo "Site" do contato)
  const urlDrive = d.webSites?.find((w) => w.url && w.url.trim() !== '')?.url?.trim() ?? undefined;

  const endereco = d.addresses?.[0]?.value ?? undefined;

  return {
    id: String(d.id),
    nome: d.name?.trim() ?? '',
    cpfCnpj: d.taxDocumentNumber ?? undefined,
    email,
    telefone,
    urlDrive,
    endereco,
    dataNascimento: d.birthDate ?? undefined,
    origem: d.clientOrigin ?? undefined,
    tipo: d.contactKind === 'PERSON' ? 'pessoa_fisica' : d.contactKind === 'COMPANY' ? 'pessoa_juridica' : undefined,
    createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : undefined,
  };
}

function mapContactListItem(item: AstreaContactListItem): Cliente {
  const telefone =
    item.telephones?.find((t) => t.typeEnum?.includes('CELLULAR'))?.telephone ??
    item.telephones?.[0]?.telephone ??
    undefined;

  const email =
    item.emails?.[0]?.address ??
    (item.emails?.[0] as any)?.email ??
    undefined;

  return {
    id: String(item.id),
    nome: item.name?.trim() ?? '',
    email,
    telefone,
    tipo: item.contactKind === 'PERSON' ? 'pessoa_fisica' : item.contactKind === 'COMPANY' ? 'pessoa_juridica' : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload de busca para POST /contact/all
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mapeia um item da lista de contatos para ClienteResumido (sem chamadas extras).
 */
function mapContactListItemResumido(item: AstreaContactListItem): ClienteResumido {
  const telefone =
    item.telephones?.find((t) => t.typeEnum?.includes('CELLULAR'))?.telephone ??
    item.telephones?.[0]?.telephone ??
    undefined;

  const email =
    item.emails?.[0]?.address ??
    (item.emails?.[0] as any)?.email ??
    undefined;

  const endereco =
    item.addresses?.[0]?.display ??
    undefined;

  const etiquetas =
    item.tags?.map((t) => t.name ?? '').filter(Boolean) ?? undefined;

  return {
    id: String(item.id),
    nome: item.name?.trim() ?? '',
    classificacao: item.classificationName ?? undefined,
    tipo: item.contactKind === 'PERSON' ? 'pessoa_fisica' : item.contactKind === 'COMPANY' ? 'pessoa_juridica' : undefined,
    telefone,
    email,
    endereco,
    etiquetas: etiquetas?.length ? etiquetas : undefined,
    criadoEm: item.createdAt ?? undefined,
  };
}

function buildSearchPayload(text: string, apiPage: number, limit: number) {
  return {
    queryDTO: {
      type: '',
      text: text.trim(),
      order: 'nameUpperCase',
      selectedTagsIds: [],
      startsWith: [],
      onlyWithEmail: false,
      searchInCompany: false,
      customerNotificationTypeFilter: 'ALL',
      customerNotification: ['CLIPPING', 'AUTOMATIC_HISTORIES'],
      customerNotificationArtificialIntelligenceFilter: 'ALL',
      birthMonth: 0,
      state: '',
    },
    page: apiPage,
    limit,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Service: Listar / Buscar Clientes por nome
//
// GET /api/clientes?nome=NOME
//
// Fluxo:
//  1. POST /api/v2/contact/all com { queryDTO: { text: nome }, page, limit }
//     → retorna lista de contatos (sem urlDrive)
//  2. Para cada contato encontrado em buscas por nome (até MAX_ENRICH),
//     GET /api/v2/contact/{id}/details → enriquece com urlDrive, cpfCnpj, etc.
// ─────────────────────────────────────────────────────────────────────────────

export async function listarClientes(filtros?: FiltrosCliente): Promise<ServiceResponse<Cliente[]>> {
  try {
    const data = await withBrowserContext(async (page) => {
      // Garante que o app AngularJS está carregado (necessário para $http interceptors)
      await navigateTo(page, ANGULAR_PAGE_PATH);

      const pagina = filtros?.pagina ?? 1;
      const limite = filtros?.limite ?? 50;

      const response = await astreaApiPost<AstreaContactListResponse>(
        page,
        `${ASTREA_API}/contact/all`,
        buildSearchPayload(filtros?.nome ?? '', pagina - 1, limite),
      );

      let contacts = response.contacts ?? [];

      // Filtro local por email (a API não suporta filtro de email no POST)
      if (filtros?.email) {
        const emailLower = filtros.email.toLowerCase();
        contacts = contacts.filter((c) =>
          c.emails?.some(
            (e) =>
              e.address?.toLowerCase().includes(emailLower) ||
              (e as any).email?.toLowerCase().includes(emailLower),
          ),
        );
      }

      // Enriquecer com detalhes (urlDrive, cpfCnpj, endereco, etc.) para buscas por nome
      const MAX_ENRICH = 20;
      const shouldEnrich = !!filtros?.nome;
      const toEnrich = shouldEnrich ? contacts.slice(0, MAX_ENRICH) : [];

      let clientes: Cliente[];

      if (toEnrich.length > 0) {
        logger.debug({ count: toEnrich.length }, 'Buscando detalhes dos contatos encontrados...');

        clientes = await Promise.all(
          toEnrich.map(async (item): Promise<Cliente> => {
            try {
              const details = await astreaApiGet<AstreaContactDetails>(
                page,
                `${ASTREA_API}/contact/${item.id}/details`,
              );
              return mapContactDetails(details);
            } catch (enrichErr) {
              logger.warn(
                { id: item.id, err: String(enrichErr) },
                'Falha ao buscar detalhe do contato; usando dados parciais',
              );
              return mapContactListItem(item);
            }
          }),
        );

        // Append contatos além do limite de enriquecimento sem dados detalhados
        if (contacts.length > MAX_ENRICH) {
          const enrichedIds = new Set(clientes.map((c) => c.id));
          const remaining = contacts.slice(MAX_ENRICH).map(mapContactListItem);
          clientes = [...clientes, ...remaining.filter((c) => !enrichedIds.has(c.id))];
        }
      } else {
        clientes = contacts.map(mapContactListItem);
      }

      const meta: PaginationMeta = {
        pagina,
        limite,
        total: clientes.length,
        hasNextPage: !!response.cursor,
      };

      return { clientes, meta };
    });

    return { ok: true, data: data.clientes, meta: data.meta };
  } catch (err) {
    logger.error({ err }, 'Erro em listarClientes');
    return {
      ok: false,
      error: {
        message: err instanceof Error ? err.message : 'Erro desconhecido',
        code:
          err instanceof Error && err.message.includes('BROWSER_POOL_TIMEOUT')
            ? 'BROWSER_UNAVAILABLE'
            : 'SCRAPE_ERROR',
        retryable: isRetryablePlaywrightError(err),
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Service: Listar TODOS os clientes (listagem completa)
//
// GET /api/clientes/todos
//
// Fluxo:
//  1. POST /api/v2/contact/all com pageSize=9999 → retorna todos de uma vez
//  2. Mapeia para ClienteResumido[] (sem chamadas extras de /details)
//
// 100% HTTP request — nenhum scraping envolvido.
// ─────────────────────────────────────────────────────────────────────────────

export async function listarTodosClientes(): Promise<ServiceResponse<ClienteResumido[]>> {
  try {
    const data = await withBrowserContext(async (page) => {
      // Garante que o app AngularJS está carregado
      await navigateTo(page, ANGULAR_PAGE_PATH);

      logger.debug('Buscando lista completa de contatos via API...');

      const response = await astreaApiPost<AstreaContactListResponse>(
        page,
        `${ASTREA_API}/contact/all`,
        {
          queryDTO: {
            type: '',
            text: '',
            order: 'nameUpperCase',
            selectedTagsIds: [],
            startsWith: [],
            onlyWithEmail: false,
            searchInCompany: false,
            customerNotificationTypeFilter: 'ALL',
            customerNotification: ['CLIPPING', 'AUTOMATIC_HISTORIES'],
            customerNotificationArtificialIntelligenceFilter: 'ALL',
            birthMonth: 0,
            state: '',
            onlyCount: false,
          },
          paging: { pageNumber: 0, pageSize: 9999 },
        },
      );

      const contacts = response.contacts ?? [];
      logger.debug({ count: contacts.length }, 'Contatos obtidos via API.');

      return contacts.map(mapContactListItemResumido);
    });

    return {
      ok: true,
      data,
      meta: { pagina: 1, limite: data.length, total: data.length },
    };
  } catch (err) {
    logger.error({ err }, 'Erro em listarTodosClientes');
    return {
      ok: false,
      error: {
        message: err instanceof Error ? err.message : 'Erro desconhecido',
        code:
          err instanceof Error && err.message.includes('BROWSER_POOL_TIMEOUT')
            ? 'BROWSER_UNAVAILABLE'
            : 'SCRAPE_ERROR',
        retryable: isRetryablePlaywrightError(err),
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Buscar documentos de um contato via scraping do scope AngularJS
//
// Fluxo:
//  1. Navega pelo SPA: $state.go('main.contacts-detail.documents', { contactId })
//  2. Aguarda o componente <document-list> carregar os documentos
//  3. Lê os documentos do scope isolado ($ctrl.data.documents)
//  4. Se hasMorePages, chama $ctrl.loadMore() e repete
//  5. Mapeia para DocumentoContato[]
//
// Nota: Não existe endpoint REST que filtre documentos por contato. O endpoint
// POST /documents/all retorna TODOS os documentos do escritório, sem filtro
// por customerId. O SPA filtra client-side via AngularJS component binding.
// ─────────────────────────────────────────────────────────────────────────────

/** Representação interna de um documento retornado pelo scope do AngularJS */
interface AstreaDocumentScope {
  id: number;
  type: string;
  title: string;
  url?: string;
  origin?: string;
  responsibleName?: string;
  updateDateFormatted?: string;
  documentDescription?: string;
  downloadDocumentUrl?: string;
  customerId?: number;
  customerName?: string;
  caseDTO?: {
    id: number;
    title: string;
    caseType: string;
  } | null;
}

function mapDocumentScope(d: AstreaDocumentScope): DocumentoContato {
  return {
    id: String(d.id),
    tipo: d.type ?? '',
    titulo: d.title ?? '',
    descricao: d.documentDescription ?? undefined,
    url: d.url ?? undefined,
    urlDownload: d.downloadDocumentUrl ?? undefined,
    responsavel: d.responsibleName ?? undefined,
    ultimaEdicao: d.updateDateFormatted ?? undefined,
    origem: d.origin ?? undefined,
    caso: d.caseDTO
      ? {
          id: String(d.caseDTO.id),
          titulo: d.caseDTO.title ?? '',
          tipo: d.caseDTO.caseType ?? '',
        }
      : undefined,
  };
}

/**
 * Navega até a aba "Documentos" do contato via SPA e extrai os documentos
 * do scope isolado do componente <document-list>.
 */
async function buscarDocumentosContato(page: Page, contactId: string): Promise<DocumentoContato[]> {
  logger.debug({ contactId }, 'Buscando documentos do contato via SPA...');

  // Navegar via $state.go para a aba de documentos do contato
  await page.evaluate(
    ([cId]) => {
      const $state = (window as any).angular.element(document.body).injector().get('$state');
      $state.go('main.contacts-detail.documents', { contactId: cId });
    },
    [contactId] as [string],
  );

  // Aguardar o componente <document-list> carregar
  await page.waitForSelector('document-list', { timeout: 15_000 });

  // Aguardar que o loading do componente termine
  await page.waitForFunction(
    () => {
      const el = document.querySelector('document-list');
      if (!el) return false;
      const iScope = (window as any).angular.element(el).isolateScope?.();
      return iScope?.$ctrl?.loading === false;
    },
    { timeout: 15_000 },
  );

  // Extrair documentos do scope com paginação automática
  const rawDocs = await page.evaluate(async () => {
    const el = document.querySelector('document-list');
    if (!el) return [];

    const iScope = (window as any).angular.element(el).isolateScope?.();
    const ctrl = iScope?.$ctrl;
    if (!ctrl?.data?.documents) return [];

    // Se há mais páginas, carregar todas
    const MAX_PAGES = 20; // segurança contra loop infinito
    let pages = 0;
    while (ctrl.hasMorePages && pages < MAX_PAGES) {
      ctrl.loadMore();
      // Aguardar o loading finalizar
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!ctrl.loading) return resolve();
          setTimeout(check, 200);
        };
        setTimeout(check, 300);
      });
      pages++;
    }

    // Serializar documentos (sem referências circulares do Angular)
    return (ctrl.data.documents as any[]).map((d: any) => ({
      id: d.id,
      type: d.type,
      title: d.title,
      url: d.url,
      origin: d.origin,
      responsibleName: d.responsibleName,
      updateDateFormatted: d.updateDateFormatted,
      documentDescription: d.documentDescription,
      downloadDocumentUrl: d.downloadDocumentUrl,
      customerId: d.customerId,
      customerName: d.customerName,
      caseDTO: d.caseDTO
        ? { id: d.caseDTO.id, title: d.caseDTO.title, caseType: d.caseDTO.caseType }
        : null,
    }));
  }) as AstreaDocumentScope[];

  const documentos = rawDocs.map(mapDocumentScope);
  logger.debug({ contactId, count: documentos.length }, 'Documentos do contato obtidos com sucesso.');
  return documentos;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service: Buscar Cliente por ID (ou nome/CPF)
//
// GET /api/clientes/:id
//
// Se `id` for um número longo (ID do Astrea ≥ 10 dígitos):
//   → GET /api/v2/contact/{id}/details (retorno imediato com dados completos)
//
// Se `id` for texto (nome ou CPF):
//   → POST /api/v2/contact/all (busca) → pega o primeiro resultado
//   → GET /api/v2/contact/{id}/details
//
// A resposta inclui urlDrive, e a lista de documentos da aba "Documentos".
// ─────────────────────────────────────────────────────────────────────────────

export async function buscarCliente(idOrNomeCpf: string): Promise<ServiceResponse<Cliente>> {
  try {
    const data = await withBrowserContext(async (page) => {
      // Garante que o app AngularJS está carregado
      await navigateTo(page, ANGULAR_PAGE_PATH);

      let contactId = idOrNomeCpf.trim();
      const isNumericId = /^\d{10,}$/.test(contactId);

      if (!isNumericId) {
        logger.debug({ search: contactId }, 'Buscando contato por nome/CPF...');

        const listResponse = await astreaApiPost<AstreaContactListResponse>(
          page,
          `${ASTREA_API}/contact/all`,
          buildSearchPayload(contactId, 0, 1),
        );

        if (!listResponse.contacts?.length) {
          throw new Error('NOT_FOUND: Contato não encontrado');
        }

        contactId = String(listResponse.contacts[0].id);
        logger.debug({ contactId }, 'ID do contato encontrado');
      }

      const details = await astreaApiGet<AstreaContactDetails>(
        page,
        `${ASTREA_API}/contact/${contactId}/details`,
      ).catch((err: unknown) => {
        if (err instanceof Error && err.message.includes('API_ERROR_404')) {
          throw new Error('NOT_FOUND: Contato não encontrado');
        }
        throw err;
      });

      const cliente = mapContactDetails(details);

      // Buscar documentos do contato via scraping do scope AngularJS
      cliente.documentos = await buscarDocumentosContato(page, contactId);

      return cliente;
    });

    return { ok: true, data };
  } catch (err) {
    logger.error({ err }, 'Erro em buscarCliente');
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
