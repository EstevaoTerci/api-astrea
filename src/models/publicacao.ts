export interface Publicacao {
  id: string;
  processoNumero: string;
  /** ID do caso/processo vinculado à publicação (quando retornado pelo Astrea). */
  casoId?: string;
  /** URL direta do caso/processo no app do Astrea (quando houver casoId). */
  urlCaso?: string;
  tribunal?: string;
  data: string;
  conteudo: string;
  tipo?: string;
  prazo?: string;
  lida?: boolean;
  responsavel?: string;
}
