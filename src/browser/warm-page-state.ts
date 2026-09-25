/**
 * Estado PURO da "aba quente" do pool (sem Playwright — testável).
 *
 * Motivo: `acquirePage()` abre uma aba nova e `releasePage()` a fecha, então toda
 * chamada paga o boot da SPA do Astrea (`page.goto` + networkidle, 10–30 s).
 * Para os consumidores sensíveis a latência (agenda da atendente virtual), o
 * pool mantém UMA aba estacionada já na rota Angular: a próxima chamada `warm`
 * a reutiliza e o `navigateTo` pula a navegação (rota igual + angular vivo),
 * reduzindo a chamada a um único `$http.post` (~1–3 s).
 *
 * Regras:
 *  - no máximo uma aba quente; se estiver ocupada, o chamador usa aba comum
 *    (não espera — evita serializar requisições);
 *  - release da aba quente = estacionar (não fechar);
 *  - aba estacionada que foi fechada por fora é descartada no próximo take;
 *  - invalidar sessão: aba estacionada volta para ser fechada; aba em uso é
 *    marcada para descarte no release (fechá-la no meio da operação quebraria
 *    o retry do withBrowserContext, que reusa a mesma aba).
 */
/** Rota Angular onde a aba quente fica estacionada (= ANGULAR_PAGE_PATH). */
export const ROTA_ESTACIONAMENTO = 'main/contacts';

/**
 * A aba está exatamente na rota de estacionamento? Aba em outra rota (ex.: o
 * formulário de novo contato) não é estacionada: a próxima chamada pagaria o
 * boot da SPA de qualquer jeito, e a aba ficaria viva à toa.
 */
export function naRotaPadrao(url: string): boolean {
  const i = url.indexOf('#/');
  if (i === -1) return false;
  return url.slice(i + 2).split('?')[0] === ROTA_ESTACIONAMENTO;
}

export class WarmPageSlot<P> {
  private page: P | null = null;
  private inUse = false;
  private dropOnRelease = false;
  private hits = 0;
  private misses = 0;
  private discards = 0;

  /** Tenta pegar a aba quente estacionada. `null` = use uma aba comum. */
  take(isUsable: (p: P) => boolean): P | null {
    if (this.page && !this.inUse) {
      if (isUsable(this.page)) {
        this.inUse = true;
        this.hits++;
        return this.page;
      }
      this.page = null;
      this.discards++;
    }
    this.misses++;
    return null;
  }

  /** Oferece uma aba recém-criada para virar a quente. `true` = adotada (e em uso). */
  adopt(p: P): boolean {
    if (this.page !== null) return false;
    this.page = p;
    this.inUse = true;
    this.dropOnRelease = false;
    return true;
  }

  /**
   * `true` = era a aba quente e foi estacionada (NÃO feche); `false` = feche normalmente.
   * `reutilizavel=false` (operação falhou ou aba fora da rota padrão) descarta a aba quente.
   */
  release(p: P, reutilizavel = true): boolean {
    if (this.page === null || p !== this.page) return false;
    if (this.dropOnRelease || !reutilizavel) {
      this.page = null;
      this.inUse = false;
      this.dropOnRelease = false;
      this.discards++;
      return false;
    }
    this.inUse = false;
    return true;
  }

  /**
   * Sessão invalidada. Devolve a aba estacionada para o chamador fechar, ou
   * `null` se não há aba ou se ela está em uso (nesse caso é descartada no release).
   */
  invalidate(): P | null {
    if (!this.page) return null;
    if (this.inUse) {
      this.dropOnRelease = true;
      return null;
    }
    const p = this.page;
    this.page = null;
    this.discards++;
    return p;
  }

  /** Browser/context encerrado — as abas morreram junto. */
  reset(): void {
    this.page = null;
    this.inUse = false;
    this.dropOnRelease = false;
  }

  get stats() {
    return {
      parked: this.page !== null && !this.inUse,
      inUse: this.page !== null && this.inUse,
      hits: this.hits,
      misses: this.misses,
      discards: this.discards,
    };
  }
}
