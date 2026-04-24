import { Page } from 'playwright';
import { withBrowserContext } from '../browser/astrea-http.js';
import { navigateTo } from '../browser/navigator.js';
import { isRetryablePlaywrightError } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { urlContato } from '../utils/astrea-urls.js';
import type {
  Cliente,
  ClienteResumido,
  CriarClienteInput,
  DocumentoContato,
} from '../models/index.js';
import type { FiltrosCliente, ServiceResponse, PaginationMeta } from '../types/index.js';

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
const CONTACT_ADD_PERSONAL_PATH = '/#/main/contacts/add-edit-merge/%5B,,,%5B%5D,%5D/personal';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos da API interna do Astrea (Mapeados via playwright-mcp em 21/02/2026)
//
// Endpoint de lista:   POST https://app.astrea.net.br/api/v2/contact/all
// Endpoint de detalhe: GET  https://app.astrea.net.br/api/v2/contact/{id}/details
// ─────────────────────────────────────────────────────────────────────────────

interface AstreaPhone {
  typeEnum?: string;
  number?: string; // campo em /details
  telephone?: string; // campo em /all (lista)
  operator?: string;
}

interface AstreaEmail {
  typeEnum?: string;
  address?: string; // campo em /details
  email?: string; // campo em /all (lista)
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

interface AstreaSaveContactResponse {
  response?: string | number;
  errorMessage?: string;
}

interface AstreaContactDraft {
  contactKind?: string;
  classification?: number;
  name?: string;
  nickname?: string;
  taxDocumentNumber?: string;
  clientOrigin?: string;
  telephones?: Array<{ type?: string; operator?: string; number?: string }>;
  emails?: Array<{ type?: string; address?: string }>;
  addresses?: Array<{
    type?: string;
    zipCode?: string;
    street?: string;
    number?: string;
    complement?: string;
    district?: string;
    city?: string;
    state?: string;
    countryName?: string;
  }>;
  webSites?: Array<{ url?: string }>;
  [key: string]: unknown;
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

async function loadDefaultContactDraft(page: Page): Promise<AstreaContactDraft> {
  await navigateTo(page, CONTACT_ADD_PERSONAL_PATH);
  await page.waitForSelector('button[ng-click="save(myForm.$invalid)"]', { timeout: 15_000 });

  return page.evaluate(() => {
    const saveBtn = Array.from(document.querySelectorAll('button')).find(
      (button) => (button.textContent ?? '').trim() === 'Salvar',
    );

    if (!saveBtn) {
      throw new Error('FORM_UNAVAILABLE: botão de salvar do contato não encontrado');
    }

    const ng = (window as any).angular;
    const scope = ng?.element(saveBtn)?.scope?.();
    const controllerScope = scope?.$parent ?? scope;
    if (!controllerScope?.contact) {
      throw new Error('FORM_UNAVAILABLE: payload base do contato não encontrado');
    }

    return JSON.parse(JSON.stringify(controllerScope.contact));
  });
}

function buildContactPayload(
  baseDraft: AstreaContactDraft,
  input: CriarClienteInput,
): AstreaContactDraft {
  const payload: AstreaContactDraft = {
    ...baseDraft,
    name: input.nome.trim(),
    classification: input.perfil === 'contato' ? 2 : 1,
    contactKind: input.tipo === 'pessoa_juridica' ? 'COMPANY' : 'PERSON',
    nickname: input.apelido?.trim() || '',
    taxDocumentNumber: input.cpfCnpj?.trim() || '',
    clientOrigin: input.origem?.trim() || '',
    telephones: Array.isArray(baseDraft.telephones)
      ? baseDraft.telephones.map((phone) => ({ ...phone }))
      : [{ type: '', operator: '', number: '' }],
    emails: Array.isArray(baseDraft.emails)
      ? baseDraft.emails.map((email) => ({ ...email }))
      : [{ type: '', address: '' }],
    addresses: Array.isArray(baseDraft.addresses)
      ? baseDraft.addresses.map((address) => ({ ...address }))
      : [
          {
            type: '',
            zipCode: '',
            street: '',
            number: '',
            complement: '',
            district: '',
            city: '',
            state: '',
            countryName: '',
          },
        ],
    webSites: Array.isArray(baseDraft.webSites)
      ? baseDraft.webSites.map((site) => ({ ...site }))
      : [{ url: '' }],
  } satisfies AstreaContactDraft;

  if (payload.classification !== 1) {
    payload.clientOrigin = undefined;
  }

  if (input.telefone?.trim()) {
    payload.telephones![0] = {
      ...payload.telephones![0],
      number: input.telefone.trim(),
    };
  }

  if (input.email?.trim()) {
    payload.emails![0] = {
      ...payload.emails![0],
      address: input.email.trim(),
    };
  }

  if (input.site?.trim()) {
    payload.webSites![0] = {
      ...payload.webSites![0],
      url: input.site.trim(),
    };
  }

  if (typeof input.endereco === 'string' && input.endereco.trim()) {
    payload.addresses![0] = {
      ...payload.addresses![0],
      street: input.endereco.trim(),
    };
  } else if (input.endereco && typeof input.endereco === 'object') {
    payload.addresses![0] = {
      ...payload.addresses![0],
      zipCode: input.endereco.cep?.trim() ?? '',
      street: input.endereco.logradouro?.trim() ?? '',
      number: input.endereco.numero?.trim() ?? '',
      complement: input.endereco.complemento?.trim() ?? '',
      district: input.endereco.bairro?.trim() ?? '',
      city: input.endereco.cidade?.trim() ?? '',
      state: input.endereco.estado?.trim() ?? '',
      countryName: input.endereco.pais?.trim() ?? '',
    };
  }

  return payload;
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

  const id = String(d.id);
  return {
    id,
    nome: d.name?.trim() ?? '',
    url: urlContato(id),
    cpfCnpj: d.taxDocumentNumber ?? undefined,
    email,
    telefone,
    urlDrive,
    endereco,
    dataNascimento: d.birthDate ?? undefined,
    origem: d.clientOrigin ?? undefined,
    tipo:
      d.contactKind === 'PERSON'
        ? 'pessoa_fisica'
        : d.contactKind === 'COMPANY'
          ? 'pessoa_juridica'
          : undefined,
    createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : undefined,
  };
}

function mapContactListItem(item: AstreaContactListItem): Cliente {
  const telefone =
    item.telephones?.find((t) => t.typeEnum?.includes('CELLULAR'))?.telephone ??
    item.telephones?.[0]?.telephone ??
    undefined;

  const email = item.emails?.[0]?.address ?? (item.emails?.[0] as any)?.email ?? undefined;

  const id = String(item.id);
  return {
    id,
    nome: item.name?.trim() ?? '',
    url: urlContato(id),
    email,
    telefone,
    tipo:
      item.contactKind === 'PERSON'
        ? 'pessoa_fisica'
        : item.contactKind === 'COMPANY'
          ? 'pessoa_juridica'
          : undefined,
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

  const email = item.emails?.[0]?.address ?? (item.emails?.[0] as any)?.email ?? undefined;

  const endereco = item.addresses?.[0]?.display ?? undefined;

  const etiquetas = item.tags?.map((t) => t.name ?? '').filter(Boolean) ?? undefined;

  const id = String(item.id);
  return {
    id,
    nome: item.name?.trim() ?? '',
    url: urlContato(id),
    classificacao: item.classificationName ?? undefined,
    tipo:
      item.contactKind === 'PERSON'
        ? 'pessoa_fisica'
        : item.contactKind === 'COMPANY'
          ? 'pessoa_juridica'
          : undefined,
    telefone,
    email,
    endereco,
    etiquetas: etiquetas?.length ? etiquetas : undefined,
    criadoEm: item.createdAt ?? undefined,
  };
}

/**
 * Formata dígitos de CPF (11) ou CNPJ (14) no padrão brasileiro com máscara.
 * O campo `taxDocumentNumber` no Astrea é armazenado com máscara, e a busca
 * `queryDTO.text` faz match literal — sem máscara, não casa.
 * Retorna undefined se a entrada não tem 11 nem 14 dígitos.
 */
function formatarDocumentoComMascara(documento: string): string | undefined {
  const d = documento.replace(/\D/g, '');
  if (d.length === 11) {
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  return undefined;
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

export async function listarClientes(
  filtros?: FiltrosCliente,
): Promise<ServiceResponse<Cliente[]>> {
  try {
    const data = await withBrowserContext(async (page) => {
      // Garante que o app AngularJS está carregado (necessário para $http interceptors)
      await navigateTo(page, ANGULAR_PAGE_PATH);

      const pagina = filtros?.pagina ?? 1;
      const limite = filtros?.limite ?? 50;

      const cpfDigits = filtros?.cpfCnpj ? filtros.cpfCnpj.replace(/\D/g, '') : '';
      // O queryDTO.text da API /contact/all busca por nome e por documento, MAS
      // o match em documento é literal contra `taxDocumentNumber`, que o Astrea
      // armazena com máscara ("110.010.357-04"). Sem máscara o backend retorna 0.
      // Preferir nome; senão usar cpfCnpj formatado com máscara. Se o filtro
      // vier com tamanho inesperado (nem CPF nem CNPJ), cai em string vazia.
      const cpfComMascara = cpfDigits ? formatarDocumentoComMascara(cpfDigits) : undefined;
      const searchText = filtros?.nome?.trim() || cpfComMascara || '';

      const response = await astreaApiPost<AstreaContactListResponse>(
        page,
        `${ASTREA_API}/contact/all`,
        buildSearchPayload(searchText, pagina - 1, limite),
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

      // Enriquecer com /details quando o usuário pediu nome ou cpfCnpj. O cpf não
      // está no AstreaContactListItem (só no details), então o enrichment é
      // obrigatório para filtrar pelo documento abaixo.
      const MAX_ENRICH = 20;
      const shouldEnrich = !!filtros?.nome || !!cpfDigits;
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

      // Filtro local por cpfCnpj: a busca text da API é substring e pode casar o
      // documento como parte do nome, telefone, etc. Garantir match exato nos dígitos.
      if (cpfDigits) {
        clientes = clientes.filter((c) => {
          const candidatos = c.cpfCnpj ? c.cpfCnpj.replace(/\D/g, '') : '';
          return candidatos.includes(cpfDigits);
        });
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
// Service: Mesclar (Unificar) Contatos
//
// POST /api/clientes/mesclar
//
// Fluxo capturado da UI do Astrea (via chrome-devtools em 2026-04-23):
//  1. POST /api/v2/contact/ids com [idPrincipal, ...idsMesclados]
//     → retorna array de contatos (o servidor "prepara" o merge)
//  2. POST /api/v2/contact/merge com o objeto completo do contato principal
//     → servidor unifica usando o state da chamada anterior
//
// Ação IRREVERSÍVEL: os contatos em `idsMesclados` deixam de existir, e todos
// os dados (casos, telefones, emails, endereços, etc.) são incorporados no
// contato principal. Campos únicos (CPF, RG, nome) mantêm os do principal.
// ─────────────────────────────────────────────────────────────────────────────

export interface MesclarClientesInput {
  idPrincipal: string;
  idsMesclados: string[];
}

export async function mesclarClientes(
  input: MesclarClientesInput,
): Promise<ServiceResponse<Cliente>> {
  try {
    const idPrincipal = input.idPrincipal?.trim();
    const idsMesclados = input.idsMesclados.map((id) => id.trim()).filter(Boolean);

    if (!idPrincipal) {
      return {
        ok: false,
        error: {
          message: 'idPrincipal é obrigatório',
          code: 'VALIDATION_ERROR',
          retryable: false,
        },
      };
    }
    if (idsMesclados.length === 0) {
      return {
        ok: false,
        error: {
          message: 'idsMesclados deve conter ao menos um ID',
          code: 'VALIDATION_ERROR',
          retryable: false,
        },
      };
    }
    if (idsMesclados.includes(idPrincipal)) {
      return {
        ok: false,
        error: {
          message: 'idsMesclados não pode incluir o idPrincipal',
          code: 'VALIDATION_ERROR',
          retryable: false,
        },
      };
    }

    await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);

      const todosIds = [idPrincipal, ...idsMesclados].map((id) => {
        const n = Number(id);
        if (!Number.isFinite(n)) {
          throw new Error(`VALIDATION_ERROR: ID inválido "${id}"`);
        }
        return n;
      });

      const contatos = await astreaApiPost<AstreaContactDetails[]>(
        page,
        `${ASTREA_API}/contact/ids`,
        todosIds,
      );

      const principal = contatos.find((c) => String(c.id) === idPrincipal);
      if (!principal) {
        throw new Error(`NOT_FOUND: Contato principal ${idPrincipal} não encontrado`);
      }

      const response = await astreaApiPost<AstreaSaveContactResponse>(
        page,
        `${ASTREA_API}/contact/merge`,
        principal,
      );

      if (response.response === 'NOT_OK') {
        throw new Error(
          `API_ERROR: ${response.errorMessage || 'Astrea retornou NOT_OK ao mesclar contatos'}`,
        );
      }
    });

    return await buscarCliente(idPrincipal);
  } catch (err) {
    logger.error({ err, input }, 'Erro em mesclarClientes');
    const msg = err instanceof Error ? err.message : 'Erro desconhecido';
    const code = msg.startsWith('VALIDATION_ERROR')
      ? 'VALIDATION_ERROR'
      : msg.startsWith('NOT_FOUND')
        ? 'NOT_FOUND'
        : 'API_ERROR';
    return {
      ok: false,
      error: {
        message: msg.replace(/^(VALIDATION_ERROR|NOT_FOUND|API_ERROR):\s*/, ''),
        code,
        retryable: isRetryablePlaywrightError(err),
      },
    };
  }
}

export async function criarCliente(input: CriarClienteInput): Promise<ServiceResponse<Cliente>> {
  try {
    const contactId = await withBrowserContext(async (page) => {
      const baseDraft = await loadDefaultContactDraft(page);
      const payload = buildContactPayload(baseDraft, input);

      const response = await astreaApiPost<AstreaSaveContactResponse>(
        page,
        `${ASTREA_API}/contact/save`,
        payload,
      );

      const createdContactId = response.response;
      if (createdContactId == null || createdContactId === 'NOT_OK') {
        throw new Error(
          `API_ERROR: ${response.errorMessage || 'Astrea não retornou o ID do contato criado'}`,
        );
      }

      return String(createdContactId);
    });

    return await buscarCliente(contactId);
  } catch (err) {
    logger.error({ err, input }, 'Erro em criarCliente');
    return {
      ok: false,
      error: {
        message:
          err instanceof Error ? err.message.replace(/^API_ERROR:\s*/, '') : 'Erro desconhecido',
        code: 'API_ERROR',
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

/**
 * Procura a pasta Drive dentro da lista de documentos do contato.
 * Regra: documento tipo DTE_DRIVE, ou URL que aponta para uma pasta do Drive.
 * Usado como fallback para `Cliente.urlDrive` quando o campo "Site" do
 * cadastro não foi preenchido.
 */
function findUrlPastaDriveNosDocumentos(documentos: DocumentoContato[]): string | undefined {
  for (const doc of documentos) {
    if (!doc.url) continue;
    if (doc.tipo === 'DTE_DRIVE' || /drive\.google\.com\/drive\/folders/i.test(doc.url)) {
      return doc.url;
    }
  }
  return undefined;
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
  const rawDocs = (await page.evaluate(async () => {
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
  })) as AstreaDocumentScope[];

  const documentos = rawDocs.map(mapDocumentScope);
  logger.debug(
    { contactId, count: documentos.length },
    'Documentos do contato obtidos com sucesso.',
  );
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

      // Fallback: se o campo "Site" do cadastro não tem a pasta Drive, tentar
      // derivar da lista de documentos (tipo DTE_DRIVE ou URL com /drive/folders/).
      if (!cliente.urlDrive && cliente.documentos?.length) {
        cliente.urlDrive = findUrlPastaDriveNosDocumentos(cliente.documentos);
      }

      return cliente;
    });

    return { ok: true, data };
  } catch (err) {
    logger.error({ err }, 'Erro em buscarCliente');
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
