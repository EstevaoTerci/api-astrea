import { BrowserContext } from 'playwright';
import { ensureAuthenticated, invalidateSession } from '../browser/session.js';
import { navigateTo, waitForElement } from '../browser/navigator.js';
import { browserPool } from '../browser/pool.js';
import { withRetry, isRetryablePlaywrightError } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import type { Andamento, FiltrosAndamento, ServiceResponse, PaginationMeta } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Seletores reais — aba "Histórico" no detalhe de processo/caso
// URL: https://astrea.net.br/#/main/folders/detail/ID
// DOM (aba Histórico): container com items, cada item:
//   paragraph(DD/MM/YYYY) | generic(icon) | generic(descrição) | generic(actions)
// ─────────────────────────────────────────────────────────────────────────────
const SELECTORS = {
  FOLDERS_PATH: '/#/main/folders/[,,]',
  FOLDER_DETAIL_PATH: (id: string) => `/#/main/folders/detail/${id}`,
};

/** Converte DD/MM/YYYY → YYYY-MM-DD para ord. e filtragem */
function parseDateBR(date: string): string {
  const m = date.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return date;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

async function withBrowserContext<T>(operation: (context: BrowserContext) => Promise<T>): Promise<T> {
  const context = await browserPool.acquire();
  try {
    return await withRetry(() => operation(context), {
      maxAttempts: 3,
      retryIf: (err) => {
        if (err instanceof Error && err.message.includes('AUTH_FAILED')) return false;
        return isRetryablePlaywrightError(err as Error);
      },
      onRetry: (err, attempt) => {
        logger.warn({ err: String(err), attempt }, 'Retentando...');
        if (err instanceof Error && err.message.includes('SESSION_EXPIRED')) {
          invalidateSession(context);
        }
      },
    });
  } finally {
    await browserPool.release(context);
  }
}

export async function listarAndamentos(
  processoId: string,
  filtros?: FiltrosAndamento,
): Promise<ServiceResponse<Andamento[]>> {
  try {
    const data = await withBrowserContext(async (context) => {
      const page = await ensureAuthenticated(context);

      // Navega para o detalhe do processo/caso: /#/main/folders/detail/ID
      await navigateTo(page, SELECTORS.FOLDER_DETAIL_PATH(processoId));
      await page.waitForTimeout(1000);

      // Clica na aba "Histórico" para ver todos os andamentos
      await page.getByText('Histórico', { exact: true }).click().catch(() => {});
      await page.waitForTimeout(800);

      // Tenta expandir todos via "Ver todos"
      await page.getByText('Ver todos', { exact: true }).click().catch(() => {});
      await page.waitForTimeout(800);

      // Extrai itens: cada andamento tem paragraph(data DD/MM/YYYY) + 3º filho (descrição)
      const rawItems: Array<{ id: string; processoId: string; data: string; descricao: string }> =
        await page.evaluate((pid: string) => {
          const result: Array<{ id: string; processoId: string; data: string; descricao: string }> =
            [];
          const datePattern = /^\d{2}\/\d{2}\/\d{4}$/;
          const allPs = document.querySelectorAll('main p');
          let idx = 0;

          for (const p of allPs) {
            const dateText = p.textContent?.trim() ?? '';
            if (!datePattern.test(dateText)) continue;

            const parent = p.parentElement;
            if (!parent || parent.children.length < 3) continue;

            const descEl = parent.children[2];
            const desc = descEl?.textContent?.trim() ?? '';
            if (!desc || desc.length < 3) continue;

            result.push({ id: `${pid}-${idx++}`, processoId: pid, data: dateText, descricao: desc });
          }
          return result;
        }, processoId);

      // Converte datas DD/MM/YYYY → YYYY-MM-DD e aplica filtros
      const normalized: Andamento[] = rawItems.map((a) => ({ ...a, data: parseDateBR(a.data) }));

      let filtered = normalized;
      if (filtros?.dataInicio) filtered = filtered.filter((a) => a.data >= filtros.dataInicio!);
      if (filtros?.dataFim) filtered = filtered.filter((a) => a.data <= filtros.dataFim!);
      if (filtros?.dias) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - filtros.dias);
        filtered = filtered.filter((a) => a.data >= cutoff.toISOString().slice(0, 10));
      }

      const pagina = filtros?.pagina ?? 1;
      const limite = filtros?.limite ?? 50;
      const paged = filtered.slice((pagina - 1) * limite, pagina * limite);
      const meta: PaginationMeta = { pagina, limite, total: filtered.length };

      return { items: paged, meta };
    });

    return { ok: true, data: data.items, meta: data.meta };
  } catch (err) {
    logger.error({ err }, 'Erro em listarAndamentos');
    return {
      ok: false,
      error: {
        message: err instanceof Error ? err.message : 'Erro desconhecido',
        code: 'SCRAPE_ERROR',
        retryable: isRetryablePlaywrightError(err),
      },
    };
  }
}

export async function buscarAndamentosRecentes(
  filtros?: FiltrosAndamento,
): Promise<ServiceResponse<Andamento[]>> {
  try {
    const data = await withBrowserContext(async (context) => {
      const page = await ensureAuthenticated(context);

      // Navega para a lista de pastas para pegar o processo mais recentemente movimentado
      await navigateTo(page, SELECTORS.FOLDERS_PATH);
      await waitForElement(page, 'table tbody tr').catch(() => {});

      const firstHref = await page
        .$eval('table tbody tr:first-child td:nth-child(2) a', (el) => el.getAttribute('href') ?? '')
        .catch(() => '');

      const idMatch = firstHref.match(/folders\/detail\/(\d+)/);
      if (!idMatch?.[1]) {
        return { items: [], meta: { pagina: 1, limite: 50, total: 0 } };
      }

      // Obtém andamentos do processo mais recente
      const casoId = idMatch[1];
      await navigateTo(page, SELECTORS.FOLDER_DETAIL_PATH(casoId));
      await page.waitForTimeout(1000);

      await page.getByText('Histórico', { exact: true }).click().catch(() => {});
      await page.waitForTimeout(800);
      await page.getByText('Ver todos', { exact: true }).click().catch(() => {});
      await page.waitForTimeout(800);

      const rawItems: Array<{ id: string; processoId: string; data: string; descricao: string }> =
        await page.evaluate((pid: string) => {
          const result: Array<{ id: string; processoId: string; data: string; descricao: string }> =
            [];
          const datePattern = /^\d{2}\/\d{2}\/\d{4}$/;
          const allPs = document.querySelectorAll('main p');
          let idx = 0;
          for (const p of allPs) {
            const dateText = p.textContent?.trim() ?? '';
            if (!datePattern.test(dateText)) continue;
            const parent = p.parentElement;
            if (!parent || parent.children.length < 3) continue;
            const desc = parent.children[2]?.textContent?.trim() ?? '';
            if (!desc || desc.length < 3) continue;
            result.push({ id: `${pid}-${idx++}`, processoId: pid, data: dateText, descricao: desc });
          }
          return result;
        }, casoId);

      const dias = filtros?.dias ?? 30;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - dias);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      const normalized: Andamento[] = rawItems
        .map((a) => ({ ...a, data: parseDateBR(a.data) }))
        .filter((a) => a.data >= cutoffStr);

      const pagina = filtros?.pagina ?? 1;
      const limite = filtros?.limite ?? 50;
      const paged = normalized.slice((pagina - 1) * limite, pagina * limite);
      const meta: PaginationMeta = { pagina, limite, total: normalized.length };

      return { items: paged, meta };
    });

    return { ok: true, data: data.items, meta: data.meta };
  } catch (err) {
    logger.error({ err }, 'Erro em buscarAndamentosRecentes');
    return {
      ok: false,
      error: {
        message: err instanceof Error ? err.message : 'Erro desconhecido',
        code: 'SCRAPE_ERROR',
        retryable: isRetryablePlaywrightError(err),
      },
    };
  }
}
