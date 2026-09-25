import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../browser/astrea-http.js', () => ({
  ANGULAR_PAGE_PATH: '/#/main/contacts',
  withBrowserContext: vi.fn(<T>(op: (page: unknown) => Promise<T>) => op({})),
  astreaApiPost: vi.fn(),
  getAstreaUserId: vi.fn().mockResolvedValue('6528036269752320'),
}));

vi.mock('../browser/navigator.js', () => ({
  navigateTo: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./usuarios.service.js', () => ({
  listarUsuarios: vi.fn(),
}));

import { flagsParaTipos, listarAgenda, mapAtividade } from './agenda.service.js';
import { astreaApiPost } from '../browser/astrea-http.js';
import { listarUsuarios } from './usuarios.service.js';
import type { Usuario } from '../models/index.js';

const mockPost = vi.mocked(astreaApiPost);
const mockUsuarios = vi.mocked(listarUsuarios);

const LETICIA = '6051920845144064';
const VICTOR = '6043699147374592';

const USUARIOS: Usuario[] = [
  { id: LETICIA, nome: 'Letícia Bernabé', email: 'l@x' },
  { id: VICTOR, nome: 'Rafael Victor', email: 'r@x' },
];

beforeEach(() => {
  mockPost.mockReset();
  mockUsuarios.mockReset();
  mockUsuarios.mockResolvedValue({ ok: true, data: USUARIOS });
});

describe('mapAtividade', () => {
  const porId = new Map(USUARIOS.map((u) => [u.id, u]));

  it('mapeia EVENT com horário, envolvidos (sem o responsável), caso e comentários', () => {
    const e = mapAtividade(
      {
        id: 7000000000000005,
        type: 'EVENT',
        allDay: false,
        title: 'REUNIÃO',
        titleWithName: 'LB - REUNIÃO',
        dateStart: '20260924',
        dateEnd: '20260924',
        timeStart: '14:00',
        timeEnd: '14:30',
        responsibleId: LETICIA,
        involvedIds: [LETICIA, VICTOR],
        caseId: 5977121386430464,
        caseTitle: 'CASO X',
        comments: 'obs [ref:n8n-ag#1]',
        status: 'IN_PROGRESS',
      },
      porId,
    );
    expect(e).toMatchObject({
      id: '7000000000000005',
      tipo: 'atendimento',
      titulo: 'REUNIÃO',
      tituloComResponsavel: 'LB - REUNIÃO',
      diaTodo: false,
      dataInicio: '2026-09-24',
      dataFim: '2026-09-24',
      horaInicio: '14:00',
      horaFim: '14:30',
      status: 'pendente',
      responsavelId: LETICIA,
      responsavelNome: 'Letícia Bernabé',
      envolvidosIds: [VICTOR],
      envolvidos: ['Rafael Victor'],
      casoId: '5977121386430464',
      comentarios: 'obs [ref:n8n-ag#1]',
    });
  });

  it('HEARING vira audiencia com fórum/endereço/sala; DONE vira concluido', () => {
    const e = mapAtividade(
      {
        id: 1,
        type: 'HEARING',
        allDay: false,
        dateStart: '2026-10-05',
        timeStart: '14:00',
        responsibleId: 'x',
        courthouse: 'Fórum',
        address: 'Rua A',
        courthouseRoom: '2',
        status: 'DONE',
      },
      new Map(),
    );
    expect(e).toMatchObject({ tipo: 'audiencia', forum: 'Fórum', endereco: 'Rua A', sala: '2', status: 'concluido' });
    expect(e.dataInicio).toBe('2026-10-05');
    expect(e.horaFim).toBeUndefined();
  });

  it('status CANCELED vira cancelado (não pendente)', () => {
    const e = mapAtividade({ id: 3, type: 'EVENT', allDay: false, dateStart: '20260922', timeStart: '14:00', status: 'CANCELED' }, new Map());
    expect(e.status).toBe('cancelado');
  });

  it('dateStart "null" vira string vazia (tarefa sem prazo)', () => {
    const e = mapAtividade({ id: 2, type: 'TASK', allDay: true, dateStart: 'null', done: true }, new Map());
    expect(e.dataInicio).toBe('');
    expect(e.status).toBe('concluido');
  });
});

describe('flagsParaTipos', () => {
  it('sem tipos habilita tudo', () => {
    expect(flagsParaTipos(undefined)).toEqual({
      appointmentSelected: true,
      deadlineSelected: true,
      hearingSelected: true,
      taskSelected: true,
    });
  });

  it('habilita só os tipos pedidos', () => {
    expect(flagsParaTipos(['atendimento', 'audiencia'])).toEqual({
      appointmentSelected: true,
      deadlineSelected: false,
      hearingSelected: true,
      taskSelected: false,
    });
  });
});

describe('listarAgenda', () => {
  it('filtra por responsável, janela e status, e ordena por data/hora', async () => {
    mockPost.mockResolvedValueOnce({
      activities: [
        { id: 2, type: 'EVENT', allDay: false, dateStart: '20260923', timeStart: '10:00', responsibleId: LETICIA, status: 'IN_PROGRESS' },
        { id: 1, type: 'EVENT', allDay: false, dateStart: '20260922', timeStart: '14:00', responsibleId: LETICIA, status: 'IN_PROGRESS' },
      ],
    });

    const r = await listarAgenda({ responsavelId: LETICIA, inicio: '2026-09-22', fim: '2026-09-28', tipos: ['atendimento'], status: 'pendentes' });

    if (!r.ok) throw new Error('esperava ok');
    expect(r.data.map((e) => e.id)).toEqual(['1', '2']);
    const [, path, payload] = mockPost.mock.calls[0] as [unknown, string, any];
    expect(path).toBe('/calendar-pro/complete');
    expect(payload.from).toBe('20260922');
    expect(payload.to).toBe('20260928');
    expect(payload.query.userFilter.selected).toEqual([LETICIA]);
    expect(payload.query.status).toBe('IN_PROGRESS');
    expect(payload.query.start).toBe('2026-09-22T03:00:00.000Z');
    expect(payload.query.end).toBe('2026-09-29T02:59:59.999Z');
  });

  it('sem responsavelId consulta todos os usuários ativos', async () => {
    mockPost.mockResolvedValueOnce({ activities: [] });
    await listarAgenda({ inicio: '2026-09-22', fim: '2026-09-22' });
    const [, , payload] = mockPost.mock.calls[0] as [unknown, string, any];
    expect(payload.query.userFilter.selected).toEqual([LETICIA, VICTOR]);
  });

  it('filtra por número de processo ignorando a máscara', async () => {
    mockPost.mockResolvedValueOnce({
      activities: [
        { id: 1, type: 'DEADLINE', allDay: true, dateStart: '20260922', responsibleId: LETICIA, lawsuitNumber: '0001234-56.2026.8.08.0011' },
        { id: 2, type: 'DEADLINE', allDay: true, dateStart: '20260922', responsibleId: LETICIA, lawsuitNumber: '9999999-99.2026.8.08.0011' },
      ],
    });
    const r = await listarAgenda({ inicio: '2026-09-22', fim: '2026-09-22', numeroProcesso: '00012345620268080011' });
    if (!r.ok) throw new Error('esperava ok');
    expect(r.data.map((e) => e.id)).toEqual(['1']);
  });

  it('propaga falha de listarUsuarios', async () => {
    mockUsuarios.mockResolvedValueOnce({ ok: false, error: { code: 'API_ERROR', message: 'x', retryable: false } });
    const r = await listarAgenda({});
    expect(r.ok).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('erro do Astrea vira API_ERROR', async () => {
    mockPost.mockRejectedValueOnce(new Error('API_ERROR_500: boom'));
    const r = await listarAgenda({ inicio: '2026-09-22', fim: '2026-09-22' });
    expect(r).toMatchObject({ ok: false, error: { code: 'API_ERROR' } });
  });
});
