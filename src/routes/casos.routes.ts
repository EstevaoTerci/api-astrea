import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { criarCaso, criarProcesso, listarCasos, buscarCaso } from '../services/casos.service.js';
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

const compartilharSchema = z.enum(['publico', 'privado', 'equipe']);

const criarCasoSchema = z.object({
  cliente: z.string().min(1, 'Cliente é obrigatório (ID, nome ou CPF)'),
  titulo: z.string().min(1, 'Título é obrigatório'),
  descricao: z.string().optional(),
  observacoes: z.string().optional(),
  responsavelId: z.string().optional(),
  sharingType: compartilharSchema.optional(),
  tagsIds: z.array(z.string()).optional(),
  teamId: z.string().optional(),
});

const criarProcessoSchema = criarCasoSchema.extend({
  numeroProcesso: z.string().optional(),
  instancia: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  juizoNumero: z.string().optional(),
  vara: z.string().optional(),
  foro: z.string().optional(),
  acao: z.string().optional(),
  urlTribunal: z.string().optional(),
  objeto: z.string().optional(),
  valorCausa: z.number().optional(),
  distribuidoEm: z.string().optional(),
  valorCondenacao: z.number().optional(),
  papelCliente: z.string().optional(),
});

function statusFromCode(code: string): number {
  if (code === 'NOT_FOUND') return 404;
  if (code === 'VALIDATION_ERROR') return 400;
  if (code === 'BROWSER_UNAVAILABLE') return 503;
  return 500;
}

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

/** POST /api/casos — cria um caso direto (sem passar por atendimento) */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = criarCasoSchema.parse(req.body);
    const result = await criarCaso(body);

    if (!result.ok) {
      const error: ApiError = {
        success: false,
        error: result.error.message,
        code: result.error.code,
      };
      res.status(statusFromCode(result.error.code)).json(error);
      return;
    }

    const response: ApiResponse<CasoProcesso> = { success: true, data: result.data };
    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

/** POST /api/casos/processo — cria um processo direto (sem passar por atendimento) */
router.post('/processo', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = criarProcessoSchema.parse(req.body);
    const result = await criarProcesso(body);

    if (!result.ok) {
      const error: ApiError = {
        success: false,
        error: result.error.message,
        code: result.error.code,
      };
      res.status(statusFromCode(result.error.code)).json(error);
      return;
    }

    const response: ApiResponse<CasoProcesso> = { success: true, data: result.data };
    res.status(201).json(response);
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
