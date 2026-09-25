import { describe, expect, it } from 'vitest';
import { ReloginBudget } from './relogin-budget.js';

const MIN = 60_000;
const opts = { maxPorJanela: 3, janelaMs: 10 * MIN, bloqueioInicialMs: 10 * MIN, bloqueioMaxMs: 30 * MIN, calmariaMs: 60 * MIN };

/** Tenta logar e, se liberado, registra como login bem-sucedido. */
function loginOk(b: ReloginBudget, t: number) {
  const d = b.verificar(t);
  if (d.ok) b.registrarSucesso(t);
  return d;
}

describe('ReloginBudget — teto de logins BEM-SUCEDIDOS para qualquer gatilho', () => {
  it('libera 3 logins ok em 10 min; o 4º é bloqueado por 10 min (alerta só no início)', () => {
    const b = new ReloginBudget(opts);
    const t0 = 1_000_000;
    expect(loginOk(b, t0).ok).toBe(true);
    expect(loginOk(b, t0 + MIN).ok).toBe(true);
    expect(loginOk(b, t0 + 2 * MIN).ok).toBe(true);
    expect(b.verificar(t0 + 3 * MIN)).toEqual({ ok: false, retryAfterMs: 10 * MIN, novoBloqueio: true });
    expect(b.verificar(t0 + 8 * MIN)).toEqual({ ok: false, retryAfterMs: 5 * MIN, novoBloqueio: false });
    expect(b.bloqueioAtivo(t0 + 8 * MIN)).toBe(t0 + 13 * MIN);
  });

  it('logins que FALHAM não gastam o orçamento (ficam com o breaker)', () => {
    const b = new ReloginBudget(opts);
    const t0 = 2_000_000;
    for (let i = 0; i < 10; i++) expect(b.verificar(t0 + i * 1000).ok).toBe(true);
    expect(b.snapshot(t0 + 10_000).recentes).toBe(0);
  });

  it('janela deslizante: logins antigos saem da conta', () => {
    const b = new ReloginBudget(opts);
    const t0 = 5_000_000;
    loginOk(b, t0);
    loginOk(b, t0 + MIN);
    loginOk(b, t0 + 2 * MIN);
    expect(loginOk(b, t0 + 10 * MIN + 1).ok).toBe(true);
  });

  it('estouros repetidos dobram o bloqueio até o teto (10 → 20 → 30 → 30)', () => {
    const b = new ReloginBudget(opts);
    let t = 10_000_000;
    const estourar = () => {
      for (let i = 0; i < 3; i++) expect(loginOk(b, t + i).ok).toBe(true);
      const r = b.verificar(t + 3);
      expect(r.ok).toBe(false);
      return r.retryAfterMs;
    };
    expect(estourar()).toBe(10 * MIN);
    t += 10 * MIN + 10 * MIN;
    expect(estourar()).toBe(20 * MIN);
    t += 20 * MIN + 10 * MIN;
    expect(estourar()).toBe(30 * MIN);
    t += 30 * MIN + 10 * MIN;
    expect(estourar()).toBe(30 * MIN);
  });

  it('1 h de calmaria depois de um bloqueio zera a escalada', () => {
    const b = new ReloginBudget(opts);
    let t = 20_000_000;
    for (let i = 0; i < 3; i++) loginOk(b, t + i);
    expect(b.verificar(t + 3).retryAfterMs).toBe(10 * MIN);
    t += 10 * MIN + 60 * MIN + 10;
    for (let i = 0; i < 3; i++) expect(loginOk(b, t + i).ok).toBe(true);
    expect(b.verificar(t + 3).retryAfterMs).toBe(10 * MIN);
  });

  it('snapshot para o /health', () => {
    const b = new ReloginBudget(opts);
    const t0 = 30_000_000;
    loginOk(b, t0);
    loginOk(b, t0 + 1);
    expect(b.snapshot(t0 + 2)).toEqual({ recentes: 2, maxPorJanela: 3, janelaMs: 10 * MIN, bloqueadoAte: null, estouros: 0 });
  });
});
