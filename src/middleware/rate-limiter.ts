import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { ApiError } from '../types/index.js';

/**
 * Rate limiter para proteger o Astrea de sobrecarga.
 * Limita requisições por IP dentro de uma janela de tempo.
 */
export const rateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  message: (): ApiError => ({
    success: false,
    error: `Limite de requisições excedido. Tente novamente em ${Math.ceil(env.RATE_LIMIT_WINDOW_MS / 1000)} segundos.`,
    code: 'RATE_LIMIT_EXCEEDED',
  }),
  skip: (req) => req.path === '/health',
});
