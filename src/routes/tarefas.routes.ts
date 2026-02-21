import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { listarTarefas, buscarTarefasPorProcesso } from '../services/tarefas.service.js';
import type { ApiResponse, ApiError } from '../types/index.js';

const router = Router();

const querySchema = z.object({
  status: z.string().optional(),
  prioridade: z.string().optional(),
  responsavel: z.string().optional(),
  casoId: z.string().optional(),
  processoId: z.string().optional(),
  pagina: z.coerce.number().int().positive().default(1),
  limite: z.coerce.number().int().min(1).max(100).default(50),
});

/** GET /api/tarefas */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filtros = querySchema.parse(req.query);
    const result = await listarTarefas(filtros);

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

/** GET /api/tarefas/por-processo/:processoId */
router.get('/por-processo/:processoId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await buscarTarefasPorProcesso(req.params.processoId);

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
