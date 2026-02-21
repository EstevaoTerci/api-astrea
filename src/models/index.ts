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
