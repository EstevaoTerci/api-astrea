import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { ServiceResponse, ServiceError } from '../types/index.js';
import type { Cliente, ClienteResumido } from '../models/index.js';
import { buildApp } from '../../test/helpers/express-app.js';
import { errorHandler } from '../middleware/error-handler.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mocks de serviços — as routes só precisam validar Zod + mapear códigos pro HTTP.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../services/clientes.service.js', () => ({
  listarClientes: vi.fn(),
  listarTodosClientes: vi.fn(),
  listarAniversariantesEnriquecidos: vi.fn(),
  buscarCliente: vi.fn(),
  criarCliente: vi.fn(),
  atualizarCliente: vi.fn(),
  mesclarClientes: vi.fn(),
}));

vi.mock('../services/casos.service.js', () => ({
  buscarCasosPorCliente: vi.fn(),
}));

vi.mock('../services/documentos.service.js', () => ({
  adicionarDocumentoLink: vi.fn(),
}));

import clientesRouter from './clientes.routes.js';
import {
  listarClientes,
  listarTodosClientes,
  listarAniversariantesEnriquecidos,
  buscarCliente,
  criarCliente,
  atualizarCliente,
  mesclarClientes,
} from '../services/clientes.service.js';
import { buscarCasosPorCliente } from '../services/casos.service.js';
import { adicionarDocumentoLink } from '../services/documentos.service.js';

const mockListar = vi.mocked(listarClientes);
const mockListarTodos = vi.mocked(listarTodosClientes);
const mockListarAniv = vi.mocked(listarAniversariantesEnriquecidos);
const mockBuscar = vi.mocked(buscarCliente);
const mockCriar = vi.mocked(criarCliente);
const mockAtualizar = vi.mocked(atualizarCliente);
const mockMesclar = vi.mocked(mesclarClientes);
const mockBuscarCasos = vi.mocked(buscarCasosPorCliente);
const mockAddDoc = vi.mocked(adicionarDocumentoLink);

function ok<T>(data: T, meta?: object): ServiceResponse<T> {
  return { ok: true, data, ...(meta && { meta: meta as never }) };
}

function err(error: ServiceError): ServiceResponse<never> {
  return { ok: false, error };
}

const sampleCliente: Cliente = {
  id: '1',
  nome: 'João',
  url: 'https://astrea.net.br/#/main/contacts/detail/1/data',
};

function buildClientesApp() {
  return buildApp((app) => {
    app.use('/api/clientes', clientesRouter);
    app.use(errorHandler);
  });
}

beforeEach(() => {
  mockListar.mockReset();
  mockListarTodos.mockReset();
  mockListarAniv.mockReset();
  mockBuscar.mockReset();
  mockCriar.mockReset();
  mockAtualizar.mockReset();
  mockMesclar.mockReset();
  mockBuscarCasos.mockReset();
  mockAddDoc.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/clientes
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/clientes', () => {
  it('200 com ApiResponse quando service responde ok', async () => {
    mockListar.mockResolvedValueOnce(
      ok([sampleCliente], { pagina: 1, limite: 50, total: 1 }),
    );

    const res = await request(buildClientesApp()).get('/api/clientes');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: [sampleCliente],
      meta: { pagina: 1, limite: 50, total: 1 },
    });
  });

  it('parseia mesAniversario, estado e etiquetasIds (CSV) do query string', async () => {
    mockListar.mockResolvedValueOnce(ok([]));

    await request(buildClientesApp())
      .get('/api/clientes')
      .query({ mesAniversario: '5', estado: 'es', etiquetasIds: '1,2,3' });

    expect(mockListar).toHaveBeenCalledWith(
      expect.objectContaining({
        mesAniversario: 5,
        estado: 'ES', // schema faz toUpperCase
        etiquetasIds: [1, 2, 3],
      }),
    );
  });

  it('400 quando mesAniversario é inválido (13)', async () => {
    const res = await request(buildClientesApp())
      .get('/api/clientes')
      .query({ mesAniversario: '13' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 quando estado tem mais de 2 caracteres', async () => {
    const res = await request(buildClientesApp())
      .get('/api/clientes')
      .query({ estado: 'SAO' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('503 quando service responde BROWSER_UNAVAILABLE', async () => {
    mockListar.mockResolvedValueOnce(
      err({ code: 'BROWSER_UNAVAILABLE', message: 'sem pool', retryable: true }),
    );

    const res = await request(buildClientesApp()).get('/api/clientes');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      success: false,
      code: 'BROWSER_UNAVAILABLE',
    });
  });

  it('500 quando service responde SCRAPE_ERROR', async () => {
    mockListar.mockResolvedValueOnce(
      err({ code: 'SCRAPE_ERROR', message: 'falha', retryable: true }),
    );

    const res = await request(buildClientesApp()).get('/api/clientes');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('SCRAPE_ERROR');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/clientes/todos
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/clientes/todos', () => {
  it('200 com lista completa de ClienteResumido', async () => {
    const lista: ClienteResumido[] = [
      { id: '1', nome: 'A' },
      { id: '2', nome: 'B' },
    ];
    mockListarTodos.mockResolvedValueOnce(
      ok(lista, { pagina: 1, limite: 2, total: 2 }),
    );

    const res = await request(buildClientesApp()).get('/api/clientes/todos');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(lista);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/clientes/aniversariantes
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/clientes/aniversariantes', () => {
  it('200 com lista enriquecida (dataNascimento+cpfCnpj) quando mes válido', async () => {
    const lista: Cliente[] = [
      {
        id: '5312778616111104',
        nome: 'Airton Florentino',
        url: 'https://astrea.net.br/#/main/contacts/detail/5312778616111104/data',
        cpfCnpj: '003.262.217-19',
        dataNascimento: '1966-06-14',
        telefone: '(27) 99924-0611',
        tipo: 'pessoa_fisica',
      },
    ];
    mockListarAniv.mockResolvedValueOnce(ok(lista, { pagina: 1, limite: 1, total: 1 }));

    const res = await request(buildClientesApp())
      .get('/api/clientes/aniversariantes')
      .query({ mes: 6 });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(lista);
    expect(mockListarAniv).toHaveBeenCalledWith({ mes: 6 });
  });

  it('400 quando mes está fora de 1..12', async () => {
    const res = await request(buildClientesApp())
      .get('/api/clientes/aniversariantes')
      .query({ mes: 13 });

    expect(res.status).toBe(400);
    expect(mockListarAniv).not.toHaveBeenCalled();
  });

  it('400 quando mes ausente', async () => {
    const res = await request(buildClientesApp()).get('/api/clientes/aniversariantes');

    expect(res.status).toBe(400);
    expect(mockListarAniv).not.toHaveBeenCalled();
  });

  it('propaga estado e etiquetasIds (CSV) ao service', async () => {
    mockListarAniv.mockResolvedValueOnce(ok([], { pagina: 1, limite: 0, total: 0 }));

    await request(buildClientesApp())
      .get('/api/clientes/aniversariantes')
      .query({ mes: 6, estado: 'es', etiquetasIds: '10,20' });

    expect(mockListarAniv).toHaveBeenCalledWith({
      mes: 6,
      estado: 'ES', // uppercase aplicado pelo schema
      etiquetasIds: [10, 20],
    });
  });

  it('503 quando BROWSER_UNAVAILABLE', async () => {
    mockListarAniv.mockResolvedValueOnce(
      err({ code: 'BROWSER_UNAVAILABLE', message: 'pool cheio', retryable: true }),
    );

    const res = await request(buildClientesApp())
      .get('/api/clientes/aniversariantes')
      .query({ mes: 6 });

    expect(res.status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/clientes/:id
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/clientes/:id', () => {
  it('200 quando encontrado', async () => {
    mockBuscar.mockResolvedValueOnce(ok(sampleCliente));

    const res = await request(buildClientesApp()).get('/api/clientes/123');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: sampleCliente });
    expect(mockBuscar).toHaveBeenCalledWith('123', { incluirDocumentos: false });
  });

  it('404 quando NOT_FOUND', async () => {
    mockBuscar.mockResolvedValueOnce(
      err({ code: 'NOT_FOUND', message: 'contato não existe', retryable: false }),
    );

    const res = await request(buildClientesApp()).get('/api/clientes/999');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('500 para outros erros', async () => {
    mockBuscar.mockResolvedValueOnce(
      err({ code: 'SCRAPE_ERROR', message: 'algo deu errado', retryable: true }),
    );

    const res = await request(buildClientesApp()).get('/api/clientes/123');
    expect(res.status).toBe(500);
  });

  it('propaga incluirDocumentos=true via query string', async () => {
    mockBuscar.mockResolvedValueOnce(ok(sampleCliente));

    await request(buildClientesApp())
      .get('/api/clientes/123')
      .query({ incluirDocumentos: 'true' });

    expect(mockBuscar).toHaveBeenCalledWith('123', { incluirDocumentos: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/clientes
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/clientes', () => {
  it('201 quando criação tem sucesso', async () => {
    mockCriar.mockResolvedValueOnce(ok(sampleCliente));

    const res = await request(buildClientesApp())
      .post('/api/clientes')
      .send({ nome: 'João' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: sampleCliente });
  });

  it('400 quando body não tem nome (Zod)', async () => {
    const res = await request(buildClientesApp()).post('/api/clientes').send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(mockCriar).not.toHaveBeenCalled();
  });

  it('400 quando perfil é inválido', async () => {
    const res = await request(buildClientesApp())
      .post('/api/clientes')
      .send({ nome: 'X', perfil: 'inexistente' });

    expect(res.status).toBe(400);
  });

  it('500 quando service responde API_ERROR', async () => {
    mockCriar.mockResolvedValueOnce(
      err({ code: 'API_ERROR', message: 'erro do Astrea', retryable: false }),
    );

    const res = await request(buildClientesApp())
      .post('/api/clientes')
      .send({ nome: 'X' });

    expect(res.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/clientes/:id
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/clientes/:id', () => {
  it('200 quando atualização tem sucesso', async () => {
    mockAtualizar.mockResolvedValueOnce(ok({ ...sampleCliente, nome: 'Novo' }));

    const res = await request(buildClientesApp())
      .patch('/api/clientes/1')
      .send({ nome: 'Novo' });

    expect(res.status).toBe(200);
    expect(res.body.data.nome).toBe('Novo');
  });

  it('400 quando body está vazio (schema refine)', async () => {
    const res = await request(buildClientesApp()).patch('/api/clientes/1').send({});

    expect(res.status).toBe(400);
    expect(mockAtualizar).not.toHaveBeenCalled();
  });

  it('404 quando service responde NOT_FOUND', async () => {
    mockAtualizar.mockResolvedValueOnce(
      err({ code: 'NOT_FOUND', message: 'contato sumiu', retryable: false }),
    );

    const res = await request(buildClientesApp())
      .patch('/api/clientes/1')
      .send({ nome: 'X' });

    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/clientes/mesclar
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/clientes/mesclar', () => {
  it('200 quando merge tem sucesso', async () => {
    mockMesclar.mockResolvedValueOnce(ok(sampleCliente));

    const res = await request(buildClientesApp())
      .post('/api/clientes/mesclar')
      .send({ idPrincipal: '100', idsMesclados: ['200'] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(sampleCliente);
  });

  it('400 quando idsMesclados está vazio', async () => {
    const res = await request(buildClientesApp())
      .post('/api/clientes/mesclar')
      .send({ idPrincipal: '100', idsMesclados: [] });

    expect(res.status).toBe(400);
    expect(mockMesclar).not.toHaveBeenCalled();
  });

  it('400 quando service responde VALIDATION_ERROR', async () => {
    mockMesclar.mockResolvedValueOnce(
      err({ code: 'VALIDATION_ERROR', message: 'inválido', retryable: false }),
    );

    const res = await request(buildClientesApp())
      .post('/api/clientes/mesclar')
      .send({ idPrincipal: '100', idsMesclados: ['200'] });

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/clientes/:id/casos
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/clientes/:id/casos', () => {
  it('200 com lista de casos do cliente', async () => {
    mockBuscarCasos.mockResolvedValueOnce({
      ok: true,
      data: [],
      meta: { pagina: 1, limite: 50, total: 0 },
    });

    const res = await request(buildClientesApp()).get('/api/clientes/123/casos');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('500 quando service falha', async () => {
    mockBuscarCasos.mockResolvedValueOnce({
      ok: false,
      error: { code: 'SCRAPE_ERROR', message: 'erro', retryable: true },
    });

    const res = await request(buildClientesApp()).get('/api/clientes/123/casos');
    expect(res.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/clientes/:id/documentos
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/clientes/:id/documentos', () => {
  it('201 quando documento é criado', async () => {
    mockAddDoc.mockResolvedValueOnce(
      ok({ id: 'doc1', tipo: 'DTE_LINK', titulo: 'Link novo' } as any),
    );

    const res = await request(buildClientesApp())
      .post('/api/clientes/123/documentos')
      .send({ link: 'https://example.com', descricao: 'doc' });

    expect(res.status).toBe(201);
  });

  it('400 quando link não é URL válida', async () => {
    const res = await request(buildClientesApp())
      .post('/api/clientes/123/documentos')
      .send({ link: 'não-é-url', descricao: 'x' });

    expect(res.status).toBe(400);
    expect(mockAddDoc).not.toHaveBeenCalled();
  });

  it('400 quando descricao está vazia', async () => {
    const res = await request(buildClientesApp())
      .post('/api/clientes/123/documentos')
      .send({ link: 'https://example.com', descricao: '' });

    expect(res.status).toBe(400);
  });
});
