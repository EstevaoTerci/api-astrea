import { Browser, BrowserContext, chromium } from 'playwright';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

interface PoolEntry {
  context: BrowserContext;
  inUse: boolean;
  lastUsed: number;
}

/**
 * Pool de BrowserContexts do Playwright.
 * Mantém um único Browser Chromium e gerencia múltiplos contextos isolados.
 * Cada contexto representa uma sessão independente (cookies/storage separados).
 */
class BrowserPool {
  private browser: Browser | null = null;
  private pool: PoolEntry[] = [];
  private readonly size: number;
  private readonly timeoutMs: number;
  private initPromise: Promise<void> | null = null;

  constructor(size: number, timeoutMs: number) {
    this.size = size;
    this.timeoutMs = timeoutMs;
  }

  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    logger.info({ poolSize: this.size }, 'Iniciando browser Chromium...');

    this.browser = await chromium.launch({
      headless: env.BROWSER_HEADLESS,
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

    for (let i = 0; i < this.size; i++) {
      const context = await this._createContext();
      this.pool.push({ context, inUse: false, lastUsed: Date.now() });
    }

    logger.info({ poolSize: this.size }, 'Pool de browser inicializado com sucesso.');
  }

  private async _createContext(): Promise<BrowserContext> {
    if (!this.browser) throw new Error('Browser não inicializado');

    return this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
    });
  }

  /**
   * Adquire um context disponível do pool.
   * Aguarda até `timeoutMs` se todos estiverem em uso.
   * @throws Error se timeout esgotar
   */
  async acquire(): Promise<BrowserContext> {
    await this.initialize();

    const start = Date.now();

    while (Date.now() - start < this.timeoutMs) {
      const entry = this.pool.find((e) => !e.inUse);

      if (entry) {
        entry.inUse = true;
        entry.lastUsed = Date.now();
        logger.debug({ available: this.pool.filter((e) => !e.inUse).length }, 'Context adquirido do pool.');
        return entry.context;
      }

      // Aguarda 100ms antes de tentar novamente
      await new Promise((r) => setTimeout(r, 100));
    }

    throw new Error('BROWSER_POOL_TIMEOUT: Nenhum context disponível no pool após timeout.');
  }

  /**
   * Libera um context de volta ao pool.
   * Se o context estiver em estado inválido, recria-o.
   */
  async release(context: BrowserContext): Promise<void> {
    const entry = this.pool.find((e) => e.context === context);

    if (!entry) {
      logger.warn('Tentativa de liberar context não pertencente ao pool.');
      return;
    }

    // Verifica se o context ainda é utilizável
    try {
      // Fecha páginas abertas para reutilização limpa
      const pages = context.pages();
      for (const page of pages) {
        await page.close().catch(() => {});
      }
      entry.inUse = false;
      entry.lastUsed = Date.now();
      logger.debug({ available: this.pool.filter((e) => !e.inUse).length }, 'Context liberado para o pool.');
    } catch {
      logger.warn('Context corrompido, recriando...');
      await this._replaceContext(entry);
    }
  }

  /**
   * Remove a sessão de um context (logout / limpa cookies).
   * Útil quando uma sessão expira e precisa refazer login.
   */
  async clearSession(context: BrowserContext): Promise<void> {
    try {
      await context.clearCookies();
      await context.clearPermissions();
    } catch (err) {
      logger.warn({ err }, 'Erro ao limpar sessão do context.');
    }
  }

  private async _replaceContext(entry: PoolEntry): Promise<void> {
    try {
      await entry.context.close().catch(() => {});
    } catch {}

    const newContext = await this._createContext();
    entry.context = newContext;
    entry.inUse = false;
    entry.lastUsed = Date.now();
  }

  async shutdown(): Promise<void> {
    logger.info('Encerrando pool de browser...');

    for (const entry of this.pool) {
      try {
        await entry.context.close();
      } catch {}
    }

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }

    this.pool = [];
    logger.info('Pool de browser encerrado.');
  }

  get stats() {
    return {
      total: this.pool.length,
      inUse: this.pool.filter((e) => e.inUse).length,
      available: this.pool.filter((e) => !e.inUse).length,
    };
  }
}

// Instância global do pool
export const browserPool = new BrowserPool(env.BROWSER_POOL_SIZE, env.BROWSER_TIMEOUT_MS);
