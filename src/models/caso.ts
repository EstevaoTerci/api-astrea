export interface Caso {
  id: string;
  titulo: string;
  /** URL direta do caso no app do Astrea. */
  url?: string;
  /** URL direta do cliente principal no app do Astrea (quando houver clienteId). */
  urlCliente?: string;
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
