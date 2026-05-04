import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { listarAgenda } from '../services/agenda.service.js';
import type { ApiResponse, ApiError } from '../types/index.js';

const router = Router();

const tipoEnum = z.enum(['prazo', 'tarefa', 'atendimento', 'audiencia']);

const querySchema = z.object({
  responsavelId: z.string().optional(),
  inicio: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'inicio deve estar no formato YYYY-MM-DD')
    .optional(),
  fim: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'fim deve estar no formato YYYY-MM-DD')
    .optional(),
  tipos: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (!v) return undefined;
      const arr = Array.isArray(v) ? v : v.split(',');
      return arr.map((s) => s.trim()).filter(Boolean);
    })
    .pipe(z.array(tipoEnum).optional()),
  status: z.enum(['todos', 'pendentes', 'concluidos']).optional(),
  incluirSemPrazo: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((v) => v === true || v === 'true' || v === '1')
    .optional(),
});

/** GET /api/agenda */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filtros = querySchema.parse(req.query);
    const result = await listarAgenda(filtros);

    if (!result.ok) {
      const error: ApiError = {
        success: false,
        error: result.error.message,
        code: result.error.code,
      };
      res.status(result.error.code === 'BROWSER_UNAVAILABLE' ? 503 : 500).json(error);
      return;
    }

    const response: ApiResponse<typeof result.data> = { success: true, data: result.data };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

export default router;
