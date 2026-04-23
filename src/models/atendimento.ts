export interface Atendimento {
  id: string;
  /** Assunto/titulo do atendimento. */
  assunto: string;
  status: string;
  clienteId?: string;
  clienteNome?: string;
  /** URL direta do cliente no app do Astrea (quando houver clienteId). */
  urlCliente?: string;
  casoId?: string;
  casoTitulo?: string;
  /** URL direta do caso/processo no app do Astrea (quando houver casoId). */
  urlCaso?: string;
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

export type CompartilhamentoCaso = 'publico' | 'privado' | 'equipe';

export interface TransformarAtendimentoEmCasoInput {
  titulo?: string;
  descricao?: string;
  observacoes?: string;
  responsavelId?: string;
  sharingType?: CompartilhamentoCaso;
  tagsIds?: string[];
  teamId?: string;
}

export interface TransformarAtendimentoEmProcessoInput extends TransformarAtendimentoEmCasoInput {
  numeroProcesso?: string;
  instancia?: 1 | 2 | 3 | 4;
  juizoNumero?: string;
  vara?: string;
  foro?: string;
  acao?: string;
  urlTribunal?: string;
  objeto?: string;
  valorCausa?: number;
  distribuidoEm?: string;
  valorCondenacao?: number;
}
