import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { listarPublicacoes, buscarPublicacoesRecentes } from '../services/publicacoes.service.js';
import type { ApiResponse, ApiError } from '../types/index.js';

const router = Router();

const querySchema = z.object({
  dataInicio: z.string().optional(),
  dataFim: z.string().optional(),
  dias: z.coerce.number().int().positive().optional(),
  lida: z
    .string()
    .transform((v) => v === 'true')
    .optional(),
  responsavel: z.string().optional(),
  pagina: z.coerce.number().int().positive().default(1),
  limite: z.coerce.number().int().min(1).max(100).default(50),
});

/** GET /api/publicacoes */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filtros = querySchema.parse(req.query);
    const result = await listarPublicacoes(filtros);

    if (!result.ok) {
      const error: ApiError = { success: false, error: result.error.message, code: result.error.code };
      res.status(result.error.code === 'BROWSER_UNAVAILABLE' ? 503 : 500).json(error);
      return;
    }

    const response: ApiResponse<typeof result.data> = { success: true, data: result.data, meta: result.meta };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/** GET /api/publicacoes/recentes?dias=7 */
router.get('/recentes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dias, ...filtros } = querySchema.parse(req.query);
    const result = await buscarPublicacoesRecentes(dias ?? 7, filtros);

    if (!result.ok) {
      const error: ApiError = { success: false, error: result.error.message, code: result.error.code };
      res.status(500).json(error);
      return;
    }

    const response: ApiResponse<typeof result.data> = { success: true, data: result.data, meta: result.meta };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

export default router;
