export interface Andamento {
  id: string;
  processoId: string;
  processoNumero?: string;
  data: string;
  descricao: string;
  tipo?: string;
  publicadoEm?: string;
  responsavel?: string;
  responsavelId?: string;
  casoTitulo?: string;
}
