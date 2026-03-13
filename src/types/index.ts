import type { DocumentoContato } from '../models/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Entidades de domínio
// ─────────────────────────────────────────────────────────────────────────────

export type { DocumentoContato };

export interface Cliente {
  id: string;
  nome: string;
  cpfCnpj?: string;
  email?: string;
  telefone?: string;
  /** URL da pasta Google Drive associada ao cliente no Astrea (campo "Site" do contato). */
  urlDrive?: string;
  /** Lista de documentos registrados na aba "Documentos" do contato */
  documentos?: DocumentoContato[];
  tipo?: 'pessoa_fisica' | 'pessoa_juridica';
  endereco?: string;
  dataNascimento?: string;
  origem?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Versão resumida do cliente para listagem completa (GET /api/clientes/todos).
 * Contém apenas os campos essenciais retornados pela API de listagem.
 */
export interface ClienteResumido {
  id: string;
  nome: string;
  classificacao?: string;
  tipo?: 'pessoa_fisica' | 'pessoa_juridica';
  telefone?: string;
  email?: string;
  endereco?: string;
  etiquetas?: string[];
  criadoEm?: string;
}

export interface Caso {
  id: string;
  titulo: string;
  descricao?: string;
  status?: string;
  area?: string;
  clienteId?: string;
  clienteNome?: string;
  responsavel?: string;
  processos?: ProcessoResumido[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ProcessoResumido {
  id: string;
  numero: string;
  tribunal?: string;
}

export interface Processo {
  id: string;
  numero: string;
  tribunal?: string;
  vara?: string;
  juiz?: string;
  status?: string;
  parte?: string;
  tipoParticipacao?: string;
  casoId?: string;
  clienteId?: string;
  clienteNome?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Andamento {
  id: string;
  processoId: string;
  processoNumero?: string;
  data: string;
  descricao: string;
  tipo?: string;
  publicadoEm?: string;
}

export interface Tarefa {
  id: string;
  /** Conteúdo/descrição da tarefa (campo "description" no GCP Endpoints). */
  titulo: string;
  descricao?: string;
  status: string;
  prioridade?: string;
  prazo?: string;
  responsavelId?: string;
  responsavel?: string;
  clienteId?: string;
  clienteNome?: string;
  casoId?: string;
  processoId?: string;
  listaId?: string;
  createdAt?: string;
}

export interface CriarTarefaInput {
  /** Conteúdo da tarefa (mapeado para description na API GCP). */
  titulo: string;
  /** ID do caso/processo associado (casoId no TaskInfoDTO). */
  casoId?: string;
  /** ID do usuário responsável. Obrigatório para criação via GCP Endpoints. */
  responsavelId: string;
  /** ID da lista de tarefas destino. Usa a lista padrão se omitido. */
  listaId?: string;
  /** Data de vencimento no formato YYYY-MM-DD. */
  prazo?: string;
  /** Prioridade numérica: 0=normal, 1=baixa, 2=alta. */
  prioridade?: number;
}

export interface AtualizarTarefaInput {
  titulo?: string;
  status?: string;
  prazo?: string;
  responsavelId?: string;
  prioridade?: number;
}

export interface Publicacao {
  id: string;
  processoNumero: string;
  tribunal?: string;
  data: string;
  conteudo: string;
  tipo?: string;
  prazo?: string;
  lida?: boolean;
}

export interface Usuario {
  id: string;
  nome: string;
  email: string;
  /** Apelido/nickname do usuário no escritório. */
  apelido?: string;
  foto?: string;
  admin?: boolean;
  status?: string;
  perfil?: string;
  /** ID do contato associado ao usuário. */
  contatoId?: string;
}

export interface Atendimento {
  id: string;
  /** Assunto/título do atendimento. */
  assunto: string;
  status: string;
  clienteId?: string;
  clienteNome?: string;
  casoId?: string;
  casoTitulo?: string;
  responsavelId?: string;
  responsavelNome?: string;
  /** Data/hora do atendimento (ISO 8601). */
  dataHora?: string;
  descricao?: string;
  duracaoMinutos?: number;
  createdAt?: string;
}

export interface CriarAtendimentoInput {
  /** ID do cliente (contato) para associar ao atendimento. */
  clienteId: string;
  /** ID do caso/processo associado. */
  casoId?: string;
  /** Assunto do atendimento. */
  assunto: string;
  /** Data no formato YYYY-MM-DD. */
  data: string;
  /** Hora no formato HH:mm. */
  hora: string;
  /** ID do usuário responsável. */
  responsavelId: string;
  descricao?: string;
  duracaoMinutos?: number;
}

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
  pagina?: number;
  limite?: number;
}

export interface FiltrosTarefa {
  status?: string;
  prioridade?: string;
  responsavel?: string;
  casoId?: string;
  processoId?: string;
  pagina?: number;
  limite?: number;
}

export interface FiltrosPublicacao {
  dataInicio?: string;
  dataFim?: string;
  dias?: number;
  lida?: boolean;
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

export type ServiceResponse<T> = { ok: true; data: T; meta?: PaginationMeta } | { ok: false; error: ServiceError };

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
