/**
 * Montagem PURA dos corpos das chamadas de escrita de evento ("compromisso") do
 * Astrea. Isolada para ser ajustada sem tocar na orquestração.
 *
 * Fonte: bundle público do frontend (astrea.net.br/js/all.min.js, módulos
 * `appointmentService` e `AppointmentForm.buildJson`), lido em 25/09/2026 e
 * CONFIRMADO EM RUNTIME no mesmo dia (docs/agenda-eventos-discovery.md): o
 * Astrea aceitou este corpo de primeira, inclusive com caseId = atendimento.
 *
 *  - criar/editar:  POST   /api/v2/appointments            (AppointmentDTO)
 *  - carregar:      GET    /api/v2/appointments/{id}
 *  - excluir:       DELETE /api/v2/appointments/{id}
 *  - status:        PUT    /api/v2/appointments/status     ({appointmentId, userId, status, reason?})
 *  - remarcar:      PUT    /api/v2/appointments/reschedule
 */

import type { CriarEventoAgendaInput, RemarcarEventoAgendaInput } from '../models/index.js';

export interface ContextoPayload {
  /** Usuário da sessão (automação) — vira owner/userId. */
  userId: string;
  /** Caso/atendimento a vincular (prevalece sobre input.casoId). */
  caseId?: string | null;
  /** Nomes dos envolvidos (id → nome) para involvedWithNames. */
  nomes?: Record<string, string>;
}

export const DURACAO_PADRAO_MIN = 30;

export function somarMinutos(hora: string, minutos: number): string {
  const [h, m] = hora.split(':').map(Number);
  const total = h * 60 + m + minutos;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function normalizarHora(hora: string): string {
  const [h, m] = hora.split(':');
  return `${h.padStart(2, '0')}:${(m ?? '00').padStart(2, '0')}`;
}

export function refExterna(chave: string): string {
  return `[ref:${chave}]`;
}

export function montarPayloadAppointment(
  input: CriarEventoAgendaInput,
  ctx: ContextoPayload,
): Record<string, unknown> {
  const diaTodo = input.diaTodo === true;
  const compacta = input.data.replace(/-/g, '');
  // O formulário usa o dia às 12:00 locais (BRT = 15:00Z) em fromDate/toDate.
  const meioDiaUtc = `${input.data}T15:00:00.000Z`;

  const horaInicio = !diaTodo && input.horaInicio ? normalizarHora(input.horaInicio) : '';
  const horaFim = !diaTodo
    ? input.horaFim
      ? normalizarHora(input.horaFim)
      : horaInicio
        ? somarMinutos(horaInicio, DURACAO_PADRAO_MIN)
        : ''
    : '';

  const observacoes = [input.comentarios?.trim(), input.chaveExterna ? refExterna(input.chaveExterna) : '']
    .filter(Boolean)
    .join('\n');

  const nomes = ctx.nomes ?? {};
  const involvedWithNames: Record<string, string> = {};
  for (const id of input.envolvidosIds ?? []) {
    if (id === input.responsavelId) continue;
    involvedWithNames[id] = nomes[id] ?? '';
  }

  const addressType =
    input.modalidade === 'presencial'
      ? 'PHYSICAL_ADDRESS'
      : input.modalidade === 'remoto'
        ? 'ONLINE_MEETING'
        : null;

  return {
    description: input.titulo.trim(),
    descriptionDetails: observacoes,
    responsibleId: input.responsavelId,
    owner: ctx.userId,
    userId: ctx.userId,
    allDay: diaTodo,
    fromDate: meioDiaUtc,
    toDate: meioDiaUtc,
    beginDate: compacta,
    endDate: compacta,
    timeStart: horaInicio,
    timeEnd: horaFim,
    hourStart: horaInicio ? horaInicio.slice(0, 2) : '',
    minStart: horaInicio ? horaInicio.slice(3, 5) : '',
    hourEnd: horaFim ? horaFim.slice(0, 2) : '',
    minEnd: horaFim ? horaFim.slice(3, 5) : '',
    timeFromTo: diaTodo || !horaInicio ? null : `${horaInicio} - ${horaFim}`,
    intDate: Number(compacta),
    intTime: horaInicio ? Number(horaInicio.replace(':', '') + '00') : 0,
    address: input.endereco?.trim() ?? '',
    addressType,
    alertNumTimeUnit: null,
    alertTimeUnit: 'TUE_HOURS',
    secondAlertNumTimeUnit: 0,
    secondAlertTimeUnit: 'TUE_HOURS',
    contactTypeEnum: 'INTERNAL_USER',
    reminders: [],
    notifyCustomers: false,
    notifyCustomersEmails: [],
    resendNotifications: false,
    tags: [],
    tagIds: [],
    caseId: ctx.caseId ?? input.casoId ?? null,
    rootCaseId: null,
    hearingId: null,
    deadlineId: null,
    isHearing: false,
    involvedWithNames,
    kanbanId: '',
    kanbanColumnId: '',
    kanbanDetails: { id: null, columnId: null },
  };
}

export function montarPayloadReschedule(
  id: string,
  input: RemarcarEventoAgendaInput,
  userId: string,
): Record<string, unknown> {
  const diaTodo = input.diaTodo === true;
  const inicio = !diaTodo && input.horaInicio ? normalizarHora(input.horaInicio) : '';
  const fim = inicio ? (input.horaFim ? normalizarHora(input.horaFim) : somarMinutos(inicio, DURACAO_PADRAO_MIN)) : '';
  return {
    id,
    userId,
    whenDate: input.data,
    toDate: input.data,
    allDay: diaTodo,
    timeFromTo: inicio ? `${inicio} - ${fim}` : null,
    shouldNotify: false,
  };
}

/** Extrai o id do evento salvo das formas de resposta conhecidas; null se ausente. */
export function extrairIdAppointment(resp: unknown): string | null {
  if (!resp || typeof resp !== 'object') return null;
  const r = resp as Record<string, any>;
  const candidatos = [r.id, r.data?.id, r.appointment?.id, r.response?.id, r.appointmentId];
  if (typeof r.response === 'string' || typeof r.response === 'number') candidatos.push(r.response);
  for (const c of candidatos) {
    if (c === undefined || c === null) continue;
    const s = String(c);
    if (/^\d+$/.test(s)) return s;
  }
  return null;
}
