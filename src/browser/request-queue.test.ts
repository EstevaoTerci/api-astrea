import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestQueue } from './request-queue.js';

const defaults = { maxConcurrent: 2, maxQueueSize: 3, queueTimeoutMs: 5_000 };

describe('RequestQueue — slots livres', () => {
  it('resolve imediatamente quando há slot livre', async () => {
    const q = new RequestQueue(defaults);
    await expect(q.enqueue()).resolves.toBeUndefined();
    expect(q.stats.active).toBe(1);
    expect(q.stats.queued).toBe(0);
    expect(q.stats.totalProcessed).toBe(1);
  });

  it('aceita até maxConcurrent imediatos', async () => {
    const q = new RequestQueue(defaults);
    await q.enqueue();
    await q.enqueue();
    expect(q.stats.active).toBe(2);
    expect(q.stats.queued).toBe(0);
  });
});

describe('RequestQueue — backpressure', () => {
  it('rejeita com QUEUE_FULL quando excede maxQueueSize', async () => {
    const q = new RequestQueue({ ...defaults, maxConcurrent: 1, maxQueueSize: 2 });
    await q.enqueue(); // 1 ativo
    // Não awaitamos — entram na fila
    const p1 = q.enqueue();
    const p2 = q.enqueue();

    await expect(q.enqueue()).rejects.toThrow(/QUEUE_FULL/);
    expect(q.stats.totalRejected).toBe(1);

    // Limpa: libera o ativo e dequeues subsequentes
    q.dequeue();
    q.dequeue();
    q.dequeue();
    await Promise.all([p1, p2]);
  });
});

describe('RequestQueue — FIFO', () => {
  it('libera próximo da fila ao dequeue (ordem FIFO)', async () => {
    const q = new RequestQueue({ ...defaults, maxConcurrent: 1 });
    await q.enqueue(); // ativo

    const order: number[] = [];
    const p1 = q.enqueue().then(() => order.push(1));
    const p2 = q.enqueue().then(() => order.push(2));
    const p3 = q.enqueue().then(() => order.push(3));

    q.dequeue(); // libera o p1
    await p1;
    expect(order).toEqual([1]);

    q.dequeue(); // libera p2
    await p2;
    expect(order).toEqual([1, 2]);

    q.dequeue(); // libera p3
    await p3;
    expect(order).toEqual([1, 2, 3]);

    q.dequeue(); // libera slot — fila vazia, active--
    expect(q.stats.active).toBe(0);
  });

  it('dequeue com fila vazia apenas decrementa active', async () => {
    const q = new RequestQueue(defaults);
    await q.enqueue();
    expect(q.stats.active).toBe(1);

    q.dequeue();
    expect(q.stats.active).toBe(0);
    expect(q.stats.queued).toBe(0);
  });
});

describe('RequestQueue — timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejeita com QUEUE_TIMEOUT quando passa muito tempo na fila', async () => {
    const q = new RequestQueue({ ...defaults, maxConcurrent: 1, queueTimeoutMs: 100 });
    await q.enqueue();

    const promise = q.enqueue();
    const assertion = expect(promise).rejects.toThrow(/QUEUE_TIMEOUT/);

    vi.advanceTimersByTime(150);
    await assertion;

    expect(q.stats.totalTimedOut).toBe(1);
    // Removido da fila após timeout
    expect(q.stats.queued).toBe(0);
  });

  it('dequeue cancela o timer e não conta como timeout', async () => {
    const q = new RequestQueue({ ...defaults, maxConcurrent: 1, queueTimeoutMs: 100 });
    await q.enqueue();

    const promise = q.enqueue();

    vi.advanceTimersByTime(50);
    q.dequeue(); // libera o que estava na fila
    await promise;

    expect(q.stats.totalTimedOut).toBe(0);
    expect(q.stats.totalProcessed).toBe(2);
  });
});

describe('RequestQueue — métricas', () => {
  it('expõe maxConcurrent e maxQueueSize via stats', () => {
    const q = new RequestQueue({ maxConcurrent: 3, maxQueueSize: 10, queueTimeoutMs: 5_000 });
    expect(q.stats.maxConcurrent).toBe(3);
    expect(q.stats.maxQueueSize).toBe(10);
  });

  it('conta totalProcessed corretamente entre slot imediato e fila', async () => {
    const q = new RequestQueue({ ...defaults, maxConcurrent: 1 });
    await q.enqueue(); // imediato → totalProcessed=1
    const p = q.enqueue(); // fila
    q.dequeue(); // transfere para p → totalProcessed=2
    await p;

    expect(q.stats.totalProcessed).toBe(2);
  });
});
