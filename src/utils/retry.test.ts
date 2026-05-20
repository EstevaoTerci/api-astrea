import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withRetry, isRetryablePlaywrightError } from './retry.js';

describe('withRetry', () => {
  beforeEach(() => {
    // Mata o jitter (random*2-1 = 0) — delays viram determinísticos
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retorna o resultado se a primeira tentativa der sucesso', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retenta até atingir sucesso (default = 3 tentativas)', async () => {
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error('falha 1'))
      .mockRejectedValueOnce(new Error('falha 2'))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, { baseDelayMs: 10 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('lança o último erro após esgotar maxAttempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('persistente'));

    const promise = withRetry(fn, { maxAttempts: 2, baseDelayMs: 1 });
    // Anexa o handler ANTES de avançar timers — evita unhandled rejection
    const assertion = expect(promise).rejects.toThrow('persistente');
    await vi.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('não retenta quando retryIf retorna false', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('não-retryable'));
    const retryIf = vi.fn().mockReturnValue(false);

    await expect(
      withRetry(fn, { maxAttempts: 5, retryIf, baseDelayMs: 1 }),
    ).rejects.toThrow('não-retryable');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(retryIf).toHaveBeenCalledTimes(1);
  });

  it('chama onRetry com (error, attempt) entre tentativas', async () => {
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error('e1'))
      .mockResolvedValueOnce('ok');
    const onRetry = vi.fn();

    const promise = withRetry(fn, { onRetry, baseDelayMs: 1 });
    await vi.runAllTimersAsync();
    await promise;

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1);
  });

  it('backoff exponential dobra o delay agendado a cada tentativa', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 100,
      backoff: 'exponential',
    });
    await vi.runAllTimersAsync();
    await promise;

    // Filtra os setTimeout invocados pelo `sleep()` interno (delay > 0)
    const sleepCalls = setTimeoutSpy.mock.calls
      .map((c) => c[1] as number)
      .filter((delay) => delay !== undefined && delay >= 50);

    expect(sleepCalls).toEqual([100, 200]);
  });

  it('backoff linear escala linearmente o delay agendado', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 50,
      backoff: 'linear',
    });
    await vi.runAllTimersAsync();
    await promise;

    const sleepCalls = setTimeoutSpy.mock.calls
      .map((c) => c[1] as number)
      .filter((delay) => delay !== undefined && delay >= 25);

    expect(sleepCalls).toEqual([50, 100]);
  });

  it('backoff fixed mantém o mesmo delay entre tentativas', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 75,
      backoff: 'fixed',
    });
    await vi.runAllTimersAsync();
    await promise;

    const sleepCalls = setTimeoutSpy.mock.calls
      .map((c) => c[1] as number)
      .filter((delay) => delay !== undefined && delay >= 50);

    expect(sleepCalls).toEqual([75, 75]);
  });

  it('respeita o teto maxDelayMs', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error('e1'))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, {
      maxAttempts: 2,
      baseDelayMs: 1000,
      maxDelayMs: 200,
      backoff: 'exponential',
    });
    await vi.runAllTimersAsync();
    await promise;

    const sleepCalls = setTimeoutSpy.mock.calls
      .map((c) => c[1] as number)
      .filter((delay) => delay !== undefined && delay >= 50);

    expect(sleepCalls[0]).toBeLessThanOrEqual(200);
  });
});

describe('isRetryablePlaywrightError', () => {
  it('retorna false para não-Error', () => {
    expect(isRetryablePlaywrightError(null)).toBe(false);
    expect(isRetryablePlaywrightError('string')).toBe(false);
    expect(isRetryablePlaywrightError({ message: 'timeout' })).toBe(false);
  });

  it('reconhece timeout (case-insensitive)', () => {
    expect(isRetryablePlaywrightError(new Error('Operation Timeout'))).toBe(true);
    expect(isRetryablePlaywrightError(new Error('connection timeout'))).toBe(true);
  });

  it('reconhece net::ERR_*', () => {
    expect(
      isRetryablePlaywrightError(new Error('net::ERR_CONNECTION_RESET at https://example.com')),
    ).toBe(true);
  });

  it('reconhece "Navigation failed"', () => {
    expect(isRetryablePlaywrightError(new Error('Navigation failed: 504'))).toBe(true);
  });

  it('reconhece contexto/sessão fechados', () => {
    expect(isRetryablePlaywrightError(new Error('context was destroyed'))).toBe(true);
    expect(isRetryablePlaywrightError(new Error('Target closed'))).toBe(true);
    expect(isRetryablePlaywrightError(new Error('Session closed by client'))).toBe(true);
    expect(isRetryablePlaywrightError(new Error('browser has been closed'))).toBe(true);
  });

  it('retorna false para erro de negócio', () => {
    expect(isRetryablePlaywrightError(new Error('VALIDATION_ERROR: campo obrigatório'))).toBe(false);
    expect(isRetryablePlaywrightError(new Error('NOT_FOUND'))).toBe(false);
  });
});
