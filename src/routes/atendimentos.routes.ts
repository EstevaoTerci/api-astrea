import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { listarAtendimentos, criarAtendimento } from '../services/atendimentos.service.js';
import type { ApiResponse, ApiError } from '../types/index.js';

const router = Router();

const querySchema = z.object({
  clienteId: z.string().optional(),
  casoId: z.string().optional(),
  status: z.string().optional(),
  dataInicio: z.string().optional(),
  dataFim: z.string().optional(),
  pagina: z.coerce.number().int().positive().default(1),
  limite: z.coerce.number().int().min(1).max(100).default(50),
});

const criarAtendimentoSchema = z.object({
  clienteId: z.string(),
  casoId: z.string().optional(),
  assunto: z.string(),
  data: z.string(),
  hora: z.string(),
  responsavelId: z.string(),
  descricao: z.string().optional(),
  duracaoMinutos: z.number().int().positive().optional(),
});

/** GET /api/atendimentos */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filtros = querySchema.parse(req.query);
    const result = await listarAtendimentos(filtros);

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

/** POST /api/atendimentos */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = criarAtendimentoSchema.parse(req.body);
    const result = await criarAtendimento(body);

    if (!result.ok) {
      const error: ApiError = { success: false, error: result.error.message, code: result.error.code };
      res.status(result.error.code === 'VALIDATION_ERROR' ? 400 : result.error.code === 'BROWSER_UNAVAILABLE' ? 503 : 500).json(error);
      return;
    }

    const response: ApiResponse<typeof result.data> = { success: true, data: result.data };
    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

export default router;
