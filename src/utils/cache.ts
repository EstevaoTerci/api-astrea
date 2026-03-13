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
