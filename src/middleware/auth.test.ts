import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { apiKeyAuth } from './auth.js';
import { buildAppWith } from '../../test/helpers/express-app.js';
import { env } from '../config/env.js';

describe('apiKeyAuth', () => {
  const app = buildAppWith(apiKeyAuth);

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

  it('libera quando a API key bate com env.API_KEY', async () => {
    const res = await request(app).get('/test').set('x-api-key', env.API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('não vaza informação extra no 401/403 (ApiError shape estrito)', async () => {
    const r401 = await request(app).get('/test');
    const r403 = await request(app).get('/test').set('x-api-key', 'foo');

    expect(Object.keys(r401.body).sort()).toEqual(['code', 'error', 'success']);
    expect(Object.keys(r403.body).sort()).toEqual(['code', 'error', 'success']);
  });
});
