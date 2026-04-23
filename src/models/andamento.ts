export interface Andamento {
  id: string;
  processoId: string;
  /** URL direta do caso/processo no app do Astrea. */
  urlProcesso?: string;
  processoNumero?: string;
  data: string;
  descricao: string;
  tipo?: string;
  publicadoEm?: string;
  responsavel?: string;
  responsavelId?: string;
  casoTitulo?: string;
}
