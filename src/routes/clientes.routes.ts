import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  atualizarCliente,
  buscarCliente,
  criarCliente,
  listarAniversariantesEnriquecidos,
  listarClientes,
  listarTodosClientes,
  mesclarClientes,
} from '../services/clientes.service.js';
import { buscarCasosPorCliente } from '../services/casos.service.js';
import { adicionarDocumentoLink } from '../services/documentos.service.js';
import type { ApiResponse, ApiError } from '../types/index.js';

const router = Router();

/**
 * Aceita "1,2,3" (CSV) ou ["1","2"] (param repetido) e retorna number[].
 * Usado para `etiquetasIds` no query string.
 */
const idsArraySchema = z
  .preprocess((val) => {
    if (val == null || val === '') return undefined;
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') {
      return val
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return val;
  }, z.array(z.coerce.number().int().positive()))
  .optional();

const booleanQuerySchema = z
  .preprocess((val) => {
    if (typeof val === 'string') {
      if (val === 'true' || val === '1') return true;
      if (val === 'false' || val === '0') return false;
    }
    return val;
  }, z.boolean())
  .optional();

const filtrosNativosSchema = {
  mesAniversario: z.coerce.number().int().min(1).max(12).optional(),
  estado: z
    .string()
    .trim()
    .length(2)
    .transform((v) => v.toUpperCase())
    .optional(),
  etiquetasIds: idsArraySchema,
  apenasComEmail: booleanQuerySchema,
};

const querySchema = z.object({
  nome: z.string().optional(),
  cpfCnpj: z.string().optional(),
  email: z.string().optional(),
  ...filtrosNativosSchema,
  buscarEmEmpresa: booleanQuerySchema,
  pagina: z.coerce.number().int().positive().default(1),
  limite: z.coerce.number().int().min(1).max(100).default(50),
});

const queryTodosSchema = z.object(filtrosNativosSchema);

const queryAniversariantesSchema = z.object({
  mes: z.coerce.number().int().min(1).max(12),
  estado: z
    .string()
    .trim()
    .length(2)
    .transform((v) => v.toUpperCase())
    .optional(),
  etiquetasIds: idsArraySchema,
});

const enderecoSchema = z.union([
  z.string(),
  z.object({
    cep: z.string().optional(),
    logradouro: z.string().optional(),
    numero: z.string().optional(),
    complemento: z.string().optional(),
    bairro: z.string().optional(),
    cidade: z.string().optional(),
    estado: z.string().optional(),
    pais: z.string().optional(),
  }),
]);

const criarClienteSchema = z.object({
  nome: z.string().min(1),
  perfil: z.enum(['cliente', 'contato']).optional(),
  tipo: z.enum(['pessoa_fisica', 'pessoa_juridica']).optional(),
  apelido: z.string().optional(),
  cpfCnpj: z.string().optional(),
  origem: z.string().optional(),
  site: z.string().optional(),
  email: z.string().optional(),
  telefone: z.string().optional(),
  endereco: enderecoSchema.optional(),
});

const atualizarClienteSchema = z
  .object({
    nome: z.string().min(1).optional(),
    apelido: z.string().optional(),
    cpfCnpj: z.string().optional(),
    origem: z.string().optional(),
    site: z.string().optional(),
    email: z.string().optional(),
    telefone: z.string().optional(),
    endereco: enderecoSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Pelo menos um campo deve ser informado para atualização',
  });

/** GET /api/clientes */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filtros = querySchema.parse(req.query);
    const result = await listarClientes(filtros);

    if (!result.ok) {
      const error: ApiError = {
        success: false,
        error: result.error.message,
        code: result.error.code,
      };
      const status =
        result.error.code === 'BROWSER_UNAVAILABLE'
          ? 503
          : result.error.code === 'NOT_FOUND'
            ? 404
            : 500;
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

/** POST /api/clientes */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = criarClienteSchema.parse(req.body);
    const result = await criarCliente(body);

    if (!result.ok) {
      const error: ApiError = {
        success: false,
        error: result.error.message,
        code: result.error.code,
      };
      const status =
        result.error.code === 'VALIDATION_ERROR'
          ? 400
          : result.error.code === 'BROWSER_UNAVAILABLE'
            ? 503
            : result.error.code === 'NOT_FOUND'
              ? 404
              : 500;
      res.status(status).json(error);
      return;
    }

    const response: ApiResponse<typeof result.data> = { success: true, data: result.data };
    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

const mesclarClientesSchema = z.object({
  idPrincipal: z.string().min(1),
  idsMesclados: z.array(z.string().min(1)).min(1),
});

/**
 * POST /api/clientes/mesclar
 * Unifica dois ou mais contatos no contato principal.
 * Ação IRREVERSÍVEL: os contatos em `idsMesclados` deixam de existir.
 */
router.post('/mesclar', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = mesclarClientesSchema.parse(req.body);
    const result = await mesclarClientes(body);

    if (!result.ok) {
      const error: ApiError = {
        success: false,
        error: result.error.message,
        code: result.error.code,
      };
      const status =
        result.error.code === 'VALIDATION_ERROR'
          ? 400
          : result.error.code === 'NOT_FOUND'
            ? 404
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

/** GET /api/clientes/todos — Lista completa de todos os clientes com ID e nome */
router.get('/todos', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filtros = queryTodosSchema.parse(req.query);
    const result = await listarTodosClientes(filtros);

    if (!result.ok) {
      const error: ApiError = {
        success: false,
        error: result.error.message,
        code: result.error.code,
      };
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

/**
 * GET /api/clientes/aniversariantes?mes=6[&estado=ES][&etiquetasIds=1,2]
 *
 * Retorna aniversariantes do mês JÁ enriquecidos (com `dataNascimento` em
 * ISO, `cpfCnpj`, telefone, email, endereço, urlDrive). Uma única chamada
 * cobre o que antes era `listar_todos_clientes(mes)` + N×`buscar_cliente(id)`.
 */
router.get('/aniversariantes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filtros = queryAniversariantesSchema.parse(req.query);
    const result = await listarAniversariantesEnriquecidos(filtros);

    if (!result.ok) {
      const error: ApiError = {
        success: false,
        error: result.error.message,
        code: result.error.code,
      };
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

/**
 * PATCH /api/clientes/:id
 * Atualiza parcialmente o cadastro de um contato. Campos não informados
 * permanecem inalterados.
 */
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const body = atualizarClienteSchema.parse(req.body);
    const result = await atualizarCliente(id, body);

    if (!result.ok) {
      const error: ApiError = {
        success: false,
        error: result.error.message,
        code: result.error.code,
      };
      const status =
        result.error.code === 'VALIDATION_ERROR'
          ? 400
          : result.error.code === 'NOT_FOUND'
            ? 404
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

/** GET /api/clientes/:id */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const incluirDocumentosRaw = req.query['incluirDocumentos'];
    const incluirDocumentos =
      incluirDocumentosRaw === 'true' || incluirDocumentosRaw === '1';
    const result = await buscarCliente(id, { incluirDocumentos });

    if (!result.ok) {
      const error: ApiError = {
        success: false,
        error: result.error.message,
        code: result.error.code,
      };
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
      const error: ApiError = {
        success: false,
        error: result.error.message,
        code: result.error.code,
      };
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

// ─────────────────────────────────────────────────────────────────────────────
// Documentos
// ─────────────────────────────────────────────────────────────────────────────

const adicionarDocumentoSchema = z.object({
  link: z.string().url(),
  descricao: z.string().min(1),
});

/** POST /api/clientes/:id/documentos — Adiciona um documento tipo Link ao cliente */
router.post('/:id/documentos', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const body = adicionarDocumentoSchema.parse(req.body);

    const result = await adicionarDocumentoLink({
      link: body.link,
      descricao: body.descricao,
      clienteId: id,
    });

    if (!result.ok) {
      const error: ApiError = {
        success: false,
        error: result.error.message,
        code: result.error.code,
      };
      const status =
        result.error.code === 'BROWSER_UNAVAILABLE'
          ? 503
          : result.error.code === 'VALIDATION_ERROR'
            ? 400
            : 500;
      res.status(status).json(error);
      return;
    }

    const response: ApiResponse<typeof result.data> = { success: true, data: result.data };
    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

export default router;
