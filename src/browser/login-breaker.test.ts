import { describe, expect, it } from 'vitest';
import { LoginCircuitBreaker } from './login-breaker.js';

// Clock injetado via parâmetro `now` (ms) — sem Date.now interno, determinístico.
const T0 = 1_000_000;

describe('LoginCircuitBreaker', () => {
  it('começa CLOSED e permite tentativas', () => {
    const b = new LoginCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
    expect(b.canAttempt(T0)).toBe(true);
    expect(b.getState(T0).state).toBe('CLOSED');
  });

  it('1-2 falhas consecutivas NÃO abrem o circuito', () => {
    const b = new LoginCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
    b.recordFailure(T0);
    b.recordFailure(T0 + 1_000);
    expect(b.canAttempt(T0 + 2_000)).toBe(true);
    expect(b.getState(T0 + 2_000).state).toBe('CLOSED');
    expect(b.getState(T0 + 2_000).consecutiveFailures).toBe(2);
  });

  it('abre (OPEN) ao atingir o threshold e bloqueia tentativas durante o cooldown', () => {
    const b = new LoginCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
    b.recordFailure(T0);
    b.recordFailure(T0);
    b.recordFailure(T0); // 3ª falha → abre
    expect(b.getState(T0).state).toBe('OPEN');
    expect(b.canAttempt(T0 + 30_000)).toBe(false); // ainda dentro do cooldown
    expect(b.canAttempt(T0 + 59_999)).toBe(false);
  });

  it('passa para HALF_OPEN após o cooldown e permite 1 tentativa', () => {
    const b = new LoginCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
    b.recordFailure(T0);
    b.recordFailure(T0);
    b.recordFailure(T0);
    expect(b.canAttempt(T0 + 60_000)).toBe(true);
    expect(b.getState(T0 + 60_000).state).toBe('HALF_OPEN');
  });

  it('sucesso fecha o circuito e zera as falhas', () => {
    const b = new LoginCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
    b.recordFailure(T0);
    b.recordFailure(T0);
    b.recordFailure(T0);
    b.recordSuccess();
    expect(b.getState(T0).state).toBe('CLOSED');
    expect(b.getState(T0).consecutiveFailures).toBe(0);
    expect(b.canAttempt(T0)).toBe(true);
  });

  it('falha em HALF_OPEN re-abre o circuito estendendo o cooldown', () => {
    const b = new LoginCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
    b.recordFailure(T0);
    b.recordFailure(T0);
    b.recordFailure(T0); // abre até T0+60000
    const halfOpenAt = T0 + 60_000;
    expect(b.canAttempt(halfOpenAt)).toBe(true); // half-open
    b.recordFailure(halfOpenAt); // falhou de novo → re-abre
    expect(b.getState(halfOpenAt).state).toBe('OPEN');
    expect(b.canAttempt(halfOpenAt + 30_000)).toBe(false);
    expect(b.canAttempt(halfOpenAt + 60_000)).toBe(true);
  });

  it('usa defaults sensatos quando opções são omitidas', () => {
    const b = new LoginCircuitBreaker();
    b.recordFailure(T0);
    b.recordFailure(T0);
    expect(b.getState(T0).state).toBe('CLOSED'); // threshold default > 2
    b.recordFailure(T0);
    expect(b.getState(T0).state).toBe('OPEN'); // default threshold = 3
  });
});
