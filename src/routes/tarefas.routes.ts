import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { listarTarefas, buscarTarefasPorProcesso, criarTarefa, atualizarTarefa } from '../services/tarefas.service.js';
import type { ApiResponse, ApiError } from '../types/index.js';
import { withBrowserContext, gapiCall, WORKSPACE_PAGE_PATH } from '../browser/astrea-http.js';
import { navigateTo } from '../browser/navigator.js';

const router = Router();

const querySchema = z.object({
  status: z.string().optional(),
  prioridade: z.string().optional(),
  responsavel: z.string().optional(),
  responsavelId: z.string().optional(),
  casoId: z.string().optional(),
  processoId: z.string().optional(),
  incluirConcluidas: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((v) => v === true || v === 'true' || v === '1')
    .optional(),
  prazoInicio: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'prazoInicio deve estar no formato YYYY-MM-DD')
    .optional(),
  prazoFim: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'prazoFim deve estar no formato YYYY-MM-DD')
    .optional(),
  dias: z.coerce.number().int().positive().optional(),
  pagina: z.coerce.number().int().positive().default(1),
  limite: z.coerce.number().int().min(1).max(100).default(50),
});

const criarTarefaSchema = z.object({
  titulo: z.string(),
  casoId: z.string().optional(),
  responsavelId: z.string(),
  listaId: z.string().optional(),
  prazo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  prioridade: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
});

const atualizarTarefaSchema = z.object({
  titulo: z.string().optional(),
  status: z.string().optional(),
  prazo: z.string().optional(),
  responsavelId: z.string().optional(),
  prioridade: z.number().optional(),
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

/** POST /api/tarefas */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = criarTarefaSchema.parse(req.body);
    const result = await criarTarefa(body);

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

/** PATCH /api/tarefas/:id */
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = atualizarTarefaSchema.parse(req.body);
    const result = await atualizarTarefa(req.params.id, body);

    if (!result.ok) {
      const error: ApiError = { success: false, error: result.error.message, code: result.error.code };
      res.status(result.error.code === 'VALIDATION_ERROR' ? 400 : result.error.code === 'BROWSER_UNAVAILABLE' ? 503 : 500).json(error);
      return;
    }

    const response: ApiResponse<typeof result.data> = { success: true, data: result.data };
    res.status(200).json(response);
  } catch (err) {
    next(err);
  }
});

/** TEMP DEBUG: POST /api/tarefas/_debug/gapi — { service, method, params?, body? } */
router.post('/_debug/gapi', async (req: Request, res: Response) => {
  try {
    const { service, method, params, body } = req.body as {
      service: string;
      method: string;
      params?: Record<string, unknown>;
      body?: unknown;
    };
    const result = await withBrowserContext(async (page) => {
      await navigateTo(page, WORKSPACE_PAGE_PATH);
      return await gapiCall<unknown>(page, service, method, params ?? {}, body);
    });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
