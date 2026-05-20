import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  atualizarCliente,
  criarCliente,
  listarClientes,
  buscarCliente as buscarClientePorId,
  listarTodosClientes,
  listarAniversariantesEnriquecidos,
} from '../services/clientes.service.js';
import {
  buscarCaso as buscarCasoPorId,
  buscarCasosPorCliente,
  criarCaso,
  criarProcesso,
  listarProcessos,
  vincularClienteCaso,
} from '../services/casos.service.js';
import {
  listarTarefas,
  criarTarefa,
  atualizarTarefa,
  buscarTarefasPorProcesso,
  comentarTarefa,
} from '../services/tarefas.service.js';
import {
  criarAtendimento,
  listarAtendimentos,
  transformarAtendimentoEmCaso,
  transformarAtendimentoEmProcesso,
} from '../services/atendimentos.service.js';
import { listarUsuarios } from '../services/usuarios.service.js';
import { adicionarDocumentoLink } from '../services/documentos.service.js';
import {
  listarAndamentos,
  buscarAndamentosRecentes,
} from '../services/andamentos.service.js';
import { listarPublicacoes } from '../services/publicacoes.service.js';
import {
  listarQuadros,
  listarAtividadesQuadro,
  moverAtividade,
} from '../services/kanban.service.js';
import { listarAgenda } from '../services/agenda.service.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'astrea-mcp',
    version: '1.0.0',
  });

  server.tool(
    'listar_clientes',
    'Lista clientes do escritório com filtros opcionais. O filtro `cpfCnpj` aceita com ou sem máscara (comparação feita pelos dígitos). Filtros nativos do Astrea (aplicados server-side, sem chamadas extras): `mesAniversario` (1-12, ex.: 5 = aniversariantes de maio), `estado` (UF, ex.: "SP"), `etiquetasIds` (IDs numéricos das tags), `apenasComEmail` (true para retornar só contatos com email cadastrado), `buscarEmEmpresa` (true estende a busca textual ao campo empresa/cargo). Cada item inclui `url` com o link direto do contato no app do Astrea.',
    {
      nome: z.string().optional(),
      email: z.string().optional(),
      cpfCnpj: z.string().optional(),
      mesAniversario: z.number().int().min(1).max(12).optional(),
      estado: z.string().length(2).optional(),
      etiquetasIds: z.array(z.number().int().positive()).optional(),
      apenasComEmail: z.boolean().optional(),
      buscarEmEmpresa: z.boolean().optional(),
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
    'Busca um cliente por ID. Retorna `url` com o link direto do contato no app do Astrea. ' +
      'Por padrão NÃO carrega a aba Documentos (scrape lento — 1-15s no caminho feliz, até 45s+ quando o DOM do Astrea muda). ' +
      'Passe `incluirDocumentos: true` apenas se precisar do array `documentos[]`.',
    {
      id: z.string(),
      incluirDocumentos: z
        .boolean()
        .optional()
        .describe(
          'Se true, carrega a aba Documentos do contato (operação lenta). Default false.',
        ),
    },
    async (input) => {
      const result = await buscarClientePorId(input.id, {
        incluirDocumentos: input.incluirDocumentos ?? false,
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

  server.tool(
    'listar_todos_clientes',
    'Lista todos os clientes (resumido, sem paginação). Aceita filtros nativos do Astrea aplicados server-side: `mesAniversario` (1-12), `estado` (UF), `etiquetasIds` (IDs das tags), `apenasComEmail`. Use `mesAniversario` para responder "quem faz aniversário em <mês>" sem chamar `buscar_cliente` por ID — uma única chamada já filtra. Cada item inclui `url` com o link direto do contato no app do Astrea. ATENÇÃO: para varredura de aniversariantes, prefira `listar_aniversariantes` — devolve a lista JÁ enriquecida (com `dataNascimento`, `cpfCnpj`, telefone, email) em UMA chamada, dispensando o passo de `buscar_cliente` por ID.',
    {
      mesAniversario: z.number().int().min(1).max(12).optional(),
      estado: z.string().length(2).optional(),
      etiquetasIds: z.array(z.number().int().positive()).optional(),
      apenasComEmail: z.boolean().optional(),
    },
    async (input) => {
      const result = await listarTodosClientes(input);
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
    'listar_aniversariantes',
    'Retorna aniversariantes de um mês JÁ ENRIQUECIDOS com `dataNascimento` (ISO yyyy-MM-dd), `cpfCnpj`, telefone, email, endereço, urlDrive, tipo (pessoa_fisica/juridica) e origem — em UMA única chamada (independentemente de quantos aniversariantes existirem). Substitui o fluxo antigo `listar_todos_clientes({mesAniversario:N})` + N×`buscar_cliente(id)`, que fazia dezenas de chamadas. Use para varredura de aniversariantes / mensagens automáticas.',
    {
      mes: z.number().int().min(1).max(12).describe('Mês do aniversário (1-12).'),
      estado: z.string().length(2).optional().describe('Filtro opcional por UF (ex: ES).'),
      etiquetasIds: z
        .array(z.number().int().positive())
        .optional()
        .describe('IDs das tags para filtrar.'),
    },
    async (input) => {
      const result = await listarAniversariantesEnriquecidos(input);
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
    'atualizar_cliente',
    'Atualiza parcialmente o cadastro de um cliente/contato no Astrea. Apenas os campos informados são alterados — os demais ficam intactos. Útil para corrigir typos no nome, atualizar telefone/email/endereço, etc. Não permite alterar perfil/tipo (cliente vs contato, pessoa física vs jurídica) — para isso, use a UI do Astrea.',
    {
      id: z.string().describe('ID do cliente no Astrea'),
      nome: z.string().min(1).optional(),
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
      const { id, ...patch } = input;
      const result = await atualizarCliente(id, patch);
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
    'Busca um caso/processo por ID. Retorna `url` com o link direto do caso/processo no app do Astrea (e `urlCliente` quando houver cliente principal).',
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
    'listar_processos',
    'Enumera casos/processos do escritório no Astrea — listagem leve para audit ou cruzamentos (ex.: detectar processos sincronizados do tribunal com cliente anonimizado pra vincular ao cadastro completo). Filtros: `tipo` ("caso" = CTE_CASE, "processo" = CTE_LAWSUIT, "todos" — default `todos`), `status` ("ativo" — default, inclui Active+Suspended; "arquivado"; "todos"), `responsavelId` (compara contra o responsável do caso), `pagina`/`limite` (default 1/50). Cada item traz `id`, `titulo`, `numeroProcesso` (só pra processos), `clientePrincipalNome`, `responsavelNome`, `tipo`, `status` e `url` direta no app do Astrea. Sem heurística de detecção — quem decide o que fazer com a lista é o caller.',
    {
      tipo: z.enum(['caso', 'processo', 'todos']).optional(),
      status: z.enum(['ativo', 'arquivado', 'todos']).optional(),
      responsavelId: z.string().optional(),
      pagina: z.number().int().positive().optional(),
      limite: z.number().int().min(1).max(200).optional(),
    },
    async (input) => {
      const result = await listarProcessos(input);
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
    'Lista casos de um cliente. Cada item inclui `url` com o link direto do caso/processo no app do Astrea.',
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
    'Lista tarefas com filtros. Por padrão retorna apenas tarefas ativas (pendentes); passe incluirConcluidas=true para também trazer as concluídas (chamada extra ao Astrea). Use responsavelId para restringir ao escopo de tarefas de um usuário específico. Para filtrar por prazo, use dias (ex.: dias=7 para próximos 7 dias a partir de hoje) ou prazoInicio/prazoFim no formato YYYY-MM-DD. Cada item inclui `urlCaso` quando há caso/processo vinculado (link direto no app do Astrea).',
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
    'comentar_tarefa',
    'Adiciona um comentário (texto puro) em uma tarefa do Astrea — equivale à aba "Comentários" da UI. Útil para registrar o que foi feito ao concluir, ou para deixar instruções na tarefa atribuída a outro colaborador. Não suporta menção (@usuário) nem anexos nesta versão.',
    {
      tarefaId: z.string(),
      texto: z.string(),
    },
    async (input) => {
      const result = await comentarTarefa(input.tarefaId, input.texto);
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
    'Lista tarefas associadas a um processo. Cada item inclui `urlCaso` com o link direto do caso/processo no app do Astrea.',
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
    'listar_andamentos',
    'Lista os andamentos (histórico) de um processo específico. Aceita filtro por janela de data (dataInicio/dataFim em YYYY-MM-DD ou dias para últimos N dias), por tipo (ex.: APPOINTMENT, DONE_TASK), e por responsável (responsavelId para id exato, responsavel para substring do nome). Cada item inclui `urlProcesso` com o link direto do caso/processo no app do Astrea.',
    {
      processoId: z.string(),
      dataInicio: z.string().optional(),
      dataFim: z.string().optional(),
      dias: z.number().optional(),
      responsavel: z.string().optional(),
      responsavelId: z.string().optional(),
      tipo: z.string().optional(),
      pagina: z.number().optional(),
      limite: z.number().optional(),
    },
    async (input) => {
      const { processoId, ...filtros } = input;
      const result = await listarAndamentos(processoId, filtros);
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
    'andamentos_recentes',
    'Retorna andamentos recentes de todos os processos do escritório (default últimos 30 dias). Aceita filtros por janela de data (dias, dataInicio/dataFim), por tipo e por responsável (responsavelId ou responsavel). Cada item inclui `urlProcesso` com o link direto do caso/processo no app do Astrea.',
    {
      dias: z.number().optional(),
      dataInicio: z.string().optional(),
      dataFim: z.string().optional(),
      responsavel: z.string().optional(),
      responsavelId: z.string().optional(),
      tipo: z.string().optional(),
      pagina: z.number().optional(),
      limite: z.number().optional(),
    },
    async (input) => {
      const result = await buscarAndamentosRecentes(input);
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
    'listar_publicacoes',
    'Lista publicações (clippings do DJE) do escritório. Filtros: dataInicio/dataFim (YYYY-MM-DD), dias (últimos N), lida (boolean), responsavel (busca por substring no nome do advogado monitorado cuja pesquisa capturou a publicação). Cada item inclui `urlCaso` quando há caso/processo vinculado (link direto no app do Astrea).',
    {
      dataInicio: z.string().optional(),
      dataFim: z.string().optional(),
      dias: z.number().optional(),
      lida: z.boolean().optional(),
      responsavel: z.string().optional(),
      pagina: z.number().optional(),
      limite: z.number().optional(),
    },
    async (input) => {
      const result = await listarPublicacoes(input);
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
    'Lista atendimentos com filtros. Cada item inclui `urlCliente` e `urlCaso` (quando vinculados) com links diretos no app do Astrea.',
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
    'criar_caso',
    'Cria um caso direto (sem passar por atendimento). Identifique o cliente por ID numérico, nome ou CPF — busca textual usa o primeiro match. Para cadastrar um processo judicial use `criar_processo`.',
    {
      cliente: z.string().describe('ID, nome ou CPF do cliente'),
      titulo: z.string().describe('Título do caso'),
      descricao: z.string().optional(),
      observacoes: z.string().optional(),
      responsavelId: z.string().optional(),
      sharingType: z.enum(['publico', 'privado', 'equipe']).optional(),
      tagsIds: z.array(z.string()).optional(),
      teamId: z.string().optional(),
    },
    async (input) => {
      const result = await criarCaso(input);
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
    'criar_processo',
    'Cria um processo judicial direto (sem passar por atendimento). Identifique o cliente por ID, nome ou CPF. Papel do cliente default é "Autor"; passe `papelCliente` para sobrescrever.',
    {
      cliente: z.string().describe('ID, nome ou CPF do cliente'),
      titulo: z.string().describe('Título do processo'),
      descricao: z.string().optional(),
      observacoes: z.string().optional(),
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
      papelCliente: z.string().optional(),
    },
    async (input) => {
      const result = await criarProcesso(input);
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
    'vincular_cliente_caso',
    'Adiciona um cliente cadastrado completo como cliente adicional de um caso/processo já existente — útil para corrigir processos sincronizados automaticamente do tribunal cujo cliente principal vem anonimizado (ex.: "I. P." em vez de "IRINEU PEDRO"). Não remove o cliente original (manter preserva a sincronização), apenas faz append em `customers`. Idempotente: chamar 2x com mesmo `casoId`+`clienteId` é no-op na segunda chamada (retorna `alreadyLinked: true`). Para processos, o papel é resolvido via `getStakeholderRoleByName` quando fornecido, ou copiado do primeiro cliente existente quando omitido. Use `isClientePrincipal: true` para promover o novo cliente a principal (remove `main` dos outros).',
    {
      casoId: z.string().describe('ID do caso/processo no Astrea'),
      clienteId: z.string().describe('ID do contato cadastrado a vincular'),
      papel: z
        .string()
        .optional()
        .describe('Papel da nova parte (ex.: "Reclamante", "Autor"). Default: copia do primeiro cliente existente.'),
      isClientePrincipal: z
        .boolean()
        .optional()
        .describe('Quando true, novo cliente vira o principal (default: false — mantém o original)'),
    },
    async (input) => {
      const result = await vincularClienteCaso(input);
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

  server.tool(
    'listar_quadros_kanban',
    'Lista os quadros (boards) do módulo "Gestão Kanban" do escritório, com suas colunas. Cada quadro tem `padrao=true` quando é o quadro principal do tenant. Use para descobrir o `quadroId` e os `colunaId` antes de listar atividades ou mover cards.',
    {},
    async () => {
      const result = await listarQuadros();
      if (!result.ok) {
        return { content: [{ type: 'text', text: `Erro: ${result.error.message}` }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.tool(
    'listar_atividades_kanban',
    'Lista as atividades (cards) de um quadro Kanban, agrupadas por coluna. Atividades com `tipo === "TASK"` têm `id` igual ao `taskId` — pode ser usado em `comentar_tarefa`/`atualizar_tarefa`. Janela padrão: mês corrente. Filtros: `prazoInicio`/`prazoFim` (YYYY-MM-DD), `dias` (últimos N dias), `responsavelId`, `envolvidosIds`, `tipos` (ex.: ["TASK"]). Cada atividade inclui `urlCaso` quando há caso/processo vinculado.',
    {
      quadroId: z.string(),
      prazoInicio: z.string().optional(),
      prazoFim: z.string().optional(),
      dias: z.number().optional(),
      responsavelId: z.string().optional(),
      envolvidosIds: z.array(z.string()).optional(),
      tipos: z.array(z.string()).optional(),
      limite: z.number().optional(),
    },
    async (input) => {
      const { quadroId, ...filtros } = input;
      const result = await listarAtividadesQuadro(quadroId, filtros);
      if (!result.ok) {
        return { content: [{ type: 'text', text: `Erro: ${result.error.message}` }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.tool(
    'mover_atividade_kanban',
    'Move uma atividade (card) entre colunas de um quadro Kanban. Use `listar_quadros_kanban` para obter `quadroId` e os `colunaDestinoId` válidos.',
    {
      quadroId: z.string(),
      atividadeId: z.string(),
      colunaDestinoId: z.string(),
    },
    async (input) => {
      const result = await moverAtividade(input.quadroId, input.atividadeId, input.colunaDestinoId);
      if (!result.ok) {
        return { content: [{ type: 'text', text: `Erro: ${result.error.message}` }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    },
  );

  server.tool(
    'listar_agenda',
    'Retorna a agenda unificada do escritório no Astrea — prazos, tarefas, atendimentos e audiências numa única chamada, igual à tela "Agenda" do app. Use para responder perguntas como "o que a Letícia Bernabé tem essa semana?" ou "quais audiências do Rafael Victor no próximo mês?". Filtros: `responsavelId` (omitir = todos os ativos; descubra o ID via `listar_usuarios`), `inicio`/`fim` em YYYY-MM-DD (default = semana corrente, domingo a sábado), `tipos` (subset de prazo/tarefa/atendimento/audiencia), `status` (todos/pendentes/concluidos), `incluirSemPrazo` (true para também trazer tarefas sem deadline marcada), `numeroProcesso` (CNJ com ou sem máscara) para encontrar prazos/tarefas de um processo específico — útil pra cruzar contra intimações pendentes. Cada item inclui `responsavelNome`, `tituloComResponsavel` (formato "iniciais - título" usado pelo Astrea), `urlCaso`, e campos específicos por tipo (horários para atendimentos/audiências; `forum`/`endereco`/`sala` para audiências).',
    {
      responsavelId: z.string().optional(),
      inicio: z.string().optional(),
      fim: z.string().optional(),
      tipos: z.array(z.enum(['prazo', 'tarefa', 'atendimento', 'audiencia'])).optional(),
      status: z.enum(['todos', 'pendentes', 'concluidos']).optional(),
      incluirSemPrazo: z.boolean().optional(),
      numeroProcesso: z.string().optional(),
    },
    async (input) => {
      const result = await listarAgenda(input);
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
