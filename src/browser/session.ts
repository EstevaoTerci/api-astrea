import { BrowserContext, Page } from 'playwright';
import { env } from '../config/env.js';
import { browserPool } from './pool.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const ASTREA_URL = 'https://astrea.net.br';

// ─── Seletores reais mapeados via inspeção do DOM do Astrea ───────────────────

// Login
const LOGIN_EMAIL_SELECTOR = 'input[placeholder="Digite seu email"]';
const LOGIN_PASSWORD_SELECTOR = 'input[type="password"]';
const LOGIN_SUBMIT_SELECTOR = 'button:has-text("Entrar")';

// Indicadores de sessão autenticada
// Após login, URL muda para /#/main/workspace/...
// Quando logado, o banner superior com links de navegação está presente
const AUTHENTICATED_URL_FRAGMENT = '#/main/';
const AUTHENTICATED_SELECTOR = 'nav a[href="#/main/contacts"]'; // link só existe quando autenticado

// Indicador de erro no login
const LOGIN_ERROR_SELECTOR = '.alert-danger, .alert-error, [class*="alerta"], div.toast-error';

// Mapa de contexts com sessão ativa
const authenticatedContexts = new WeakSet<BrowserContext>();

/**
 * Garante que o context está autenticado no Astrea.
 * Reutiliza sessão existente se válida; faz login caso contrário.
 * Retorna uma Page já na área logada.
 */
export async function ensureAuthenticated(context: BrowserContext): Promise<Page> {
  if (env.SESSION_REUSE && authenticatedContexts.has(context)) {
    const page = await context.newPage();
    try {
      const isValid = await _checkSession(page);
      if (isValid) {
        logger.debug('Sessão reutilizada com sucesso.');
        return page;
      }
      logger.debug('Sessão expirada, refazendo login...');
    } catch {
      // ignorado — continua para re-login
    }
    await page.close().catch(() => {});
    authenticatedContexts.delete(context);
    await browserPool.clearSession(context);
  }

  return withRetry(() => _doLogin(context), {
    maxAttempts: 2,
    retryIf: (err) => err instanceof Error && !err.message.includes('AUTH_FAILED'),
  });
}

/**
 * Verifica se o context ainda possui sessão ativa no Astrea.
 * Navega para a raiz — se redirecionar para #/main/ está autenticado.
 */
async function _checkSession(page: Page): Promise<boolean> {
  try {
    await page.goto(ASTREA_URL, {
      waitUntil: 'domcontentloaded',
      timeout: env.BROWSER_TIMEOUT_MS,
    });

    // Aguarda possível redirect da SPA (hash router leva ~500ms)
    await page.waitForTimeout(1200);

    const url = page.url();
    if (url.includes(AUTHENTICATED_URL_FRAGMENT)) {
      return true;
    }

    // Fallback: link de navegação só existe quando logado
    const navLink = await page.$(AUTHENTICATED_SELECTOR);
    return navLink !== null;
  } catch {
    return false;
  }
}

/**
 * Realiza o login completo no Astrea usando as credenciais do .env.
 * Fluxo real: https://astrea.net.br → #/login/BR → preenche email/senha → clica Entrar → #/main/workspace/
 */
async function _doLogin(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();

  try {
    logger.info('Realizando login no Astrea...');

    // A SPA redireciona automaticamente para /#/login/BR
    await page.goto(ASTREA_URL, {
      waitUntil: 'domcontentloaded',
      timeout: env.BROWSER_TIMEOUT_MS,
    });

    // Aguarda o formulário de login renderizar
    await page.waitForSelector(LOGIN_EMAIL_SELECTOR, {
      state: 'visible',
      timeout: env.BROWSER_TIMEOUT_MS,
    });

    // Preenche credenciais
    await page.fill(LOGIN_EMAIL_SELECTOR, env.ASTREA_EMAIL);
    await page.fill(LOGIN_PASSWORD_SELECTOR, env.ASTREA_PASSWORD);

    // Clica em "Entrar"
    await page.click(LOGIN_SUBMIT_SELECTOR);

    // Aguarda o hash mudar de #/login/ para #/main/ (confirma login com sucesso)
    await page.waitForFunction(
      (fragment: string) => window.location.hash.includes(fragment),
      AUTHENTICATED_URL_FRAGMENT,
      { timeout: env.BROWSER_TIMEOUT_MS },
    );

    // Aguarda workspace renderizar completamente
    await page.waitForTimeout(800);

    const currentUrl = page.url();
    logger.info({ url: currentUrl }, 'Login no Astrea realizado com sucesso.');

    authenticatedContexts.add(context);
    return page;
  } catch (originalErr) {
    // Verifica mensagem de erro de credenciais na página
    try {
      const errorEl = await page.$(LOGIN_ERROR_SELECTOR);
      if (errorEl) {
        const errorText = (await errorEl.textContent())?.trim();
        await page.close().catch(() => {});
        throw new Error(`AUTH_FAILED: ${errorText || 'Credenciais inválidas'}`);
      }
    } catch (innerErr) {
      if (innerErr instanceof Error && innerErr.message.startsWith('AUTH_FAILED')) {
        throw innerErr;
      }
    }

    await page.close().catch(() => {});
    throw originalErr;
  }
}

/**
 * Invalida a sessão de um context (força re-login na próxima requisição).
 */
export function invalidateSession(context: BrowserContext): void {
  authenticatedContexts.delete(context);
}
