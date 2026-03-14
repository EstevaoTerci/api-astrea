import { withBrowserContext } from '../browser/astrea-http.js';
import { navigateTo, waitForElement } from '../browser/navigator.js';
import { isRetryablePlaywrightError } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import type { Publicacao } from '../models/index.js';
import type { FiltrosPublicacao, ServiceResponse, PaginationMeta } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Seletores reais — página de publicações (clippings)
// URL: https://astrea.net.br/#/main/clippings
// DOM: cada publicação é um <article> com filhos:
//   [0]=checkbox [1]=datas [2]=vazio [3]=processo+caso [4]=diário [5]=nomePesquisado [6]=status [7]=ações [8]=conteúdo
// ─────────────────────────────────────────────────────────────────────────────
const SELECTORS = {
  CLIPPINGS_PATH: '/#/main/clippings',
  ARTICLE: 'article',
};

/** Converte DD/MM/YYYY → YYYY-MM-DD */
function parseDateBR(date: string): string {
  const m = date.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return date;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export async function listarPublicacoes(
  filtros?: FiltrosPublicacao,
): Promise<ServiceResponse<Publicacao[]>> {
  try {
    const data = await withBrowserContext(async (page) => {
      // Navega para /#/main/clippings
      await navigateTo(page, SELECTORS.CLIPPINGS_PATH);
      await waitForElement(page, SELECTORS.ARTICLE).catch(() => {});
      await page.waitForTimeout(1000);

      // Extrai via evaluate — cada article tem estrutura bem definida
      const rawItems: Array<{
        id: string;
        processoNumero: string;
        tribunal: string | undefined;
        data: string;
        conteudo: string;
        lida: boolean;
      }> = await page.evaluate(() => {
        const articles = document.querySelectorAll('article');
        const result: Array<{
          id: string;
          processoNumero: string;
          tribunal: string | undefined;
          data: string;
          conteudo: string;
          lida: boolean;
        }> = [];
        let idx = 0;

        for (const article of articles) {
          const kids = [...article.children];
          if (kids.length < 7) continue; // estrutura incompleta

          // [1] datas: 1º <p> = data disponibilização, 2º <p> = "Publicado em: ..."
          const dateEl = kids[1];
          const dataDisp = dateEl?.children[0]?.textContent?.trim() ?? '';
          const dataPubRaw = dateEl?.children[1]?.textContent?.trim() ?? '';
          const data = dataDisp || dataPubRaw.replace(/^Publicado em:\s*/i, '');

          // [3] processo + link do caso
          const processoEl = kids[3];
          const processoNumero = processoEl?.children[0]?.textContent?.trim() ?? '';
          const casoLink = processoEl?.querySelector('a');
          const casoHref = casoLink?.getAttribute('href') ?? '';
          const casoIdMatch = casoHref.match(/folders\/detail\/(\d+)/);
          const casoId = casoIdMatch?.[1] ?? '';

          // [4] diário: 1º <p> = código do tribunal
          const tribunal = kids[4]?.children[0]?.textContent?.trim() || undefined;

          // [6] status (7º filho = index 6)
          const status = kids[6]?.textContent?.trim() ?? '';

          // [8] conteúdo expandido (9º filho se existir)
          const conteudoEl = kids[8]?.children[0]?.children[0];
          const conteudo = conteudoEl?.textContent?.trim() ?? `Processo: ${processoNumero}`;

          if (!processoNumero && !casoId) continue;

          result.push({
            id: `pub-${casoId || idx}`,
            processoNumero,
            tribunal,
            data,
            conteudo,
            lida: status !== 'Não tratada',
          });
          idx++;
        }
        return result;
      });

      // Normaliza datas e aplica filtros
      const normalized: Publicacao[] = rawItems.map((p) => ({
        ...p,
        data: parseDateBR(p.data),
      }));

      let filtered = normalized;
      if (filtros?.lida !== undefined) filtered = filtered.filter((p) => p.lida === filtros.lida);
      if (filtros?.dataInicio) filtered = filtered.filter((p) => p.data >= filtros.dataInicio!);
      if (filtros?.dataFim) filtered = filtered.filter((p) => p.data <= filtros.dataFim!);
      if (filtros?.dias) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - filtros.dias);
        filtered = filtered.filter((p) => p.data >= cutoff.toISOString().slice(0, 10));
      }

      const pagina = filtros?.pagina ?? 1;
      const limite = filtros?.limite ?? 50;
      const paged = filtered.slice((pagina - 1) * limite, pagina * limite);
      const meta: PaginationMeta = { pagina, limite, total: filtered.length };

      return { items: paged, meta };
    });

    return { ok: true, data: data.items, meta: data.meta };
  } catch (err) {
    logger.error({ err }, 'Erro em listarPublicacoes');
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

export async function buscarPublicacoesRecentes(
  dias = 7,
  filtros?: FiltrosPublicacao,
): Promise<ServiceResponse<Publicacao[]>> {
  return listarPublicacoes({ ...filtros, dias });
}
