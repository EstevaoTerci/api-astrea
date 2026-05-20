import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { RequestHandler } from 'express';
import { buildApp } from '../../test/helpers/express-app.js';

/**
 * `express-rate-limit` lê windowMs/max no momento da construção, e o
 * `rate-limiter.ts` mantém contadores globais (`blockedTotal`,
 * `lastBlockedAt`). Para isolar cada teste:
 *
 *  - `vi.stubEnv` substitui as env vars
 *  - `vi.resetModules` força re-import (nova instância de rateLimiter + store fresca)
 */

let rateLimiter: RequestHandler;
let getRateLimiterStats: () => {
  windowMs: number;
  max: number;
  blockedTotal: number;
  lastBlockedAt: string | null;
};

async function loadLimiterWith(opts: { max: number; windowMs?: number }): Promise<void> {
  vi.resetModules();
  vi.stubEnv('RATE_LIMIT_MAX_REQUESTS', String(opts.max));
  vi.stubEnv('RATE_LIMIT_WINDOW_MS', String(opts.windowMs ?? 60_000));
  const mod = await import('./rate-limiter.js');
  rateLimiter = mod.rateLimiter;
  getRateLimiterStats = mod.getRateLimiterStats;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('rateLimiter — bloqueio por IP', () => {
  beforeEach(async () => {
    await loadLimiterWith({ max: 3, windowMs: 60_000 });
  });

  it('libera requisições dentro do limite', async () => {
    const app = buildApp((a) => {
      a.use(rateLimiter);
      a.get('/data', (_req, res) => res.json({ ok: true }));
    });

    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/data');
      expect(res.status).toBe(200);
    }
  });

  it('retorna 429 com Retry-After e código RATE_LIMIT_EXCEEDED ao exceder', async () => {
    const app = buildApp((a) => {
      a.use(rateLimiter);
      a.get('/data', (_req, res) => res.json({ ok: true }));
    });

    // Consome o limite
    for (let i = 0; i < 3; i++) await request(app).get('/data');

    const blocked = await request(app).get('/data');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.body).toMatchObject({
      success: false,
      code: 'RATE_LIMIT_EXCEEDED',
    });
    expect(blocked.body.error).toMatch(/Limite de requisições/);
  });

  it('envia headers RateLimit-* (draft-7)', async () => {
    const app = buildApp((a) => {
      a.use(rateLimiter);
      a.get('/data', (_req, res) => res.json({ ok: true }));
    });

    const res = await request(app).get('/data');
    // express-rate-limit v7 com standardHeaders:'draft-7' envia RateLimit + RateLimit-Policy
    expect(res.headers).toHaveProperty('ratelimit');
    expect(res.headers).toHaveProperty('ratelimit-policy');
  });

  it('incrementa blockedTotal e atualiza lastBlockedAt em cada 429', async () => {
    const app = buildApp((a) => {
      a.use(rateLimiter);
      a.get('/data', (_req, res) => res.json({ ok: true }));
    });

    for (let i = 0; i < 3; i++) await request(app).get('/data');

    expect(getRateLimiterStats().blockedTotal).toBe(0);
    expect(getRateLimiterStats().lastBlockedAt).toBeNull();

    await request(app).get('/data');
    expect(getRateLimiterStats().blockedTotal).toBe(1);
    expect(getRateLimiterStats().lastBlockedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await request(app).get('/data');
    expect(getRateLimiterStats().blockedTotal).toBe(2);
  });
});

describe('rateLimiter — bypass de /health', () => {
  beforeEach(async () => {
    await loadLimiterWith({ max: 2 });
  });

  it('não conta /health no limite', async () => {
    const app = buildApp((a) => {
      a.use(rateLimiter);
      a.get('/health', (_req, res) => res.json({ status: 'ok' }));
      a.get('/data', (_req, res) => res.json({ ok: true }));
    });

    // Tantos hits em /health quanto quiser, todos passam
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    }

    // E o limite de /data ainda está intacto
    for (let i = 0; i < 2; i++) {
      const res = await request(app).get('/data');
      expect(res.status).toBe(200);
    }
    const blocked = await request(app).get('/data');
    expect(blocked.status).toBe(429);
  });
});

describe('rateLimiter — stats expostos via getRateLimiterStats', () => {
  beforeEach(async () => {
    await loadLimiterWith({ max: 50, windowMs: 60_000 });
  });

  it('reflete windowMs e max do env', () => {
    const stats = getRateLimiterStats();
    expect(stats.windowMs).toBe(60_000);
    expect(stats.max).toBe(50);
  });
});
