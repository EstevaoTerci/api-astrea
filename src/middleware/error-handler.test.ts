import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { errorHandler } from './error-handler.js';
import { buildApp } from '../../test/helpers/express-app.js';

/** Helper: monta um app que lança o erro `err` na rota `/boom`. */
function appThatThrows(err: unknown) {
  return buildApp((a) => {
    a.get('/boom', (_req, _res, next) => next(err));
    a.use(errorHandler);
  });
}

describe('errorHandler — ZodError', () => {
  it('retorna 400 com VALIDATION_ERROR e lista de issues', async () => {
    const schema = z.object({ idade: z.number().int().positive() });
    let capturedZodError: z.ZodError | null = null;
    try {
      schema.parse({ idade: -1 });
    } catch (e) {
      capturedZodError = e as z.ZodError;
    }

    const app = appThatThrows(capturedZodError);
    const res = await request(app).get('/boom');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: 'Parâmetros inválidos.',
      code: 'VALIDATION_ERROR',
    });
    expect(res.body.details).toBeInstanceOf(Array);
    expect(res.body.details[0]).toHaveProperty('field');
    expect(res.body.details[0]).toHaveProperty('message');
  });
});

describe('errorHandler — mapeamento de erros do scraping', () => {
  it('QUEUE_FULL → 503 + Retry-After 10s', async () => {
    const res = await request(appThatThrows(new Error('QUEUE_FULL: cheio'))).get('/boom');

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SERVER_OVERLOADED');
    expect(res.headers['retry-after']).toBe('10');
  });

  it('QUEUE_TIMEOUT → 503 + Retry-After 5s', async () => {
    const res = await request(appThatThrows(new Error('QUEUE_TIMEOUT: tempo esgotado'))).get(
      '/boom',
    );

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('QUEUE_TIMEOUT');
    expect(res.headers['retry-after']).toBe('5');
  });

  it('AUTH_FAILED → 502', async () => {
    const res = await request(appThatThrows(new Error('AUTH_FAILED: login inválido'))).get(
      '/boom',
    );

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AUTH_FAILED');
  });

  it('BROWSER_POOL_TIMEOUT → 503 BROWSER_UNAVAILABLE', async () => {
    const res = await request(appThatThrows(new Error('BROWSER_POOL_TIMEOUT: sem slot'))).get(
      '/boom',
    );

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('BROWSER_UNAVAILABLE');
  });

  it('NOT_FOUND → 404', async () => {
    const res = await request(appThatThrows(new Error('NOT_FOUND: contato não existe'))).get(
      '/boom',
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('timeout (case-insensitive) → 504', async () => {
    const res = await request(appThatThrows(new Error('Operation Timeout exceeded'))).get('/boom');
    expect(res.status).toBe(504);
    expect(res.body.code).toBe('TIMEOUT');
  });

  it('Navigation failed → 502', async () => {
    const res = await request(
      appThatThrows(new Error('Navigation failed: net::ERR_CONNECTION_REFUSED')),
    ).get('/boom');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('NAVIGATION_FAILED');
  });

  it('erro genérico → 500 INTERNAL_ERROR', async () => {
    const res = await request(appThatThrows(new Error('algo inesperado'))).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });
});

describe('errorHandler — formatação da mensagem', () => {
  it('remove o prefixo de código do início da mensagem', async () => {
    const res = await request(appThatThrows(new Error('NOT_FOUND: contato xpto não existe'))).get(
      '/boom',
    );

    // mapErrorToHttp deu NOT_FOUND, então o prefixo "NOT_FOUND: " sai
    expect(res.body.error).toBe('contato xpto não existe');
  });

  it('mantém a mensagem se não houver prefixo de código', async () => {
    const res = await request(appThatThrows(new Error('mensagem sem prefixo'))).get('/boom');
    expect(res.body.error).toBe('mensagem sem prefixo');
  });
});

describe('errorHandler — erro desconhecido (não-Error)', () => {
  it('strings cruas viram 500 INTERNAL_ERROR genérico', async () => {
    const res = await request(appThatThrows('isso não é uma Error')).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: 'Erro interno do servidor.',
      code: 'INTERNAL_ERROR',
    });
  });

  it('objetos arbitrários viram 500 INTERNAL_ERROR genérico', async () => {
    const res = await request(appThatThrows({ custom: 'thing' })).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });
});
