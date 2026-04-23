/**
 * Modelo de Caso/Processo
 *
 * No Astrea, "casos" e "processos" compartilham a mesma entidade de negócio.
 * Um caso representa um problema jurídico trazido pelo cliente e pode ser
 * convertido em processo judicial. A flag `isProcesso` diferencia os dois.
 *
 * URLs de referência:
 *  - Detalhe:   https://astrea.net.br/#/main/folders/detail/{id}
 *  - Histórico: https://astrea.net.br/#/main/folders/history/%5B,{id}%5D
 */

// ─────────────────────────────────────────────────────────────────────────────
// Sub-tipos auxiliares
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parte envolvida no processo (autor, réu, terceiro, etc.).
 * Corresponde aos registros de "Autor", "Réu" e demais partes
 * na seção "Dados do Processo".
 */
export interface ParteProcesso {
  /** ID do contato no Astrea */
  contatoId?: string;

  /** Nome da parte */
  nome: string;

  /**
   * Papel/participação da parte no processo.
   * Ex: "Autor", "Réu", "Litisconsorte Ativo", "Litisconsorte Passivo",
   * "Terceiro Interessado", "Assistente", "Opoente".
   */
  papel: string;

  /** Indica se esta parte é o cliente principal do caso */
  isClientePrincipal?: boolean;
}

/**
 * Item do histórico (timeline) de um caso/processo.
 * Corresponde a uma linha da tabela em:
 * https://astrea.net.br/#/main/folders/history/%5B,{id}%5D
 */
export interface HistoricoItem {
  /**
   * Tipo de entrada no histórico.
   * Representado por ícone na UI. Valores conhecidos:
   * "tarefa", "tarefa_concluida", "andamento_manual",
   * "evento_sistema", "atendimento", "honorario".
   * Usar string para comportar novos tipos futuramente.
   */
  tipo: string;

  /** Data do histórico (ex: "06/02/2026") */
  data: string;

  /** Descrição ou título do histórico */
  descricao: string;

  /**
   * Resultado / realização associada à tarefa.
   * Exibido no formato "Tarefa - Realizado: resultado" na UI.
   * Ex: "Inicial elaborada"
   */
  realizado?: string;

  /** Instância processual em que ocorreu o evento */
  instancia?: string;

  /** Nome do responsável pelo registro */
  responsavel?: string;

  /** Título do caso/processo vinculado ao histórico */
  casoProcessoTitulo?: string;

  /** ID do caso/processo vinculado (extraído do link na UI) */
  casoProcessoId?: string;
}

/**
 * Recurso ou desdobramento processual.
 * Seção "Recursos e desdobramentos" na aba Resumo.
 */
export interface RecursoDesdobramento {
  id?: string;
  tipo?: string;
  titulo?: string;
  status?: string;
  criadoEm?: string;
}

/**
 * Atividade pendente (próxima atividade) do caso/processo.
 * Seção "Próximas atividades" na aba Resumo.
 */
export interface AtividadePendente {
  id?: string;
  titulo: string;
  prazo?: string;
  responsavel?: string;
  prioridade?: string;
}

/**
 * Valor financeiro registrado no processo.
 * Seção "Valores" na aba Resumo.
 */
export interface ValorProcesso {
  tipo?: string;
  descricao?: string;
  valor?: string;
  data?: string;
}

/**
 * Apenso (processo relacionado/apenso).
 * Seção "Apensos" na aba Resumo.
 */
export interface ApensoProcesso {
  id?: string;
  titulo?: string;
  numeroProcesso?: string;
  status?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entidade principal: CasoProcesso
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Caso ou Processo conforme dados disponíveis nas telas do Astrea:
 *  - /main/folders/detail/{id}  → metadados e resumo
 *  - /main/folders/history/[,{id}] → histórico completo
 */
export interface CasoProcesso {
  // ── Identificação ──────────────────────────────────────────────────────────
  /** ID numérico do caso/processo, extraído da URL (ex: "4752680428699648") */
  id: string;

  /** Título do caso/processo (ex: "Restabelecimento de Beneficio Assitencial - ADONIAS") */
  titulo: string;

  /** URL direta do caso/processo no app do Astrea (https://astrea.net.br/#/main/folders/detail/{id}). */
  url?: string;

  /**
   * Flag que indica se este registro é um processo judicial.
   * Quando `true`, os campos específicos de processo abaixo estarão preenchidos.
   * Quando `false`, trata-se apenas de um caso interno do escritório.
   */
  isProcesso: boolean;

  // ── Classificação e status ─────────────────────────────────────────────────
  /**
   * Área(s) jurídica(s) / etiquetas do caso.
   * Exibidas como tags coloridas na tela (ex: ["Previdenciário", "Previdenciário - LOAS - Deficiente"]).
   */
  etiquetas?: string[];

  /**
   * Status do caso/processo.
   * Valores conhecidos: "Ativo", "Encerrado", "Arquivado", "Suspenso".
   */
  status?: string;

  // ── Responsabilidade ───────────────────────────────────────────────────────
  /** Nome do advogado/responsável pelo caso */
  responsavel?: string;

  /** Nome de quem criou o registro no Astrea */
  criadoPor?: string;

  /** Data de criação do caso no Astrea (ex: "17/06/2025") */
  criadoEm?: string;

  // ── Partes ─────────────────────────────────────────────────────────────────
  /** ID do cliente principal vinculado ao caso */
  clienteId?: string;

  /** Nome do cliente principal */
  clienteNome?: string;

  /** URL direta do cliente principal no app do Astrea (quando houver clienteId). */
  urlCliente?: string;

  /**
   * Lista de todas as partes envolvidas (autor, réu, litisconsortes, etc.).
   * Visível na seção "Dados do Processo" no detalhe.
   */
  partes?: ParteProcesso[];

  // ── Dados processuais (somente quando isProcesso = true) ───────────────────
  /**
   * Número do processo judicial no formato CNJ.
   * Ex: "5000369-75.2026.8.08.0008"
   */
  numeroProcesso?: string;

  /**
   * Juízo / vara completo (nome como aparece no Astrea).
   * Ex: "1ª vara civel BARRA DE SÃO FRANCISCO"
   */
  juizo?: string;

  /**
   * Vara (apenas o identificador simplificado).
   * Ex: "1ª vara cível"
   */
  vara?: string;

  /**
   * Tribunal (sigla ou nome).
   * Ex: "TJES", "TRF4", "STJ"
   */
  tribunal?: string;

  /**
   * Instância processual.
   * Ex: "1ª Instância", "2ª Instância", "Superior"
   */
  instancia?: string;

  /**
   * Indica se o processo está vinculado ao sistema de monitoramento do tribunal
   * (ícone de "vinculado ao tribunal" na tela).
   */
  vinculadoTribunal?: boolean;

  /** Valor da causa formatado (ex: "R$ 60.000,00") */
  valorCausa?: string;

  /** Valor de condenação formatado (ex: "R$ 0,00") */
  valorCondenacao?: string;

  /** Data de distribuição do processo (ex: "06/02/2026") */
  distribuidoEm?: string;

  // ── Atividades e histórico ─────────────────────────────────────────────────
  /**
   * Lista das próximas atividades pendentes do caso/processo.
   * Seção "Próximas atividades" na aba Resumo.
   */
  proximasAtividades?: AtividadePendente[];

  /**
   * Histórico completo do caso/processo.
   * Extraído da URL: /main/folders/history/%5B,{id}%5D
   * Ordenado por data decrescente (mais recente primeiro).
   */
  historico?: HistoricoItem[];

  // ── Informações financeiras ────────────────────────────────────────────────
  /**
   * Valores financeiros registrados no processo.
   * Seção "Valores" na aba Resumo.
   */
  valores?: ValorProcesso[];

  // ── Estrutura processual ───────────────────────────────────────────────────
  /**
   * Recursos e desdobramentos processuais.
   * Seção "Recursos e desdobramentos" na aba Resumo.
   */
  recursosDesdobramentos?: RecursoDesdobramento[];

  /**
   * Processos apensos vinculados.
   * Seção "Apensos" na aba Resumo.
   */
  apensos?: ApensoProcesso[];

  // ── Contadores de resumo ───────────────────────────────────────────────────
  /** Número de documentos associados ao caso */
  totalDocumentos?: number;

  /** Número de atendimentos associados ao caso */
  totalAtendimentos?: number;
}
