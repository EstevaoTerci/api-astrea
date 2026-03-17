import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  criarAtendimento,
  listarAtendimentos,
  transformarAtendimentoEmCaso,
  transformarAtendimentoEmProcesso,
} from '../services/atendimentos.service.js';
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

const compartilharSchema = z.enum(['publico', 'privado', 'equipe']);

const transformarEmCasoSchema = z.object({
  titulo: z.string().optional(),
  descricao: z.string().optional(),
  observacoes: z.string().optional(),
  responsavelId: z.string().optional(),
  sharingType: compartilharSchema.optional(),
  tagsIds: z.array(z.string()).optional(),
  teamId: z.string().optional(),
});

const transformarEmProcessoSchema = transformarEmCasoSchema.extend({
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
});

/** GET /api/atendimentos */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filtros = querySchema.parse(req.query);
    const result = await listarAtendimentos(filtros);

    if (!result.ok) {
      const error: ApiError = {
        success: false,
        error: result.error.message,
        code: result.error.code,
      };
      res.status(result.error.code === 'BROWSER_UNAVAILABLE' ? 503 : 500).json(error);
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

/** POST /api/atendimentos */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = criarAtendimentoSchema.parse(req.body);
    const result = await criarAtendimento(body);

    if (!result.ok) {
      const error: ApiError = {
        success: false,
        error: result.error.message,
        code: result.error.code,
      };
      res
        .status(
          result.error.code === 'VALIDATION_ERROR'
            ? 400
            : result.error.code === 'BROWSER_UNAVAILABLE'
              ? 503
              : 500,
        )
        .json(error);
      return;
    }

    const response: ApiResponse<typeof result.data> = { success: true, data: result.data };
    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

/** POST /api/atendimentos/:id/transformar-em-caso */
router.post('/:id/transformar-em-caso', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = transformarEmCasoSchema.parse(req.body ?? {});
    const result = await transformarAtendimentoEmCaso(req.params.id, body);

    if (!result.ok) {
      const error: ApiError = {
        success: false,
        error: result.error.message,
        code: result.error.code,
      };
      const status =
        result.error.code === 'NOT_FOUND'
          ? 404
          : result.error.code === 'VALIDATION_ERROR'
            ? 400
            : result.error.code === 'BROWSER_UNAVAILABLE'
              ? 503
              : 500;
      res.status(status).json(error);
      return;
    }

    const response: ApiResponse<typeof result.data> = { success: true, data: result.data };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/** POST /api/atendimentos/:id/transformar-em-processo */
router.post(
  '/:id/transformar-em-processo',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = transformarEmProcessoSchema.parse(req.body ?? {});
      const result = await transformarAtendimentoEmProcesso(req.params.id, body);

      if (!result.ok) {
        const error: ApiError = {
          success: false,
          error: result.error.message,
          code: result.error.code,
        };
        const status =
          result.error.code === 'NOT_FOUND'
            ? 404
            : result.error.code === 'VALIDATION_ERROR'
              ? 400
              : result.error.code === 'BROWSER_UNAVAILABLE'
                ? 503
                : 500;
        res.status(status).json(error);
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
