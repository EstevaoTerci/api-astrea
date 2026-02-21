import { Page } from 'playwright';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { cleanText } from '../utils/sanitize.js';

const ASTREA_URL = 'https://astrea.net.br';

/**
 * Navega para uma URL do Astrea aguardando o carregamento completo da SPA.
 */
export async function navigateTo(page: Page, path: string): Promise<void> {
  const url = path.startsWith('http') ? path : `${ASTREA_URL}${path}`;

  logger.debug({ url }, 'Navegando para URL...');

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: env.BROWSER_TIMEOUT_MS,
  });

  // Para SPA, aguarda rede ficar ociosa (sem requests por 500ms)
  await page
    .waitForLoadState('networkidle', { timeout: env.BROWSER_TIMEOUT_MS })
    .catch(() => logger.debug('waitForLoadState networkidle timeout — continuando...'));
}

/**
 * Aguarda um seletor aparecer após uma ação (ex: clique que dispara navegação SPA).
 */
export async function waitForElement(page: Page, selector: string, timeoutMs?: number): Promise<void> {
  await page.waitForSelector(selector, {
    state: 'visible',
    timeout: timeoutMs ?? env.BROWSER_TIMEOUT_MS,
  });
}

/**
 * Extrai todas as linhas de uma tabela como arrays de strings.
 */
export async function extractTableRows(page: Page, tableSelector: string): Promise<string[][]> {
  return page.$$eval(`${tableSelector} tr`, (rows) =>
    rows.map((row) =>
      Array.from(row.querySelectorAll('td, th')).map((cell) =>
        (cell.textContent ?? '').replace(/\s+/g, ' ').trim(),
      ),
    ),
  );
}

/**
 * Extrai dados de uma lista/grid de cards.
 * Retorna cada card como um mapa de { label: valor }.
 */
export async function extractCards(
  page: Page,
  cardSelector: string,
  fieldMap: Record<string, string>,
): Promise<Record<string, string>[]> {
  return page.$$eval(
    cardSelector,
    (cards, map) =>
      cards.map((card) => {
        const result: Record<string, string> = {};
        for (const [key, selector] of Object.entries(map)) {
          const el = card.querySelector(selector);
          result[key] = (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
        }
        return result;
      }),
    fieldMap,
  );
}

/**
 * Navega por todas as páginas de uma listagem paginada e coleta dados.
 * @param page - Instância do Page
 * @param extractFn - Função que extrai dados da página atual
 * @param nextButtonSelector - Seletor do botão "próxima página"
 * @param maxPages - Limite de páginas para evitar loops infinitos
 */
export async function paginateAndCollect<T>(
  page: Page,
  extractFn: (page: Page) => Promise<T[]>,
  nextButtonSelector: string,
  maxPages = 50,
): Promise<T[]> {
  const allItems: T[] = [];
  let currentPage = 1;

  while (currentPage <= maxPages) {
    const items = await extractFn(page);
    allItems.push(...items);

    logger.debug({ currentPage, itemsFound: items.length }, 'Página extraída.');

    const nextButton = await page.$(nextButtonSelector);
    if (!nextButton) break;

    const isDisabled = await nextButton.getAttribute('disabled');
    const hasDisabledClass = await nextButton.evaluate(
      (el) =>
        el.classList.contains('disabled') ||
        el.classList.contains('inactive') ||
        el.getAttribute('aria-disabled') === 'true',
    );

    if (isDisabled !== null || hasDisabledClass) break;

    await nextButton.click();
    await page
      .waitForLoadState('networkidle', { timeout: env.BROWSER_TIMEOUT_MS })
      .catch(() => {});
    await page.waitForTimeout(500); // Pequeno delay para SPA re-renderizar

    currentPage++;
  }

  return allItems;
}

/**
 * Espera e fecha um modal/overlay se estiver visível.
 */
export async function dismissModal(page: Page, closeSelector = '[data-dismiss="modal"], .modal-close, button.close'): Promise<void> {
  try {
    const closeBtn = await page.$(closeSelector);
    if (closeBtn) {
      await closeBtn.click();
      await page.waitForTimeout(300);
    }
  } catch {}
}

/**
 * Obtém o texto de um seletor ou retorna undefined se não encontrado.
 */
export async function safeGetText(page: Page, selector: string): Promise<string | undefined> {
  try {
    const text = await page.textContent(selector, { timeout: 3000 });
    return cleanText(text) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Obtém o atributo de um elemento ou retorna undefined se não encontrado.
 */
export async function safeGetAttr(page: Page, selector: string, attr: string): Promise<string | undefined> {
  try {
    const value = await page.getAttribute(selector, attr, { timeout: 3000 });
    return value ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Realiza uma busca em um campo de pesquisa da SPA e espera os resultados.
 */
export async function searchInInput(
  page: Page,
  searchSelector: string,
  query: string,
  resultsSelector: string,
): Promise<void> {
  await page.fill(searchSelector, query);
  await page.waitForTimeout(500); // Debounce
  await page
    .waitForSelector(resultsSelector, { state: 'visible', timeout: env.BROWSER_TIMEOUT_MS })
    .catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}
