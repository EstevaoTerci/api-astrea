import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// O pool real importa playwright/chromium e sobe browser — mockamos por completo.
// Foco do teste: a política de retry de `withBrowserContext` (retryIf), em
// especial que falhas de LOGIN NÃO são re-tentadas (corta a amplificação K×3),
// enquanto erros de OPERAÇÃO transitórios continuam sendo.
vi.mock('./pool.js', () => ({
  browserPool: {
    acquirePage: vi.fn().mockResolvedValue({}),
    ensureAuthenticated: vi.fn().mockResolvedValue(undefined),
    releasePage: vi.fn().mockResolvedValue(undefined),
    invalidateSession: vi.fn(),
  },
}));

import {
  astreaApiDelete,
  astreaApiGet,
  astreaApiPost,
  astreaApiPut,
  withBrowserContext,
} from './astrea-http.js';
import { browserPool } from './pool.js';

const mockAcquire = vi.mocked(browserPool.acquirePage);
const mockEnsure = vi.mocked(browserPool.ensureAuthenticated);
const mockRelease = vi.mocked(browserPool.releasePage);

beforeEach(() => {
  mockAcquire.mockReset().mockResolvedValue({});
  mockEnsure.mockReset().mockResolvedValue(undefined);
  mockRelease.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('withBrowserContext — aba quente', () => {
  it('repassa { warm: true } ao pool quando pedido', async () => {
    await withBrowserContext(async () => 'ok', { warm: true });
    expect(mockAcquire).toHaveBeenCalledWith({ warm: true });
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('sem opção usa aba comum (warm false)', async () => {
    await withBrowserContext(async () => 'ok');
    expect(mockAcquire).toHaveBeenCalledWith({ warm: false });
  });
});

describe('withBrowserContext — política de retry', () => {
  it('NÃO re-tenta falha de login estruturada (LOGIN_FAILED_*) — operação roda 0x', async () => {
    mockEnsure.mockRejectedValue(new Error('LOGIN_FAILED_STILL_ON_LOGIN: campo de senha visível'));
    const op = vi.fn().mockResolvedValue('nunca');

    await expect(withBrowserContext(op)).rejects.toThrow(/LOGIN_FAILED_STILL_ON_LOGIN/);

    // ensureAuthenticated chamado UMA vez (sem o K×3 antigo), operação nunca alcançada.
    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expect(op).not.toHaveBeenCalled();
    // Slot do pool sempre liberado.
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('NÃO re-tenta quando o circuit breaker está aberto (LOGIN_CIRCUIT_OPEN)', async () => {
    mockEnsure.mockRejectedValue(new Error('LOGIN_CIRCUIT_OPEN: login bloqueado; retry em ~42s'));
    const op = vi.fn();

    await expect(withBrowserContext(op)).rejects.toThrow(/LOGIN_CIRCUIT_OPEN/);
    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expect(op).not.toHaveBeenCalled();
  });

  it('NÃO re-tenta credencial inválida (AUTH_FAILED)', async () => {
    mockEnsure.mockRejectedValue(new Error('AUTH_FAILED: banner de erro: Senha inválida'));
    const op = vi.fn();

    await expect(withBrowserContext(op)).rejects.toThrow(/AUTH_FAILED/);
    expect(mockEnsure).toHaveBeenCalledTimes(1);
  });

  it('RE-tenta erro de operação transitório (net::ERR) e tem sucesso na 2ª', async () => {
    vi.useFakeTimers();
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
      .mockResolvedValueOnce('ok-na-segunda');

    const p = withBrowserContext(op);
    // Avança os timers (backoff do withRetry) sem esperar em tempo real.
    await vi.runAllTimersAsync();

    await expect(p).resolves.toBe('ok-na-segunda');
    expect(op).toHaveBeenCalledTimes(2);
  });
});

describe('withBrowserContext — descarte e recarga da aba', () => {
  it('sucesso libera a aba sem descartar', async () => {
    await withBrowserContext(async () => 'ok', { warm: true });
    expect(mockRelease).toHaveBeenCalledWith(expect.anything(), { descartar: false });
  });

  it('falha final libera a aba pedindo descarte (não estaciona aba possivelmente quebrada)', async () => {
    await expect(
      withBrowserContext(async () => {
        throw new Error('API_ERROR_500: boom');
      }, { warm: true }),
    ).rejects.toThrow(/boom/);
    expect(mockRelease).toHaveBeenCalledWith(expect.anything(), { descartar: true });
  });

  it('após erro de sessão (401), a retentativa recarrega a aba antes de repetir', async () => {
    vi.useFakeTimers();
    const goto = vi.fn().mockResolvedValue(undefined);
    mockAcquire.mockResolvedValueOnce({ goto } as never);
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error('API_ERROR_401: sessão expirada'))
      .mockResolvedValueOnce('ok');

    const p = withBrowserContext(op, { warm: true });
    await vi.runAllTimersAsync();

    await expect(p).resolves.toBe('ok');
    expect(goto).toHaveBeenCalledWith('about:blank');
    expect(goto).toHaveBeenCalledTimes(1);
  });
});

describe('helpers REST — timeout', () => {
  it('astreaApiPost repassa timeout default de 60 s ao evaluate', async () => {
    const evaluate = vi.fn().mockResolvedValue({ ok: 1 });
    await astreaApiPost({ evaluate } as never, '/x', { a: 1 });
    expect(evaluate.mock.calls[0][1]).toMatchObject({ method: 'POST', body: { a: 1 }, timeoutMs: 60_000 });
    expect(evaluate.mock.calls[0][1].url).toMatch(/\/api\/v2\/x$/);
  });

  it('timeout customizado e demais métodos', async () => {
    const evaluate = vi.fn().mockResolvedValue({});
    await astreaApiPut({ evaluate } as never, '/y', {}, 5_000);
    await astreaApiDelete({ evaluate } as never, '/z', 7_000);
    await astreaApiGet({ evaluate } as never, '/w', 9_000);
    expect(evaluate.mock.calls.map((c) => [c[1].method, c[1].timeoutMs])).toEqual([
      ['PUT', 5_000],
      ['DELETE', 7_000],
      ['GET', 9_000],
    ]);
  });
});
