/**
 * Serviço de agenda para consumidores automatizados (atendente virtual Léia/n8n).
 *
 * Fase 1 — `calcularDisponibilidade`: intervalos OCUPADOS de um ou mais usuários
 * do Astrea numa janela, já com as regras de bloqueio (ver agenda-disponibilidade.ts).
 *  - NÃO chama `listarUsuarios()` (economiza uma aba de boot da SPA);
 *  - UMA chamada a `/calendar-pro/complete` com `userFilter.selected` = ids;
 *  - cache de 60 s com dedup de inflight; `fresh` fura o cache.
 *
 * Fase 2 — eventos (compromissos): criar, buscar, remarcar, cancelar, excluir e
 * buscar compromissos de um contato. Contrato de escrita confirmado em runtime em
 * 25/09/2026 (ver docs/agenda-eventos-discovery.md).
 *
 * Plano: assistente-marketing-escritorio/docs/plano-agenda-astrea-2026-09-25.md
 */

import type { Page } from 'playwright';
import {
  ANGULAR_PAGE_PATH,
  astreaApiDelete,
  astreaApiGet,
  astreaApiPost,
  astreaApiPut,
  getAstreaUserId,
  withBrowserContext,
} from '../browser/astrea-http.js';
import { navigateTo } from '../browser/navigator.js';
import { fetchCalendarPro, flagsParaTipos, mapAtividade } from './agenda.service.js';
import {
  computarBusy,
  isoParaEpoch,
  brtParaIso,
  TIPOS_OCUPAM_HORARIO_DEFAULT,
} from './agenda-disponibilidade.js';
import {
  DURACAO_PADRAO_MIN,
  extrairIdAppointment,
  montarPayloadAppointment,
  montarPayloadReschedule,
  refExterna,
  somarMinutos,
} from './agenda-appointment-payload.js';
import { buscarContatosNaPagina, criarContatoNaPagina, telefonesIguais } from './clientes.service.js';
import {
  criarAtendimentoNaPagina,
  listarAtendimentosDoContatoNaPagina,
} from './atendimentos.service.js';
import { listarUsuarios } from './usuarios.service.js';
import { InflightTtlCache, type InflightCacheStats } from '../utils/cache.js';
import { isRetryablePlaywrightError } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import type {
  ContatoEventoInput,
  CriarEventoAgendaInput,
  DisponibilidadeAgenda,
  EventoAgenda,
  EventoAgendaCriado,
  EventoDoContato,
  IntervaloOcupado,
  RemarcarEventoAgendaInput,
  ResultadoCriacaoEvento,
  StatusEventoAgenda,
  TipoEventoAgenda,
  Usuario,
} from '../models/index.js';
import type { FiltrosDisponibilidade, ServiceError, ServiceResponse } from '../types/index.js';

export const RE_ID_ASTREA = /^\d{10,20}$/;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^([01]?\d|2[0-3]):[0-5]\d$/;
const RE_CHAVE = /^[A-Za-z0-9#:_.-]{1,100}$/;
export const JANELA_MAX_DIAS = 31;
const DISPONIBILIDADE_TTL_MS = 60_000;
/** Timeout das escritas no Astrea: abaixo do timeout do consumidor (n8n 60–90 s). */
const TIMEOUT_ESCRITA_MS = 30_000;
const TIPOS_CONFLITO: TipoEventoAgenda[] = ['atendimento', 'audiencia'];

// ─────────────────────────────────────────────────────────────────────────────
// Cache de disponibilidade
// ─────────────────────────────────────────────────────────────────────────────

type DadosCacheados = Omit<DisponibilidadeAgenda, 'cache'>;

const disponibilidadeCache = new InflightTtlCache<DadosCacheados>(DISPONIBILIDADE_TTL_MS);

export function getDisponibilidadeCacheStats(): InflightCacheStats {
  return disponibilidadeCache.stats;
}

/** Descarta os dados do cache (inclusive loads em andamento) — chamar após qualquer mutação. */
export function invalidarDisponibilidadeCache(): void {
  disponibilidadeCache.invalidateAll();
}

/** Zera dados e métricas (testes). */
export function resetarDisponibilidadeCache(): void {
  disponibilidadeCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Erros
// ─────────────────────────────────────────────────────────────────────────────

function erroValidacao(message: string): { ok: false; error: ServiceError } {
  return { ok: false, error: { code: 'VALIDATION_ERROR', message, retryable: false } };
}

function hhmm(iso: string): string {
  return iso.slice(11, 16);
}

/** Horário já ocupado no Astrea. A mensagem não traz título (nome de cliente). */
export class ConflitoAgendaError extends Error {
  constructor(public readonly conflitos: IntervaloOcupado[]) {
    const p = conflitos[0];
    super(`CONFLICT: horário ocupado no Astrea (${p ? `${p.inicio.slice(0, 10)} ${hhmm(p.inicio)}–${hhmm(p.fim)}` : '?'})`);
    this.name = 'ConflitoAgendaError';
  }
}

/** Evento não foi criado pela automação (sem marcador [ref:]) — mutação exige `forcar`. */
export class EventoProtegidoError extends Error {
  constructor(id: string) {
    super(`FORBIDDEN: o evento ${id} não foi criado pela automação; use forcar=true para alterá-lo`);
    this.name = 'EventoProtegidoError';
  }
}

/** Remove o invólucro do Playwright ("page.evaluate: Error: ...") e o stack. */
export function limparMensagem(msg: string): string {
  return msg
    .replace(/^page\.evaluate:\s*(Error:\s*)?/, '')
    .split(/\n\s+at /)[0]
    .trim();
}

/**
 * Classifica falhas de browser/Astrea num código estável para o consumidor.
 * O n8n trata qualquer não-200 da disponibilidade como "não ofereça horários"
 * (fail-closed), mas o código ajuda a decidir retry/alerta.
 */
export function classificarErro(err: unknown): ServiceError {
  if (err instanceof ConflitoAgendaError) {
    return {
      code: 'CONFLICT',
      message: err.message,
      retryable: false,
      details: {
        conflitos: err.conflitos.map((c) => ({
          ...c,
          origens: c.origens.map(({ titulo: _t, ...resto }) => resto),
        })),
      },
    };
  }
  if (err instanceof EventoProtegidoError) {
    return { code: 'FORBIDDEN', message: err.message, retryable: false };
  }
  const message = limparMensagem(err instanceof Error ? err.message : String(err));
  if (/LOGIN_CIRCUIT_OPEN|LOGIN_FAILED_|QUEUE_FULL|QUEUE_TIMEOUT|BROWSER_POOL_TIMEOUT|BROWSER_UNAVAILABLE/.test(message)) {
    return { code: 'BROWSER_UNAVAILABLE', message, retryable: true };
  }
  if (/timeout/i.test(message)) {
    return { code: 'TIMEOUT', message, retryable: true };
  }
  if (/NOT_FOUND|API_ERROR_404|API_ERROR_410/.test(message)) {
    return { code: 'NOT_FOUND', message, retryable: false };
  }
  if (/^SEM_ID:/.test(message)) {
    return { code: 'API_ERROR', message, retryable: true };
  }
  return { code: 'API_ERROR', message, retryable: isRetryablePlaywrightError(err) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validação
// ─────────────────────────────────────────────────────────────────────────────

/** Data real no formato YYYY-MM-DD (recusa 2026-09-31, 2026-02-30, 2026-13-01). */
export function dataValida(s: string | undefined): boolean {
  if (!s || !RE_DATA.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === s;
}

function diasEntre(inicio: string, fim: string): number {
  return Math.round((Date.parse(`${fim}T00:00:00Z`) - Date.parse(`${inicio}T00:00:00Z`)) / 86_400_000);
}

function validarJanela(ids: string[] | undefined, inicio: string, fim: string): string | null {
  const lista = ids ?? [];
  if (lista.length === 0) return 'responsavelIds: informe ao menos um ID de usuário do Astrea';
  const invalido = lista.find((id) => !RE_ID_ASTREA.test(String(id)));
  if (invalido !== undefined) return `responsavelIds: ID inválido "${invalido}" (esperado número do Astrea)`;
  if (!dataValida(inicio) || !dataValida(fim)) return 'inicio/fim devem ser datas válidas no formato YYYY-MM-DD';
  const dias = diasEntre(inicio, fim);
  if (dias < 0) return 'fim deve ser igual ou posterior a inicio';
  if (dias + 1 > JANELA_MAX_DIAS) return `janela máxima de ${JANELA_MAX_DIAS} dias`;
  return null;
}

function chaveCache(f: FiltrosDisponibilidade, tipos: TipoEventoAgenda[], duracao: number): string {
  return JSON.stringify({
    ids: [...f.responsavelIds].map(String).sort(),
    inicio: f.inicio,
    fim: f.fim,
    tipos: [...tipos].sort(),
    duracao,
  });
}

function semTitulos(intervalos: IntervaloOcupado[]): IntervaloOcupado[] {
  return intervalos.map((i) => ({ ...i, origens: i.origens.map(({ titulo: _t, ...resto }) => resto) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// calcularDisponibilidade
// ─────────────────────────────────────────────────────────────────────────────

export async function calcularDisponibilidade(
  filtros: FiltrosDisponibilidade,
): Promise<ServiceResponse<DisponibilidadeAgenda>> {
  const problema = validarJanela(filtros.responsavelIds, filtros.inicio, filtros.fim);
  if (problema) return erroValidacao(problema);

  const responsavelIds = filtros.responsavelIds.map(String);
  const tipos: TipoEventoAgenda[] =
    filtros.tipos && filtros.tipos.length > 0 ? [...filtros.tipos] : [...TIPOS_OCUPAM_HORARIO_DEFAULT];
  const duracaoPadraoMin = filtros.duracaoPadraoMin ?? 30;

  let carregouAgora = false;
  const loader = async (): Promise<DadosCacheados> => {
    carregouAgora = true;
    const t0 = Date.now();
    const activities = await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);
      const sessionUserId = await getAstreaUserId(page);
      return fetchCalendarPro(page, {
        sessionUserId,
        inicio: filtros.inicio,
        fim: filtros.fim,
        flags: flagsParaTipos(tipos),
        status: 'ALL',
        responsaveisSelecionados: responsavelIds,
      });
    }, { warm: true });

    const semNomes = new Map<string, Usuario>();
    const eventos = (activities ?? []).map((a) => mapAtividade(a, semNomes));
    const { busy, porResponsavel } = computarBusy(eventos, { responsavelIds, tipos, duracaoPadraoMin });

    logger.info(
      { responsavelIds, inicio: filtros.inicio, fim: filtros.fim, eventos: eventos.length, intervalos: busy.length, durationMs: Date.now() - t0 },
      'Disponibilidade calculada',
    );

    return {
      inicio: filtros.inicio,
      fim: filtros.fim,
      timezone: 'America/Sao_Paulo',
      responsavelIds,
      tipos,
      busy,
      porResponsavel,
      totalEventos: eventos.length,
      geradoEm: new Date().toISOString(),
    };
  };

  try {
    const dados = filtros.fresh
      ? await loader()
      : await disponibilidadeCache.get(chaveCache(filtros, tipos, duracaoPadraoMin), loader);
    // O cache é compartilhado entre chamadas com os mesmos ids em outra ordem:
    // reordena `busy` pela ordem pedida nesta chamada.
    const porResponsavel: Record<string, IntervaloOcupado[]> = {};
    for (const id of responsavelIds) {
      const lista = dados.porResponsavel[id] ?? [];
      porResponsavel[id] = filtros.incluirTitulos ? lista : semTitulos(lista);
    }
    const busy = responsavelIds.flatMap((id) => porResponsavel[id]);
    return { ok: true, data: { ...dados, responsavelIds, porResponsavel, busy, cache: { hit: !carregouAgora } } };
  } catch (err) {
    const error = classificarErro(err);
    logger.error({ err: error.message, code: error.code, responsavelIds }, 'Erro em calcularDisponibilidade');
    return { ok: false, error };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Fase 2 — Eventos (compromissos) na agenda do Astrea
// ═════════════════════════════════════════════════════════════════════════════

interface CriacaoNormalizada {
  titulo: string;
  data: string;
  horaInicio?: string;
  horaFim?: string;
  diaTodo: boolean;
  responsavelId: string;
  envolvidosIds: string[];
  comentarios?: string;
  chaveExterna?: string;
  modalidade?: 'remoto' | 'presencial';
  endereco?: string;
  casoId?: string;
  contato?: ContatoEventoInput;
  criarAtendimento: boolean;
  verificarConflito: boolean;
}

function horaParaMin(h: string): number {
  const [hh, mm] = h.split(':').map(Number);
  return hh * 60 + mm;
}

/** Valida horários (fim explícito ou padrão +30 min não pode passar da meia-noite). */
function validarHorario(horaInicio: string | undefined, horaFim: string | undefined): string | null {
  if (!horaInicio || !RE_HORA.test(horaInicio)) return 'horaInicio (HH:mm) é obrigatória quando não é dia inteiro';
  if (horaFim !== undefined && !RE_HORA.test(horaFim)) return 'horaFim deve estar no formato HH:mm';
  const fim = horaFim !== undefined ? horaParaMin(horaFim) : horaParaMin(horaInicio) + DURACAO_PADRAO_MIN;
  if (fim <= horaParaMin(horaInicio)) return 'horaFim deve ser posterior a horaInicio';
  if (fim > 24 * 60) return 'o compromisso não pode passar da meia-noite (informe horaFim)';
  return null;
}

function validarCriacao(input: CriarEventoAgendaInput): string | null {
  if (!input.titulo || !input.titulo.trim()) return 'titulo é obrigatório';
  if (input.titulo.trim().length > 200) return 'titulo: máximo 200 caracteres';
  if (!dataValida(input.data)) return 'data deve ser uma data válida no formato YYYY-MM-DD';
  if (!RE_ID_ASTREA.test(String(input.responsavelId ?? ''))) return 'responsavelId: ID inválido do Astrea';
  const envolvidoInvalido = (input.envolvidosIds ?? []).find((id) => !RE_ID_ASTREA.test(String(id)));
  if (envolvidoInvalido !== undefined) return `envolvidosIds: ID inválido "${envolvidoInvalido}"`;
  if (!input.diaTodo) {
    const problemaHora = validarHorario(input.horaInicio, input.horaFim);
    if (problemaHora) return problemaHora;
  }
  if (input.chaveExterna !== undefined && !RE_CHAVE.test(input.chaveExterna)) {
    return 'chaveExterna: use até 100 caracteres [A-Za-z0-9#:_.-]';
  }
  if ((input.comentarios ?? '').length > 2000) return 'comentarios: máximo 2000 caracteres';
  if (input.contato && !input.contato.nome?.trim()) return 'contato.nome é obrigatório';
  if (input.casoId !== undefined && !RE_ID_ASTREA.test(String(input.casoId))) return 'casoId: ID inválido do Astrea';
  return null;
}

function normalizarCriacao(input: CriarEventoAgendaInput): CriacaoNormalizada {
  const diaTodo = input.diaTodo === true;
  const horaInicio = diaTodo ? undefined : input.horaInicio;
  const horaFim = diaTodo ? undefined : input.horaFim ?? (horaInicio ? somarMinutos(horaInicio, DURACAO_PADRAO_MIN) : undefined);
  const responsavelId = String(input.responsavelId);
  const envolvidosIds = [...new Set((input.envolvidosIds ?? []).map(String))].filter((id) => id !== responsavelId);
  const contato = input.contato
    ? {
        nome: input.contato.nome.trim(),
        telefone: input.contato.telefone?.trim() || undefined,
        email: input.contato.email?.trim() || undefined,
      }
    : undefined;
  return {
    titulo: input.titulo.trim(),
    data: input.data,
    horaInicio,
    horaFim,
    diaTodo,
    responsavelId,
    envolvidosIds,
    comentarios: input.comentarios?.trim() || undefined,
    chaveExterna: input.chaveExterna,
    modalidade: input.modalidade,
    endereco: input.endereco?.trim() || undefined,
    casoId: input.casoId ? String(input.casoId) : undefined,
    contato,
    criarAtendimento: contato ? input.criarAtendimento !== false : false,
    verificarConflito: input.verificarConflito !== false,
  };
}

/** Lê os eventos (atendimento + audiência) de um dia para um responsável, na aba dada. */
async function lerDia(page: Page, userId: string, data: string, responsavelId: string): Promise<EventoAgenda[]> {
  const activities = await fetchCalendarPro(page, {
    sessionUserId: userId,
    inicio: data,
    fim: data,
    flags: flagsParaTipos(TIPOS_CONFLITO),
    status: 'ALL',
    responsaveisSelecionados: [responsavelId],
  });
  const semNomes = new Map<string, Usuario>();
  return (activities ?? []).map((a) => mapAtividade(a, semNomes));
}

/** Evento ATIVO com a [ref:chave] (cancelados não contam: o retry cria de novo). */
function acharPorRef(eventos: EventoAgenda[], chave: string): EventoAgenda | undefined {
  const marca = refExterna(chave);
  return eventos.find((e) => e.status !== 'cancelado' && (e.comentarios ?? '').includes(marca));
}

/** Intervalos do responsável que colidem com [ini, fim) do novo horário. */
function conflitosNoHorario(
  eventos: EventoAgenda[],
  responsavelId: string,
  data: string,
  horaInicio: string | undefined,
  horaFim: string | undefined,
  ignorarEventoId?: string,
): IntervaloOcupado[] {
  const candidatos = ignorarEventoId ? eventos.filter((e) => e.id !== ignorarEventoId) : eventos;
  const { porResponsavel } = computarBusy(candidatos, { responsavelIds: [responsavelId], tipos: TIPOS_CONFLITO });
  const ini = horaInicio ? isoParaEpoch(brtParaIso(data, horaInicio)) : isoParaEpoch(brtParaIso(data));
  let fim = horaInicio && horaFim ? isoParaEpoch(brtParaIso(data, horaFim)) : ini + 24 * 60 * 60_000;
  if (fim <= ini) fim = ini + DURACAO_PADRAO_MIN * 60_000; // defesa (validação já recusa)
  return (porResponsavel[responsavelId] ?? []).filter(
    (i) => isoParaEpoch(i.inicio) < fim && isoParaEpoch(i.fim) > ini,
  );
}

function paraCriado(e: EventoAgenda, chave?: string): EventoAgendaCriado {
  return {
    id: e.id,
    titulo: e.titulo,
    data: e.dataInicio,
    horaInicio: e.horaInicio,
    horaFim: e.horaFim,
    diaTodo: e.diaTodo,
    responsavelId: e.responsavelId,
    envolvidosIds: e.envolvidosIds,
    casoId: e.casoId,
    chaveExterna: chave,
    status: e.status,
  };
}

function mensagem(err: unknown): string {
  return limparMensagem(err instanceof Error ? err.message : String(err));
}

function ehTimeout(err: unknown): boolean {
  return /timeout/i.test(mensagem(err));
}

/** Recusa explícita do Astrea (validação), sem efeito colateral: seguro repostar sem o caseId. */
function ehRecusaExplicita(err: unknown): boolean {
  return /API_ERROR_(400|422)\b/.test(mensagem(err));
}

/**
 * Acha o contato ou cria um novo — nunca pede CPF.
 *
 * A busca textual do Astrea (/contact/all) NÃO indexa telefone (verificado em
 * 25/09/2026 com vários formatos): só o nome encontra. Então: busca pelo nome e
 * confirma pelo telefone (mesma pessoa); sem telefone, ou sem casamento, cria um
 * contato novo (perfil "contato") — homônimo com outro telefone é outra pessoa.
 */
async function resolverContato(page: Page, contato: ContatoEventoInput): Promise<{ id: string; criado: boolean }> {
  const telefone = contato.telefone;
  if (telefone) {
    const porNome = await buscarContatosNaPagina(page, contato.nome, 20);
    const achado = porNome.find((c) => telefonesIguais(c.telefone, telefone));
    if (achado) return { id: achado.id, criado: false };
  }
  const id = await criarContatoNaPagina(page, {
    nome: contato.nome,
    perfil: 'contato',
    telefone,
    email: contato.email,
  });
  return { id, criado: true };
}

/** Reaproveita o atendimento com a mesma [ref:] (replays do consumidor) ou cria um novo. */
async function resolverAtendimento(
  page: Page,
  contatoId: string,
  n: CriacaoNormalizada,
): Promise<{ id: string; criado: boolean }> {
  if (n.chaveExterna) {
    const marca = refExterna(n.chaveExterna);
    const existentes = await listarAtendimentosDoContatoNaPagina(page, contatoId, 20);
    const achado = existentes.find((a) => (a.descricao ?? '').includes(marca));
    if (achado) return { id: achado.id, criado: false };
  }
  const descricao = [n.comentarios, n.chaveExterna ? refExterna(n.chaveExterna) : '']
    .filter(Boolean)
    .join('\n');
  const at = await criarAtendimentoNaPagina(page, {
    clienteId: contatoId,
    assunto: n.titulo,
    descricao: descricao || undefined,
    data: n.data,
    hora: n.horaInicio ?? '00:00',
    responsavelId: n.responsavelId,
  });
  return { id: at.id, criado: true };
}

async function nomesDosEnvolvidos(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const r = await listarUsuarios();
  if (!r.ok) {
    logger.warn({ err: r.error.message }, 'Sem nomes dos envolvidos (listarUsuarios falhou); seguindo com nome vazio');
    return {};
  }
  const nomes: Record<string, string> = {};
  for (const u of r.data) if (ids.includes(u.id)) nomes[u.id] = u.nome;
  return nomes;
}

// ─────────────────────────────────────────────────────────────────────────────
// criarEventoAgenda
// ─────────────────────────────────────────────────────────────────────────────

/** Criações em andamento por chaveExterna: a 2ª chamada simultânea espera a 1ª. */
const criacoesEmAndamento = new Map<string, Promise<ServiceResponse<ResultadoCriacaoEvento>>>();

/**
 * Cria o compromisso na agenda do Astrea, numa única aba (quente):
 *  1. lê o dia do responsável;
 *  2. evento ATIVO com a mesma [ref:chaveExterna] → devolve o existente (idempotência);
 *  3. conflito com compromisso do responsável → CONFLICT (a menos que verificarConflito=false);
 *  4. contato: acha pelo telefone ou cria (melhor esforço);
 *  5. atendimento de CRM (reaproveitado pela [ref:]) → vira o caseId do evento (melhor esforço);
 *  6. POST /appointments; timeout → reconcilia relendo o dia pela [ref:]; recusa
 *     explícita (4xx) do caseId → relê e, se não houver evento, recria sem vínculo (parcial).
 *
 * O withBrowserContext pode repetir a operação (sessão expirada, contexto destruído):
 * o que já foi criado numa tentativa fica fora do closure e não é refeito.
 */
export async function criarEventoAgenda(
  input: CriarEventoAgendaInput,
): Promise<ServiceResponse<ResultadoCriacaoEvento>> {
  const problema = validarCriacao(input);
  if (problema) return erroValidacao(problema);
  const n = normalizarCriacao(input);

  const chave = n.chaveExterna;
  if (!chave) return criarEventoNormalizado(n);
  const emAndamento = criacoesEmAndamento.get(chave);
  if (emAndamento) return emAndamento;
  const p = criarEventoNormalizado(n).finally(() => criacoesEmAndamento.delete(chave));
  criacoesEmAndamento.set(chave, p);
  return p;
}

async function criarEventoNormalizado(n: CriacaoNormalizada): Promise<ServiceResponse<ResultadoCriacaoEvento>> {
  const t0 = Date.now();
  const estado: {
    contato?: { id: string; criado: boolean } | null;
    atendimento?: { id: string; criado: boolean } | null;
    tentouCriar: boolean;
    erros: string[];
  } = { tentouCriar: false, erros: [] };

  try {
    const nomes = await nomesDosEnvolvidos(n.envolvidosIds);

    const resultado = await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);
      const userId = await getAstreaUserId(page);
      const eventosDia = await lerDia(page, userId, n.data, n.responsavelId);

      const montar = (evento: EventoAgendaCriado, reaproveitado: boolean): ResultadoCriacaoEvento => ({
        evento,
        reaproveitado,
        contato: estado.contato ?? null,
        atendimento: estado.atendimento ?? null,
        parcial: estado.erros.length > 0,
        erros: [...estado.erros],
      });

      if (n.chaveExterna) {
        const existente = acharPorRef(eventosDia, n.chaveExterna);
        if (existente) {
          if (estado.atendimento === undefined && existente.casoId) {
            estado.atendimento = { id: existente.casoId, criado: false };
          }
          // Criado por uma tentativa anterior desta mesma chamada → não é "reaproveitado".
          return montar(paraCriado(existente, n.chaveExterna), !estado.tentouCriar);
        }
      }

      if (n.verificarConflito) {
        const conflitos = conflitosNoHorario(eventosDia, n.responsavelId, n.data, n.horaInicio, n.horaFim);
        if (conflitos.length > 0) throw new ConflitoAgendaError(conflitos);
      }

      if (n.contato && estado.contato === undefined) {
        try {
          estado.contato = await resolverContato(page, n.contato);
        } catch (err) {
          estado.contato = null;
          estado.erros.push(`contato: ${mensagem(err)}`);
        }
      }

      if (estado.contato && n.criarAtendimento && estado.atendimento === undefined) {
        try {
          estado.atendimento = await resolverAtendimento(page, estado.contato.id, n);
        } catch (err) {
          estado.atendimento = null;
          estado.erros.push(`atendimento: ${mensagem(err)}`);
        }
      }

      const salvar = async (caseId: string | null): Promise<string> => {
        const payload = montarPayloadAppointment(
          { ...n, horaInicio: n.horaInicio, horaFim: n.horaFim, envolvidosIds: n.envolvidosIds },
          { userId, caseId, nomes },
        );
        estado.tentouCriar = true;
        try {
          const resp = await astreaApiPost<unknown>(page, '/appointments', payload, TIMEOUT_ESCRITA_MS);
          const id = extrairIdAppointment(resp);
          if (id) return id;
          if (n.chaveExterna) {
            const achado = acharPorRef(await lerDia(page, userId, n.data, n.responsavelId), n.chaveExterna);
            if (achado) return achado.id;
          }
          // Resposta 2xx sem id: NÃO repostar (pode ter criado) — o consumidor repete com a mesma chave.
          throw new Error('SEM_ID: o Astrea não retornou o id do evento criado');
        } catch (err) {
          if (ehTimeout(err) && n.chaveExterna) {
            try {
              const achado = acharPorRef(await lerDia(page, userId, n.data, n.responsavelId), n.chaveExterna);
              if (achado) {
                logger.info({ chave: n.chaveExterna, id: achado.id }, 'Timeout no POST, mas o evento existe (reconciliado)');
                return achado.id;
              }
            } catch {
              // releitura falhou — propaga o erro original
            }
          }
          throw err;
        }
      };

      const caseId = estado.atendimento?.id ?? n.casoId ?? null;
      let eventoId: string;
      let casoVinculado: string | undefined = caseId ?? undefined;
      try {
        eventoId = await salvar(caseId);
      } catch (err) {
        if (!(caseId && estado.atendimento) || !ehRecusaExplicita(err)) throw err;
        // O Astrea recusou o atendimento como "caso" do evento: relê e, se nada foi
        // criado, cria sem vínculo.
        const achado = n.chaveExterna
          ? acharPorRef(await lerDia(page, userId, n.data, n.responsavelId), n.chaveExterna)
          : undefined;
        if (achado) {
          eventoId = achado.id;
          casoVinculado = achado.casoId;
        } else {
          estado.erros.push(`vinculo: ${mensagem(err)}`);
          casoVinculado = undefined;
          eventoId = await salvar(null);
        }
      }

      return montar(
        {
          id: eventoId,
          titulo: n.titulo,
          data: n.data,
          horaInicio: n.horaInicio,
          horaFim: n.horaFim,
          diaTodo: n.diaTodo,
          responsavelId: n.responsavelId,
          envolvidosIds: n.envolvidosIds,
          casoId: casoVinculado,
          chaveExterna: n.chaveExterna,
          status: 'pendente',
        },
        false,
      );
    }, { warm: true });

    invalidarDisponibilidadeCache();
    logger.info(
      {
        eventoId: resultado.evento.id,
        chave: n.chaveExterna,
        reaproveitado: resultado.reaproveitado,
        parcial: resultado.parcial,
        durationMs: Date.now() - t0,
      },
      'Evento de agenda criado no Astrea',
    );
    return { ok: true, data: resultado };
  } catch (err) {
    if (estado.tentouCriar) invalidarDisponibilidadeCache();
    const error = classificarErro(err);
    const nivel = error.code === 'CONFLICT' ? 'warn' : 'error';
    logger[nivel]({ err: error.message, code: error.code, chave: n.chaveExterna }, 'Falha em criarEventoAgenda');
    return { ok: false, error };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Buscar / cancelar / excluir / remarcar por id
// ─────────────────────────────────────────────────────────────────────────────

/** DTO de GET /api/v2/appointments/{id} (formato observado em 25/09/2026). */
interface AstreaAppointmentDTO {
  id?: string | number;
  description?: string;
  descriptionDetails?: string;
  responsibleId?: string | number;
  whenDate?: string | number;
  toDateInt?: string | number;
  beginDate?: string | number;
  endDate?: string | number;
  fromDate?: string | number;
  toDate?: string | number;
  startAt?: number;
  endAt?: number;
  allDay?: boolean;
  timeStart?: string;
  timeEnd?: string;
  timeFromTo?: string | null;
  hourStart?: string;
  minStart?: string;
  hourEnd?: string;
  minEnd?: string;
  involvedWithNames?: Record<string, string>;
  involvedIds?: Array<string | number>;
  caseId?: string | number | null;
  status?: string;
  isHearing?: boolean;
  address?: string;
}

/** YYYYMMDD (número/string), YYYY-MM-DD ou epoch ms → YYYY-MM-DD em BRT. */
function dataDoDto(...valores: Array<string | number | undefined>): string {
  for (const v of valores) {
    if (v === undefined || v === null || v === '') continue;
    const s = String(v);
    if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const t = typeof v === 'number' ? v : Number.isFinite(Number(s)) ? Number(s) : Date.parse(s);
    if (Number.isFinite(t) && t > 0) return new Date(t - 3 * 60 * 60_000).toISOString().slice(0, 10);
  }
  return '';
}

function statusDoAppointment(s?: string): StatusEventoAgenda {
  if (s === 'CANCELED' || s === 'CANCELLED') return 'cancelado';
  if (s === 'DONE') return 'concluido';
  return 'pendente';
}

export function mapAppointmentDTO(a: AstreaAppointmentDTO): EventoAgenda {
  const responsavelId = a.responsibleId != null ? String(a.responsibleId) : '';
  let horaInicio: string | undefined = a.timeStart || undefined;
  let horaFim: string | undefined = a.timeEnd || undefined;
  if (!horaInicio) {
    const faixa = (a.timeFromTo ?? '').match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
    if (faixa) {
      horaInicio = faixa[1];
      horaFim = faixa[2];
    } else if (a.hourStart) {
      horaInicio = `${a.hourStart.padStart(2, '0')}:${(a.minStart ?? '00').padStart(2, '0')}`;
      if (a.hourEnd) horaFim = `${a.hourEnd.padStart(2, '0')}:${(a.minEnd ?? '00').padStart(2, '0')}`;
    }
  }
  const nomes = a.involvedWithNames ?? {};
  const envolvidosIds = [...new Set([...Object.keys(nomes), ...(a.involvedIds ?? []).map(String)])].filter(
    (id) => id !== responsavelId,
  );
  const dataInicio = dataDoDto(a.whenDate, a.beginDate, a.startAt, a.fromDate);
  return {
    id: String(a.id ?? ''),
    tipo: a.isHearing ? 'audiencia' : 'atendimento',
    titulo: a.description ?? '',
    tituloComResponsavel: a.description ?? '',
    diaTodo: a.allDay === true,
    dataInicio,
    dataFim: dataDoDto(a.toDateInt, a.endDate, a.endAt, a.toDate) || dataInicio,
    horaInicio: a.allDay ? undefined : horaInicio,
    horaFim: a.allDay ? undefined : horaFim,
    status: statusDoAppointment(a.status),
    responsavelId,
    envolvidosIds,
    envolvidos: envolvidosIds.map((id) => nomes[id]).filter(Boolean),
    casoId: a.caseId != null ? String(a.caseId) : undefined,
    comentarios: a.descriptionDetails || undefined,
    endereco: a.address || undefined,
  };
}

export interface OpcoesMutacao {
  /** Permite alterar evento que não foi criado pela automação (sem [ref:]). */
  forcar?: boolean;
}

/** Sem `forcar`, só eventos criados pela automação (com [ref:]) podem ser alterados. */
async function garantirEventoDaAutomacao(page: Page, id: string, opcoes: OpcoesMutacao): Promise<void> {
  if (opcoes.forcar) return;
  const dto = await astreaApiGet<AstreaAppointmentDTO>(page, `/appointments/${id}`);
  if (!(dto.descriptionDetails ?? '').includes('[ref:')) throw new EventoProtegidoError(id);
}

export async function buscarEventoAgenda(id: string): Promise<ServiceResponse<EventoAgenda>> {
  if (!RE_ID_ASTREA.test(String(id))) return erroValidacao('id inválido do Astrea');
  try {
    const dto = await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);
      return astreaApiGet<AstreaAppointmentDTO>(page, `/appointments/${id}`);
    }, { warm: true });
    return { ok: true, data: mapAppointmentDTO(dto) };
  } catch (err) {
    return { ok: false, error: classificarErro(err) };
  }
}

export async function cancelarEventoAgenda(
  id: string,
  motivo?: string,
  opcoes: OpcoesMutacao = {},
): Promise<ServiceResponse<{ id: string; status: 'cancelado' }>> {
  if (!RE_ID_ASTREA.test(String(id))) return erroValidacao('id inválido do Astrea');
  try {
    await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);
      const userId = await getAstreaUserId(page);
      await garantirEventoDaAutomacao(page, String(id), opcoes);
      await astreaApiPut(
        page,
        '/appointments/status',
        { appointmentId: String(id), userId, status: 'CANCELED', reason: motivo?.trim() || undefined },
        TIMEOUT_ESCRITA_MS,
      );
    }, { warm: true });
    invalidarDisponibilidadeCache();
    logger.info({ id, forcar: !!opcoes.forcar }, 'Evento de agenda cancelado no Astrea');
    return { ok: true, data: { id: String(id), status: 'cancelado' } };
  } catch (err) {
    return { ok: false, error: classificarErro(err) };
  }
}

export async function excluirEventoAgenda(
  id: string,
  opcoes: OpcoesMutacao = {},
): Promise<ServiceResponse<{ id: string; removido: true }>> {
  if (!RE_ID_ASTREA.test(String(id))) return erroValidacao('id inválido do Astrea');
  try {
    await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);
      await garantirEventoDaAutomacao(page, String(id), opcoes);
      await astreaApiDelete(page, `/appointments/${id}`, TIMEOUT_ESCRITA_MS);
    }, { warm: true });
    invalidarDisponibilidadeCache();
    logger.info({ id, forcar: !!opcoes.forcar }, 'Evento de agenda excluído no Astrea');
    return { ok: true, data: { id: String(id), removido: true } };
  } catch (err) {
    return { ok: false, error: classificarErro(err) };
  }
}

export async function remarcarEventoAgenda(
  id: string,
  input: RemarcarEventoAgendaInput,
  opcoes: OpcoesMutacao = {},
): Promise<ServiceResponse<{ id: string; data: string; horaInicio?: string; horaFim?: string; diaTodo: boolean }>> {
  if (!RE_ID_ASTREA.test(String(id))) return erroValidacao('id inválido do Astrea');
  if (!dataValida(input.data)) return erroValidacao('data deve ser uma data válida no formato YYYY-MM-DD');
  const diaTodo = input.diaTodo === true;
  if (!diaTodo) {
    const problemaHora = validarHorario(input.horaInicio, input.horaFim);
    if (problemaHora) return erroValidacao(problemaHora);
  }
  const verificar = input.verificarConflito !== false;
  if (verificar && !RE_ID_ASTREA.test(String(input.responsavelId ?? ''))) {
    return erroValidacao('responsavelId é necessário para checar conflito (ou envie verificarConflito=false)');
  }
  const horaInicio = diaTodo ? undefined : input.horaInicio;
  const horaFim = diaTodo ? undefined : input.horaFim ?? (horaInicio ? somarMinutos(horaInicio, DURACAO_PADRAO_MIN) : undefined);

  try {
    await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);
      const userId = await getAstreaUserId(page);
      await garantirEventoDaAutomacao(page, String(id), opcoes);
      if (verificar) {
        const eventosDia = await lerDia(page, userId, input.data, String(input.responsavelId));
        const conflitos = conflitosNoHorario(eventosDia, String(input.responsavelId), input.data, horaInicio, horaFim, String(id));
        if (conflitos.length > 0) throw new ConflitoAgendaError(conflitos);
      }
      await astreaApiPut(
        page,
        '/appointments/reschedule',
        montarPayloadReschedule(String(id), { ...input, horaInicio, horaFim }, userId),
        TIMEOUT_ESCRITA_MS,
      );
    }, { warm: true });
    invalidarDisponibilidadeCache();
    return { ok: true, data: { id: String(id), data: input.data, horaInicio, horaFim, diaTodo } };
  } catch (err) {
    return { ok: false, error: classificarErro(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// buscarEventosPorContato — consultas marcadas pelas secretárias (decisão 6)
// ─────────────────────────────────────────────────────────────────────────────

export interface FiltrosEventosDoContato {
  telefone?: string;
  /** Refina a busca do contato; sozinho não identifica ninguém (recusado). */
  nome?: string;
  chaveExterna?: string;
  inicio: string;
  fim: string;
  responsavelIds: string[];
  /** Default false: cancelados ficam de fora. */
  incluirCancelados?: boolean;
}

/**
 * Compromissos de um lead/cliente numa janela, para a atendente virtual não
 * negar consulta marcada à mão. Um evento conta quando:
 *  - `ref`: as observações têm a [ref:chaveExterna] (criado pela automação);
 *  - `caso`: o caseId é um atendimento/caso do contato achado pelo telefone;
 *  - `observacoes`: as observações contêm o telefone (convenção das secretárias).
 * Exige telefone ou chaveExterna: nome sozinho não identifica e devolveria uma
 * lista vazia enganosa ("não tem consulta").
 */
export async function buscarEventosPorContato(
  filtros: FiltrosEventosDoContato,
): Promise<ServiceResponse<EventoDoContato[]>> {
  const telefone = filtros.telefone?.trim() || undefined;
  const digitosTel = telefone ? telefone.replace(/\D/g, '') : '';
  if (!telefone && !filtros.chaveExterna) {
    return erroValidacao('informe telefone ou chaveExterna (nome sozinho não identifica o contato)');
  }
  if (telefone && digitosTel.length < 8) return erroValidacao('telefone: ao menos 8 dígitos');
  if (filtros.chaveExterna !== undefined && !RE_CHAVE.test(filtros.chaveExterna)) return erroValidacao('chaveExterna inválida');
  const problema = validarJanela(filtros.responsavelIds, filtros.inicio, filtros.fim);
  if (problema) return erroValidacao(problema);

  try {
    const { eventos, casos, contatosPorCaso } = await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);
      const userId = await getAstreaUserId(page);

      const casos = new Set<string>();
      const contatosPorCaso = new Map<string, { id: string; nome: string }>();
      // A busca do Astrea só acha contato pelo NOME (não indexa telefone): sem nome,
      // o vínculo por caso/atendimento não é possível; restam [ref:] e observações.
      const nome = filtros.nome?.trim();
      if (telefone && nome) {
        const encontrados = new Map<string, string>();
        for (const c of await buscarContatosNaPagina(page, nome, 20)) {
          if (telefonesIguais(c.telefone, telefone)) encontrados.set(c.id, c.nome);
        }
        for (const [contatoId, contatoNome] of [...encontrados.entries()].slice(0, 3)) {
          for (const at of await listarAtendimentosDoContatoNaPagina(page, contatoId, 20)) {
            for (const id of [at.id, at.casoId].filter((x): x is string => !!x)) {
              casos.add(id);
              contatosPorCaso.set(id, { id: contatoId, nome: contatoNome });
            }
          }
        }
      }

      const activities = await fetchCalendarPro(page, {
        sessionUserId: userId,
        inicio: filtros.inicio,
        fim: filtros.fim,
        flags: flagsParaTipos(TIPOS_CONFLITO),
        status: 'ALL',
        responsaveisSelecionados: filtros.responsavelIds.map(String),
      });
      const semNomes = new Map<string, Usuario>();
      return {
        eventos: (activities ?? []).map((a) => mapAtividade(a, semNomes)),
        casos,
        contatosPorCaso,
      };
    }, { warm: true });

    const marca = filtros.chaveExterna ? refExterna(filtros.chaveExterna) : null;
    const ultimos8 = digitosTel.slice(-8);
    const achados: EventoDoContato[] = [];
    for (const e of eventos) {
      if (e.status === 'cancelado' && !filtros.incluirCancelados) continue;
      const obs = e.comentarios ?? '';
      if (marca && obs.includes(marca)) {
        achados.push({ ...e, motivo: 'ref' });
      } else if (e.casoId && casos.has(e.casoId)) {
        achados.push({ ...e, motivo: 'caso', contato: contatosPorCaso.get(e.casoId) });
      } else if (ultimos8 && obs.replace(/\D/g, '').includes(ultimos8)) {
        achados.push({ ...e, motivo: 'observacoes' });
      }
    }
    achados.sort((a, b) =>
      `${a.dataInicio} ${a.horaInicio ?? ''}`.localeCompare(`${b.dataInicio} ${b.horaInicio ?? ''}`),
    );
    return { ok: true, data: achados };
  } catch (err) {
    return { ok: false, error: classificarErro(err) };
  }
}
