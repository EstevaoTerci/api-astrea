import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { ApiError } from '../types/index.js';

/**
 * Contadores globais — expostos pelo /health para detectar consumer
 * mal-comportado (retry-storm) em produção.
 */
let blockedTotal = 0;
let lastBlockedAt: number | null = null;

export interface RateLimiterStats {
  windowMs: number;
  max: number;
  blockedTotal: number;
  lastBlockedAt: string | null;
}

export function getRateLimiterStats(): RateLimiterStats {
  return {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX_REQUESTS,
    blockedTotal,
    lastBlockedAt: lastBlockedAt ? new Date(lastBlockedAt).toISOString() : null,
  };
}

/**
 * Rate limiter global por IP. `standardHeaders: 'draft-7'` envia
 * `RateLimit-*` (RFC 6585+) E `Retry-After` no 429 — o consumer atual
 * (`assistente-claude`) já respeita Retry-After.
 */
export const rateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: (): ApiError => ({
    success: false,
    error: `Limite de requisições excedido. Tente novamente em ${Math.ceil(env.RATE_LIMIT_WINDOW_MS / 1000)} segundos.`,
    code: 'RATE_LIMIT_EXCEEDED',
  }),
  handler: (req, res, next, options) => {
    blockedTotal++;
    lastBlockedAt = Date.now();
    // `options.message` é a função/valor passado em `message` acima. Em v7
    // do express-rate-limit, esse campo NÃO é auto-resolvido quando é uma
    // função, então um `res.json(fn)` vira body vazio (`JSON.stringify(fn) === undefined`).
    const body =
      typeof options.message === 'function' ? options.message(req, res, next, options) : options.message;
    res.status(options.statusCode).json(body);
  },
  skip: (req) => req.path === '/health',
});
