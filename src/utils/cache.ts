/**
 * Cache TTL genérico em memória. Processo único, sem Redis.
 * Adequado para dados estáveis (usuários, tags) em escala de instância única.
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();

  constructor(private readonly defaultTtlMs: number) {}

  /** Retorna o valor se presente e não expirado; undefined caso contrário. */
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.data;
  }

  /** Armazena o valor com TTL opcional (usa defaultTtlMs se omitido). */
  set(key: string, data: T, ttlMs?: number): void {
    this.store.set(key, { data, expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs) });
  }

  /** Remove uma chave específica do cache. */
  invalidate(key: string): void {
    this.store.delete(key);
  }

  /** Remove todas as entradas do cache. */
  clear(): void {
    this.store.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// InflightTtlCache — TTL + deduplicação de chamadas concorrentes (inflight)
//
// Quando uma chave está em estado `inflight`, callers concorrentes para a
// mesma chave compartilham a Promise — o `loader` roda uma só vez e todos
// recebem o mesmo resultado. Após resolver, a entrada vira `resolved` por
// `ttlMs`. Rejeições NÃO são cacheadas (a próxima chamada faz fresh).
//
// Útil para janelas curtas de varredura onde múltiplos consumers/retries
// chegam quase simultaneamente pedindo a mesma coisa (ex: aniversariantes
// do mês X durante um cron noturno).
// ─────────────────────────────────────────────────────────────────────────────

type InflightEntry<T> =
  | { kind: 'inflight'; promise: Promise<T> }
  | { kind: 'resolved'; value: T; expiresAt: number };

export interface InflightCacheStats {
  hits: number;
  misses: number;
  inflightShared: number;
  entries: number;
  hitRatio: number;
}

export class InflightTtlCache<T> {
  private readonly store = new Map<string, InflightEntry<T>>();
  private hits = 0;
  private misses = 0;
  private inflightShared = 0;

  constructor(private readonly ttlMs: number) {}

  /**
   * Retorna o valor cacheado para `key`, ou executa `loader()` para produzi-lo.
   * Chamadas concorrentes para a mesma key durante o inflight compartilham a Promise.
   */
  async get(key: string, loader: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const existing = this.store.get(key);

    if (existing) {
      if (existing.kind === 'resolved' && existing.expiresAt > now) {
        this.hits++;
        return existing.value;
      }
      if (existing.kind === 'inflight') {
        this.inflightShared++;
        return existing.promise;
      }
      // resolved expirado — descarta e cai pro fresh load abaixo
      this.store.delete(key);
    }

    this.misses++;

    const promise = (async () => {
      try {
        const value = await loader();
        this.store.set(key, { kind: 'resolved', value, expiresAt: Date.now() + this.ttlMs });
        return value;
      } catch (err) {
        this.store.delete(key);
        throw err;
      }
    })();

    this.store.set(key, { kind: 'inflight', promise });
    return promise;
  }

  /** Limpa estado e métricas (útil em testes). */
  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
    this.inflightShared = 0;
  }

  get stats(): InflightCacheStats {
    const now = Date.now();
    let entries = 0;
    for (const entry of this.store.values()) {
      if (entry.kind === 'resolved' && entry.expiresAt > now) entries++;
    }
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      inflightShared: this.inflightShared,
      entries,
      hitRatio: total === 0 ? 0 : Number((this.hits / total).toFixed(3)),
    };
  }
}
