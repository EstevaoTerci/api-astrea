import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { browserPool } from '../browser/pool.js';
import { logger } from '../utils/logger.js';

// Import all service functions
import {
  listarClientes,
  buscarCliente as buscarClientePorId,
  listarTodosClientes,
} from '../services/clientes.service.js';
import { buscarCaso as buscarCasoPorId, buscarCasosPorCliente } from '../services/casos.service.js';
import {
  listarTarefas,
  criarTarefa,
  atualizarTarefa,
  buscarTarefasPorProcesso,
} from '../services/tarefas.service.js';
import { listarAtendimentos, criarAtendimento } from '../services/atendimentos.service.js';
import { listarUsuarios } from '../services/usuarios.service.js';

const server = new McpServer({
  name: 'astrea-mcp',
  version: '1.0.0',
});

// ─────────────────────────────────────────────────────────────────────────────
// Clientes
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
  'listar_clientes',
  'Lista clientes do escritório com filtros opcionais.',
  {
    nome: z.string().optional(),
    email: z.string().optional(),
    cpfCnpj: z.string().optional(),
    pagina: z.number().optional(),
    limite: z.number().optional(),
  },
  async (input) => {
    const result = await listarClientes(input);
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Erro: ${result.error.message}` }], isError: true };
    }
    const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  },
);

server.tool(
  'buscar_cliente',
  'Busca um cliente por ID.',
  {
    id: z.string(),
  },
  async (input) => {
    const result = await buscarClientePorId(input.id);
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Erro: ${result.error.message}` }], isError: true };
    }
    const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  },
);

server.tool(
  'listar_todos_clientes',
  'Lista todos os clientes (resumido, sem paginação).',
  {},
  async () => {
    const result = await listarTodosClientes();
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Erro: ${result.error.message}` }], isError: true };
    }
    const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Casos
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
  'buscar_caso',
  'Busca um caso/processo por ID.',
  {
    id: z.string(),
  },
  async (input) => {
    const result = await buscarCasoPorId(input.id);
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Erro: ${result.error.message}` }], isError: true };
    }
    const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  },
);

server.tool(
  'buscar_casos_por_cliente',
  'Lista casos de um cliente.',
  {
    clienteId: z.string(),
  },
  async (input) => {
    const result = await buscarCasosPorCliente(input.clienteId);
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Erro: ${result.error.message}` }], isError: true };
    }
    const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Tarefas
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
  'listar_tarefas',
  'Lista tarefas com filtros.',
  {
    status: z.string().optional(),
    casoId: z.string().optional(),
    responsavel: z.string().optional(),
    pagina: z.number().optional(),
    limite: z.number().optional(),
  },
  async (input) => {
    const result = await listarTarefas(input);
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Erro: ${result.error.message}` }], isError: true };
    }
    const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  },
);

server.tool(
  'criar_tarefa',
  'Cria uma tarefa em um caso do Astrea.',
  {
    titulo: z.string(),
    casoId: z.string().optional(),
    responsavelId: z.string(),
    listaId: z.string().optional(),
    prazo: z.string().optional(),
    prioridade: z.number().optional(),
  },
  async (input) => {
    const result = await criarTarefa(input);
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Erro: ${result.error.message}` }], isError: true };
    }
    const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  },
);

server.tool(
  'atualizar_tarefa',
  'Atualiza uma tarefa existente.',
  {
    id: z.string(),
    titulo: z.string().optional(),
    status: z.string().optional(),
    prazo: z.string().optional(),
    responsavelId: z.string().optional(),
    prioridade: z.number().optional(),
  },
  async (input) => {
    const { id, ...updateInput } = input;
    const result = await atualizarTarefa(id, updateInput);
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Erro: ${result.error.message}` }], isError: true };
    }
    const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  },
);

server.tool(
  'buscar_tarefas_por_processo',
  'Lista tarefas associadas a um processo.',
  {
    processoId: z.string(),
  },
  async (input) => {
    const result = await buscarTarefasPorProcesso(input.processoId);
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Erro: ${result.error.message}` }], isError: true };
    }
    const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Atendimentos
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
  'listar_atendimentos',
  'Lista atendimentos com filtros.',
  {
    clienteId: z.string().optional(),
    casoId: z.string().optional(),
    status: z.string().optional(),
    dataInicio: z.string().optional(),
    dataFim: z.string().optional(),
    pagina: z.number().optional(),
    limite: z.number().optional(),
  },
  async (input) => {
    const result = await listarAtendimentos(input);
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Erro: ${result.error.message}` }], isError: true };
    }
    const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  },
);

server.tool(
  'criar_atendimento',
  'Agenda um atendimento.',
  {
    clienteId: z.string(),
    casoId: z.string().optional(),
    assunto: z.string(),
    data: z.string(),
    hora: z.string(),
    responsavelId: z.string(),
    descricao: z.string().optional(),
    duracaoMinutos: z.number().optional(),
  },
  async (input) => {
    const result = await criarAtendimento(input);
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Erro: ${result.error.message}` }], isError: true };
    }
    const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Usuarios
// ─────────────────────────────────────────────────────────────────────────────

server.tool('listar_usuarios', 'Lista usuários/advogados do escritório.', {}, async () => {
  const result = await listarUsuarios();
  if (!result.ok) {
    return { content: [{ type: 'text', text: `Erro: ${result.error.message}` }], isError: true };
  }
  const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
  return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
});

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('Servidor MCP Astrea iniciado via stdio');

    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Encerrando servidor MCP Astrea...');
      await browserPool.shutdown().catch((err) => {
        logger.warn({ err }, 'Falha ao encerrar browser pool do MCP.');
      });
      process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (err) {
    logger.fatal({ err }, 'Falha ao iniciar servidor MCP');
    process.exit(1);
  }
}

main();
