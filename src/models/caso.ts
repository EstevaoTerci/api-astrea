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
