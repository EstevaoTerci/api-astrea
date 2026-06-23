import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { RequestQueue } from './request-queue.js';
import { LoginCircuitBreaker } from './login-breaker.js';
import {
  classifyPostLoginState,
  formatLoginDiagnostic,
  type LoginSnapshot,
} from './login-state.js';
import {
  isStateUsable,
  readSessionState,
  redactSession,
  sessionAgeMs,
  writeSessionStateAtomic,
  type PersistedSession,
  type SessionStorageState,
} from './session-state.js';

/** Seletores de banner de erro de credencial na tela de login do Astrea. */
const LOGIN_ALERT_SELECTOR = '.alert-danger, .alert-error, [class*="alerta"], div.toast-error';

/**
 * Pool de páginas Playwright com sessão compartilhada.
 *
 * Usa um único BrowserContext (= 1 janela) para que todas as páginas (abas)
 * compartilhem cookies e localStorage. Isso evita que o Astrea invalide
 * sessões por detectar múltiplos logins simultâneos do mesmo usuário.
 *
 * A concorrência é controlada pela RequestQueue (FIFO), limitando o número
 * máximo de abas abertas simultaneamente (BROWSER_POOL_SIZE).
 */
class BrowserPool {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private authenticated = false;
  private authPromise: Promise<void> | null = null;
  private readonly maxPages: number;
  private initPromise: Promise<void> | null = null;
  private readonly requestQueue: RequestQueue;
  private activePagesCount = 0;
  private idleShutdownTimer: NodeJS.Timeout | null = null;
  private readonly idleTtlMs: number;
  private readonly loginBreaker: LoginCircuitBreaker;
  /** Quando true, o próximo _doLogin limpa cookies (sessão comprovadamente inválida). */
  private forceClearNextLogin = false;
  /** O context atual veio de um storageState restaurado? (para /health) */
  private sessionRestored = false;
  // Contadores para observabilidade no /health (logs do Coolify são decimados).
  private coldStarts = 0;
  private logins = 0;
  private loginFailures = 0;
  private lastLoginFailure: { message: string; at: number } | null = null;

  constructor(maxPages: number) {
    this.maxPages = maxPages;
    this.idleTtlMs = env.BROWSER_IDLE_TTL_MS;
    this.loginBreaker = new LoginCircuitBreaker({
      failureThreshold: env.LOGIN_BREAKER_THRESHOLD,
      cooldownMs: env.LOGIN_BREAKER_COOLDOWN_MS,
    });
    this.requestQueue = new RequestQueue({
      maxConcurrent: maxPages,
      maxQueueSize: env.QUEUE_MAX_SIZE,
      queueTimeoutMs: env.QUEUE_TIMEOUT_MS,
    });
  }

  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._initialize().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    this.clearIdleShutdownTimer();

    if (this.browser && this.context) {
      return;
    }

    this.coldStarts += 1;
    logger.info({ maxPages: this.maxPages }, 'Iniciando browser Chromium (single-context)...');

    this.browser = await chromium.launch({
      headless: env.BROWSER_HEADLESS,
      executablePath: env.BROWSER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    });

    // Restauro OTIMISTA da sessão persistida (P1): se há storageState recente e
    // válido, criamos o context já com cookies+localStorage e marcamos como
    // autenticado — pulando o UI-login. A 1ª operação valida de fato; se a sessão
    // tiver morrido server-side, o recovery de 401 (withBrowserContext) invalida e
    // força um re-login limpo. Isso elimina o cold-login de 12-30s do idle-shutdown.
    const restored = this._restorableSession();

    this.context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      ...(restored ? { storageState: restored.storageState } : {}),
    });

    if (restored) {
      this.authenticated = true;
      this.sessionRestored = true;
      logger.info(
        { session: redactSession(restored) },
        'Sessão restaurada do storageState (pulando UI-login).',
      );
    } else {
      this.sessionRestored = false;
    }

    logger.info(
      { maxPages: this.maxPages, sessionRestored: this.sessionRestored },
      'Pool de browser inicializado (single-context, multi-page).',
    );
  }

  /** Retorna a sessão persistida se reuso estiver ligado e ela for utilizável. */
  private _restorableSession(): PersistedSession | null {
    if (!env.SESSION_REUSE) return null;
    const saved = readSessionState();
    if (saved && isStateUsable(saved, Date.now(), env.SESSION_STATE_MAX_AGE_MS)) {
      return saved;
    }
    return null;
  }

  /**
   * Adquire uma nova página (aba) autenticada no contexto compartilhado.
   *
   * - Aguarda slot na fila FIFO (backpressure se cheia)
   * - Se a sessão não está ativa, faz login (com lock para evitar logins paralelos)
   * - Cria nova aba no contexto compartilhado
   */
  async acquirePage(): Promise<Page> {
    this.clearIdleShutdownTimer();
    await this.initialize();
    await this.requestQueue.enqueue();

    try {
      if (!this.authenticated) {
        await this._ensureAuthenticated();
      }

      const page = await this.context!.newPage();
      this.activePagesCount++;
      logger.debug({ activePages: this.activePagesCount }, 'Página adquirida do pool.');
      return page;
    } catch (err) {
      // Se falhou ao criar página, libera o slot
      this.requestQueue.dequeue();
      throw err;
    }
  }

  async ensureAuthenticated(): Promise<void> {
    await this.initialize();
    if (!this.authenticated) {
      await this._ensureAuthenticated();
    }
  }

  /**
   * Libera uma página (fecha a aba) e devolve o slot para a fila.
   */
  async releasePage(page: Page): Promise<void> {
    try {
      await page.close().catch(() => {});
    } catch {
      // ignorado — página pode já estar fechada
    }
    this.activePagesCount = Math.max(0, this.activePagesCount - 1);
    logger.debug({ activePages: this.activePagesCount }, 'Página liberada do pool.');
    this.requestQueue.dequeue();
    this.scheduleIdleShutdownIfNeeded();
  }

  /**
   * Invalida a sessão (força re-login na próxima acquirePage).
   * Marca `forceClearNextLogin` para que o próximo login limpe os cookies stale
   * (a sessão restaurada/anterior se mostrou inválida) antes de re-logar.
   */
  invalidateSession(): void {
    this.authenticated = false;
    this.authPromise = null;
    this.forceClearNextLogin = true;
    logger.debug('Sessão invalidada — próximo login será limpo (forceClear).');
  }

  /**
   * Limpa cookies e storage do contexto compartilhado.
   */
  async clearSession(): Promise<void> {
    if (!this.context) return;
    try {
      await this.context.clearCookies();
      await this.context.clearPermissions();
    } catch (err) {
      logger.warn({ err }, 'Erro ao limpar sessão do context.');
    }
    this.invalidateSession();
  }

  /**
   * Autentica no Astrea usando o contexto compartilhado.
   * Usa lock (authPromise) para evitar logins simultâneos quando
   * múltiplas requisições chegam ao mesmo tempo sem sessão ativa.
   */
  private async _ensureAuthenticated(): Promise<void> {
    if (this.authPromise) {
      return this.authPromise;
    }

    // Circuit breaker: depois de N falhas consecutivas de login, segura novos
    // logins por um cooldown em vez de martelar a conta (uso indevido na Astrea).
    const now = Date.now();
    if (!this.loginBreaker.canAttempt(now)) {
      const { openUntil, consecutiveFailures } = this.loginBreaker.getState(now);
      const retryAfterSec = openUntil ? Math.ceil(Math.max(0, openUntil - now) / 1000) : 0;
      logger.warn(
        { consecutiveFailures, retryAfterSec },
        'Login bloqueado pelo circuit breaker; não tentando logar.',
      );
      throw new Error(
        `LOGIN_CIRCUIT_OPEN: login bloqueado após ${consecutiveFailures} falhas consecutivas; ` +
          `retry em ~${retryAfterSec}s`,
      );
    }

    this.authPromise = this._doLogin();
    try {
      await this.authPromise;
      this.authenticated = true;
      this.authPromise = null;
      this.loginBreaker.recordSuccess();
      this.logins += 1;
      await this._persistSessionState();
    } catch (err) {
      this.authPromise = null;
      this.loginBreaker.recordFailure(Date.now());
      this.loginFailures += 1;
      this.lastLoginFailure = {
        message: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      };
      throw err;
    }
  }

  /** Persiste o storageState atual (best-effort) — chamado após login bem-sucedido. */
  private async _persistSessionState(): Promise<void> {
    if (!env.SESSION_REUSE || !this.context) return;
    try {
      const state = (await this.context.storageState()) as SessionStorageState;
      writeSessionStateAtomic(state, Date.now());
      logger.debug('storageState persistido após login.');
    } catch (err) {
      logger.warn({ err: String(err) }, 'Falha ao persistir storageState (best-effort).');
    }
  }

  private async _doLogin(): Promise<void> {
    if (!this.context) throw new Error('BROWSER_UNAVAILABLE: Context não inicializado');

    // clearCookies SÓ quando a sessão é comprovadamente inválida (forceClear, via
    // invalidateSession) ou com reuso desligado. Antes era incondicional, o que
    // descartava sessão válida e, no context compartilhado, podia derrubar abas
    // concorrentes em voo (401 espúrio). _doLogin só roda quando NÃO estamos
    // autenticados (cold-start sem restauro = cookies vazios; ou pós-invalidação =
    // forceClear), então pular a limpeza é seguro nos demais casos.
    const forceClear = this.forceClearNextLogin || !env.SESSION_REUSE;
    this.forceClearNextLogin = false;
    if (forceClear) {
      await this.context.clearCookies();
    }

    const page = await this.context.newPage();
    try {
      logger.info('Realizando login no Astrea (contexto compartilhado)...');

      await page.goto('https://astrea.net.br', {
        waitUntil: 'domcontentloaded',
        timeout: env.BROWSER_TIMEOUT_MS,
      });

      await page.waitForSelector('input[placeholder="Digite seu email"]', {
        state: 'visible',
        timeout: env.BROWSER_TIMEOUT_MS,
      });

      await page.fill('input[placeholder="Digite seu email"]', env.ASTREA_EMAIL);
      await page.fill('input[type="password"]', env.ASTREA_PASSWORD);
      await page.click('button:has-text("Entrar")');

      // Corre o sinal de SUCESSO (hash chega em #/main/) contra o de ERRO DE
      // CREDENCIAL (banner visível). Antes esperávamos só o sucesso por 30s, então
      // credencial errada/interstitial também queimava o timeout cheio sem pista.
      // Timeout de login DEDICADO (cobre a cauda do cold-start sem afrouxar operações).
      const loginTimeout = env.BROWSER_LOGIN_TIMEOUT_MS;
      const successLeg = page
        .waitForFunction(
          (fragment: string) => window.location.hash.includes(fragment),
          '#/main/',
          { timeout: loginTimeout },
        )
        .then(() => 'SUCCESS' as const);
      const credentialLeg = page
        .waitForSelector(LOGIN_ALERT_SELECTOR, { state: 'visible', timeout: loginTimeout })
        .then(() => 'CREDENTIAL' as const);
      // Evita unhandledRejection da perna perdedora (rejeita após a aba fechar).
      successLeg.catch(() => {});
      credentialLeg.catch(() => {});

      const outcome = await Promise.race([successLeg, credentialLeg]);
      if (outcome !== 'SUCCESS') {
        // Banner de erro apareceu — cai no diagnóstico unificado abaixo.
        throw new Error('LOGIN_ALERT_DETECTED');
      }

      await page.waitForTimeout(800);

      logger.info(
        { url: page.url() },
        'Login no Astrea realizado com sucesso (sessão compartilhada).',
      );
    } catch (originalErr) {
      // Diagnóstico unificado: captura o estado real da página (url/hash/título/
      // alerta/texto) ANTES de fechar a aba. Se descobrir que a sessão JÁ está
      // ativa (redirecionou para o app, sem form de login), trata como SUCESSO.
      // Senão, lança erro ESTRUTURADO em vez do Timeout cru (fim do diagnóstico cego).
      const { authenticated, error } = await this._diagnoseLogin(page, originalErr);
      if (authenticated) {
        logger.info({ url: page.url() }, 'Sessão já ativa — login confirmado pós-diagnóstico.');
        return;
      }
      throw error;
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Monta um snapshot best-effort da página de login (sem nunca mascarar o erro
   * original se a própria captura falhar) e o classifica. Retorna `authenticated`
   * quando o estado é AUTHENTICATED (sessão já ativa). Credencial inválida vira
   * `AUTH_FAILED` (semântica preservada, não-retryable); os demais viram
   * `LOGIN_FAILED_<STATE>` com contexto.
   */
  private async _diagnoseLogin(
    page: Page,
    originalErr: unknown,
  ): Promise<{ authenticated: boolean; error: Error }> {
    try {
      const snapshot = await this._buildLoginSnapshot(page);
      const classification = classifyPostLoginState(snapshot);
      if (classification.state === 'AUTHENTICATED') {
        return { authenticated: true, error: new Error('OK') };
      }
      logger.error(
        {
          state: classification.state,
          reason: classification.reason,
          url: snapshot.url,
          hash: snapshot.hash,
          title: snapshot.title,
        },
        'Falha de login no Astrea',
      );
      if (classification.state === 'CREDENTIAL_FAILED') {
        return { authenticated: false, error: new Error(`AUTH_FAILED: ${classification.reason}`) };
      }
      return { authenticated: false, error: new Error(formatLoginDiagnostic(snapshot, classification)) };
    } catch (diagErr) {
      logger.warn(
        { diagErr: String(diagErr), originalErr: String(originalErr) },
        'Falha ao diagnosticar o login; propagando erro original.',
      );
      return {
        authenticated: false,
        error: originalErr instanceof Error ? originalErr : new Error(String(originalErr)),
      };
    }
  }

  /** Captura defensiva do estado da página de login para classificação. */
  private async _buildLoginSnapshot(page: Page): Promise<LoginSnapshot> {
    const url = page.url();
    const [hash, title, hasPasswordField, alertText, bodyTextSnippet] = await Promise.all([
      page.evaluate(() => window.location.hash).catch(() => ''),
      page.title().catch(() => ''),
      page
        .$('input[type="password"]')
        .then((el) => !!el)
        .catch(() => false),
      page
        .$(LOGIN_ALERT_SELECTOR)
        .then((el) => (el ? el.textContent() : null))
        .catch(() => null),
      page.evaluate(() => (document.body?.innerText ?? '').slice(0, 300)).catch(() => ''),
    ]);
    return {
      url,
      hash,
      title,
      hasPasswordField,
      alertText: alertText?.trim() || null,
      bodyTextSnippet,
    };
  }

  async shutdown(): Promise<void> {
    this.clearIdleShutdownTimer();
    logger.info('Encerrando pool de browser...');

    if (this.context) {
      // Persiste a sessão mais fresca ANTES de fechar — assim o idle-shutdown não
      // descarta o token (que pode ter sido renovado durante o uso); o próximo
      // cold-start restaura em vez de re-logar.
      if (this.authenticated) {
        await this._persistSessionState();
      }
      await this.context.close().catch(() => {});
      this.context = null;
    }

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }

    this.authenticated = false;
    this.authPromise = null;
    this.initPromise = null;
    this.activePagesCount = 0;
    logger.info('Pool de browser encerrado.');
  }

  private clearIdleShutdownTimer(): void {
    if (this.idleShutdownTimer) {
      clearTimeout(this.idleShutdownTimer);
      this.idleShutdownTimer = null;
    }
  }

  private scheduleIdleShutdownIfNeeded(): void {
    if (this.idleTtlMs === 0) return;
    if (!this.browser || !this.context) return;

    const queueStats = this.requestQueue.stats;
    if (this.activePagesCount > 0 || queueStats.active > 0 || queueStats.queued > 0) {
      return;
    }

    this.clearIdleShutdownTimer();
    this.idleShutdownTimer = setTimeout(() => {
      this.idleShutdownTimer = null;

      const latestQueueStats = this.requestQueue.stats;
      if (this.activePagesCount > 0 || latestQueueStats.active > 0 || latestQueueStats.queued > 0) {
        return;
      }

      logger.info(
        { idleTtlMs: this.idleTtlMs },
        'Pool ocioso por TTL configurado. Encerrando browser e mantendo lazy init para a próxima chamada.',
      );
      void this.shutdown().catch((err) => {
        logger.warn({ err }, 'Falha ao encerrar pool ocioso.');
      });
    }, this.idleTtlMs);
  }

  get stats() {
    return {
      pool: {
        total: this.maxPages,
        inUse: this.activePagesCount,
        available: this.maxPages - this.activePagesCount,
        idleTtlMs: this.idleTtlMs,
        initialized: !!this.browser && !!this.context,
      },
      queue: this.requestQueue.stats,
    };
  }

  /**
   * Observabilidade do login para o /health (os logs do Coolify são decimados).
   * Expõe o estado do circuit breaker, da sessão persistida e contadores.
   */
  get loginStats() {
    const now = Date.now();
    const breaker = this.loginBreaker.getState(now);
    const persisted = env.SESSION_REUSE ? readSessionState() : null;
    return {
      breaker: {
        state: breaker.state,
        consecutiveFailures: breaker.consecutiveFailures,
        openUntil: breaker.openUntil,
      },
      session: {
        reuseEnabled: env.SESSION_REUSE,
        restoredFromStorage: this.sessionRestored,
        ageMs: sessionAgeMs(persisted, now),
      },
      counters: {
        coldStarts: this.coldStarts,
        logins: this.logins,
        loginFailures: this.loginFailures,
      },
      lastFailure: this.lastLoginFailure,
    };
  }
}

// Instância global do pool
export const browserPool = new BrowserPool(env.BROWSER_POOL_SIZE);
