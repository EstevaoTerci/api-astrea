import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { listarAndamentos, buscarAndamentosRecentes } from '../services/andamentos.service.js';
import type { ApiResponse, ApiError } from '../types/index.js';

const router = Router();

const filtroSchema = z.object({
  dataInicio: z.string().optional(),
  dataFim: z.string().optional(),
  dias: z.coerce.number().int().positive().optional(),
  pagina: z.coerce.number().int().positive().default(1),
  limite: z.coerce.number().int().min(1).max(100).default(50),
});

/** GET /api/andamentos/recentes */
router.get('/recentes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filtros = filtroSchema.parse(req.query);
    const result = await buscarAndamentosRecentes(filtros);

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

/** GET /api/andamentos/:processoId */
router.get('/:processoId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filtros = filtroSchema.parse(req.query);
    const result = await listarAndamentos(req.params.processoId, filtros);

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
