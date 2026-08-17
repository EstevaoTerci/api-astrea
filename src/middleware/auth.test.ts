import { describe, expect, it, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { apiKeyAuth, carregarKeys, type AuthenticatedRequest } from './auth.js';
import { buildAppWith } from '../../test/helpers/express-app.js';
import { logger } from '../utils/logger.js';

// Valores stubados em test/setup.ts (antes do parseEnv rodar no import):
//   API_KEY  = test-api-key-with-at-least-32-characters-long-aaa   (legada, label `legacy`)
//   API_KEYS = <alpha>:alpha,<beta>                                (beta sem label → fingerprint)
const KEY_LEGADA = 'test-api-key-with-at-least-32-characters-long-aaa';
const KEY_ALPHA = 'test-list-key-alpha-with-32-plus-chars-aaaa';
const KEY_BETA = 'test-list-key-beta-with-32-plus-chars-bbbb';

describe('apiKeyAuth', () => {
  const app = buildAppWith(apiKeyAuth, {
    protectedHandler: (req, res) => {
      res.json({ ok: true, apiKey: (req as AuthenticatedRequest).apiKey });
    },
  });

  beforeEach(() => {
    vi.mocked(logger).info.mockClear();
  });

  it('retorna 401 quando o header x-api-key está ausente', async () => {
    const res = await request(app).get('/test');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: 'Header x-api-key ausente.',
      code: 'MISSING_API_KEY',
    });
  });

  it('retorna 403 quando a API key está incorreta', async () => {
    const res = await request(app).get('/test').set('x-api-key', 'chave-errada');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: 'API Key inválida.',
      code: 'INVALID_API_KEY',
    });
  });

  it('aceita chave da lista API_KEYS e anexa req.apiKey com o label', async () => {
    const res = await request(app).get('/test').set('x-api-key', KEY_ALPHA);

    expect(res.status).toBe(200);
    expect(res.body.apiKey).toEqual({ key: KEY_ALPHA, label: 'alpha' });
  });

  it('aceita chave da lista sem label, usando fingerprint como label', async () => {
    const res = await request(app).get('/test').set('x-api-key', KEY_BETA);

    expect(res.status).toBe(200);
    expect(res.body.apiKey.label).toBe(`key-${KEY_BETA.slice(0, 4)}…${KEY_BETA.slice(-4)}`);
  });

  it('aceita a chave legada (env.API_KEY) com label `legacy`', async () => {
    const res = await request(app).get('/test').set('x-api-key', KEY_LEGADA);

    expect(res.status).toBe(200);
    expect(res.body.apiKey).toEqual({ key: KEY_LEGADA, label: 'legacy' });
  });

  it('loga o label autenticado, nunca a chave', async () => {
    await request(app).get('/test').set('x-api-key', KEY_ALPHA);

    const calls = vi.mocked(logger).info.mock.calls;
    const authCall = calls.find(([obj]) => (obj as { keyLabel?: string })?.keyLabel === 'alpha');
    expect(authCall).toBeDefined();
    expect(JSON.stringify(authCall)).not.toContain(KEY_ALPHA);
  });

  it('não loga nada em tentativa inválida além do label ausente (nunca a chave)', async () => {
    await request(app).get('/test').set('x-api-key', 'chave-errada');

    expect(JSON.stringify(vi.mocked(logger).info.mock.calls)).not.toContain('chave-errada');
  });

  it('não vaza informação extra no 401/403 (ApiError shape estrito)', async () => {
    const r401 = await request(app).get('/test');
    const r403 = await request(app).get('/test').set('x-api-key', 'foo');

    expect(Object.keys(r401.body).sort()).toEqual(['code', 'error', 'success']);
    expect(Object.keys(r403.body).sort()).toEqual(['code', 'error', 'success']);
  });
});

describe('carregarKeys', () => {
  it('falha rápido se uma chave da lista tem menos de 32 caracteres', () => {
    expect(() => carregarKeys('curta:rafael', undefined)).toThrow(/32/);
  });

  it('falha rápido se nenhuma chave está configurada', () => {
    expect(() => carregarKeys(undefined, undefined)).toThrow(/Nenhuma API key/i);
  });

  it('ignora entradas vazias e aparas espaços', () => {
    const keys = carregarKeys(` ${'a'.repeat(32)}:um , ,${'b'.repeat(32)}:dois `, undefined);
    expect(keys).toEqual([
      { key: 'a'.repeat(32), label: 'um' },
      { key: 'b'.repeat(32), label: 'dois' },
    ]);
  });
});
