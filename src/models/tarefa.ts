export interface Tarefa {
  id: string;
  /** Conteudo/descricao da tarefa (campo "description" no GCP Endpoints). */
  titulo: string;
  descricao?: string;
  status: string;
  prioridade?: string;
  prazo?: string;
  responsavelId?: string;
  responsavel?: string;
  clienteId?: string;
  clienteNome?: string;
  /** URL direta do cliente no app do Astrea (quando houver clienteId). */
  urlCliente?: string;
  casoId?: string;
  processoId?: string;
  /** URL direta do caso/processo no app do Astrea (quando houver casoId). */
  urlCaso?: string;
  listaId?: string;
  createdAt?: string;
}

export interface CriarTarefaInput {
  /** Conteudo da tarefa (mapeado para description na API GCP). */
  titulo: string;
  /** ID do caso/processo associado (casoId no TaskInfoDTO). */
  casoId?: string;
  /** ID do usuario responsavel. Obrigatorio para criacao via GCP Endpoints. */
  responsavelId: string;
  /** ID da lista de tarefas destino. Usa a lista padrao se omitido. */
  listaId?: string;
  /** Data de vencimento no formato YYYY-MM-DD. */
  prazo?: string;
  /** Prioridade numerica: 0=normal, 1=baixa, 2=alta. */
  prioridade?: number;
}

export interface AtualizarTarefaInput {
  titulo?: string;
  status?: string;
  prazo?: string;
  responsavelId?: string;
  prioridade?: number;
}
