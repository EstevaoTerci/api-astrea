export interface Publicacao {
  id: string;
  processoNumero: string;
  tribunal?: string;
  data: string;
  conteudo: string;
  tipo?: string;
  prazo?: string;
  lida?: boolean;
  responsavel?: string;
}
