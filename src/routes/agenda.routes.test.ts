import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { ServiceError, ServiceResponse } from '../types/index.js';
import type { DisponibilidadeAgenda, EventoAgenda } from '../models/index.js';
import { buildApp } from '../../test/helpers/express-app.js';
import { errorHandler } from '../middleware/error-handler.js';

vi.mock('../services/agenda.service.js', () => ({
  listarAgenda: vi.fn(),
}));

vi.mock('../services/agenda-eventos.service.js', () => ({
  calcularDisponibilidade: vi.fn(),
  criarEventoAgenda: vi.fn(),
  buscarEventoAgenda: vi.fn(),
  cancelarEventoAgenda: vi.fn(),
  excluirEventoAgenda: vi.fn(),
  remarcarEventoAgenda: vi.fn(),
  buscarEventosPorContato: vi.fn(),
}));

import agendaRouter from './agenda.routes.js';
import { listarAgenda } from '../services/agenda.service.js';
import {
  buscarEventoAgenda,
  buscarEventosPorContato,
  calcularDisponibilidade,
  cancelarEventoAgenda,
  criarEventoAgenda,
  excluirEventoAgenda,
  remarcarEventoAgenda,
} from '../services/agenda-eventos.service.js';

const mockListar = vi.mocked(listarAgenda);
const mockDisp = vi.mocked(calcularDisponibilidade);
const mockCriar = vi.mocked(criarEventoAgenda);
const mockBuscar = vi.mocked(buscarEventoAgenda);
const mockCancelar = vi.mocked(cancelarEventoAgenda);
const mockExcluir = vi.mocked(excluirEventoAgenda);
const mockRemarcar = vi.mocked(remarcarEventoAgenda);
const mockPorContato = vi.mocked(buscarEventosPorContato);

const LETICIA = '6051920845144064';
const VICTOR = '6043699147374592';

function ok<T>(data: T): ServiceResponse<T> {
  return { ok: true, data };
}
function err(error: ServiceError): ServiceResponse<never> {
  return { ok: false, error };
}

function disp(overrides: Partial<DisponibilidadeAgenda> = {}): DisponibilidadeAgenda {
  return {
    inicio: '2026-09-22',
    fim: '2026-09-30',
    timezone: 'America/Sao_Paulo',
    responsavelIds: [LETICIA],
    tipos: ['atendimento', 'audiencia'],
    busy: [],
    porResponsavel: { [LETICIA]: [] },
    totalEventos: 0,
    geradoEm: '2026-09-25T15:00:00.000Z',
    cache: { hit: false },
    ...overrides,
  };
}

const app = buildApp((a) => {
  a.use('/api/agenda', agendaRouter);
  a.use(errorHandler);
});

beforeEach(() => {
  for (const m of [mockListar, mockDisp, mockCriar, mockBuscar, mockCancelar, mockExcluir, mockRemarcar, mockPorContato]) m.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/agenda (contrato existente — não pode mudar)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/agenda', () => {
  it('200 com os eventos do service', async () => {
    const eventos: EventoAgenda[] = [];
    mockListar.mockResolvedValueOnce(ok(eventos));
    const res = await request(app).get('/api/agenda?responsavelId=1&inicio=2026-09-22&fim=2026-09-28&tipos=atendimento,audiencia');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: [] });
    expect(mockListar).toHaveBeenCalledWith(
      expect.objectContaining({ responsavelId: '1', inicio: '2026-09-22', tipos: ['atendimento', 'audiencia'] }),
    );
  });

  it('400 com data mal formatada', async () => {
    const res = await request(app).get('/api/agenda?inicio=22/09/2026');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(mockListar).not.toHaveBeenCalled();
  });

  it('503 quando o browser está indisponível', async () => {
    mockListar.mockResolvedValueOnce(err({ code: 'BROWSER_UNAVAILABLE', message: 'x', retryable: true }));
    const res = await request(app).get('/api/agenda');
    expect(res.status).toBe(503);
  });

  it('500 para os demais erros', async () => {
    mockListar.mockResolvedValueOnce(err({ code: 'API_ERROR', message: 'x', retryable: false }));
    const res = await request(app).get('/api/agenda');
    expect(res.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/agenda/disponibilidade
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/agenda/disponibilidade', () => {
  it('200 e repassa os filtros normalizados (ids em CSV, defaults)', async () => {
    mockDisp.mockResolvedValueOnce(ok(disp()));
    const res = await request(app).get(
      `/api/agenda/disponibilidade?responsavelIds=${LETICIA},${VICTOR}&inicio=2026-09-22&fim=2026-09-30`,
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.timezone).toBe('America/Sao_Paulo');
    expect(mockDisp).toHaveBeenCalledWith({
      responsavelIds: [LETICIA, VICTOR],
      inicio: '2026-09-22',
      fim: '2026-09-30',
      tipos: undefined,
      duracaoPadraoMin: 30,
      fresh: false,
      incluirTitulos: false,
    });
  });

  it('aceita responsavelIds repetido na query, tipos em CSV, duração e fresh', async () => {
    mockDisp.mockResolvedValueOnce(ok(disp()));
    const res = await request(app).get(
      `/api/agenda/disponibilidade?responsavelIds=${LETICIA}&responsavelIds=${VICTOR}&inicio=2026-09-22&fim=2026-09-22&tipos=atendimento&duracaoPadraoMin=45&fresh=1`,
    );
    expect(res.status).toBe(200);
    expect(mockDisp).toHaveBeenCalledWith({
      responsavelIds: [LETICIA, VICTOR],
      inicio: '2026-09-22',
      fim: '2026-09-22',
      tipos: ['atendimento'],
      duracaoPadraoMin: 45,
      fresh: true,
      incluirTitulos: false,
    });
  });

  it('400 sem responsavelIds', async () => {
    const res = await request(app).get('/api/agenda/disponibilidade?inicio=2026-09-22&fim=2026-09-22');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(mockDisp).not.toHaveBeenCalled();
  });

  it('400 com id não numérico', async () => {
    const res = await request(app).get('/api/agenda/disponibilidade?responsavelIds=abc&inicio=2026-09-22&fim=2026-09-22');
    expect(res.status).toBe(400);
  });

  it('400 sem inicio/fim', async () => {
    const res = await request(app).get(`/api/agenda/disponibilidade?responsavelIds=${LETICIA}`);
    expect(res.status).toBe(400);
  });

  it('400 com fim antes do início', async () => {
    const res = await request(app).get(
      `/api/agenda/disponibilidade?responsavelIds=${LETICIA}&inicio=2026-09-22&fim=2026-09-21`,
    );
    expect(res.status).toBe(400);
  });

  it('400 com janela maior que 31 dias', async () => {
    const res = await request(app).get(
      `/api/agenda/disponibilidade?responsavelIds=${LETICIA}&inicio=2026-09-01&fim=2026-10-03`,
    );
    expect(res.status).toBe(400);
  });

  it('repassa incluirTitulos=1', async () => {
    mockDisp.mockResolvedValueOnce(ok(disp()));
    await request(app).get(`/api/agenda/disponibilidade?responsavelIds=${LETICIA}&inicio=2026-09-22&fim=2026-09-22&incluirTitulos=1`);
    expect(mockDisp).toHaveBeenCalledWith(expect.objectContaining({ incluirTitulos: true }));
  });

  it('400 com data impossível (2026-02-30)', async () => {
    const res = await request(app).get(`/api/agenda/disponibilidade?responsavelIds=${LETICIA}&inicio=2026-02-30&fim=2026-03-02`);
    expect(res.status).toBe(400);
  });

  it('400 com duração fora de 5..240', async () => {
    const res = await request(app).get(
      `/api/agenda/disponibilidade?responsavelIds=${LETICIA}&inicio=2026-09-22&fim=2026-09-22&duracaoPadraoMin=500`,
    );
    expect(res.status).toBe(400);
  });

  it('400 com tipo desconhecido', async () => {
    const res = await request(app).get(
      `/api/agenda/disponibilidade?responsavelIds=${LETICIA}&inicio=2026-09-22&fim=2026-09-22&tipos=reuniao`,
    );
    expect(res.status).toBe(400);
  });

  it.each([
    ['VALIDATION_ERROR', 400],
    ['BROWSER_UNAVAILABLE', 503],
    ['TIMEOUT', 504],
    ['API_ERROR', 500],
  ] as const)('mapeia erro %s do service para HTTP %i', async (code, status) => {
    mockDisp.mockResolvedValueOnce(err({ code, message: 'falhou', retryable: false }));
    const res = await request(app).get(
      `/api/agenda/disponibilidade?responsavelIds=${LETICIA}&inicio=2026-09-22&fim=2026-09-22`,
    );
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ success: false, code, error: 'falhou' });
  });

  it('503 da disponibilidade devolve Retry-After para o consumidor recuar', async () => {
    mockDisp.mockResolvedValueOnce(err({ code: 'BROWSER_UNAVAILABLE', message: 'x', retryable: true }));
    const res = await request(app).get(
      `/api/agenda/disponibilidade?responsavelIds=${LETICIA}&inicio=2026-09-22&fim=2026-09-22`,
    );
    expect(res.headers['retry-after']).toBe('30');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/agenda/eventos
// ─────────────────────────────────────────────────────────────────────────────

const EVENTO_OK = {
  evento: {
    id: '8888888888888888',
    titulo: 'ATENDIMENTO INICIAL - X - ONLINE',
    data: '2026-09-30',
    horaInicio: '14:00',
    horaFim: '14:30',
    diaTodo: false,
    responsavelId: LETICIA,
    envolvidosIds: [],
    chaveExterna: 'n8n-ag#42',
  },
  reaproveitado: false,
  contato: null,
  atendimento: null,
  parcial: false,
  erros: [],
};

const CORPO = {
  titulo: 'ATENDIMENTO INICIAL - X - ONLINE',
  data: '2026-09-30',
  horaInicio: '14:00',
  responsavelId: LETICIA,
  chaveExterna: 'n8n-ag#42',
  contato: { nome: 'X', telefone: '+5527990000001' },
};

describe('POST /api/agenda/eventos', () => {
  it('201 quando cria', async () => {
    mockCriar.mockResolvedValueOnce(ok(EVENTO_OK));
    const res = await request(app).post('/api/agenda/eventos').send(CORPO);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: EVENTO_OK });
    expect(mockCriar).toHaveBeenCalledWith(expect.objectContaining({ titulo: CORPO.titulo, contato: CORPO.contato }));
  });

  it('200 quando reaproveita (mesma chaveExterna)', async () => {
    mockCriar.mockResolvedValueOnce(ok({ ...EVENTO_OK, reaproveitado: true }));
    const res = await request(app).post('/api/agenda/eventos').send(CORPO);
    expect(res.status).toBe(200);
  });

  it('409 com os conflitos no details', async () => {
    const conflitos = [{ responsavelId: LETICIA, inicio: '2026-09-30T14:00:00-03:00', fim: '2026-09-30T14:30:00-03:00', origens: [] }];
    mockCriar.mockResolvedValueOnce(err({ code: 'CONFLICT', message: 'horário ocupado', retryable: false, details: { conflitos } }));
    const res = await request(app).post('/api/agenda/eventos').send(CORPO);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, code: 'CONFLICT', error: 'horário ocupado', details: { conflitos } });
  });

  it('mensagem de erro sai sem o prefixo de código', async () => {
    mockCriar.mockResolvedValueOnce(err({ code: 'CONFLICT', message: 'CONFLICT: horário ocupado no Astrea (2026-09-30 14:00–14:30)', retryable: false }));
    const res = await request(app).post('/api/agenda/eventos').send(CORPO);
    expect(res.body.error).toBe('horário ocupado no Astrea (2026-09-30 14:00–14:30)');
  });

  it.each([
    [{ ...CORPO, responsavelId: 'x' }],
    [{ ...CORPO, data: '30/09/2026' }],
    [{ ...CORPO, horaInicio: undefined }],
    [{ ...CORPO, titulo: '' }],
    [{ ...CORPO, chaveExterna: 'com espaço' }],
    [{ ...CORPO, contato: { telefone: '1' } }],
    [{ ...CORPO, modalidade: 'hibrido' }],
    [{ ...CORPO, data: '2026-09-31' }],
    [{ ...CORPO, campoDesconhecido: 1 }],
    [{ ...CORPO, contato: { nome: 'X', cpf: '1' } }],
  ])('400 com corpo inválido (%#)', async (corpo) => {
    const res = await request(app).post('/api/agenda/eventos').send(corpo);
    expect(res.status).toBe(400);
    expect(mockCriar).not.toHaveBeenCalled();
  });

  it('dia inteiro dispensa horaInicio', async () => {
    mockCriar.mockResolvedValueOnce(ok(EVENTO_OK));
    const res = await request(app).post('/api/agenda/eventos').send({ ...CORPO, horaInicio: undefined, diaTodo: true });
    expect(res.status).toBe(201);
  });

  it('503 com Retry-After quando o browser está indisponível', async () => {
    mockCriar.mockResolvedValueOnce(err({ code: 'BROWSER_UNAVAILABLE', message: 'x', retryable: true }));
    const res = await request(app).post('/api/agenda/eventos').send(CORPO);
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
  });
});

describe('GET /api/agenda/eventos (busca por contato)', () => {
  it('repassa telefone, nome, chave, janela e responsáveis', async () => {
    mockPorContato.mockResolvedValueOnce(ok([]));
    const res = await request(app).get(
      `/api/agenda/eventos?telefone=%2B5527990000001&nome=Fulano&chaveExterna=n8n-ag%2342&inicio=2026-09-25&fim=2026-10-10&responsavelIds=${LETICIA},${VICTOR}`,
    );
    expect(res.status).toBe(200);
    expect(mockPorContato).toHaveBeenCalledWith({
      telefone: '+5527990000001',
      nome: 'Fulano',
      chaveExterna: 'n8n-ag#42',
      inicio: '2026-09-25',
      fim: '2026-10-10',
      responsavelIds: [LETICIA, VICTOR],
    });
  });

  it('400 só com nome (sem telefone nem chave)', async () => {
    const res = await request(app).get(`/api/agenda/eventos?nome=Fulano&inicio=2026-09-25&fim=2026-10-10&responsavelIds=${LETICIA}`);
    expect(res.status).toBe(400);
    expect(mockPorContato).not.toHaveBeenCalled();
  });

  it('repassa incluirCancelados', async () => {
    mockPorContato.mockResolvedValueOnce(ok([]));
    await request(app).get(`/api/agenda/eventos?telefone=27990000001&inicio=2026-09-25&fim=2026-10-10&responsavelIds=${LETICIA}&incluirCancelados=1`);
    expect(mockPorContato).toHaveBeenCalledWith(expect.objectContaining({ incluirCancelados: true }));
  });

  it('400 sem janela', async () => {
    const res = await request(app).get(`/api/agenda/eventos?telefone=27990000001&responsavelIds=${LETICIA}`);
    expect(res.status).toBe(400);
  });

  it('erro de validação do service vira 400', async () => {
    mockPorContato.mockResolvedValueOnce(err({ code: 'VALIDATION_ERROR', message: 'informe telefone', retryable: false }));
    const res = await request(app).get(`/api/agenda/eventos?inicio=2026-09-25&fim=2026-10-10&responsavelIds=${LETICIA}`);
    expect(res.status).toBe(400);
  });
});

describe('/api/agenda/eventos/:id', () => {
  it('GET 200 / 404', async () => {
    mockBuscar.mockResolvedValueOnce(ok({ id: '8888888888888888' } as never));
    expect((await request(app).get('/api/agenda/eventos/8888888888888888')).status).toBe(200);
    mockBuscar.mockResolvedValueOnce(err({ code: 'NOT_FOUND', message: 'x', retryable: false }));
    expect((await request(app).get('/api/agenda/eventos/8888888888888888')).status).toBe(404);
  });

  it('POST /:id/cancelar repassa o motivo', async () => {
    mockCancelar.mockResolvedValueOnce(ok({ id: '8888888888888888', status: 'cancelado' as const }));
    const res = await request(app).post('/api/agenda/eventos/8888888888888888/cancelar').send({ motivo: 'desistiu' });
    expect(res.status).toBe(200);
    expect(mockCancelar).toHaveBeenCalledWith('8888888888888888', 'desistiu', { forcar: undefined });
  });

  it('forcar=1 é repassado às mutações; FORBIDDEN vira 403', async () => {
    mockExcluir.mockResolvedValueOnce(ok({ id: '8888888888888888', removido: true as const }));
    await request(app).delete('/api/agenda/eventos/8888888888888888?forcar=1');
    expect(mockExcluir).toHaveBeenCalledWith('8888888888888888', { forcar: true });

    mockCancelar.mockResolvedValueOnce(err({ code: 'FORBIDDEN', message: 'FORBIDDEN: não foi criado pela automação', retryable: false }));
    const res = await request(app).post('/api/agenda/eventos/8888888888888888/cancelar').send({});
    expect(res.status).toBe(403);
  });

  it('DELETE 200', async () => {
    mockExcluir.mockResolvedValueOnce(ok({ id: '8888888888888888', removido: true as const }));
    const res = await request(app).delete('/api/agenda/eventos/8888888888888888');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: '8888888888888888', removido: true });
  });

  it('PATCH remarca; 409 em conflito', async () => {
    mockRemarcar.mockResolvedValueOnce(ok({ id: '8888888888888888', data: '2026-10-02', horaInicio: '15:00', horaFim: '15:30', diaTodo: false }));
    const res = await request(app)
      .patch('/api/agenda/eventos/8888888888888888')
      .send({ data: '2026-10-02', horaInicio: '15:00', responsavelId: LETICIA });
    expect(res.status).toBe(200);
    expect(mockRemarcar).toHaveBeenCalledWith('8888888888888888', { data: '2026-10-02', horaInicio: '15:00', responsavelId: LETICIA }, { forcar: undefined });

    mockRemarcar.mockResolvedValueOnce(err({ code: 'CONFLICT', message: 'ocupado', retryable: false, details: { conflitos: [] } }));
    const r2 = await request(app).patch('/api/agenda/eventos/8888888888888888').send({ data: '2026-10-02', horaInicio: '15:00', responsavelId: LETICIA });
    expect(r2.status).toBe(409);
  });

  it('PATCH 400 sem data', async () => {
    const res = await request(app).patch('/api/agenda/eventos/8888888888888888').send({ horaInicio: '15:00' });
    expect(res.status).toBe(400);
  });
});
