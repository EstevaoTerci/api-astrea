import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// O pool real importa playwright/chromium e sobe browser — mockamos por completo.
// Foco do teste: a política de retry de `withBrowserContext` (retryIf), em
// especial que falhas de LOGIN NÃO são re-tentadas (corta a amplificação K×3),
// enquanto erros de OPERAÇÃO transitórios continuam sendo.
const poolMock = vi.hoisted(() => ({ geracao: 1 }));
vi.mock('./pool.js', () => ({
  browserPool: {
    acquirePage: vi.fn().mockResolvedValue({}),
    ensureAuthenticated: vi.fn().mockResolvedValue(undefined),
    releasePage: vi.fn().mockResolvedValue(undefined),
    invalidateSession: vi.fn().mockReturnValue(true),
    get geracaoSessao() {
      return poolMock.geracao;
    },
  },
}));

import {
  astreaApiDelete,
  astreaApiGet,
  astreaApiPost,
  astreaApiPut,
  getAstreaUserId,
  withBrowserContext,
} from './astrea-http.js';
import { browserPool } from './pool.js';

const mockAcquire = vi.mocked(browserPool.acquirePage);
const mockEnsure = vi.mocked(browserPool.ensureAuthenticated);
const mockRelease = vi.mocked(browserPool.releasePage);
const mockInvalidate = vi.mocked(browserPool.invalidateSession);

beforeEach(() => {
  poolMock.geracao = 1;
  mockAcquire.mockReset().mockResolvedValue({});
  mockEnsure.mockReset().mockResolvedValue(undefined);
  mockRelease.mockReset().mockResolvedValue(undefined);
  mockInvalidate.mockReset().mockReturnValue(true);
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

// Incidente 25/09/2026: outro login da mesma conta derrubou a sessão no servidor; a SPA
// limpou o localStorage e getAstreaUserId lançava AUTH_FAILED (não-retryable) — a sessão
// nunca era invalidada (`authenticated` seguia true) e a api ficou fora até o redeploy.
describe('sessão derrubada no servidor', () => {
  const paginaSemUsuario = () => ({ evaluate: vi.fn().mockResolvedValue(null) }) as never;

  it('getAstreaUserId devolve o userId do localStorage quando há sessão', async () => {
    const page = { evaluate: vi.fn().mockResolvedValue('6528036269752320') } as never;
    await expect(getAstreaUserId(page)).resolves.toBe('6528036269752320');
  });

  it('getAstreaUserId sem userId lança SESSION_EXPIRED (recuperável), sempre', async () => {
    await expect(getAstreaUserId(paginaSemUsuario())).rejects.toThrow(/^SESSION_EXPIRED/);
    await expect(getAstreaUserId(paginaSemUsuario())).rejects.toThrow(/^SESSION_EXPIRED/);
  });

  it('invalida a sessão informando a geração usada, recarrega a aba e repete', async () => {
    vi.useFakeTimers();
    poolMock.geracao = 7;
    const goto = vi.fn().mockResolvedValue(undefined);
    const evaluate = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('6528036269752320');
    mockAcquire.mockResolvedValueOnce({ goto, evaluate } as never);
    mockEnsure.mockImplementation(async () => {
      // o relogin (2ª chamada) sobe a geração
      if (mockEnsure.mock.calls.length === 2) poolMock.geracao = 8;
    });

    const p = withBrowserContext((page) => getAstreaUserId(page), { warm: true });
    await vi.runAllTimersAsync();

    await expect(p).resolves.toBe('6528036269752320');
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
    expect(mockInvalidate).toHaveBeenCalledWith(7);
    expect(goto).toHaveBeenCalledWith('about:blank');
  });

  it('no máximo UMA recuperação por chamada: se o relogin não trouxe o userId, desiste', async () => {
    vi.useFakeTimers();
    const goto = vi.fn().mockResolvedValue(undefined);
    const evaluate = vi.fn().mockResolvedValue(null);
    mockAcquire.mockResolvedValueOnce({ goto, evaluate } as never);

    const p = withBrowserContext((page) => getAstreaUserId(page), { warm: true });
    const verificacao = expect(p).rejects.toThrow(/^SESSION_EXPIRED/);
    await vi.runAllTimersAsync();
    await verificacao;

    expect(mockInvalidate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('401 também conta como a recuperação da chamada (não invalida 2x)', async () => {
    vi.useFakeTimers();
    const goto = vi.fn().mockResolvedValue(undefined);
    mockAcquire.mockResolvedValueOnce({ goto } as never);
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error('API_ERROR_401: non-existent user session'))
      .mockRejectedValueOnce(new Error('SESSION_EXPIRED: não foi possível obter userId da sessão'));

    const p = withBrowserContext(op, { warm: true });
    const verificacao = expect(p).rejects.toThrow(/^SESSION_EXPIRED/);
    await vi.runAllTimersAsync();
    await verificacao;

    expect(op).toHaveBeenCalledTimes(2);
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
  });

  it('se a sessão foi renovada por outra requisição entre tentativas, recarrega a aba antes de repetir', async () => {
    vi.useFakeTimers();
    const goto = vi.fn().mockResolvedValue(undefined);
    mockAcquire.mockResolvedValueOnce({ goto } as never);
    mockEnsure.mockImplementation(async () => {
      if (mockEnsure.mock.calls.length === 2) poolMock.geracao = 2; // outra requisição relogou
    });
    const op = vi.fn().mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET')).mockResolvedValueOnce('ok');

    const p = withBrowserContext(op, { warm: true });
    await vi.runAllTimersAsync();

    await expect(p).resolves.toBe('ok');
    expect(goto).toHaveBeenCalledWith('about:blank');
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('sem mudança de sessão, retentativa de erro transitório NÃO recarrega a aba', async () => {
    vi.useFakeTimers();
    const goto = vi.fn().mockResolvedValue(undefined);
    mockAcquire.mockResolvedValueOnce({ goto } as never);
    const op = vi.fn().mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET')).mockResolvedValueOnce('ok');

    const p = withBrowserContext(op, { warm: true });
    await vi.runAllTimersAsync();

    await expect(p).resolves.toBe('ok');
    expect(goto).not.toHaveBeenCalled();
  });

  it('sessão morta detectada na ÚLTIMA tentativa ainda invalida (próxima requisição reloga)', async () => {
    vi.useFakeTimers();
    const goto = vi.fn().mockResolvedValue(undefined);
    mockAcquire.mockResolvedValueOnce({ goto } as never);
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
      .mockRejectedValueOnce(new Error('Execution context was destroyed'))
      .mockRejectedValueOnce(new Error('SESSION_EXPIRED: não foi possível obter userId da sessão'));

    const p = withBrowserContext(op, { warm: true });
    const verificacao = expect(p).rejects.toThrow(/^SESSION_EXPIRED/);
    await vi.runAllTimersAsync();
    await verificacao;

    expect(op).toHaveBeenCalledTimes(3);
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
    expect(mockInvalidate).toHaveBeenCalledWith(1);
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
