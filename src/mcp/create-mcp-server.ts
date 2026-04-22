import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  criarCliente,
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
import {
  criarAtendimento,
  listarAtendimentos,
  transformarAtendimentoEmCaso,
  transformarAtendimentoEmProcesso,
} from '../services/atendimentos.service.js';
import { listarUsuarios } from '../services/usuarios.service.js';
import { adicionarDocumentoLink } from '../services/documentos.service.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'astrea-mcp',
    version: '1.0.0',
  });

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
        return {
          content: [{ type: 'text', text: `Erro: ${result.error.message}` }],
          isError: true,
        };
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
        return {
          content: [{ type: 'text', text: `Erro: ${result.error.message}` }],
          isError: true,
        };
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
        return {
          content: [{ type: 'text', text: `Erro: ${result.error.message}` }],
          isError: true,
        };
      }
      const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    },
  );

  server.tool(
    'criar_cliente',
    'Cria um cliente/contato no Astrea.',
    {
      nome: z.string(),
      perfil: z.enum(['cliente', 'contato']).optional(),
      tipo: z.enum(['pessoa_fisica', 'pessoa_juridica']).optional(),
      apelido: z.string().optional(),
      cpfCnpj: z.string().optional(),
      origem: z.string().optional(),
      site: z.string().optional(),
      email: z.string().optional(),
      telefone: z.string().optional(),
      endereco: z
        .union([
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
        ])
        .optional(),
    },
    async (input) => {
      const result = await criarCliente(input);
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: `Erro: ${result.error.message}` }],
          isError: true,
        };
      }
      const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    },
  );

  server.tool(
    'buscar_caso',
    'Busca um caso/processo por ID.',
    {
      id: z.string(),
    },
    async (input) => {
      const result = await buscarCasoPorId(input.id);
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: `Erro: ${result.error.message}` }],
          isError: true,
        };
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
        return {
          content: [{ type: 'text', text: `Erro: ${result.error.message}` }],
          isError: true,
        };
      }
      const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    },
  );

  server.tool(
    'listar_tarefas',
    'Lista tarefas com filtros. Por padrão retorna apenas tarefas ativas (pendentes); passe incluirConcluidas=true para também trazer as concluídas (chamada extra ao Astrea). Use responsavelId para restringir ao escopo de tarefas de um usuário específico. Para filtrar por prazo, use dias (ex.: dias=7 para próximos 7 dias a partir de hoje) ou prazoInicio/prazoFim no formato YYYY-MM-DD.',
    {
      status: z.string().optional(),
      casoId: z.string().optional(),
      responsavel: z.string().optional(),
      responsavelId: z.string().optional(),
      incluirConcluidas: z.boolean().optional(),
      prazoInicio: z.string().optional(),
      prazoFim: z.string().optional(),
      dias: z.number().optional(),
      pagina: z.number().optional(),
      limite: z.number().optional(),
    },
    async (input) => {
      const result = await listarTarefas(input);
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: `Erro: ${result.error.message}` }],
          isError: true,
        };
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
        return {
          content: [{ type: 'text', text: `Erro: ${result.error.message}` }],
          isError: true,
        };
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
        return {
          content: [{ type: 'text', text: `Erro: ${result.error.message}` }],
          isError: true,
        };
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
        return {
          content: [{ type: 'text', text: `Erro: ${result.error.message}` }],
          isError: true,
        };
      }
      const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    },
  );

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
        return {
          content: [{ type: 'text', text: `Erro: ${result.error.message}` }],
          isError: true,
        };
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
        return {
          content: [{ type: 'text', text: `Erro: ${result.error.message}` }],
          isError: true,
        };
      }
      const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    },
  );

  server.tool(
    'transformar_atendimento_em_caso',
    'Transforma um atendimento em caso.',
    {
      atendimentoId: z.string(),
      titulo: z.string().optional(),
      descricao: z.string().optional(),
      observacoes: z.string().optional(),
      responsavelId: z.string().optional(),
      sharingType: z.enum(['publico', 'privado', 'equipe']).optional(),
      tagsIds: z.array(z.string()).optional(),
      teamId: z.string().optional(),
    },
    async (input) => {
      const { atendimentoId, ...payload } = input;
      const result = await transformarAtendimentoEmCaso(atendimentoId, payload);
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: `Erro: ${result.error.message}` }],
          isError: true,
        };
      }
      const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    },
  );

  server.tool(
    'transformar_atendimento_em_processo',
    'Transforma um atendimento em processo.',
    {
      atendimentoId: z.string(),
      titulo: z.string().optional(),
      observacoes: z.string().optional(),
      descricao: z.string().optional(),
      responsavelId: z.string().optional(),
      sharingType: z.enum(['publico', 'privado', 'equipe']).optional(),
      tagsIds: z.array(z.string()).optional(),
      teamId: z.string().optional(),
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
    },
    async (input) => {
      const { atendimentoId, ...payload } = input;
      const result = await transformarAtendimentoEmProcesso(atendimentoId, payload);
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: `Erro: ${result.error.message}` }],
          isError: true,
        };
      }
      const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    },
  );

  server.tool(
    'adicionar_documento_link',
    'Adiciona um documento tipo Link (URL) ao cadastro de um cliente. Usado para registrar a pasta Drive do cliente, por exemplo.',
    {
      clienteId: z.string().describe('ID do cliente no Astrea'),
      link: z.string().url().describe('URL do link a registrar'),
      descricao: z.string().describe('Descrição do documento (ex: "Pasta Drive")'),
    },
    async (input) => {
      const result = await adicionarDocumentoLink({
        link: input.link,
        descricao: input.descricao,
        clienteId: input.clienteId,
      });
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: `Erro: ${result.error.message}` }],
          isError: true,
        };
      }
      const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    },
  );

  server.tool('listar_usuarios', 'Lista usuários/advogados do escritório.', {}, async () => {
    const result = await listarUsuarios();
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Erro: ${result.error.message}` }], isError: true };
    }
    const output = result.meta ? { data: result.data, meta: result.meta } : result.data;
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  });

  return server;
}
