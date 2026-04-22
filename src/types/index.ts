export type {
  DocumentoContato,
  Cliente,
  ClienteResumido,
  CriarClienteInput,
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
  pagina?: number;
  limite?: number;
}

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
