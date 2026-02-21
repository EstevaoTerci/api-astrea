import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { listarClientes, listarTodosClientes, buscarCliente } from '../services/clientes.service.js';
import { buscarCasosPorCliente } from '../services/casos.service.js';
import type { ApiResponse, ApiError } from '../types/index.js';

const router = Router();

const querySchema = z.object({
  nome: z.string().optional(),
  cpfCnpj: z.string().optional(),
  email: z.string().optional(),
  pagina: z.coerce.number().int().positive().default(1),
  limite: z.coerce.number().int().min(1).max(100).default(50),
});

/** GET /api/clientes */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filtros = querySchema.parse(req.query);
    const result = await listarClientes(filtros);

    if (!result.ok) {
      const error: ApiError = { success: false, error: result.error.message, code: result.error.code };
      const status = result.error.code === 'BROWSER_UNAVAILABLE' ? 503 : result.error.code === 'NOT_FOUND' ? 404 : 500;
      res.status(status).json(error);
      return;
    }

    const response: ApiResponse<typeof result.data> = {
      success: true,
      data: result.data,
      meta: result.meta,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/** GET /api/clientes/todos — Lista completa de todos os clientes com ID e nome */
router.get('/todos', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await listarTodosClientes();

    if (!result.ok) {
      const error: ApiError = { success: false, error: result.error.message, code: result.error.code };
      const status = result.error.code === 'BROWSER_UNAVAILABLE' ? 503 : 500;
      res.status(status).json(error);
      return;
    }

    const response: ApiResponse<typeof result.data> = {
      success: true,
      data: result.data,
      meta: result.meta,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/** GET /api/clientes/:id */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const result = await buscarCliente(id);

    if (!result.ok) {
      const error: ApiError = { success: false, error: result.error.message, code: result.error.code };
      const status = result.error.code === 'NOT_FOUND' ? 404 : 500;
      res.status(status).json(error);
      return;
    }

    const response: ApiResponse<typeof result.data> = { success: true, data: result.data };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/** GET /api/clientes/:id/casos */
router.get('/:id/casos', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const pagina = z.coerce.number().int().positive().default(1).parse(req.query['pagina']);
    const limite = z.coerce.number().int().min(1).max(100).default(50).parse(req.query['limite']);

    const result = await buscarCasosPorCliente(id);

    if (!result.ok) {
      const error: ApiError = { success: false, error: result.error.message, code: result.error.code };
      res.status(500).json(error);
      return;
    }

    const response: ApiResponse<typeof result.data> = {
      success: true,
      data: result.data,
      meta: result.meta ?? { pagina, limite },
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

export default router;
