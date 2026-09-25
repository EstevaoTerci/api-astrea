import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — Playwright/Astrea NUNCA rodam em teste. withBrowserContext só invoca a
// callback com um page-stub; os helpers HTTP viram vi.fn() configurados por teste.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../browser/astrea-http.js', () => ({
  ANGULAR_PAGE_PATH: '/#/main/contacts',
  withBrowserContext: vi.fn(<T>(op: (page: unknown) => Promise<T>) => op({})),
  astreaApiPost: vi.fn(),
  astreaApiGet: vi.fn(),
  astreaApiPut: vi.fn(),
  astreaApiDelete: vi.fn(),
  getAstreaUserId: vi.fn().mockResolvedValue('6528036269752320'),
}));

vi.mock('../browser/navigator.js', () => ({
  navigateTo: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./usuarios.service.js', () => ({
  listarUsuarios: vi.fn(),
}));

import {
  calcularDisponibilidade,
  getDisponibilidadeCacheStats,
  invalidarDisponibilidadeCache,
  resetarDisponibilidadeCache,
} from './agenda-eventos.service.js';
import { astreaApiPost, withBrowserContext } from '../browser/astrea-http.js';
import { listarUsuarios } from './usuarios.service.js';

const mockPost = vi.mocked(astreaApiPost);
const mockWith = vi.mocked(withBrowserContext);
const mockUsuarios = vi.mocked(listarUsuarios);

const LETICIA = '6051920845144064';
const VICTOR = '6043699147374592';

function atividade(overrides: Record<string, unknown> = {}) {
  return {
    id: 7000000000000001,
    type: 'EVENT',
    allDay: false,
    title: 'ATENDIMENTO INICIAL',
    titleWithName: 'LB - ATENDIMENTO INICIAL',
    dateStart: '20260922',
    dateEnd: '20260922',
    timeStart: '14:00',
    timeEnd: '14:30',
    responsibleId: LETICIA,
    involvedIds: [],
    status: 'IN_PROGRESS',
    ...overrides,
  };
}

beforeEach(() => {
  mockPost.mockReset();
  mockUsuarios.mockReset();
  mockWith.mockClear();
  resetarDisponibilidadeCache();
});

describe('calcularDisponibilidade — chamada ao Astrea', () => {
  it('faz UMA chamada a /calendar-pro/complete filtrando pelos responsáveis e só atendimento+audiência', async () => {
    mockPost.mockResolvedValueOnce({ activities: [atividade()] });

    const r = await calcularDisponibilidade({
      responsavelIds: [LETICIA, VICTOR],
      inicio: '2026-09-22',
      fim: '2026-10-03',
    });

    expect(r.ok).toBe(true);
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [, path, payload] = mockPost.mock.calls[0] as [unknown, string, any];
    expect(path).toBe('/calendar-pro/complete');
    expect(payload.from).toBe('20260922');
    expect(payload.to).toBe('20261003');
    expect(payload.userId).toBe('6528036269752320');
    expect(payload.query.userFilter).toEqual({
      selected: [LETICIA, VICTOR],
      type: 'CF_ALL',
      users: [],
    });
    expect(payload.query.appointmentSelected).toBe(true);
    expect(payload.query.hearingSelected).toBe(true);
    expect(payload.query.deadlineSelected).toBe(false);
    expect(payload.query.taskSelected).toBe(false);
    expect(payload.query.status).toBe('ALL');
  });

  it('usa a aba quente do pool', async () => {
    mockPost.mockResolvedValueOnce({ activities: [] });
    await calcularDisponibilidade({ responsavelIds: [LETICIA], inicio: '2026-09-22', fim: '2026-09-22' });
    expect(mockWith).toHaveBeenCalledWith(expect.any(Function), { warm: true });
  });

  it('não chama listarUsuarios (nomes não são necessários — economiza uma aba)', async () => {
    mockPost.mockResolvedValueOnce({ activities: [] });
    await calcularDisponibilidade({ responsavelIds: [LETICIA], inicio: '2026-09-22', fim: '2026-09-22' });
    expect(mockUsuarios).not.toHaveBeenCalled();
  });

  it('devolve busy computado (responsável + envolvido) com metadados', async () => {
    mockPost.mockResolvedValueOnce({
      activities: [
        atividade(),
        atividade({
          id: 7000000000000005,
          dateStart: '20260924',
          dateEnd: '20260924',
          involvedIds: [VICTOR],
        }),
        atividade({ id: 7000000000000099, type: 'HEARING', responsibleId: '999999999999' }),
      ],
    });

    const r = await calcularDisponibilidade({
      responsavelIds: [LETICIA, VICTOR],
      inicio: '2026-09-22',
      fim: '2026-09-30',
    });

    if (!r.ok) throw new Error('esperava ok');
    expect(r.data.timezone).toBe('America/Sao_Paulo');
    expect(r.data.inicio).toBe('2026-09-22');
    expect(r.data.fim).toBe('2026-09-30');
    expect(r.data.responsavelIds).toEqual([LETICIA, VICTOR]);
    expect(r.data.tipos).toEqual(['atendimento', 'audiencia']);
    expect(r.data.totalEventos).toBe(3);
    expect(r.data.porResponsavel[LETICIA]).toHaveLength(2);
    expect(r.data.porResponsavel[VICTOR]).toEqual([
      expect.objectContaining({
        inicio: '2026-09-24T14:00:00-03:00',
        fim: '2026-09-24T14:30:00-03:00',
        origens: [expect.objectContaining({ eventoId: '7000000000000005', papel: 'envolvido' })],
      }),
    ]);
    expect(r.data.cache.hit).toBe(false);
    expect(typeof r.data.geradoEm).toBe('string');
  });

  it('omite títulos (nome de cliente) por padrão e os inclui com incluirTitulos', async () => {
    mockPost.mockResolvedValue({ activities: [atividade({ title: 'ATENDIMENTO INICIAL - CICLANO' })] });
    const sem = await calcularDisponibilidade({ responsavelIds: [LETICIA], inicio: '2026-09-22', fim: '2026-09-22' });
    const com = await calcularDisponibilidade({ responsavelIds: [LETICIA], inicio: '2026-09-22', fim: '2026-09-22', incluirTitulos: true });
    if (!sem.ok || !com.ok) throw new Error('esperava ok');
    expect(JSON.stringify(sem.data)).not.toContain('CICLANO');
    expect(sem.data.porResponsavel[LETICIA][0].origens[0]).not.toHaveProperty('titulo');
    expect(com.data.porResponsavel[LETICIA][0].origens[0].titulo).toBe('ATENDIMENTO INICIAL - CICLANO');
  });

  it('rejeita data impossível', async () => {
    const r = await calcularDisponibilidade({ responsavelIds: [LETICIA], inicio: '2026-09-31', fim: '2026-10-01' });
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('aceita activities ausente como agenda vazia', async () => {
    mockPost.mockResolvedValueOnce({});
    const r = await calcularDisponibilidade({ responsavelIds: [LETICIA], inicio: '2026-09-22', fim: '2026-09-22' });
    if (!r.ok) throw new Error('esperava ok');
    expect(r.data.busy).toEqual([]);
    expect(r.data.porResponsavel).toEqual({ [LETICIA]: [] });
  });
});

describe('calcularDisponibilidade — cache 60 s', () => {
  it('segunda chamada idêntica vem do cache (sem novo POST) e sinaliza hit', async () => {
    mockPost.mockResolvedValue({ activities: [atividade()] });
    const filtros = { responsavelIds: [LETICIA], inicio: '2026-09-22', fim: '2026-09-30' };

    const a = await calcularDisponibilidade(filtros);
    const b = await calcularDisponibilidade(filtros);

    expect(mockPost).toHaveBeenCalledTimes(1);
    if (!a.ok || !b.ok) throw new Error('esperava ok');
    expect(a.data.cache.hit).toBe(false);
    expect(b.data.cache.hit).toBe(true);
    expect(b.data.busy).toEqual(a.data.busy);
  });

  it('ordem dos ids não muda a chave do cache', async () => {
    mockPost.mockResolvedValue({ activities: [] });
    await calcularDisponibilidade({ responsavelIds: [LETICIA, VICTOR], inicio: '2026-09-22', fim: '2026-09-30' });
    await calcularDisponibilidade({ responsavelIds: [VICTOR, LETICIA], inicio: '2026-09-22', fim: '2026-09-30' });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('fresh=true fura o cache', async () => {
    mockPost.mockResolvedValue({ activities: [] });
    const filtros = { responsavelIds: [LETICIA], inicio: '2026-09-22', fim: '2026-09-30' };
    await calcularDisponibilidade(filtros);
    const r = await calcularDisponibilidade({ ...filtros, fresh: true });
    expect(mockPost).toHaveBeenCalledTimes(2);
    if (!r.ok) throw new Error('esperava ok');
    expect(r.data.cache.hit).toBe(false);
  });

  it('invalidarDisponibilidadeCache força nova leitura', async () => {
    mockPost.mockResolvedValue({ activities: [] });
    const filtros = { responsavelIds: [LETICIA], inicio: '2026-09-22', fim: '2026-09-30' };
    await calcularDisponibilidade(filtros);
    invalidarDisponibilidadeCache();
    await calcularDisponibilidade(filtros);
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('erros não são cacheados', async () => {
    mockPost.mockRejectedValueOnce(new Error('API_ERROR_500: boom'));
    mockPost.mockResolvedValueOnce({ activities: [] });
    const filtros = { responsavelIds: [LETICIA], inicio: '2026-09-22', fim: '2026-09-30' };
    const a = await calcularDisponibilidade(filtros);
    const b = await calcularDisponibilidade(filtros);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(true);
  });

  it('expõe estatísticas do cache', async () => {
    mockPost.mockResolvedValue({ activities: [] });
    const filtros = { responsavelIds: [LETICIA], inicio: '2026-09-22', fim: '2026-09-30' };
    await calcularDisponibilidade(filtros);
    await calcularDisponibilidade(filtros);
    expect(getDisponibilidadeCacheStats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
  });
});

describe('calcularDisponibilidade — validação e erros', () => {
  it('rejeita id não numérico sem tocar no browser', async () => {
    const r = await calcularDisponibilidade({ responsavelIds: ['abc'], inicio: '2026-09-22', fim: '2026-09-22' });
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', retryable: false } });
    expect(mockWith).not.toHaveBeenCalled();
  });

  it('rejeita lista vazia de responsáveis', async () => {
    const r = await calcularDisponibilidade({ responsavelIds: [], inicio: '2026-09-22', fim: '2026-09-22' });
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('rejeita fim antes do início', async () => {
    const r = await calcularDisponibilidade({ responsavelIds: [LETICIA], inicio: '2026-09-22', fim: '2026-09-21' });
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('rejeita janela maior que 31 dias', async () => {
    const r = await calcularDisponibilidade({ responsavelIds: [LETICIA], inicio: '2026-09-01', fim: '2026-10-03' });
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('rejeita data em formato inválido', async () => {
    const r = await calcularDisponibilidade({ responsavelIds: [LETICIA], inicio: '22/09/2026', fim: '2026-09-22' });
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('circuit breaker de login aberto vira BROWSER_UNAVAILABLE (retryable)', async () => {
    mockPost.mockRejectedValueOnce(new Error('LOGIN_CIRCUIT_OPEN: login bloqueado'));
    const r = await calcularDisponibilidade({ responsavelIds: [LETICIA], inicio: '2026-09-22', fim: '2026-09-22' });
    expect(r).toMatchObject({ ok: false, error: { code: 'BROWSER_UNAVAILABLE', retryable: true } });
  });

  it('fila cheia vira BROWSER_UNAVAILABLE', async () => {
    mockWith.mockRejectedValueOnce(new Error('QUEUE_FULL: fila cheia'));
    const r = await calcularDisponibilidade({ responsavelIds: [LETICIA], inicio: '2026-09-22', fim: '2026-09-22' });
    expect(r).toMatchObject({ ok: false, error: { code: 'BROWSER_UNAVAILABLE' } });
  });

  it('timeout vira TIMEOUT', async () => {
    mockPost.mockRejectedValueOnce(new Error('page.evaluate: Timeout 30000ms exceeded'));
    const r = await calcularDisponibilidade({ responsavelIds: [LETICIA], inicio: '2026-09-22', fim: '2026-09-22' });
    expect(r).toMatchObject({ ok: false, error: { code: 'TIMEOUT', retryable: true } });
  });

  it('erro da API do Astrea vira API_ERROR', async () => {
    mockPost.mockRejectedValueOnce(new Error('API_ERROR_500: erro interno'));
    const r = await calcularDisponibilidade({ responsavelIds: [LETICIA], inicio: '2026-09-22', fim: '2026-09-22' });
    expect(r).toMatchObject({ ok: false, error: { code: 'API_ERROR' } });
  });
});
