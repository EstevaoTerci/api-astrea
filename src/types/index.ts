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
