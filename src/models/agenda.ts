export type TipoEventoAgenda = 'prazo' | 'tarefa' | 'atendimento' | 'audiencia';

/** `cancelado` = status CANCELED do Astrea (evento cancelado sem ser excluído). */
export type StatusEventoAgenda = 'pendente' | 'concluido' | 'cancelado';

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

// ─────────────────────────────────────────────────────────────────────────────
// Disponibilidade (intervalos ocupados) — GET /api/agenda/disponibilidade
// ─────────────────────────────────────────────────────────────────────────────

/** Evento do Astrea que explica por que um intervalo está ocupado (auditoria). */
export interface OrigemOcupacao {
  eventoId: string;
  tipo: TipoEventoAgenda;
  /** Omitido por padrão na API HTTP (pode conter nome de cliente); ver incluirTitulos. */
  titulo?: string;
  diaTodo: boolean;
  status: StatusEventoAgenda;
  /** Se o usuário ocupa o horário como responsável ou apenas como envolvido. */
  papel: 'responsavel' | 'envolvido';
}

/**
 * Intervalo ocupado de um usuário, semiaberto [inicio, fim), em ISO 8601 com
 * offset -03:00 (BRT). Intervalos sobrepostos ou encostados do mesmo usuário
 * são fundidos e acumulam as `origens`.
 */
export interface IntervaloOcupado {
  responsavelId: string;
  inicio: string;
  fim: string;
  origens: OrigemOcupacao[];
}

export interface DisponibilidadeAgenda {
  /** Janela consultada (YYYY-MM-DD, inclusiva). */
  inicio: string;
  fim: string;
  timezone: 'America/Sao_Paulo';
  responsavelIds: string[];
  tipos: TipoEventoAgenda[];
  /** Todos os intervalos, na ordem de `responsavelIds` e cronológica dentro de cada um. */
  busy: IntervaloOcupado[];
  /** Mesmos intervalos agrupados; toda chave pedida existe (lista vazia = livre). */
  porResponsavel: Record<string, IntervaloOcupado[]>;
  /** Quantidade de eventos brutos devolvidos pelo Astrea na janela. */
  totalEventos: number;
  geradoEm: string;
  cache: { hit: boolean };
}

// ─────────────────────────────────────────────────────────────────────────────
// Eventos (compromissos) — POST/GET/PATCH/DELETE /api/agenda/eventos
// ─────────────────────────────────────────────────────────────────────────────

/** Lead/cliente a vincular ao evento (sem CPF — só o necessário para achar/criar o contato). */
export interface ContatoEventoInput {
  nome: string;
  telefone?: string;
  email?: string;
}

export interface CriarEventoAgendaInput {
  /** Título do evento (padrão das secretárias: "ATENDIMENTO INICIAL - NOME - ONLINE"). */
  titulo: string;
  /** YYYY-MM-DD */
  data: string;
  /** HH:mm (ignorado se diaTodo) */
  horaInicio?: string;
  /** HH:mm — default horaInicio + 30 min */
  horaFim?: string;
  diaTodo?: boolean;
  /** Usuário do Astrea dono do compromisso (o advogado). */
  responsavelId: string;
  /** Outros usuários envolvidos (ex.: secretária da sede). */
  envolvidosIds?: string[];
  /** Observações do evento. A chaveExterna é anexada como `[ref:<chave>]`. */
  comentarios?: string;
  /** Chave de idempotência do consumidor (ex.: "n8n-ag#123"): repetir a chamada não duplica o evento. */
  chaveExterna?: string;
  modalidade?: 'remoto' | 'presencial';
  /** Endereço (presencial) ou link (remoto). */
  endereco?: string;
  /** Vincula a um caso/processo/atendimento já existente. */
  casoId?: string;
  /** Acha (por telefone) ou cria o contato e, por padrão, abre um atendimento vinculado ao evento. */
  contato?: ContatoEventoInput;
  /** Default true quando `contato` é informado. */
  criarAtendimento?: boolean;
  /** Default true: recusa (CONFLICT) se o responsável já tem compromisso no horário. */
  verificarConflito?: boolean;
}

export interface EventoAgendaCriado {
  id: string;
  titulo: string;
  data: string;
  horaInicio?: string;
  horaFim?: string;
  diaTodo: boolean;
  responsavelId: string;
  envolvidosIds: string[];
  casoId?: string;
  chaveExterna?: string;
  status?: StatusEventoAgenda;
}

export interface ResultadoCriacaoEvento {
  evento: EventoAgendaCriado;
  /** true = já existia um evento com a mesma chaveExterna (nada foi criado). */
  reaproveitado: boolean;
  contato: { id: string; criado: boolean } | null;
  atendimento: { id: string; criado: boolean } | null;
  /** true = o evento existe, mas alguma etapa acessória (contato/atendimento/vínculo) falhou. */
  parcial: boolean;
  erros: string[];
}

export interface RemarcarEventoAgendaInput {
  data: string;
  horaInicio?: string;
  horaFim?: string;
  diaTodo?: boolean;
  /** Necessário para checar conflito na nova data. */
  responsavelId?: string;
  verificarConflito?: boolean;
}

/** Evento encontrado na busca por contato, com o motivo do vínculo. */
export interface EventoDoContato extends EventoAgenda {
  motivo: 'ref' | 'caso' | 'observacoes';
  /** Em motivo 'caso': o contato (achado pelo telefone) dono do atendimento/caso. */
  contato?: { id: string; nome: string };
}
