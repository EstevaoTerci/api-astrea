/**
 * Barrel de exportações dos modelos de domínio do Astrea.
 *
 * Importações centralizadas para uso nos services, routes e demais módulos:
 *
 * ```typescript
 * import type { Contato, CasoProcesso, HistoricoItem } from '../models/index.js';
 * ```
 */

export type {
  Contato,
  EnderecoContato,
  TelefoneContato,
  EmailContato,
  ContaBancaria,
  DocumentoContato,
  CasoVinculadoDocumento,
} from './contato.js';

export type {
  CasoProcesso,
  ParteProcesso,
  HistoricoItem,
  RecursoDesdobramento,
  AtividadePendente,
  ValorProcesso,
  ApensoProcesso,
} from './caso-processo.js';

export type {
  Cliente,
  ClienteResumido,
  CriarClienteInput,
  EnderecoCriacaoClienteInput,
  PerfilContato,
  TipoContato,
} from './cliente.js';
export type { Caso, ProcessoResumido, Processo } from './caso.js';
export type { Andamento } from './andamento.js';
export type {
  Tarefa,
  CriarTarefaInput,
  AtualizarTarefaInput,
  Comentario,
  ComentarTarefaInput,
} from './tarefa.js';
export type { Publicacao } from './publicacao.js';
export type { Usuario } from './usuario.js';
export type {
  Atendimento,
  CompartilhamentoCaso,
  CriarAtendimentoInput,
  TransformarAtendimentoEmCasoInput,
  TransformarAtendimentoEmProcessoInput,
} from './atendimento.js';
