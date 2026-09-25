/**
 * Cálculo PURO de ocupação da agenda (sem I/O, sem Playwright).
 *
 * Recebe eventos já mapeados (`EventoAgenda`, saída de `mapAtividade`) e devolve,
 * para cada usuário pedido, os intervalos em que ele está ocupado. É o que a
 * atendente virtual (n8n) usa para NÃO oferecer horário já tomado no Astrea.
 *
 * Regras (derivadas da agenda real do escritório, 20/08–30/09/2026):
 *  (a) `diaTodo` bloqueia o(s) dia(s) inteiro(s) em BRT — é como as secretárias
 *      lançam "BLOQUEADO", "IR A DELEGACIA" etc.;
 *  (b) evento sem `horaInicio` (e não diaTodo) também bloqueia o dia inteiro
 *      (conservador: sem hora não dá para saber o que está livre);
 *  (c) sem `horaFim` (ou horaFim <= horaInicio) → horaInicio + duracaoPadraoMin;
 *  (d) o evento ocupa o RESPONSÁVEL e cada ENVOLVIDO que esteja em responsavelIds;
 *  (e) tipos default: atendimento + audiencia (prazo/tarefa não ocupam hora);
 *  (f) status pendente e concluido contam (um "concluído" futuro ainda ocupa);
 *      cancelado (status CANCELED do Astrea) NÃO ocupa;
 *  (g) intervalos sobrepostos ou encostados do mesmo usuário são fundidos;
 *  (h) saída em ISO 8601 com offset fixo -03:00. O Brasil não tem horário de
 *      verão desde 2019, então o offset fixo é exato para America/Sao_Paulo.
 *
 * Intervalos são semiabertos [inicio, fim): um evento 14:00–14:30 não colide
 * com um slot 14:30–15:00.
 */

import type {
  EventoAgenda,
  IntervaloOcupado,
  OrigemOcupacao,
  TipoEventoAgenda,
} from '../models/index.js';

const OFFSET_BRT_HORAS = 3;
const MINUTO_MS = 60_000;
const DIA_MS = 24 * 60 * MINUTO_MS;

export const TIPOS_OCUPAM_HORARIO_DEFAULT: TipoEventoAgenda[] = ['atendimento', 'audiencia'];

export interface OpcoesBusy {
  responsavelIds: string[];
  tipos?: TipoEventoAgenda[];
  duracaoPadraoMin?: number;
}

export interface ResultadoBusy {
  busy: IntervaloOcupado[];
  porResponsavel: Record<string, IntervaloOcupado[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de data (BRT fixo, sem dependência externa)
// ─────────────────────────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Epoch UTC de uma data (YYYY-MM-DD) + hora (HH:mm) em BRT. Hora ausente = 00:00. */
function brtParaEpoch(data: string, hora?: string): number {
  const [y, m, d] = data.split('-').map(Number);
  const [hh, mm] = (hora ?? '00:00').split(':').map(Number);
  return Date.UTC(y, m - 1, d, (hh || 0) + OFFSET_BRT_HORAS, mm || 0);
}

/** Formata um epoch UTC como ISO local BRT: `YYYY-MM-DDTHH:mm:ss-03:00`. */
function epochParaIsoBrt(epoch: number): string {
  const local = new Date(epoch - OFFSET_BRT_HORAS * 60 * MINUTO_MS);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}-03:00`
  );
}

/** `brtParaIso('2026-09-22', '14:00')` → `'2026-09-22T14:00:00-03:00'`. */
export function brtParaIso(data: string, hora?: string): string {
  return epochParaIsoBrt(brtParaEpoch(data, hora));
}

/** Epoch UTC de um ISO 8601 com offset. */
export function isoParaEpoch(iso: string): number {
  return Date.parse(iso);
}

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^\d{1,2}:\d{2}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Intervalo bruto de um evento
// ─────────────────────────────────────────────────────────────────────────────

function intervaloDoEvento(e: EventoAgenda, duracaoPadraoMin: number): { ini: number; fim: number } | null {
  if (!e.dataInicio || !RE_DATA.test(e.dataInicio)) return null;
  const dataFim = e.dataFim && RE_DATA.test(e.dataFim) ? e.dataFim : e.dataInicio;

  const temHora = !!e.horaInicio && RE_HORA.test(e.horaInicio);
  if (e.diaTodo || !temHora) {
    const ini = brtParaEpoch(e.dataInicio);
    const fimDia = brtParaEpoch(dataFim) + DIA_MS;
    return { ini, fim: Math.max(fimDia, ini + DIA_MS) };
  }

  const ini = brtParaEpoch(e.dataInicio, e.horaInicio);
  let fim = e.horaFim && RE_HORA.test(e.horaFim) ? brtParaEpoch(dataFim, e.horaFim) : NaN;
  // Evento que atravessa a meia-noite gravado com dataFim = dataInicio (ex.: 23:00–00:30):
  // se o "fim" cai até 6 h depois do início no dia seguinte, é isso — não dado inconsistente.
  if (Number.isFinite(fim) && fim < ini && dataFim === e.dataInicio && fim + DIA_MS - ini <= 6 * 60 * MINUTO_MS) {
    fim += DIA_MS;
  }
  if (!Number.isFinite(fim) || fim <= ini) fim = ini + duracaoPadraoMin * MINUTO_MS;
  return { ini, fim };
}

// ─────────────────────────────────────────────────────────────────────────────
// computarBusy
// ─────────────────────────────────────────────────────────────────────────────

interface Bruto {
  ini: number;
  fim: number;
  origem: OrigemOcupacao;
}

export function computarBusy(eventos: EventoAgenda[], opts: OpcoesBusy): ResultadoBusy {
  const tipos = new Set(opts.tipos && opts.tipos.length > 0 ? opts.tipos : TIPOS_OCUPAM_HORARIO_DEFAULT);
  const duracao = opts.duracaoPadraoMin && opts.duracaoPadraoMin > 0 ? opts.duracaoPadraoMin : 30;
  const pedidos = new Set(opts.responsavelIds.map(String));

  const brutos = new Map<string, Bruto[]>();
  for (const id of opts.responsavelIds) brutos.set(String(id), []);

  for (const e of eventos) {
    if (!tipos.has(e.tipo)) continue;
    if (e.status === 'cancelado') continue;
    const intervalo = intervaloDoEvento(e, duracao);
    if (!intervalo) continue;

    const origemBase = {
      eventoId: String(e.id),
      tipo: e.tipo,
      titulo: e.titulo,
      diaTodo: !!e.diaTodo,
      status: e.status,
    };

    const responsavel = String(e.responsavelId ?? '');
    const jaIncluidos = new Set<string>();
    if (pedidos.has(responsavel)) {
      brutos.get(responsavel)!.push({ ...intervalo, origem: { ...origemBase, papel: 'responsavel' } });
      jaIncluidos.add(responsavel);
    }
    for (const envolvido of (e.envolvidosIds ?? []).map(String)) {
      if (!pedidos.has(envolvido) || jaIncluidos.has(envolvido)) continue;
      brutos.get(envolvido)!.push({ ...intervalo, origem: { ...origemBase, papel: 'envolvido' } });
      jaIncluidos.add(envolvido);
    }
  }

  const porResponsavel: Record<string, IntervaloOcupado[]> = {};
  const busy: IntervaloOcupado[] = [];

  for (const [id, lista] of brutos) {
    const ordenados = [...lista].sort((a, b) => a.ini - b.ini || a.fim - b.fim);
    const fundidos: Array<{ ini: number; fim: number; origens: OrigemOcupacao[] }> = [];
    for (const b of ordenados) {
      const ultimo = fundidos[fundidos.length - 1];
      if (ultimo && b.ini <= ultimo.fim) {
        ultimo.fim = Math.max(ultimo.fim, b.fim);
        ultimo.origens.push(b.origem);
      } else {
        fundidos.push({ ini: b.ini, fim: b.fim, origens: [b.origem] });
      }
    }
    porResponsavel[id] = fundidos.map((f) => ({
      responsavelId: id,
      inicio: epochParaIsoBrt(f.ini),
      fim: epochParaIsoBrt(f.fim),
      origens: f.origens,
    }));
    busy.push(...porResponsavel[id]);
  }

  return { busy, porResponsavel };
}
