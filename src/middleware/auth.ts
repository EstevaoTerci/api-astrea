import { timingSafeEqual } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { ApiError } from '../types/index.js';

export interface ApiKeyEntry {
  key: string;
  /** Rótulo para auditoria/rotação. Quando ausente na config, usa fingerprint da key. */
  label: string;
}

export interface AuthenticatedRequest extends Request {
  apiKey?: ApiKeyEntry;
}

/**
 * Carrega as keys ativas:
 *   1. API_KEYS (lista, formato `chave[:label],chave[:label],...`)
 *   2. API_KEY (legada, label `legacy` — chave da Leia, não pode quebrar)
 * Falha rápido no boot se alguma key tem menos de 32 chars ou se nenhuma existe.
 */
export function carregarKeys(
  apiKeys: string | undefined,
  apiKey: string | undefined,
): ApiKeyEntry[] {
  const keys: ApiKeyEntry[] = [];

  if (apiKeys) {
    for (const raw of apiKeys.split(',')) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const sep = trimmed.indexOf(':');
      const key = sep === -1 ? trimmed : trimmed.slice(0, sep);
      const label = sep === -1 ? fingerprint(key) : trimmed.slice(sep + 1);
      if (key.length < 32) {
        throw new Error(`API_KEYS contém entrada com menos de 32 caracteres (label: ${label})`);
      }
      keys.push({ key, label });
    }
  }

  if (apiKey) {
    keys.push({ key: apiKey, label: 'legacy' });
  }

  if (keys.length === 0) {
    throw new Error('Nenhuma API key configurada (API_KEY ou API_KEYS)');
  }

  return keys;
}

function fingerprint(key: string): string {
  return `key-${key.slice(0, 4)}…${key.slice(-4)}`;
}

const KEYS = carregarKeys(env.API_KEYS, env.API_KEY);

/**
 * Middleware de autenticação por API Key.
 * Verifica o header `x-api-key` em todas as rotas (exceto /health).
 * Anexa `req.apiKey = { key, label }` e loga o label (nunca a chave) para auditoria.
 */
export function apiKeyAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const header = req.headers['x-api-key'];

  if (!header) {
    const error: ApiError = {
      success: false,
      error: 'Header x-api-key ausente.',
      code: 'MISSING_API_KEY',
    };
    res.status(401).json(error);
    return;
  }

  const provided = Buffer.from(Array.isArray(header) ? header[0] : header);
  const match = KEYS.find((entry) => {
    const expected = Buffer.from(entry.key);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });

  if (!match) {
    const error: ApiError = {
      success: false,
      error: 'API Key inválida.',
      code: 'INVALID_API_KEY',
    };
    res.status(403).json(error);
    return;
  }

  req.apiKey = match;
  // info (não debug): em produção o pino roda em level info, e este log é a
  // trilha de auditoria de qual chave usou a API.
  logger.info({ keyLabel: match.label, method: req.method, path: req.path }, 'API key autenticada');
  next();
}
