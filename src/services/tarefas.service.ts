import { BrowserContext } from 'playwright';
import { ensureAuthenticated, invalidateSession } from '../browser/session.js';
import { navigateTo, waitForElement } from '../browser/navigator.js';
import { browserPool } from '../browser/pool.js';
import { withRetry, isRetryablePlaywrightError } from '../utils/retry.js';
import { cleanText } from '../utils/sanitize.js';
import { logger } from '../utils/logger.js';
import type { Tarefa, FiltrosTarefa, ServiceResponse, PaginationMeta } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Seletores reais — área de trabalho (workspace)
// URL: https://astrea.net.br/#/main/workspace/%5B,%5D
// DOM: main > list > listitem[]
//   listitem > generic (inner wrapper):
//     [0]=checkbox area [1]=título [2]=prazo [3]=ações [4]=link do caso [5]=responsável+status
// ─────────────────────────────────────────────────────────────────────────────
const SELECTORS = {
  WORKSPACE_PATH: '/#/main/workspace/[,]',
  TASK_LIST_ITEM: 'main ul > li',
};

/** Converte "- DD/MM/YYYY" ou "DD/MM/YYYY" → YYYY-MM-DD */
function parsePrazo(raw: string): string | undefined {
  const m = raw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return undefined;
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

export async function listarTarefas(filtros?: FiltrosTarefa): Promise<ServiceResponse<Tarefa[]>> {
  try {
    const data = await withBrowserContext(async (context) => {
      const page = await ensureAuthenticated(context);

      // Navega para a área de trabalho: /#/main/workspace/[,]
      await navigateTo(page, SELECTORS.WORKSPACE_PATH);
      await waitForElement(page, SELECTORS.TASK_LIST_ITEM).catch(() => {});
      await page.waitForTimeout(1000);

      // Extrai tarefas via evaluate
      // Estrutura de cada listitem > container:
      //   kids[0]=checkbox  kids[1]=título  kids[2]=prazo  kids[3]=ações
      //   link=caso (href #/main/folders/detail/ID)
      //   kids[-1]=responsável+status
      const rawItems: Array<{
        id: string;
        titulo: string;
        status: string;
        prazoRaw: string;
        casoId: string | undefined;
        casoNome: string | undefined;
        responsavel: string | undefined;
      }> = await page.evaluate(() => {
        const items = document.querySelectorAll('main ul > li');
        const result: Array<{
          id: string;
          titulo: string;
          status: string;
          prazoRaw: string;
          casoId: string | undefined;
          casoNome: string | undefined;
          responsavel: string | undefined;
        }> = [];
        let idx = 0;

        for (const item of items) {
          const container = item.children[0];
          if (!container || container.children.length < 2) continue;

          const kids = [...container.children];

          // Título: 2º filho (cursor=pointer com o texto da tarefa)
          const titulo = kids[1]?.textContent?.trim() ?? '';
          if (!titulo) continue;

          // Prazo: 3º filho — formato "- DD/MM/YYYY"
          const prazoRaw = kids[2]?.textContent?.trim() ?? '';

          // Link do caso: primeiro <a> no container
          const casoLink = container.querySelector('a');
          const casoHref = casoLink?.getAttribute('href') ?? '';
          const casoIdMatch = casoHref.match(/folders\/detail\/(\d+)/);
          const casoId = casoIdMatch?.[1] ?? undefined;
          const casoNome = casoLink?.textContent?.trim() || undefined;

          // Último filho: responsável + lista de status
          const lastEl = kids[kids.length - 1];
          const responsavel = lastEl?.children[1]?.textContent?.trim() || undefined;
          const statusText =
            lastEl?.querySelector('ul > li > *:first-child')?.textContent?.trim() ?? 'pendente';

          result.push({
            id: `tarefa-${idx++}`,
            titulo,
            status: statusText,
            prazoRaw,
            casoId,
            casoNome,
            responsavel,
          });
        }
        return result;
      });

      // Mapeia para a interface Tarefa e aplica filtros
      const tarefas: Tarefa[] = rawItems.map((t) => ({
        id: t.id,
        titulo: cleanText(t.titulo) || t.titulo,
        status: t.status,
        prazo: parsePrazo(t.prazoRaw),
        casoId: t.casoId,
        responsavel: t.responsavel,
      }));

      let filtered = tarefas;
      if (filtros?.status) filtered = filtered.filter((t) => t.status === filtros.status);
      if (filtros?.casoId)
        filtered = filtered.filter(
          (t) => t.casoId === filtros.casoId || t.casoId === filtros.processoId,
        );
      if (filtros?.responsavel) {
        filtered = filtered.filter((t) =>
          t.responsavel?.toLowerCase().includes(filtros.responsavel!.toLowerCase()),
        );
      }

      const pagina = filtros?.pagina ?? 1;
      const limite = filtros?.limite ?? 50;
      const paged = filtered.slice((pagina - 1) * limite, pagina * limite);
      const meta: PaginationMeta = { pagina, limite, total: filtered.length };

      return { items: paged, meta };
    });

    return { ok: true, data: data.items, meta: data.meta };
  } catch (err) {
    logger.error({ err }, 'Erro em listarTarefas');
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

export async function buscarTarefasPorProcesso(processoId: string): Promise<ServiceResponse<Tarefa[]>> {
  return listarTarefas({ processoId });
}
