import {
  withBrowserContext,
  astreaApiPost,
  getAstreaUserId,
  ANGULAR_PAGE_PATH,
} from '../browser/astrea-http.js';
import { navigateTo } from '../browser/navigator.js';
import { isRetryablePlaywrightError } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import type { DocumentoContato } from '../models/index.js';
import type { ServiceResponse } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

export interface AdicionarDocumentoLinkInput {
  /** URL do link (obrigatório) */
  link: string;
  /** Descrição do documento (obrigatório) */
  descricao: string;
  /** ID do cliente a associar (opcional) */
  clienteId?: string;
}

interface AstreaSaveDocumentResponse {
  response?: string | number;
  errorMessage?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service: Adicionar documento tipo Link
//
// POST /api/v2/documents
//
// Payload interceptado via browser:
// {
//   "url": "<link>",
//   "description": "<descrição>",
//   "type": "DTE_URL",
//   "customerId": <clienteId>,  // opcional
//   "responsibleId": "<userId>",
//   "responsibleName": "<userName>",
//   "ownerId": "<userId>",
//   "attachments": []
// }
//
// 100% HTTP request — nenhum scraping envolvido.
// ─────────────────────────────────────────────────────────────────────────────

export async function adicionarDocumentoLink(
  input: AdicionarDocumentoLinkInput,
): Promise<ServiceResponse<DocumentoContato>> {
  try {
    const data = await withBrowserContext(async (page) => {
      await navigateTo(page, ANGULAR_PAGE_PATH);

      const userId = await getAstreaUserId(page);

      // Obter o nome do usuário logado a partir do scope Angular
      const userName = await page.evaluate(() => {
        try {
          const ng = (window as any).angular;
          const store = ng?.element(document.body)?.injector()?.get('store');
          return store?.user?.name ?? store?.user?.nome ?? null;
        } catch {
          return null;
        }
      });

      const payload: Record<string, unknown> = {
        url: input.link.trim(),
        description: input.descricao.trim(),
        type: 'DTE_URL',
        responsibleId: userId,
        responsibleName: userName ?? 'automacao',
        ownerId: userId,
        attachments: [],
      };

      if (input.clienteId) {
        payload.customerId = Number(input.clienteId);
      }

      logger.debug({ payload }, 'Criando documento tipo Link no Astrea...');

      const response = await astreaApiPost<AstreaSaveDocumentResponse>(
        page,
        '/documents',
        payload,
      );

      const documentId = response.response;
      if (documentId == null || documentId === 'NOT_OK') {
        throw new Error(
          `API_ERROR: ${response.errorMessage || 'Astrea não retornou o ID do documento criado'}`,
        );
      }

      const doc: DocumentoContato = {
        id: String(documentId),
        tipo: 'DTE_URL',
        titulo: input.link.trim(),
        descricao: input.descricao.trim(),
        url: input.link.trim(),
        responsavel: userName ?? 'automacao',
      };

      logger.info({ documentId, clienteId: input.clienteId }, 'Documento Link criado com sucesso.');
      return doc;
    });

    return { ok: true, data };
  } catch (err) {
    logger.error({ err, input }, 'Erro em adicionarDocumentoLink');
    return {
      ok: false,
      error: {
        message:
          err instanceof Error ? err.message.replace(/^API_ERROR:\s*/, '') : 'Erro desconhecido',
        code:
          err instanceof Error && err.message.includes('BROWSER_POOL_TIMEOUT')
            ? 'BROWSER_UNAVAILABLE'
            : 'API_ERROR',
        retryable: isRetryablePlaywrightError(err),
      },
    };
  }
}
