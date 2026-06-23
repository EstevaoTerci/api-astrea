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

import { withBrowserContext } from './astrea-http.js';
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
