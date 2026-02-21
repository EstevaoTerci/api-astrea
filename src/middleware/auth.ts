import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { ApiError } from '../types/index.js';

/**
 * Middleware de autenticação por API Key.
 * Verifica o header `x-api-key` em todas as rotas (exceto /health).
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    const error: ApiError = {
      success: false,
      error: 'Header x-api-key ausente.',
      code: 'MISSING_API_KEY',
    };
    res.status(401).json(error);
    return;
  }

  if (apiKey !== env.API_KEY) {
    const error: ApiError = {
      success: false,
      error: 'API Key inválida.',
      code: 'INVALID_API_KEY',
    };
    res.status(403).json(error);
    return;
  }

  next();
}
