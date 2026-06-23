import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { buildApp } from '../../test/helpers/express-app.js';

// Mocks — health depende do browserPool real (que instancia Chromium ao import).
// Mockamos antes de importar a route.
vi.mock('../browser/pool.js', () => ({
  browserPool: {
    stats: {
      pool: {
        total: 3,
        inUse: 0,
        available: 3,
        idleTtlMs: 900_000,
        initialized: false,
      },
      queue: {
        active: 0,
        queued: 0,
        maxConcurrent: 3,
        maxQueueSize: 20,
        totalProcessed: 0,
        totalRejected: 0,
        totalTimedOut: 0,
      },
    },
    loginStats: {
      breaker: { state: 'CLOSED', consecutiveFailures: 0, openUntil: null },
      session: { reuseEnabled: true, restoredFromStorage: true, ageMs: 12_345 },
      counters: { coldStarts: 2, logins: 1, loginFailures: 0 },
      lastFailure: null,
    },
  },
}));

vi.mock('../services/clientes.service.js', () => ({
  getListarClientesCacheStats: vi.fn().mockReturnValue({
    hits: 7,
    misses: 3,
    inflightShared: 1,
    entries: 2,
    hitRatio: 0.7,
  }),
  getAniversariantesCacheStats: vi.fn().mockReturnValue({
    hits: 12,
    misses: 1,
    inflightShared: 0,
    entries: 1,
    hitRatio: 0.923,
  }),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  getRateLimiterStats: vi.fn().mockReturnValue({
    windowMs: 60_000,
    max: 50,
    blockedTotal: 4,
    lastBlockedAt: '2026-05-19T12:34:56.000Z',
  }),
}));

import healthRouter from './health.routes.js';
import {
  getListarClientesCacheStats,
  getAniversariantesCacheStats,
} from '../services/clientes.service.js';
import { getRateLimiterStats } from '../middleware/rate-limiter.js';

function buildHealthApp() {
  return buildApp((app) => app.use('/health', healthRouter));
}

// Não chamamos `mockClear`/`mockReset` aqui de propósito: as funções foram
// criadas com `.mockReturnValue(...)` na factory do vi.mock e qualquer reset
// limparia o retorno fixo (que viraria undefined).

describe('GET /health', () => {
  it('200 com status ok', async () => {
    const res = await request(buildHealthApp()).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('expõe timestamp ISO + uptime + memory', async () => {
    const res = await request(buildHealthApp()).get('/health');

    expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.memory).toMatchObject({
      heapUsed: expect.any(Number),
      heapTotal: expect.any(Number),
      rss: expect.any(Number),
      unit: 'MB',
    });
  });

  it('expõe stats do browser pool (total, inUse, available)', async () => {
    const res = await request(buildHealthApp()).get('/health');

    expect(res.body.pool).toMatchObject({
      total: 3,
      inUse: 0,
      available: 3,
      initialized: false,
    });
  });

  it('expõe stats da request queue (FIFO concorrência)', async () => {
    const res = await request(buildHealthApp()).get('/health');

    expect(res.body.queue).toMatchObject({
      active: 0,
      queued: 0,
      maxConcurrent: 3,
      maxQueueSize: 20,
      totalProcessed: 0,
      totalRejected: 0,
      totalTimedOut: 0,
    });
  });

  it('expõe stats do cache de listarClientes', async () => {
    const res = await request(buildHealthApp()).get('/health');

    expect(res.body.cache.listarClientes).toEqual({
      hits: 7,
      misses: 3,
      inflightShared: 1,
      entries: 2,
      hitRatio: 0.7,
    });
    expect(getListarClientesCacheStats).toHaveBeenCalled();
  });

  it('expõe stats do cache de aniversariantes', async () => {
    const res = await request(buildHealthApp()).get('/health');

    expect(res.body.cache.aniversariantes).toEqual({
      hits: 12,
      misses: 1,
      inflightShared: 0,
      entries: 1,
      hitRatio: 0.923,
    });
    expect(getAniversariantesCacheStats).toHaveBeenCalled();
  });

  it('expõe stats de login (breaker, sessão, contadores)', async () => {
    const res = await request(buildHealthApp()).get('/health');

    expect(res.body.login).toEqual({
      breaker: { state: 'CLOSED', consecutiveFailures: 0, openUntil: null },
      session: { reuseEnabled: true, restoredFromStorage: true, ageMs: 12_345 },
      counters: { coldStarts: 2, logins: 1, loginFailures: 0 },
      lastFailure: null,
    });
  });

  it('expõe stats do rate limiter (incluindo blockedTotal)', async () => {
    const res = await request(buildHealthApp()).get('/health');

    expect(res.body.rateLimit).toEqual({
      windowMs: 60_000,
      max: 50,
      blockedTotal: 4,
      lastBlockedAt: '2026-05-19T12:34:56.000Z',
    });
    expect(getRateLimiterStats).toHaveBeenCalled();
  });
});
