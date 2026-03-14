export interface Atendimento {
  id: string;
  /** Assunto/titulo do atendimento. */
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
  /** ID do usuario responsavel. */
  responsavelId: string;
  descricao?: string;
  duracaoMinutos?: number;
}
