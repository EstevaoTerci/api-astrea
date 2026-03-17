import { Page } from 'playwright';
import { browserPool } from './pool.js';
import { withRetry, isRetryablePlaywrightError } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

/** Base URL da API REST interna do Astrea */
export const ASTREA_API = 'https://app.astrea.net.br/api/v2';

/**
 * Rota Angular que carrega o AngularJS com gapi.client inicializado.
 * Usada antes de qualquer chamada à API REST ou GCP Endpoints.
 */
export const ANGULAR_PAGE_PATH = '/#/main/contacts';

/**
 * Rota que inicializa o gapi.client.workspace e gapi.client.users.
 * Necessária para chamadas saveTaskWithList e getAllUsers.
 */
export const WORKSPACE_PAGE_PATH = '/#/main/workspace/%5B,%5D';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de erro de scraping
// ─────────────────────────────────────────────────────────────────────────────

const SCRAPING_INDICATORS = [
  'Timeout',
  'waiting for selector',
  'Target closed',
  'net::ERR',
  'Element not found',
  'strict mode violation',
] as const;

/**
 * Retorna true se o erro indica falha de scraping DOM (seletor, timeout,
 * rede) em vez de falha de API ou autenticação.
 */
export function isScrapingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    SCRAPING_INDICATORS.some((s) => msg.includes(s)) &&
    !msg.includes('AUTH_FAILED') &&
    !msg.includes('API_ERROR')
  );
}

function isSessionRecoveryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes('SESSION_EXPIRED') ||
    msg.includes('non-existent user session') ||
    msg.includes('INVALID_SESSION_EXCEPTION') ||
    msg.includes('API_ERROR_401')
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// withBrowserContext — wrapper compartilhado com retry + invalidação de sessão
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adquire uma página (aba) do pool compartilhado, executa a operação com
 * retry automático e fecha a aba ao final.
 *
 * Todas as páginas compartilham cookies/sessão (single-context), permitindo
 * paralelismo real sem conflito de sessão no Astrea.
 */
export async function withBrowserContext<T>(operation: (page: Page) => Promise<T>): Promise<T> {
  const page = await browserPool.acquirePage();
  try {
    return await withRetry(
      async () => {
        await browserPool.ensureAuthenticated();
        return operation(page);
      },
      {
        maxAttempts: 3,
        retryIf: (err) => {
          if (err instanceof Error && err.message.includes('AUTH_FAILED')) return false;
          if (isSessionRecoveryError(err)) return true;
          return isRetryablePlaywrightError(err as Error);
        },
        onRetry: (err, attempt) => {
          logger.warn({ err: String(err), attempt }, 'Retentando operação no browser...');
          if (isSessionRecoveryError(err)) {
            browserPool.invalidateSession();
          }
        },
      },
    );
  } finally {
    await browserPool.releasePage(page);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API REST — helpers via Angular $http (sessão automática)
// ─────────────────────────────────────────────────────────────────────────────

/** GET para a API REST do Astrea via Angular $http. */
export async function astreaApiGet<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (url: string) => {
    const http = (window as any).angular?.element(document.body)?.injector()?.get('$http');
    if (!http) throw new Error('Angular $http não disponível');

    try {
      const res = await http.get(url);
      return res.data as T;
    } catch (err: any) {
      const status = err?.status ?? 'UNKNOWN';
      const rawMessage =
        err?.data?.errorMessage ?? err?.data ?? err?.message ?? err?.statusText ?? err;
      const detail = typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage);
      throw new Error(`API_ERROR_${status}: ${detail}`);
    }
  }, `${ASTREA_API}${path}`);
}

/** POST para a API REST do Astrea via Angular $http. */
export async function astreaApiPost<T>(page: Page, path: string, body: unknown): Promise<T> {
  return page.evaluate(
    async ({ url, body }: { url: string; body: unknown }) => {
      const http = (window as any).angular?.element(document.body)?.injector()?.get('$http');
      if (!http) throw new Error('Angular $http não disponível');

      try {
        const res = await http.post(url, body);
        return res.data as T;
      } catch (err: any) {
        const status = err?.status ?? 'UNKNOWN';
        const rawMessage =
          err?.data?.errorMessage ?? err?.data ?? err?.message ?? err?.statusText ?? err;
        const detail = typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage);
        throw new Error(`API_ERROR_${status}: ${detail}`);
      }
    },
    { url: `${ASTREA_API}${path}`, body },
  );
}

/** DELETE para a API REST do Astrea via Angular $http. */
export async function astreaApiDelete<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (url: string) => {
    const http = (window as any).angular?.element(document.body)?.injector()?.get('$http');
    if (!http) throw new Error('Angular $http não disponível');

    try {
      const res = await http.delete(url);
      return res.data as T;
    } catch (err: any) {
      const status = err?.status ?? 'UNKNOWN';
      const rawMessage =
        err?.data?.errorMessage ?? err?.data ?? err?.message ?? err?.statusText ?? err;
      const detail = typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage);
      throw new Error(`API_ERROR_${status}: ${detail}`);
    }
  }, `${ASTREA_API}${path}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// GCP Endpoints — gapi.client helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chama um método do GCP Cloud Endpoints via gapi.client.
 *
 * @param page - Página autenticada com gapi.client carregado.
 * @param service - Caminho do serviço: 'workspace.taskListService' | 'users.userService'.
 * @param method - Nome do método, ex: 'saveTaskWithList', 'getAllUsers'.
 * @param params - Parâmetros de URL (query string).
 * @param body - Corpo da requisição (para métodos POST).
 * @param timeoutMs - Timeout da chamada em ms (padrão 15s).
 */
export async function gapiCall<T>(
  page: Page,
  service: string,
  method: string,
  params: Record<string, unknown> = {},
  body?: unknown,
  timeoutMs = 15000,
): Promise<T> {
  return page.evaluate(
    async ({ service, method, params, body, timeoutMs }) => {
      const serviceRef = service
        .split('.')
        .reduce((obj: any, key: string) => obj?.[key], (window as any).gapi?.client);
      if (!serviceRef) throw new Error(`gapi.client.${service} não disponível`);
      if (typeof serviceRef[method] !== 'function') {
        throw new Error(`Método ${method} não encontrado em gapi.client.${service}`);
      }

      return new Promise<T>((resolve, reject) => {
        const req =
          body !== undefined ? serviceRef[method](params, body) : serviceRef[method](params);
        req.execute((r: any) => {
          if (r.error) {
            const errMsg = typeof r.error === 'object' ? JSON.stringify(r.error) : String(r.error);
            reject(new Error(errMsg));
          } else {
            resolve(r as T);
          }
        });
        setTimeout(
          () => reject(new Error(`Timeout ${timeoutMs}ms em gapi.client.${service}.${method}`)),
          timeoutMs,
        );
      });
    },
    { service, method, params, body, timeoutMs },
  );
}

/**
 * Obtém o userId da sessão Angular ativa.
 */
export async function getAstreaUserId(page: Page): Promise<string> {
  const userId = await page.evaluate(() => {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('case_suggestions_for_user_')) {
          const m = key.match(/case_suggestions_for_user_(\d+)_/);
          if (m) return m[1];
        }
      }
    } catch {}
    return null;
  });

  if (!userId) throw new Error('AUTH_FAILED: não foi possível obter userId da sessão');
  return userId;
}

// ─────────────────────────────────────────────────────────────────────────────
// withScrapingFallback — wrapper para operações DOM com fallback LLM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executa `operation` com fallback automático para navegação LLM se falhar
 * por motivo de scraping (seletor, timeout, DOM não encontrado).
 */
export async function withScrapingFallback<T>(
  page: Page,
  taskDescription: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (!isScrapingError(err)) throw err;

    logger.warn(
      { taskDescription, err: String(err) },
      'Scraping falhou — ativando fallback LLM...',
    );

    const { llmNavigate } = await import('../utils/llm-navigator.js');
    const { notifyScrapingIncident } = await import('../utils/mailer.js');

    const { result, fixDescription } = await llmNavigate(page, taskDescription, err as Error);

    await notifyScrapingIncident({
      operation: taskDescription,
      error: err as Error,
      url: page.url(),
      llmFix: fixDescription,
      llmCodeSuggestion: `Investigar seletor em ${taskDescription}: ${(err as Error).message}`,
    }).catch((mailErr) => logger.warn({ mailErr }, 'Falha ao enviar email de incidente'));

    return result as T;
  }
}
