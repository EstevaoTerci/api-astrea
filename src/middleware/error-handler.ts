import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../utils/logger.js';
import { ApiError } from '../types/index.js';

/**
 * Mapeia mensagens de erro do Playwright/browser/queue para códigos HTTP.
 */
function mapErrorToHttp(error: Error): { status: number; code: string; retryAfter?: number } {
  const msg = error.message;

  if (msg.includes('QUEUE_FULL')) return { status: 503, code: 'SERVER_OVERLOADED', retryAfter: 10 };
  if (msg.includes('QUEUE_TIMEOUT')) return { status: 503, code: 'QUEUE_TIMEOUT', retryAfter: 5 };
  if (msg.includes('AUTH_FAILED')) return { status: 502, code: 'AUTH_FAILED' };
  if (msg.includes('BROWSER_POOL_TIMEOUT')) return { status: 503, code: 'BROWSER_UNAVAILABLE' };
  if (msg.includes('NOT_FOUND')) return { status: 404, code: 'NOT_FOUND' };
  if (msg.includes('timeout') || msg.includes('Timeout')) return { status: 504, code: 'TIMEOUT' };
  if (msg.includes('Navigation failed')) return { status: 502, code: 'NAVIGATION_FAILED' };

  return { status: 500, code: 'INTERNAL_ERROR' };
}

/**
 * Handler global de erros do Express.
 * Formata todos os erros em um padrão JSON consistente.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  // Erro de validação Zod (query params inválidos)
  if (err instanceof ZodError) {
    const error: ApiError = {
      success: false,
      error: 'Parâmetros inválidos.',
      code: 'VALIDATION_ERROR',
      details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
    };
    res.status(400).json(error);
    return;
  }

  if (err instanceof Error) {
    const { status, code, retryAfter } = mapErrorToHttp(err);

    logger.error(
      { err: { message: err.message, stack: err.stack }, path: req.path, method: req.method },
      `Erro na requisição: ${err.message}`,
    );

    const error: ApiError = {
      success: false,
      error: err.message.replace(/^[A-Z_]+:\s*/, ''), // Remove o prefixo de código
      code,
      ...(process.env.NODE_ENV === 'development' && { details: err.stack }),
    };

    if (retryAfter) {
      res.setHeader('Retry-After', retryAfter);
    }

    res.status(status).json(error);
    return;
  }

  // Erro desconhecido
  logger.error({ err, path: req.path }, 'Erro desconhecido');
  const error: ApiError = {
    success: false,
    error: 'Erro interno do servidor.',
    code: 'INTERNAL_ERROR',
  };
  res.status(500).json(error);
}
