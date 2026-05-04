export type {
  DocumentoContato,
  Cliente,
  ClienteResumido,
  CriarClienteInput,
  AtualizarClienteInput,
  Caso,
  ProcessoResumido,
  Processo,
  Andamento,
  Tarefa,
  CriarTarefaInput,
  AtualizarTarefaInput,
  Publicacao,
  Usuario,
  Atendimento,
  CriarAtendimentoInput,
  TransformarAtendimentoEmCasoInput,
  TransformarAtendimentoEmProcessoInput,
  EventoAgenda,
  TipoEventoAgenda,
  StatusEventoAgenda,
} from '../models/index.js';

export interface FiltrosAtendimento {
  clienteId?: string;
  casoId?: string;
  status?: string;
  dataInicio?: string;
  dataFim?: string;
  pagina?: number;
  limite?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filtros de consulta
// ─────────────────────────────────────────────────────────────────────────────

export interface FiltrosCliente {
  nome?: string;
  cpfCnpj?: string;
  email?: string;
  /** Mês de aniversário (1-12). Filtro server-side via `queryDTO.birthMonth` do Astrea. */
  mesAniversario?: number;
  /** UF do endereço (ex: "SP"). Filtro server-side via `queryDTO.state` do Astrea. */
  estado?: string;
  /** IDs numéricos das etiquetas/tags. Filtro server-side via `queryDTO.selectedTagsIds`. */
  etiquetasIds?: number[];
  /** Quando true, retorna apenas contatos com email cadastrado (`queryDTO.onlyWithEmail`). */
  apenasComEmail?: boolean;
  /**
   * Quando true, a busca textual (`nome`/`cpfCnpj`) também procura no campo
   * empresa/cargo do contato (`queryDTO.searchInCompany`).
   */
  buscarEmEmpresa?: boolean;
  pagina?: number;
  limite?: number;
}

/** Subconjunto de filtros aceitos por `listarTodosClientes` (sem busca textual e sem paginação). */
export type FiltrosTodosClientes = Pick<
  FiltrosCliente,
  'mesAniversario' | 'estado' | 'etiquetasIds' | 'apenasComEmail'
>;

export interface FiltrosCaso {
  clienteId?: string;
  status?: string;
  area?: string;
  pagina?: number;
  limite?: number;
}

export interface FiltrosAndamento {
  dataInicio?: string;
  dataFim?: string;
  dias?: number;
  responsavel?: string;
  responsavelId?: string;
  tipo?: string;
  pagina?: number;
  limite?: number;
}

export interface FiltrosTarefa {
  status?: string;
  prioridade?: string;
  responsavel?: string;
  responsavelId?: string;
  casoId?: string;
  processoId?: string;
  incluirConcluidas?: boolean;
  prazoInicio?: string;
  prazoFim?: string;
  dias?: number;
  pagina?: number;
  limite?: number;
}

export interface FiltrosPublicacao {
  dataInicio?: string;
  dataFim?: string;
  dias?: number;
  lida?: boolean;
  responsavel?: string;
  pagina?: number;
  limite?: number;
}

export interface FiltrosAgenda {
  /** ID do responsável a filtrar. Se ausente, retorna agenda de todos os usuários ativos. */
  responsavelId?: string;
  /** Início da janela em `YYYY-MM-DD`. Default: domingo da semana corrente. */
  inicio?: string;
  /** Fim da janela (inclusivo) em `YYYY-MM-DD`. Default: 6 dias após `inicio`. */
  fim?: string;
  /** Tipos a incluir. Se ausente ou vazio, todos. */
  tipos?: Array<'prazo' | 'tarefa' | 'atendimento' | 'audiencia'>;
  /** "todos" (default), "pendentes" (status IN_PROGRESS) ou "concluidos" (status DONE). */
  status?: 'todos' | 'pendentes' | 'concluidos';
  /**
   * Quando true, inclui também tarefas sem prazo. Útil para "o que LB tem
   * pendente sem deadline marcada". Aplicado apenas se `tipos` incluir tarefa.
   */
  incluirSemPrazo?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Respostas padrão da API
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiResponse<T> {
  success: true;
  data: T;
  meta?: PaginationMeta;
}

export interface ApiError {
  success: false;
  error: string;
  code: string;
  details?: unknown;
}

export interface PaginationMeta {
  total?: number;
  pagina: number;
  limite: number;
  hasNextPage?: boolean;
}

export type ServiceResponse<T> =
  | { ok: true; data: T; meta?: PaginationMeta }
  | { ok: false; error: ServiceError };

export interface ServiceError {
  message: string;
  code:
    | 'BROWSER_UNAVAILABLE'
    | 'NAVIGATION_FAILED'
    | 'SESSION_EXPIRED'
    | 'NOT_FOUND'
    | 'SCRAPE_ERROR'
    | 'TIMEOUT'
    | 'AUTH_FAILED'
    | 'VALIDATION_ERROR'
    | 'API_ERROR';
  retryable: boolean;
}
