import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { listarCasos, buscarCaso } from '../services/casos.service.js';
import { listarAndamentos } from '../services/andamentos.service.js';
import type { ApiResponse, ApiError } from '../types/index.js';
import type { CasoProcesso } from '../models/caso-processo.js';

const router = Router();

const querySchema = z.object({
  clienteId: z.string().optional(),
  status: z.string().optional(),
  area: z.string().optional(),
  pagina: z.coerce.number().int().positive().default(1),
  limite: z.coerce.number().int().min(1).max(100).default(50),
});

/** GET /api/casos */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filtros = querySchema.parse(req.query);
    const result = await listarCasos(filtros);

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

/** GET /api/casos/:id — Retorna dados completos do caso/processo incluindo histórico */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await buscarCaso(req.params.id);

    if (!result.ok) {
      const error: ApiError = { success: false, error: result.error.message, code: result.error.code };
      res.status(result.error.code === 'NOT_FOUND' ? 404 : 500).json(error);
      return;
    }

    const response: ApiResponse<CasoProcesso> = { success: true, data: result.data };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/** GET /api/casos/:id/andamentos */
router.get('/:id/andamentos', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filtros = z
      .object({
        dataInicio: z.string().optional(),
        dataFim: z.string().optional(),
        pagina: z.coerce.number().int().positive().default(1),
        limite: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);

    const result = await listarAndamentos(req.params.id, filtros);

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
