// ─────────────────────────────────────────────────────────────────────────────
// LoginCircuitBreaker — corta a tempestade de logins (lógica PURA)
//
// Causa-raiz confirmada nos logs: um login que estoura derruba N requisições e
// dispara re-logins em rajada contra a conta — o padrão que a Astrea trata como
// uso indevido. O breaker conta falhas CONSECUTIVAS de login; ao atingir o
// threshold, abre o circuito por `cooldownMs`, rejeitando novos logins sem
// bater na Astrea. Após o cooldown, permite 1 tentativa (HALF_OPEN); sucesso
// fecha, falha re-abre.
//
// Clock injetado via parâmetro `now` (ms) — sem Date.now interno, para ser
// determinístico em teste (espelha o estilo de request-queue).
// ─────────────────────────────────────────────────────────────────────────────

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface BreakerSnapshot {
  state: BreakerState;
  consecutiveFailures: number;
  openUntil: number | null;
}

export interface LoginCircuitBreakerOptions {
  /** Nº de falhas consecutivas que abre o circuito (default 3). */
  failureThreshold?: number;
  /** Tempo (ms) que o circuito fica aberto antes de permitir 1 tentativa (default 60s). */
  cooldownMs?: number;
}

export class LoginCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private consecutiveFailures = 0;
  private openUntil: number | null = null;

  constructor(opts: LoginCircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
  }

  /** Pode tentar logar agora? CLOSED → sim; OPEN no cooldown → não; HALF_OPEN → sim (1 sonda). */
  canAttempt(now: number): boolean {
    if (this.openUntil === null) return true;
    return now >= this.openUntil;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openUntil = null;
  }

  recordFailure(now: number): void {
    this.consecutiveFailures += 1;
    // Re-abre se estávamos em half-open (openUntil já passou) OU se atingiu o threshold.
    const wasHalfOpen = this.openUntil !== null && now >= this.openUntil;
    if (wasHalfOpen || this.consecutiveFailures >= this.failureThreshold) {
      this.openUntil = now + this.cooldownMs;
    }
  }

  getState(now: number): BreakerSnapshot {
    let state: BreakerState;
    if (this.openUntil === null) state = 'CLOSED';
    else if (now >= this.openUntil) state = 'HALF_OPEN';
    else state = 'OPEN';
    return { state, consecutiveFailures: this.consecutiveFailures, openUntil: this.openUntil };
  }
}
