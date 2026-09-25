import { describe, expect, it } from 'vitest';
import {
  extrairIdAppointment,
  montarPayloadAppointment,
  montarPayloadReschedule,
  somarMinutos,
} from './agenda-appointment-payload.js';

const LETICIA = '6051920845144064';
const DIUIANE = '5521380837982208';
const AUTOMACAO = '6528036269752320';

describe('somarMinutos', () => {
  it('soma e formata HH:mm', () => {
    expect(somarMinutos('14:00', 30)).toBe('14:30');
    expect(somarMinutos('13:45', 30)).toBe('14:15');
    expect(somarMinutos('9:05', 60)).toBe('10:05');
  });
});

describe('montarPayloadAppointment — contrato do formulário do Astrea (bundle 25/09/2026)', () => {
  const base = {
    titulo: 'ATENDIMENTO INICIAL - FULANO - ONLINE',
    data: '2026-09-30',
    horaInicio: '14:00',
    horaFim: '14:30',
    responsavelId: LETICIA,
  };

  it('monta os campos de data/hora como o AppointmentForm.buildJson', () => {
    const p = montarPayloadAppointment(base, { userId: AUTOMACAO });
    expect(p).toMatchObject({
      description: 'ATENDIMENTO INICIAL - FULANO - ONLINE',
      responsibleId: LETICIA,
      owner: AUTOMACAO,
      userId: AUTOMACAO,
      allDay: false,
      fromDate: '2026-09-30T15:00:00.000Z',
      toDate: '2026-09-30T15:00:00.000Z',
      beginDate: '20260930',
      endDate: '20260930',
      timeStart: '14:00',
      timeEnd: '14:30',
      hourStart: '14',
      minStart: '00',
      hourEnd: '14',
      minEnd: '30',
      timeFromTo: '14:00 - 14:30',
      intDate: 20260930,
      intTime: 140000,
      isHearing: false,
      notifyCustomers: false,
      notifyCustomersEmails: [],
      reminders: [],
      tags: [],
      tagIds: [],
      caseId: null,
      rootCaseId: null,
      kanbanDetails: { id: null, columnId: null },
    });
  });

  it('horaFim ausente = horaInicio + 30 min', () => {
    const p = montarPayloadAppointment({ ...base, horaFim: undefined }, { userId: AUTOMACAO });
    expect(p.timeEnd).toBe('14:30');
    expect(p.timeFromTo).toBe('14:00 - 14:30');
  });

  it('observações recebem a chave externa como [ref:...] (idempotência)', () => {
    const p = montarPayloadAppointment(
      { ...base, comentarios: 'Conversa: https://chatwoot/x', chaveExterna: 'n8n-ag#42' },
      { userId: AUTOMACAO },
    );
    expect(p.descriptionDetails).toBe('Conversa: https://chatwoot/x\n[ref:n8n-ag#42]');
  });

  it('sem comentários e sem chave, observações vazias', () => {
    expect(montarPayloadAppointment(base, { userId: AUTOMACAO }).descriptionDetails).toBe('');
  });

  it('modalidade vira addressType; endereço vai em address', () => {
    const remoto = montarPayloadAppointment({ ...base, modalidade: 'remoto' }, { userId: AUTOMACAO });
    expect(remoto).toMatchObject({ addressType: 'ONLINE_MEETING', address: '' });
    const presencial = montarPayloadAppointment(
      { ...base, modalidade: 'presencial', endereco: 'R. Elizeu Divino, 220' },
      { userId: AUTOMACAO },
    );
    expect(presencial).toMatchObject({ addressType: 'PHYSICAL_ADDRESS', address: 'R. Elizeu Divino, 220' });
    expect(montarPayloadAppointment(base, { userId: AUTOMACAO }).addressType).toBeNull();
  });

  it('envolvidos viram involvedWithNames (id → nome), sem repetir o responsável', () => {
    const p = montarPayloadAppointment(
      { ...base, envolvidosIds: [DIUIANE, LETICIA] },
      { userId: AUTOMACAO, nomes: { [DIUIANE]: 'Diuiane' } },
    );
    expect(p.involvedWithNames).toEqual({ [DIUIANE]: 'Diuiane' });
  });

  it('caseId do contexto tem precedência sobre o do input', () => {
    expect(montarPayloadAppointment({ ...base, casoId: '111' }, { userId: AUTOMACAO }).caseId).toBe('111');
    expect(montarPayloadAppointment({ ...base, casoId: '111' }, { userId: AUTOMACAO, caseId: '222' }).caseId).toBe('222');
  });

  it('dia inteiro: sem horário', () => {
    const p = montarPayloadAppointment(
      { titulo: 'BLOQUEADO', data: '2026-10-01', diaTodo: true, responsavelId: LETICIA },
      { userId: AUTOMACAO },
    );
    expect(p).toMatchObject({ allDay: true, timeFromTo: null, intTime: 0, timeStart: '', timeEnd: '' });
  });
});

describe('montarPayloadReschedule', () => {
  it('monta o corpo do PUT /appointments/reschedule', () => {
    expect(
      montarPayloadReschedule('999', { data: '2026-10-02', horaInicio: '15:00' }, AUTOMACAO),
    ).toEqual({
      id: '999',
      userId: AUTOMACAO,
      whenDate: '2026-10-02',
      toDate: '2026-10-02',
      allDay: false,
      timeFromTo: '15:00 - 15:30',
      shouldNotify: false,
    });
  });
});

describe('extrairIdAppointment', () => {
  it('lê id nas formas conhecidas de resposta', () => {
    expect(extrairIdAppointment({ id: 123 })).toBe('123');
    expect(extrairIdAppointment({ data: { id: '456' } })).toBe('456');
    expect(extrairIdAppointment({ appointment: { id: 789 } })).toBe('789');
    expect(extrairIdAppointment({ response: { id: 10 } })).toBe('10');
    expect(extrairIdAppointment({ response: '11' })).toBe('11');
  });

  it('null quando não há id', () => {
    expect(extrairIdAppointment({})).toBeNull();
    expect(extrairIdAppointment(null)).toBeNull();
    expect(extrairIdAppointment({ response: 'NOT_OK' })).toBeNull();
  });
});
