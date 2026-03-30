import { Router, type Request, Response, NextFunction } from 'express';
import { listarUsuarios, obterUsuarioLogado } from '../services/usuarios.service.js';
import type { ApiResponse, ApiError } from '../types/index.js';

const router = Router();

/** GET /api/usuarios/me — retorna o usuário logado na sessão */
router.get('/me', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await obterUsuarioLogado();

    if (!result.ok) {
      const error: ApiError = { success: false, error: result.error.message, code: result.error.code };
      res.status(result.error.code === 'BROWSER_UNAVAILABLE' ? 503 : 500).json(error);
      return;
    }

    const response: ApiResponse<typeof result.data> = { success: true, data: result.data };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/** GET /api/usuarios */
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await listarUsuarios();

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

export default router;
