import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TtlCache, InflightTtlCache } from './cache.js';

describe('TtlCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retorna undefined para chave inexistente', () => {
    const cache = new TtlCache<string>(1000);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('retorna o valor armazenado dentro do TTL', () => {
    const cache = new TtlCache<number>(1000);
    cache.set('k', 42);
    expect(cache.get('k')).toBe(42);
  });

  it('expira o valor após o TTL', () => {
    const cache = new TtlCache<string>(1000);
    cache.set('k', 'value');
    vi.advanceTimersByTime(1001);
    expect(cache.get('k')).toBeUndefined();
  });

  it('considera valor ainda válido em t = TTL exato (>)', () => {
    const cache = new TtlCache<string>(1000);
    cache.set('k', 'value');
    vi.advanceTimersByTime(1000);
    // expiresAt = now+1000; get checa `Date.now() > expiresAt`. Em t=1000, ainda válido.
    expect(cache.get('k')).toBe('value');
  });

  it('respeita TTL custom no set()', () => {
    const cache = new TtlCache<string>(1000);
    cache.set('curto', 'a', 100);
    cache.set('longo', 'b', 5000);

    vi.advanceTimersByTime(200);
    expect(cache.get('curto')).toBeUndefined();
    expect(cache.get('longo')).toBe('b');
  });

  it('invalidate remove uma chave específica', () => {
    const cache = new TtlCache<string>(1000);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.invalidate('a');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('2');
  });

  it('clear remove tudo', () => {
    const cache = new TtlCache<string>(1000);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });
});

describe('InflightTtlCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('executa o loader em miss e cacheia o resultado', async () => {
    const cache = new InflightTtlCache<string>(1000);
    const loader = vi.fn().mockResolvedValue('valor');

    const r1 = await cache.get('k', loader);
    const r2 = await cache.get('k', loader);

    expect(r1).toBe('valor');
    expect(r2).toBe('valor');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('contabiliza hits e misses corretamente', async () => {
    const cache = new InflightTtlCache<string>(1000);

    await cache.get('k', async () => 'v'); // miss
    await cache.get('k', async () => 'v'); // hit
    await cache.get('k', async () => 'v'); // hit

    expect(cache.stats.misses).toBe(1);
    expect(cache.stats.hits).toBe(2);
    expect(cache.stats.hitRatio).toBeCloseTo(0.667, 2);
  });

  it('compartilha a Promise entre chamadas concorrentes (inflight dedup)', async () => {
    const cache = new InflightTtlCache<string>(1000);
    let resolveLoader: (v: string) => void;
    const loader = vi.fn().mockReturnValue(
      new Promise<string>((res) => {
        resolveLoader = res;
      }),
    );

    // Dispara 3 chamadas concorrentes — só 1 loader deve rodar
    const p1 = cache.get('k', loader);
    const p2 = cache.get('k', loader);
    const p3 = cache.get('k', loader);

    expect(loader).toHaveBeenCalledTimes(1);

    resolveLoader!('shared');
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe('shared');
    expect(r2).toBe('shared');
    expect(r3).toBe('shared');

    expect(cache.stats.inflightShared).toBe(2);
    expect(cache.stats.misses).toBe(1);
  });

  it('não cacheia rejeições — próxima chamada re-executa o loader', async () => {
    const cache = new InflightTtlCache<string>(1000);
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok');

    await expect(cache.get('k', loader)).rejects.toThrow('boom');
    const r2 = await cache.get('k', loader);

    expect(r2).toBe('ok');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('expira o valor após o TTL e re-executa o loader', async () => {
    const cache = new InflightTtlCache<number>(1000);
    let counter = 0;
    const loader = vi.fn(async () => ++counter);

    expect(await cache.get('k', loader)).toBe(1);
    vi.advanceTimersByTime(500);
    expect(await cache.get('k', loader)).toBe(1); // hit
    vi.advanceTimersByTime(600); // total 1100ms > 1000
    expect(await cache.get('k', loader)).toBe(2); // re-executa
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('chaves diferentes não colidem', async () => {
    const cache = new InflightTtlCache<string>(1000);
    await cache.get('a', async () => 'va');
    await cache.get('b', async () => 'vb');
    expect(await cache.get('a', async () => 'NEW')).toBe('va');
    expect(await cache.get('b', async () => 'NEW')).toBe('vb');
  });

  it('clear zera entradas e métricas', async () => {
    const cache = new InflightTtlCache<string>(1000);
    await cache.get('k', async () => 'v');
    await cache.get('k', async () => 'v');
    expect(cache.stats.entries).toBe(1);
    expect(cache.stats.hits).toBe(1);

    cache.clear();
    expect(cache.stats.entries).toBe(0);
    expect(cache.stats.hits).toBe(0);
    expect(cache.stats.misses).toBe(0);
    expect(cache.stats.inflightShared).toBe(0);
  });

  it('stats.hitRatio é 0 quando não houve chamadas', () => {
    const cache = new InflightTtlCache<string>(1000);
    expect(cache.stats.hitRatio).toBe(0);
  });

  it('stats.entries conta apenas entradas resolved não expiradas', async () => {
    const cache = new InflightTtlCache<string>(1000);
    await cache.get('a', async () => 'va');
    await cache.get('b', async () => 'vb');
    expect(cache.stats.entries).toBe(2);

    vi.advanceTimersByTime(1500);
    expect(cache.stats.entries).toBe(0);
  });
});
