import type { DocumentoContato } from './contato.js';

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
 * Versao resumida do cliente para listagem completa (GET /api/clientes/todos).
 * Contem apenas os campos essenciais retornados pela API de listagem.
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

export type PerfilContato = 'cliente' | 'contato';
export type TipoContato = 'pessoa_fisica' | 'pessoa_juridica';

export interface EnderecoCriacaoClienteInput {
  cep?: string;
  logradouro?: string;
  numero?: string;
  complemento?: string;
  bairro?: string;
  cidade?: string;
  estado?: string;
  pais?: string;
}

export interface CriarClienteInput {
  nome: string;
  perfil?: PerfilContato;
  tipo?: TipoContato;
  apelido?: string;
  cpfCnpj?: string;
  origem?: string;
  site?: string;
  email?: string;
  telefone?: string;
  endereco?: string | EnderecoCriacaoClienteInput;
}
