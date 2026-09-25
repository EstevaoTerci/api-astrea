/**
 * Orçamento de logins BEM-SUCEDIDOS pela tela (UI-login) do pool, valendo para qualquer
 * gatilho (401 de sessão, SESSION_EXPIRED por falta de userId, cold start sem sessão salva).
 *
 * Por que existe (incidente de 25/09/2026): o Astrea mantém UMA sessão por usuário. Se
 * outro processo loga com a mesma conta, ou se a chave do localStorage que dá o userId
 * mudar, cada relogin nosso é inútil ou derruba o outro lado — e o circuit breaker de
 * login não ajuda, porque só conta FALHAS (login que dá certo zera o breaker). Sem teto,
 * isso vira tempestade de logins, que o Astrea trata como uso indevido.
 *
 * Só logins que DERAM CERTO contam: falhas continuam com o breaker (contar as duas coisas
 * transformava uma instabilidade curta da tela de login em bloqueio longo).
 *
 * Regra: no máximo `maxPorJanela` logins bem-sucedidos em `janelaMs`. Cheio → bloqueia novos
 * logins por `bloqueioInicialMs`, dobrando a cada novo estouro até `bloqueioMaxMs`. Depois de
 * `calmariaMs` sem estouro, a escalada volta ao início. Puro e determinístico (testável).
 */
export interface ReloginBudgetOptions {
  maxPorJanela: number;
  janelaMs: number;
  bloqueioInicialMs: number;
  bloqueioMaxMs: number;
  calmariaMs: number;
}

export type ReloginDecision =
  | { ok: true; retryAfterMs?: undefined; novoBloqueio?: undefined }
  | { ok: false; retryAfterMs: number; /** true só no instante em que o bloqueio começa (para alertar 1x). */ novoBloqueio: boolean };

export interface ReloginBudgetSnapshot {
  recentes: number;
  maxPorJanela: number;
  janelaMs: number;
  bloqueadoAte: number | null;
  estouros: number;
}

export class ReloginBudget {
  private sucessos: number[] = [];
  private bloqueadoAte: number | null = null;
  private fimUltimoBloqueio: number | null = null;
  private estouros = 0;

  constructor(private readonly opts: ReloginBudgetOptions) {}

  /** Pode tentar um login agora? Se o orçamento está cheio, inicia (ou informa) o bloqueio. */
  verificar(now: number): ReloginDecision {
    if (this.bloqueadoAte !== null) {
      if (now < this.bloqueadoAte) return { ok: false, retryAfterMs: this.bloqueadoAte - now, novoBloqueio: false };
      this.fimUltimoBloqueio = this.bloqueadoAte;
      this.bloqueadoAte = null;
    }
    if (this.fimUltimoBloqueio !== null && now - this.fimUltimoBloqueio >= this.opts.calmariaMs) {
      this.estouros = 0;
      this.fimUltimoBloqueio = null;
    }
    this.sucessos = this.sucessos.filter((t) => now - t < this.opts.janelaMs);
    if (this.sucessos.length >= this.opts.maxPorJanela) {
      const duracao = Math.min(this.opts.bloqueioInicialMs * 2 ** this.estouros, this.opts.bloqueioMaxMs);
      this.estouros += 1;
      this.bloqueadoAte = now + duracao;
      this.sucessos = [];
      return { ok: false, retryAfterMs: duracao, novoBloqueio: true };
    }
    return { ok: true };
  }

  /** Registra um login que deu certo (chamar só depois do sucesso). */
  registrarSucesso(now: number): void {
    this.sucessos.push(now);
  }

  /** Bloqueio ativo agora? (para falhar rápido com o código certo). */
  bloqueioAtivo(now: number): number | null {
    return this.bloqueadoAte !== null && now < this.bloqueadoAte ? this.bloqueadoAte : null;
  }

  snapshot(now: number): ReloginBudgetSnapshot {
    return {
      recentes: this.sucessos.filter((t) => now - t < this.opts.janelaMs).length,
      maxPorJanela: this.opts.maxPorJanela,
      janelaMs: this.opts.janelaMs,
      bloqueadoAte: this.bloqueioAtivo(now),
      estouros: this.estouros,
    };
  }
}
