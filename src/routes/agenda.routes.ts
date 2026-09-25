import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { listarAgenda } from '../services/agenda.service.js';
import {
  buscarEventoAgenda,
  buscarEventosPorContato,
  calcularDisponibilidade,
  cancelarEventoAgenda,
  criarEventoAgenda,
  excluirEventoAgenda,
  remarcarEventoAgenda,
} from '../services/agenda-eventos.service.js';
import type { ApiResponse, ApiError, ServiceError } from '../types/index.js';

const router = Router();

const tipoEnum = z.enum(['prazo', 'tarefa', 'atendimento', 'audiencia']);
function dataReal(s: string): boolean {
  // O Zod roda o refine mesmo quando a regex já falhou: não pode estourar.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === s;
}

const dataSchema = (campo: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${campo} deve estar no formato YYYY-MM-DD`)
    .refine(dataReal, `${campo} não é uma data válida`);

const tiposSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (!v) return undefined;
    const arr = Array.isArray(v) ? v : v.split(',');
    return arr.map((s) => s.trim()).filter(Boolean);
  })
  .pipe(z.array(tipoEnum).optional());

const booleanQuery = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const querySchema = z.object({
  responsavelId: z.string().optional(),
  inicio: dataSchema('inicio').optional(),
  fim: dataSchema('fim').optional(),
  tipos: tiposSchema,
  status: z.enum(['todos', 'pendentes', 'concluidos']).optional(),
  incluirSemPrazo: booleanQuery.optional(),
  numeroProcesso: z.string().optional(),
});

const JANELA_MAX_DIAS = 31;

function diasEntre(inicio: string, fim: string): number {
  return Math.round((Date.parse(`${fim}T00:00:00Z`) - Date.parse(`${inicio}T00:00:00Z`)) / 86_400_000);
}

const disponibilidadeSchema = z
  .object({
    responsavelIds: z
      .union([z.string(), z.array(z.string())])
      .transform((v) =>
        (Array.isArray(v) ? v : [v])
          .flatMap((s) => s.split(','))
          .map((s) => s.trim())
          .filter(Boolean),
      )
      .pipe(
        z
          .array(z.string().regex(/^\d{10,20}$/, 'responsavelIds deve conter IDs numéricos do Astrea'))
          .min(1, 'informe ao menos um responsavelId')
          .max(20, 'no máximo 20 responsavelIds'),
      ),
    inicio: dataSchema('inicio'),
    fim: dataSchema('fim'),
    tipos: tiposSchema,
    duracaoPadraoMin: z.coerce.number().int().min(5).max(240).default(30),
    fresh: booleanQuery.optional().default(false),
    incluirTitulos: booleanQuery.optional().default(false),
  })
  .refine((q) => diasEntre(q.inicio, q.fim) >= 0, {
    message: 'fim deve ser igual ou posterior a inicio',
    path: ['fim'],
  })
  .refine((q) => diasEntre(q.inicio, q.fim) + 1 <= JANELA_MAX_DIAS, {
    message: `janela máxima de ${JANELA_MAX_DIAS} dias`,
    path: ['fim'],
  });

const idAstrea = z.string().regex(/^\d{10,20}$/, 'ID numérico do Astrea');
const horaSchema = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'hora no formato HH:mm');
const idsCsvSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((v) =>
    (Array.isArray(v) ? v : [v])
      .flatMap((s) => s.split(','))
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(idAstrea).min(1).max(20));

const criarEventoSchema = z
  .object({
    titulo: z.string().trim().min(1).max(200),
    data: dataSchema('data'),
    horaInicio: horaSchema.optional(),
    horaFim: horaSchema.optional(),
    diaTodo: z.boolean().optional(),
    responsavelId: idAstrea,
    envolvidosIds: z.array(idAstrea).max(10).optional(),
    comentarios: z.string().max(2000).optional(),
    chaveExterna: z.string().regex(/^[A-Za-z0-9#:_.-]{1,100}$/, 'chaveExterna: até 100 caracteres [A-Za-z0-9#:_.-]').optional(),
    modalidade: z.enum(['remoto', 'presencial']).optional(),
    endereco: z.string().max(300).optional(),
    casoId: idAstrea.optional(),
    contato: z
      .object({
        nome: z.string().trim().min(1).max(200),
        telefone: z.string().max(40).optional(),
        email: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
    criarAtendimento: z.boolean().optional(),
    verificarConflito: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.diaTodo === true || !!b.horaInicio, {
    message: 'horaInicio é obrigatória quando não é dia inteiro',
    path: ['horaInicio'],
  });

const remarcarSchema = z
  .object({
    data: dataSchema('data'),
    horaInicio: horaSchema.optional(),
    horaFim: horaSchema.optional(),
    diaTodo: z.boolean().optional(),
    responsavelId: idAstrea.optional(),
    verificarConflito: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.diaTodo === true || !!b.horaInicio, {
    message: 'horaInicio é obrigatória quando não é dia inteiro',
    path: ['horaInicio'],
  });

const eventosDoContatoSchema = z
  .object({
    telefone: z.string().max(40).optional(),
    nome: z.string().max(200).optional(),
    chaveExterna: z.string().max(100).optional(),
    inicio: dataSchema('inicio'),
    fim: dataSchema('fim'),
    responsavelIds: idsCsvSchema,
    incluirCancelados: booleanQuery.optional(),
  })
  .refine((q) => !!q.telefone?.trim() || !!q.chaveExterna?.trim(), {
    message: 'informe telefone ou chaveExterna (nome sozinho não identifica o contato)',
    path: ['telefone'],
  });

const forcarSchema = z.object({ forcar: booleanQuery.optional() });

function statusHttp(error: ServiceError): number {
  switch (error.code) {
    case 'VALIDATION_ERROR':
      return 400;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'FORBIDDEN':
      return 403;
    case 'BROWSER_UNAVAILABLE':
      return 503;
    case 'TIMEOUT':
      return 504;
    default:
      return 500;
  }
}

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

/**
 * GET /api/agenda/disponibilidade
 *
 * Intervalos OCUPADOS por usuário do Astrea numa janela (≤ 31 dias), já com as
 * regras de bloqueio aplicadas (dia inteiro, envolvidos, horaFim ausente) e
 * intervalos fundidos. Cache de 60 s; `fresh=1` ignora o cache.
 */
router.get('/disponibilidade', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = disponibilidadeSchema.parse(req.query);
    const result = await calcularDisponibilidade({
      responsavelIds: q.responsavelIds,
      inicio: q.inicio,
      fim: q.fim,
      tipos: q.tipos,
      duracaoPadraoMin: q.duracaoPadraoMin,
      fresh: q.fresh,
      incluirTitulos: q.incluirTitulos,
    });

    if (!result.ok) {
      responderErro(res, result.error);
      return;
    }

    const response: ApiResponse<typeof result.data> = { success: true, data: result.data };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

function responderErro(res: Response, erro: ServiceError): void {
  const status = statusHttp(erro);
  if (status === 503) res.setHeader('Retry-After', 30);
  const error: ApiError = {
    success: false,
    error: erro.message.replace(/^[A-Z_]+:\s*/, ''),
    code: erro.code,
    ...(erro.details !== undefined && { details: erro.details }),
  };
  res.status(status).json(error);
}

/**
 * POST /api/agenda/eventos — cria compromisso na agenda do Astrea.
 * 201 criado; 200 reaproveitado (mesma chaveExterna); 409 horário ocupado.
 */
router.post('/eventos', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = criarEventoSchema.parse(req.body ?? {});
    const result = await criarEventoAgenda(body);
    if (!result.ok) {
      responderErro(res, result.error);
      return;
    }
    const response: ApiResponse<typeof result.data> = { success: true, data: result.data };
    res.status(result.data.reaproveitado ? 200 : 201).json(response);
  } catch (err) {
    next(err);
  }
});

/** GET /api/agenda/eventos — compromissos de um contato (telefone/nome/chaveExterna) na janela. */
router.get('/eventos', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = eventosDoContatoSchema.parse(req.query);
    const result = await buscarEventosPorContato(q);
    if (!result.ok) {
      responderErro(res, result.error);
      return;
    }
    const response: ApiResponse<typeof result.data> = { success: true, data: result.data };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/** GET /api/agenda/eventos/:id */
router.get('/eventos/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await buscarEventoAgenda(req.params.id);
    if (!result.ok) {
      responderErro(res, result.error);
      return;
    }
    const response: ApiResponse<typeof result.data> = { success: true, data: result.data };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/agenda/eventos/:id — remarca (data/hora), checando conflito. */
router.patch('/eventos/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = remarcarSchema.parse(req.body ?? {});
    const { forcar } = forcarSchema.parse(req.query);
    const result = await remarcarEventoAgenda(req.params.id, body, { forcar });
    if (!result.ok) {
      responderErro(res, result.error);
      return;
    }
    const response: ApiResponse<typeof result.data> = { success: true, data: result.data };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/** POST /api/agenda/eventos/:id/cancelar — status CANCELED (mantém histórico). */
router.post('/eventos/:id/cancelar', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const motivo = z.object({ motivo: z.string().max(500).optional() }).parse(req.body ?? {}).motivo;
    const { forcar } = forcarSchema.parse(req.query);
    const result = await cancelarEventoAgenda(req.params.id, motivo, { forcar });
    if (!result.ok) {
      responderErro(res, result.error);
      return;
    }
    const response: ApiResponse<typeof result.data> = { success: true, data: result.data };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/agenda/eventos/:id — exclui o compromisso. */
router.delete('/eventos/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { forcar } = forcarSchema.parse(req.query);
    const result = await excluirEventoAgenda(req.params.id, { forcar });
    if (!result.ok) {
      responderErro(res, result.error);
      return;
    }
    const response: ApiResponse<typeof result.data> = { success: true, data: result.data };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

export default router;
