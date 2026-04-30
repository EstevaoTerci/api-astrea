import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  listarQuadros,
  listarAtividadesQuadro,
  moverAtividade,
} from '../services/kanban.service.js';
import type { ApiResponse, ApiError } from '../types/index.js';

const router = Router();

const dataIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data deve estar no formato YYYY-MM-DD');

const listarAtividadesQuerySchema = z.object({
  prazoInicio: dataIso.optional(),
  prazoFim: dataIso.optional(),
  dias: z.coerce.number().int().positive().optional(),
  responsavelId: z.string().optional(),
  envolvidosIds: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(',').map((s) => s.trim()).filter(Boolean)))
    .optional(),
  tipos: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(',').map((s) => s.trim()).filter(Boolean)))
    .optional(),
  limite: z.coerce.number().int().min(1).max(500).optional(),
});

const moverBodySchema = z.object({
  colunaDestinoId: z.string().min(1, 'colunaDestinoId é obrigatório'),
});

function statusFromCode(code: string): number {
  if (code === 'VALIDATION_ERROR') return 400;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'BROWSER_UNAVAILABLE') return 503;
  return 500;
}

/** GET /api/kanban/quadros */
router.get('/quadros', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await listarQuadros();
    if (!result.ok) {
      const error: ApiError = { success: false, error: result.error.message, code: result.error.code };
      res.status(statusFromCode(result.error.code)).json(error);
      return;
    }
    const response: ApiResponse<typeof result.data> = { success: true, data: result.data };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/** GET /api/kanban/quadros/:quadroId/atividades */
router.get(
  '/quadros/:quadroId/atividades',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const filtros = listarAtividadesQuerySchema.parse(req.query);
      const result = await listarAtividadesQuadro(req.params.quadroId, filtros);
      if (!result.ok) {
        const error: ApiError = {
          success: false,
          error: result.error.message,
          code: result.error.code,
        };
        res.status(statusFromCode(result.error.code)).json(error);
        return;
      }
      const response: ApiResponse<typeof result.data> = { success: true, data: result.data };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

/** PUT /api/kanban/quadros/:quadroId/atividades/:atividadeId/mover */
router.put(
  '/quadros/:quadroId/atividades/:atividadeId/mover',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = moverBodySchema.parse(req.body);
      const result = await moverAtividade(
        req.params.quadroId,
        req.params.atividadeId,
        body.colunaDestinoId,
      );
      if (!result.ok) {
        const error: ApiError = {
          success: false,
          error: result.error.message,
          code: result.error.code,
        };
        res.status(statusFromCode(result.error.code)).json(error);
        return;
      }
      const response: ApiResponse<typeof result.data> = { success: true, data: result.data };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
