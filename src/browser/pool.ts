import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { RequestQueue } from './request-queue.js';

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

  constructor(maxPages: number) {
    this.maxPages = maxPages;
    this.idleTtlMs = env.BROWSER_IDLE_TTL_MS;
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

    this.context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
    });

    logger.info(
      { maxPages: this.maxPages },
      'Pool de browser inicializado (single-context, multi-page).',
    );
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
   */
  invalidateSession(): void {
    this.authenticated = false;
    this.authPromise = null;
    logger.debug('Sessão invalidada — próxima operação fará re-login.');
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

    this.authPromise = this._doLogin();
    try {
      await this.authPromise;
      this.authenticated = true;
      this.authPromise = null;
    } catch (err) {
      this.authPromise = null;
      throw err;
    }
  }

  private async _doLogin(): Promise<void> {
    if (!this.context) throw new Error('BROWSER_UNAVAILABLE: Context não inicializado');

    // Limpa cookies antes de (re)login para garantir que o Astrea
    // mostre a tela de login em vez de redirecionar para o app com sessão stale.
    await this.context.clearCookies();

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

      await page.waitForFunction(
        (fragment: string) => window.location.hash.includes(fragment),
        '#/main/',
        { timeout: env.BROWSER_TIMEOUT_MS },
      );

      await page.waitForTimeout(800);

      logger.info(
        { url: page.url() },
        'Login no Astrea realizado com sucesso (sessão compartilhada).',
      );
    } catch (originalErr) {
      try {
        const errorEl = await page.$(
          '.alert-danger, .alert-error, [class*="alerta"], div.toast-error',
        );
        if (errorEl) {
          const errorText = (await errorEl.textContent())?.trim();
          throw new Error(`AUTH_FAILED: ${errorText || 'Credenciais inválidas'}`);
        }
      } catch (innerErr) {
        if (innerErr instanceof Error && innerErr.message.startsWith('AUTH_FAILED')) {
          await page.close().catch(() => {});
          throw innerErr;
        }
      }
      await page.close().catch(() => {});
      throw originalErr;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async shutdown(): Promise<void> {
    this.clearIdleShutdownTimer();
    logger.info('Encerrando pool de browser...');

    if (this.context) {
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
}

// Instância global do pool
export const browserPool = new BrowserPool(env.BROWSER_POOL_SIZE);
