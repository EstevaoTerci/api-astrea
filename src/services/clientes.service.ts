import { Page } from 'playwright';
import {
  withBrowserContext,
  astreaApiGet,
  astreaApiPost,
  getAstreaUserId,
  ASTREA_API,
} from '../browser/astrea-http.js';
import { navigateTo } from '../browser/navigator.js';
import { isRetryablePlaywrightError } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { urlContato } from '../utils/astrea-urls.js';
import type {
  Cliente,
  ClienteResumido,
  CriarClienteInput,
  AtualizarClienteInput,
  DocumentoContato,
} from '../models/index.js';
import type {
  FiltrosCliente,
  FiltrosTodosClientes,
  ServiceResponse,
  PaginationMeta,
} from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

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
// Os wrappers `astreaApiGet`/`astreaApiPost` (importados de ../browser/astrea-http)
// já tratam a inicialização do $http de forma defensiva (optional chaining) e
// padronizam as mensagens de erro. Ao usá-los em vez de helpers locais, evitamos
// crashes do tipo "Cannot read properties of undefined (reading 'element')"
// quando o Angular ainda não está disponível.
// ─────────────────────────────────────────────────────────────────────────────

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

interface QueryDTOFiltros {
  text?: string;
  mesAniversario?: number;
  estado?: string;
  etiquetasIds?: number[];
  apenasComEmail?: boolean;
  buscarEmEmpresa?: boolean;
}

/**
 * Monta o `queryDTO` aceito pelo POST /contact/all do Astrea, mapeando os
 * nomes em PT-BR da nossa API para os campos originais. Campos não passados
 * recebem o valor "neutro" que a UI usa no estado padrão.
 */
function buildQueryDTO(filtros: QueryDTOFiltros) {
  return {
    type: '',
    text: (filtros.text ?? '').trim(),
    order: 'nameUpperCase',
    selectedTagsIds: filtros.etiquetasIds ?? [],
    startsWith: [],
    onlyWithEmail: filtros.apenasComEmail ?? false,
    searchInCompany: filtros.buscarEmEmpresa ?? false,
    customerNotificationTypeFilter: 'ALL',
    customerNotification: ['CLIPPING', 'AUTOMATIC_HISTORIES'],
    customerNotificationArtificialIntelligenceFilter: 'ALL',
    birthMonth: filtros.mesAniversario ?? 0,
    state: filtros.estado?.trim() ?? '',
  };
}

function buildSearchPayload(
  filtros: QueryDTOFiltros,
  apiPage: number,
  limit: number,
) {
  return {
    queryDTO: buildQueryDTO(filtros),
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
        `/contact/all`,
        buildSearchPayload(
          {
            text: searchText,
            mesAniversario: filtros?.mesAniversario,
            estado: filtros?.estado,
            etiquetasIds: filtros?.etiquetasIds,
            apenasComEmail: filtros?.apenasComEmail,
            buscarEmEmpresa: filtros?.buscarEmEmpresa,
          },
          pagina - 1,
          limite,
        ),
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
                `/contact/${item.id}/details`,
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

export async function listarTodosClientes(
  filtros?: FiltrosTodosClientes,
): Promise<ServiceResponse<ClienteResumido[]>> {
  try {
    const data = await withBrowserContext(async (page) => {
      // Garante que o app AngularJS está carregado
      await navigateTo(page, ANGULAR_PAGE_PATH);

      logger.debug({ filtros }, 'Buscando lista completa de contatos via API...');

      const response = await astreaApiPost<AstreaContactListResponse>(
        page,
        `/contact/all`,
        {
          queryDTO: {
            ...buildQueryDTO({
              mesAniversario: filtros?.mesAniversario,
              estado: filtros?.estado,
              etiquetasIds: filtros?.etiquetasIds,
              apenasComEmail: filtros?.apenasComEmail,
            }),
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
      const todosIds = [idPrincipal, ...idsMesclados].map((id) => {
        const n = Number(id);
        if (!Number.isFinite(n)) {
          throw new Error(`VALIDATION_ERROR: ID inválido "${id}"`);
        }
        return n;
      });

      // Navegar para a URL do form de unificação — a SPA do Astrea faz o
      // POST /contact/ids e monta o scope.contact consolidado (merge dos
      // dados dos 2+ contatos, com campos no formato exato que /contact/merge
      // aceita — birthYear/Day/Month como number, countryName no endereço etc).
      //
      // Formato da URL: /add-edit-merge/[,,true,[ID_PRINCIPAL,ID_SLAVE...],]/personal
      // O primeiro ID da lista vira o master selecionado no dropdown por default.
      // Primeiro garante que o app AngularJS está carregado e pronto — sem
      // isso, uma navegação direta para a rota de merge pode não ativar o
      // roteador e o form nunca renderiza.
      await navigateTo(page, ANGULAR_PAGE_PATH);
      await page.waitForFunction(
        () => !!(window as unknown as { angular?: unknown }).angular,
        null,
        { timeout: 20_000 },
      );

      // Agora navega para a rota de unificação via $state.go (UI-Router).
      // State: main.contacts-add-edit-merge.personal
      // Params: contactId, name, merge, ids (array), fromFolder
      //   → merge=true + ids=[...] é o que ativa o modo "Unificar contatos"
      await page.evaluate((ids: number[]) => {
        const ng = (window as unknown as {
          angular: {
            element: (el: Element) => {
              injector: () => {
                get: (name: string) => { go: (state: string, params: Record<string, unknown>) => unknown };
              };
            };
          };
        }).angular;
        const $state = ng.element(document.body).injector().get('$state');
        $state.go('main.contacts-add-edit-merge.personal', {
          contactId: '',
          name: '',
          merge: true,
          ids,
          fromFolder: '',
        });
      }, todosIds);

      // Aguardar o form renderizar (botão Salvar aparece quando o scope está pronto)
      await page.waitForSelector('button[ng-click="save(myForm.$invalid)"]', { timeout: 25_000 });

      // Aguardar o scope.contact ser populado. O botão Salvar aparece antes de
      // POST /contact/ids voltar, então precisamos esperar scope.contact.id e
      // scope.isMerge estarem prontos.
      await page.waitForFunction(
        (expectedId: string) => {
          const btn = document.querySelector('button[ng-click="save(myForm.$invalid)"]');
          if (!btn) return false;
          const ng = (window as unknown as { angular?: { element: (el: Element) => { scope: () => unknown } } }).angular;
          if (!ng) return false;
          const scope = ng.element(btn).scope() as { contact?: { id?: number | string; name?: string }; isMerge?: boolean } | undefined;
          return !!(
            scope &&
            scope.isMerge === true &&
            scope.contact &&
            scope.contact.name &&
            String(scope.contact.id) === expectedId
          );
        },
        idPrincipal,
        { timeout: 20_000 },
      );

      // Ler o payload consolidado do scope. Usar angular.toJson em vez de
      // JSON.stringify — ele remove campos internos do Angular ($$hashKey etc),
      // que o backend do Astrea rejeita.
      const payload = await page.evaluate((expectedId: string) => {
        const saveBtn = document.querySelector('button[ng-click="save(myForm.$invalid)"]');
        if (!saveBtn) throw new Error('FORM_UNAVAILABLE: botão Salvar não encontrado');

        const ng = (window as unknown as {
          angular: {
            element: (el: Element) => { scope: () => { contact?: Record<string, unknown>; isMerge?: boolean } };
            toJson: (obj: unknown) => string;
          };
        }).angular;
        const scope = ng.element(saveBtn).scope();
        if (!scope?.contact) throw new Error('FORM_UNAVAILABLE: scope.contact não encontrado');
        if (!scope.isMerge) throw new Error('FORM_UNAVAILABLE: scope não está em modo merge');

        const contact = JSON.parse(ng.toJson(scope.contact)) as Record<string, unknown>;
        if (String(contact.id) !== expectedId) {
          throw new Error(
            `FORM_UNAVAILABLE: master selecionado (${contact.id}) difere do idPrincipal (${expectedId})`,
          );
        }
        return contact;
      }, idPrincipal);

      // Descobrir o userId do usuário logado. O Astrea não expõe endpoint
      // "current user" — pegar do localStorage (Hotjar grava em _hjUserAttributes
      // como base64 JSON {userId, ...}). Fallback: regex em chaves tipo
      // "case_suggestions_for_user_<ID>_...".
      const userId = await page.evaluate(() => {
        try {
          const raw = localStorage.getItem('_hjUserAttributes');
          if (raw) {
            const decoded = JSON.parse(atob(raw)) as { userId?: string };
            if (decoded.userId) return String(decoded.userId);
          }
        } catch {
          // ignore
        }
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i) || '';
          const m = key.match(/_user_(\d{10,})(?:_|$)/);
          if (m) return m[1];
        }
        return null;
      });

      if (!userId) {
        throw new Error('API_ERROR: não foi possível obter o userId do usuário logado');
      }

      // Estrutura REAL esperada pelo POST /contact/merge:
      //   {
      //     destinationContact: {...master completo},
      //     destinationContactId: <masterId>,
      //     originContactIds: [masterId, ...slavesIds]  (inclui o próprio master!),
      //     userId: "<userId do usuário logado>"
      //   }
      const mergeBody = {
        destinationContact: payload,
        destinationContactId: Number(idPrincipal),
        originContactIds: [Number(idPrincipal), ...idsMesclados.map((id) => Number(id))],
        userId,
      };

      logger.debug(
        { idPrincipal, idsMesclados, userId },
        'Enviando /contact/merge',
      );

      // Chamamos $http diretamente (em vez de astreaApiPost) para capturar o
      // body de erro do backend — astreaApiPost descarta detalhes do 400.
      const merged = (await page.evaluate(
        ([apiUrl, body]) =>
          new Promise((resolve) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const http = (window as any).angular.element(document.body).injector().get('$http');
            http
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .post(apiUrl, body)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .then((r: any) => resolve({ ok: true, status: r.status, data: r.data }))
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .catch((err: any) =>
                resolve({
                  ok: false,
                  status: err?.status,
                  statusText: err?.statusText,
                  data: err?.data,
                }),
              );
          }),
        [`${ASTREA_API}/contact/merge`, mergeBody] as [string, Record<string, unknown>],
      )) as { ok: boolean; status?: number; statusText?: string; data?: unknown };

      if (!merged.ok) {
        logger.error(
          { idPrincipal, status: merged.status, statusText: merged.statusText, data: merged.data, payload },
          'Astrea rejeitou /contact/merge',
        );
        throw new Error(
          `API_ERROR: Astrea retornou ${merged.status} ${merged.statusText || ''} — ${JSON.stringify(merged.data)}`,
        );
      }

      const response = merged.data as AstreaSaveContactResponse;

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
        `/contact/save`,
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
// Service: Atualizar Cliente (PATCH parcial)
//
// PATCH /api/clientes/:id
//
// Fluxo 100% HTTP (sem webscraping):
//  1. GET /api/v2/contact/{id}/details — pega o objeto atual completo
//  2. Normalização: birthYear/birthDay/birthMonth vêm como string em /details
//     mas /save espera number. Endereços precisam de countryName preenchido
//     (o /details omite, mas a UI sempre envia "Brasil" quando countryCode="76").
//  3. Aplica os overrides do input sobre o objeto normalizado
//  4. POST /api/v2/contact/save com o objeto inteiro (operação é "full replace",
//     não PATCH — por isso temos que ler antes e mesclar)
//
// Discovery feito em 2026-05-03 capturando a request real da UI ao salvar
// uma edição. Diff entre /details (read) e /save (write):
//   - birth* (string vs number)
//   - addresses[].countryName ausente em /details
//   - emails:[] vs emails:[{typeEnum:"BLANK",valid:true}] (UI manda placeholder)
//   - classificationEditDisabled e company aparecem só no /save (metadata UI)
// Os campos "metadata" são re-enviados por garantia.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converte para number quando o valor é numérico-string ou number; caso contrário undefined.
 * /details retorna birthYear/Day/Month como string ("1964"), mas /save espera number.
 */
function toFiniteNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Normaliza o objeto retornado por /contact/{id}/details para o formato
 * exato esperado por POST /contact/save. Não muda a semântica — só ajusta
 * tipos/campos que a UI preenche silenciosamente.
 */
function normalizeDetailsForSave(
  d: AstreaContactDetails & Record<string, unknown>,
): Record<string, unknown> {
  const addresses = Array.isArray(d.addresses)
    ? d.addresses.map((a) => {
        const addr = a as Record<string, unknown>;
        return {
          ...addr,
          countryName:
            (addr.countryName as string | undefined) ??
            (addr.countryCode === '76' ? 'Brasil' : undefined),
        };
      })
    : d.addresses;

  return {
    ...d,
    birthYear: toFiniteNumber(d.birthYear),
    birthDay: toFiniteNumber(d.birthDay),
    birthMonth: toFiniteNumber(d.birthMonth),
    addresses,
    classificationEditDisabled: true,
    company: null,
  };
}

/**
 * Aplica os overrides parciais do AtualizarClienteInput sobre o objeto base
 * (já normalizado a partir de /details). Campos não passados ficam intactos.
 */
function applyContactPatch(
  base: Record<string, unknown>,
  input: AtualizarClienteInput,
): Record<string, unknown> {
  const patched: Record<string, unknown> = { ...base };

  if (input.nome !== undefined) patched.name = input.nome.trim();
  if (input.apelido !== undefined) patched.nickname = input.apelido.trim();
  if (input.cpfCnpj !== undefined) patched.taxDocumentNumber = input.cpfCnpj.trim();
  if (input.origem !== undefined) patched.clientOrigin = input.origem.trim();

  if (input.site !== undefined) {
    const sitesAtual = Array.isArray(patched.webSites)
      ? [...(patched.webSites as Array<Record<string, unknown>>)]
      : [];
    if (sitesAtual.length > 0) {
      sitesAtual[0] = { ...sitesAtual[0], url: input.site.trim() };
    } else {
      sitesAtual.push({ url: input.site.trim() });
    }
    patched.webSites = sitesAtual;
  }

  if (input.email !== undefined) {
    const emailsAtual = Array.isArray(patched.emails)
      ? [...(patched.emails as Array<Record<string, unknown>>)]
      : [];
    const novoEmail = input.email.trim();
    if (emailsAtual.length > 0) {
      emailsAtual[0] = { ...emailsAtual[0], address: novoEmail };
    } else {
      emailsAtual.push({ typeEnum: 'PERSONAL', address: novoEmail, valid: true });
    }
    patched.emails = emailsAtual;
  }

  if (input.telefone !== undefined) {
    const fonesAtual = Array.isArray(patched.telephones)
      ? [...(patched.telephones as Array<Record<string, unknown>>)]
      : [];
    const novoNumero = input.telefone.trim();
    if (fonesAtual.length > 0) {
      fonesAtual[0] = { ...fonesAtual[0], number: novoNumero };
    } else {
      fonesAtual.push({ typeEnum: 'PERSONAL_CELLULAR', number: novoNumero, operator: '' });
    }
    patched.telephones = fonesAtual;
  }

  if (input.endereco !== undefined) {
    const enderecosAtual = Array.isArray(patched.addresses)
      ? [...(patched.addresses as Array<Record<string, unknown>>)]
      : [];
    const baseAddr = enderecosAtual[0] ?? { typeEnum: 'HOME', countryCode: '76', countryName: 'Brasil' };
    if (typeof input.endereco === 'string') {
      enderecosAtual[0] = { ...baseAddr, street: input.endereco.trim() };
    } else {
      const e = input.endereco;
      enderecosAtual[0] = {
        ...baseAddr,
        ...(e.cep !== undefined ? { zipCode: e.cep.trim() } : {}),
        ...(e.logradouro !== undefined ? { street: e.logradouro.trim() } : {}),
        ...(e.numero !== undefined ? { number: e.numero.trim() } : {}),
        ...(e.complemento !== undefined ? { complement: e.complemento.trim() } : {}),
        ...(e.bairro !== undefined ? { district: e.bairro.trim() } : {}),
        ...(e.cidade !== undefined ? { city: e.cidade.trim() } : {}),
        ...(e.estado !== undefined ? { state: e.estado.trim() } : {}),
        ...(e.pais !== undefined ? { countryName: e.pais.trim() } : {}),
      };
    }
    patched.addresses = enderecosAtual;
  }

  return patched;
}

export async function atualizarCliente(
  id: string,
  input: AtualizarClienteInput,
): Promise<ServiceResponse<Cliente>> {
  try {
    const idTrim = id.trim();
    if (!idTrim) {
      return {
        ok: false,
        error: { message: 'id é obrigatório', code: 'VALIDATION_ERROR', retryable: false },
      };
    }

    // Se input vier vazio, evita chamada desnecessária
    const temAlgumCampo = Object.values(input).some((v) => v !== undefined);
    if (!temAlgumCampo) {
      return {
        ok: false,
        error: {
          message: 'Pelo menos um campo deve ser informado para atualização',
          code: 'VALIDATION_ERROR',
          retryable: false,
        },
      };
    }

    await withBrowserContext(async (page) => {
      // Garante que o app AngularJS está carregado para o $http funcionar com auth
      await navigateTo(page, ANGULAR_PAGE_PATH);

      // 1. Lê o estado atual do contato
      const details = await astreaApiGet<AstreaContactDetails & Record<string, unknown>>(
        page,
        `/contact/${idTrim}/details`,
      ).catch((err: unknown) => {
        if (err instanceof Error && err.message.includes('API_ERROR_404')) {
          throw new Error('NOT_FOUND: Contato não encontrado');
        }
        throw err;
      });

      // 2. Normaliza para formato de write
      const normalized = normalizeDetailsForSave(details);

      // 3. Aplica os overrides do input
      const payload = applyContactPatch(normalized, input);

      // 4. Envia para /save (full replace)
      const response = await astreaApiPost<AstreaSaveContactResponse>(
        page,
        `/contact/save`,
        payload,
      );

      if (response.response == null || response.response === 'NOT_OK') {
        throw new Error(
          `API_ERROR: ${response.errorMessage || 'Astrea retornou erro ao salvar o contato'}`,
        );
      }
    });

    return await buscarCliente(idTrim);
  } catch (err) {
    logger.error({ err, id, input }, 'Erro em atualizarCliente');
    const msg = err instanceof Error ? err.message : 'Erro desconhecido';
    const code = msg.startsWith('NOT_FOUND')
      ? 'NOT_FOUND'
      : msg.startsWith('VALIDATION_ERROR')
        ? 'VALIDATION_ERROR'
        : 'API_ERROR';
    return {
      ok: false,
      error: {
        message: msg.replace(/^(NOT_FOUND|VALIDATION_ERROR|API_ERROR):\s*/, ''),
        code,
        retryable: isRetryablePlaywrightError(err),
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Buscar documentos de um contato via REST nativo
//
// Endpoint mapeado em 2026-05-19 (chrome-devtools MCP) capturando a chamada
// real que o componente <document-list> dispara ao abrir a aba "Documentos":
//
//   POST /api/v2/documents/all
//   Body: {
//     order: '-updateDate', limit: 30,
//     beginUpdateDate/endUpdateDate/beginCreateDate/endCreateDate: null,
//     origin: null,
//     customers: [contactId],   // ← filtro server-side por contato
//     descriptions: [], caseIds: [], responsibleIds: [],
//     userId,                    // ← userId do usuário logado
//     queryCursor: ''            // ← paginação por cursor
//   }
//   Resp: { queryCursor, count, dtoList: [...] }
//
// Substitui o DOM scrape antigo ($state.go + waitForSelector('document-list')
// + loadMore()), que ficou frágil quando o Astrea passou a renderizar o
// componente com display:hidden em alguns estados (causando timeout de 15s).
// ─────────────────────────────────────────────────────────────────────────────

/** Item do `dtoList` retornado por POST /documents/all */
interface AstreaDocumentDTO {
  id: number;
  type: string;
  title: string;
  url?: string;
  origin?: string;
  responsibleName?: string;
  /** Timestamp em ms da última atualização */
  updateDate?: number;
  downloadDocumentUrl?: string;
  customerId?: number;
  customerName?: string;
  caseDTO?: {
    id: number;
    title: string;
    caseType: string;
  } | null;
}

interface AstreaDocumentsAllResponse {
  queryCursor?: string;
  count?: number;
  dtoList?: AstreaDocumentDTO[];
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

/** Formata um timestamp (ms) para `dd/MM/yyyy` na timezone de São Paulo. */
function formatUpdateDate(ts: number | undefined): string | undefined {
  if (!ts || !Number.isFinite(ts)) return undefined;
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(ts));
  } catch {
    return undefined;
  }
}

function mapDocumentDTO(d: AstreaDocumentDTO): DocumentoContato {
  return {
    id: String(d.id),
    tipo: d.type ?? '',
    titulo: d.title ?? '',
    descricao: undefined, // /documents/all não retorna documentDescription
    url: d.url ?? undefined,
    urlDownload: d.downloadDocumentUrl ?? undefined,
    responsavel: d.responsibleName ?? undefined,
    ultimaEdicao: formatUpdateDate(d.updateDate),
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
 * Busca os documentos de um contato via POST /documents/all (REST nativo).
 * Paginação por cursor — encerra quando o backend devolve `queryCursor` vazio
 * ou `dtoList` vazio, com um teto de segurança de MAX_PAGES.
 */
async function buscarDocumentosContato(page: Page, contactId: string): Promise<DocumentoContato[]> {
  logger.debug({ contactId }, 'Buscando documentos do contato via REST...');

  const userId = await getAstreaUserId(page);

  const PAGE_SIZE = 50;
  const MAX_PAGES = 40;

  let cursor = '';
  let pages = 0;
  const documentos: DocumentoContato[] = [];

  while (pages < MAX_PAGES) {
    const res = await astreaApiPost<AstreaDocumentsAllResponse>(page, `/documents/all`, {
      order: '-updateDate',
      limit: PAGE_SIZE,
      beginUpdateDate: null,
      endUpdateDate: null,
      beginCreateDate: null,
      endCreateDate: null,
      origin: null,
      customers: [contactId],
      descriptions: [],
      caseIds: [],
      responsibleIds: [],
      userId,
      queryCursor: cursor,
    });

    const list = res.dtoList ?? [];
    for (const d of list) documentos.push(mapDocumentDTO(d));

    if (!res.queryCursor || list.length === 0) break;
    cursor = res.queryCursor;
    pages++;
  }

  logger.debug(
    { contactId, count: documentos.length, pages },
    'Documentos do contato obtidos via REST.',
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
// Por padrão NÃO carrega a aba "Documentos" (scrape lento e frágil: 15-45s
// quando o DOM do Astrea muda e cai em retry). Habilite com
// `incluirDocumentos: true` apenas quando o caller realmente precisa do
// array `documentos[]`.
// ─────────────────────────────────────────────────────────────────────────────

export interface BuscarClienteOpts {
  /**
   * Se true, faz scrape da aba "Documentos" do contato (lento — 1-15s no
   * caminho feliz, 45s+ em retry quando o DOM muda). Default false.
   * Habilite só quando o caller precisa dos documentos.
   */
  incluirDocumentos?: boolean;
}

export async function buscarCliente(
  idOrNomeCpf: string,
  opts: BuscarClienteOpts = {},
): Promise<ServiceResponse<Cliente>> {
  const incluirDocumentos = opts.incluirDocumentos ?? false;
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
          `/contact/all`,
          buildSearchPayload({ text: contactId }, 0, 1),
        );

        if (!listResponse.contacts?.length) {
          throw new Error('NOT_FOUND: Contato não encontrado');
        }

        contactId = String(listResponse.contacts[0].id);
        logger.debug({ contactId }, 'ID do contato encontrado');
      }

      const details = await astreaApiGet<AstreaContactDetails>(
        page,
        `/contact/${contactId}/details`,
      ).catch((err: unknown) => {
        if (err instanceof Error && err.message.includes('API_ERROR_404')) {
          throw new Error('NOT_FOUND: Contato não encontrado');
        }
        throw err;
      });

      const cliente = mapContactDetails(details);

      if (incluirDocumentos) {
        // Scrape opcional da aba "Documentos" (caminho lento)
        cliente.documentos = await buscarDocumentosContato(page, contactId);

        // Fallback do urlDrive só faz sentido com documentos carregados.
        // O caminho rápido (sem documentos) já tenta extrair do `webSites[]`
        // do /details em mapContactDetails.
        if (!cliente.urlDrive && cliente.documentos?.length) {
          cliente.urlDrive = findUrlPastaDriveNosDocumentos(cliente.documentos);
        }
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
