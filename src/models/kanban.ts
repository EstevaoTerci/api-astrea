/**
 * Modelos do módulo Kanban do Astrea (feature "Gestão Kanban").
 *
 * O Kanban opera sobre as mesmas tarefas/atividades já existentes no Astrea —
 * uma `AtividadeKanban` com `tipo === 'TASK'` tem `id` igual ao `taskId`
 * usado em `taskListService.getTaskWithComments` (validado em discovery).
 *
 * IDs do Astrea são `Long` (números muito grandes); todos serializados como
 * `string` para evitar perda de precisão em JSON.
 */

export type TipoColunaKanban = 'BACKLOG' | 'IN_PROGRESS' | 'DONE';

export interface ColunaKanban {
  id: string;
  nome: string;
  tipo: TipoColunaKanban;
  cor?: string;
}

export interface QuadroKanban {
  id: string;
  nome: string;
  /** Indica se este é o quadro padrão do tenant. */
  padrao: boolean;
  colunas: ColunaKanban[];
}

export type PrioridadeKanban = 'baixa' | 'normal' | 'alta';

export interface AtividadeKanban {
  /** ID da atividade. Para `tipo === 'TASK'` é o mesmo `taskId`. */
  id: string;
  tipo: string;
  titulo: string;
  /** True quando a atividade está concluída (mesmo significado de done). */
  concluida: boolean;
  /** Prazo no formato YYYY-MM-DD (convertido do `dateStart` YYYYMMDD). */
  prazo?: string;
  prioridade?: PrioridadeKanban;
  responsavelId?: string;
  responsavel?: string;
  envolvidosIds?: string[];
  casoId?: string;
  casoTitulo?: string;
  /** URL direta do caso/processo no app do Astrea (quando há casoId). */
  urlCaso?: string;
  comentariosCount: number;
  /** ID do quadro Kanban onde a atividade está. */
  quadroId: string;
  /** ID da coluna atual da atividade dentro do quadro. */
  colunaId: string;
  /** ISO timestamp de criação (convertido do `createdDate` epoch ms). */
  criadoEm?: string;
}

export interface FiltrosAtividadeKanban {
  /** Início da janela de busca (YYYY-MM-DD). Default: 1º dia do mês corrente. */
  prazoInicio?: string;
  /** Fim da janela de busca (YYYY-MM-DD). Default: último dia do mês corrente. */
  prazoFim?: string;
  /** Atalho: últimos N dias a partir de hoje (sobrescreve prazoInicio/prazoFim). */
  dias?: number;
  /** Filtra atividades pelo responsável (id Long como string). */
  responsavelId?: string;
  /** Filtra por envolvidos (qualquer da lista). */
  envolvidosIds?: string[];
  /** Filtra por tipos (ex.: ['TASK']). Default: sem filtro. */
  tipos?: string[];
  /** Limite por coluna (default 100). Internamente pagina via cursor até esgotar. */
  limite?: number;
}

export interface AtividadesPorColuna {
  colunaId: string;
  colunaNome: string;
  colunaTipo: TipoColunaKanban;
  atividades: AtividadeKanban[];
}

export interface QuadroAtividades {
  quadroId: string;
  quadroNome: string;
  colunas: AtividadesPorColuna[];
}

export interface MoverAtividadeInput {
  /** ID da coluna destino dentro do mesmo quadro. */
  colunaDestinoId: string;
}
