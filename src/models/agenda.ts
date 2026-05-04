export type TipoEventoAgenda = 'prazo' | 'tarefa' | 'atendimento' | 'audiencia';

export type StatusEventoAgenda = 'pendente' | 'concluido';

export interface EventoAgenda {
  id: string;
  tipo: TipoEventoAgenda;
  /** Título "limpo", sem o prefixo de iniciais do responsável. */
  titulo: string;
  /** Mesmo título no formato exibido pelo Astrea: "LB - Verificar processo". */
  tituloComResponsavel: string;
  /** True para prazos/tarefas (sem hora); false para atendimentos/audiências. */
  diaTodo: boolean;
  /** Data de início no formato `YYYY-MM-DD`. Tarefas sem prazo retornam string vazia. */
  dataInicio: string;
  dataFim?: string;
  /** Hora de início "HH:mm" — apenas eventos não diaTodo. */
  horaInicio?: string;
  horaFim?: string;
  status: StatusEventoAgenda;
  /** Apenas em tarefas. "alta" | "normal" | "baixa". */
  prioridade?: string;
  responsavelId: string;
  responsavelNome?: string;
  /** IDs de outros usuários envolvidos (sem o responsável). */
  envolvidosIds: string[];
  envolvidos?: string[];
  casoId?: string;
  casoTitulo?: string;
  numeroProcesso?: string;
  /** URL direta do caso/processo no app do Astrea. */
  urlCaso?: string;
  comentarios?: string;
  /** Apenas em audiências. */
  forum?: string;
  /** Apenas em audiências. Pode ser endereço físico ou URL de videoconferência. */
  endereco?: string;
  sala?: string;
}
