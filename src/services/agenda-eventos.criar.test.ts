import { beforeEach, describe, expect, it, vi } from 'vitest';

// Dados fictícios (nunca usar nome/telefone de lead real em teste versionado).
const NOME = 'Fulano de Tal';
const TEL = '+5527990000001';
const TEL_MASCARA = '(27) 99000-0001';
const TITULO = 'ATENDIMENTO INICIAL - FULANO - ONLINE';

vi.mock('../browser/astrea-http.js', () => ({
  ANGULAR_PAGE_PATH: '/#/main/contacts',
  withBrowserContext: vi.fn(<T>(op: (page: unknown) => Promise<T>) => op({})),
  astreaApiPost: vi.fn(),
  astreaApiGet: vi.fn(),
  astreaApiPut: vi.fn(),
  astreaApiDelete: vi.fn(),
  getAstreaUserId: vi.fn().mockResolvedValue('6528036269752320'),
}));

vi.mock('../browser/navigator.js', () => ({
  navigateTo: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./usuarios.service.js', () => ({
  listarUsuarios: vi.fn(),
}));

vi.mock('./clientes.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./clientes.service.js')>();
  return {
    telefonesIguais: real.telefonesIguais,
    buscarContatosNaPagina: vi.fn(),
    criarContatoNaPagina: vi.fn(),
  };
});

vi.mock('./atendimentos.service.js', () => ({
  criarAtendimentoNaPagina: vi.fn(),
  listarAtendimentosDoContatoNaPagina: vi.fn(),
}));

import {
  buscarEventoAgenda,
  buscarEventosPorContato,
  calcularDisponibilidade,
  cancelarEventoAgenda,
  classificarErro,
  criarEventoAgenda,
  excluirEventoAgenda,
  mapAppointmentDTO,
  remarcarEventoAgenda,
  resetarDisponibilidadeCache,
} from './agenda-eventos.service.js';
import {
  astreaApiDelete,
  astreaApiGet,
  astreaApiPost,
  astreaApiPut,
  withBrowserContext,
} from '../browser/astrea-http.js';
import { listarUsuarios } from './usuarios.service.js';
import { buscarContatosNaPagina, criarContatoNaPagina } from './clientes.service.js';
import { criarAtendimentoNaPagina, listarAtendimentosDoContatoNaPagina } from './atendimentos.service.js';
import type { CriarEventoAgendaInput } from '../models/index.js';

const mockPost = vi.mocked(astreaApiPost);
const mockGet = vi.mocked(astreaApiGet);
const mockPut = vi.mocked(astreaApiPut);
const mockDelete = vi.mocked(astreaApiDelete);
const mockWith = vi.mocked(withBrowserContext);
const mockUsuarios = vi.mocked(listarUsuarios);
const mockBuscarContatos = vi.mocked(buscarContatosNaPagina);
const mockCriarContato = vi.mocked(criarContatoNaPagina);
const mockCriarAtendimento = vi.mocked(criarAtendimentoNaPagina);
const mockListarAtendimentos = vi.mocked(listarAtendimentosDoContatoNaPagina);

const LETICIA = '6051920845144064';
const DIUIANE = '5521380837982208';

/** Atividades que o /calendar-pro/complete devolve para o dia consultado. */
let calendario: Array<Record<string, unknown>> = [];
/** Resposta do POST /appointments (ou função que decide). */
let respostaAppointment: unknown = { id: 8888888888888888 };

function atividade(overrides: Record<string, unknown> = {}) {
  return {
    id: 7000000000000001,
    type: 'EVENT',
    allDay: false,
    title: 'ATENDIMENTO X',
    dateStart: '20260930',
    dateEnd: '20260930',
    timeStart: '14:00',
    timeEnd: '14:30',
    responsibleId: LETICIA,
    involvedIds: [],
    status: 'IN_PROGRESS',
    ...overrides,
  };
}

function input(overrides: Partial<CriarEventoAgendaInput> = {}): CriarEventoAgendaInput {
  return {
    titulo: TITULO,
    data: '2026-09-30',
    horaInicio: '14:00',
    horaFim: '14:30',
    responsavelId: LETICIA,
    comentarios: 'Conversa: https://chatwoot.alvesbernabe.com/app/accounts/1/conversations/999',
    chaveExterna: 'n8n-ag#42',
    modalidade: 'remoto',
    ...overrides,
  };
}

function chamadasAppointments() {
  return mockPost.mock.calls.filter((c) => c[1] === '/appointments');
}

beforeEach(() => {
  calendario = [];
  respostaAppointment = { id: 8888888888888888 };
  for (const m of [mockPost, mockGet, mockPut, mockDelete, mockUsuarios, mockBuscarContatos, mockCriarContato, mockCriarAtendimento, mockListarAtendimentos]) m.mockReset();
  mockWith.mockReset();
  mockWith.mockImplementation(<T>(op: (page: unknown) => Promise<T>) => op({}));
  mockPost.mockImplementation(async (_page: unknown, path: string) => {
    if (path === '/calendar-pro/complete') return { activities: calendario };
    if (path === '/appointments') {
      if (typeof respostaAppointment === 'function') return (respostaAppointment as () => unknown)();
      return respostaAppointment;
    }
    throw new Error(`POST inesperado: ${path}`);
  });
  mockUsuarios.mockResolvedValue({ ok: true, data: [{ id: DIUIANE, nome: 'Diuiane', email: 'd@x' }] });
  mockListarAtendimentos.mockResolvedValue([]);
  resetarDisponibilidadeCache();
});

// ─────────────────────────────────────────────────────────────────────────────
// criarEventoAgenda — caminho feliz
// ─────────────────────────────────────────────────────────────────────────────

describe('criarEventoAgenda — criação', () => {
  it('confere o dia do responsável e cria o evento com o payload do formulário (timeout de escrita 30 s)', async () => {
    const r = await criarEventoAgenda(input());

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const leitura = mockPost.mock.calls.find((c) => c[1] === '/calendar-pro/complete')![2] as any;
    expect(leitura.from).toBe('20260930');
    expect(leitura.to).toBe('20260930');
    expect(leitura.query.userFilter.selected).toEqual([LETICIA]);

    const [[, , payload, timeout]] = chamadasAppointments() as Array<[unknown, string, any, number]>;
    expect(timeout).toBe(30_000);
    expect(payload).toMatchObject({
      description: TITULO,
      responsibleId: LETICIA,
      owner: '6528036269752320',
      timeFromTo: '14:00 - 14:30',
      addressType: 'ONLINE_MEETING',
      caseId: null,
    });
    expect(payload.descriptionDetails).toContain('[ref:n8n-ag#42]');

    expect(r.data).toEqual({
      evento: {
        id: '8888888888888888',
        titulo: TITULO,
        data: '2026-09-30',
        horaInicio: '14:00',
        horaFim: '14:30',
        diaTodo: false,
        responsavelId: LETICIA,
        envolvidosIds: [],
        casoId: undefined,
        chaveExterna: 'n8n-ag#42',
        status: 'pendente',
      },
      reaproveitado: false,
      contato: null,
      atendimento: null,
      parcial: false,
      erros: [],
    });
  });

  it('envolvidos recebem nome via listarUsuarios (só quando há envolvidos)', async () => {
    await criarEventoAgenda(input({ envolvidosIds: [DIUIANE] }));
    const [[, , payload]] = chamadasAppointments() as Array<[unknown, string, any]>;
    expect(payload.involvedWithNames).toEqual({ [DIUIANE]: 'Diuiane' });

    mockUsuarios.mockClear();
    await criarEventoAgenda(input({ chaveExterna: 'n8n-ag#43' }));
    expect(mockUsuarios).not.toHaveBeenCalled();
  });

  it('falha ao obter nomes não impede a criação (nome vazio)', async () => {
    mockUsuarios.mockResolvedValueOnce({ ok: false, error: { code: 'API_ERROR', message: 'x', retryable: false } });
    const r = await criarEventoAgenda(input({ envolvidosIds: [DIUIANE] }));
    expect(r.ok).toBe(true);
    const [[, , payload]] = chamadasAppointments() as Array<[unknown, string, any]>;
    expect(payload.involvedWithNames).toEqual({ [DIUIANE]: '' });
  });

  it('invalida o cache de disponibilidade após criar', async () => {
    const filtros = { responsavelIds: [LETICIA], inicio: '2026-09-30', fim: '2026-09-30' };
    await calcularDisponibilidade(filtros);
    await criarEventoAgenda(input());
    const antes = mockPost.mock.calls.filter((c) => c[1] === '/calendar-pro/complete').length;
    await calcularDisponibilidade(filtros);
    const depois = mockPost.mock.calls.filter((c) => c[1] === '/calendar-pro/complete').length;
    expect(depois).toBe(antes + 1);
  });

  it('chamadas simultâneas com a mesma chaveExterna compartilham uma única criação', async () => {
    const [a, b] = await Promise.all([criarEventoAgenda(input()), criarEventoAgenda(input())]);
    expect(a).toEqual(b);
    expect(mockWith).toHaveBeenCalledTimes(1);
    expect(chamadasAppointments()).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotência, conflito e reconciliação
// ─────────────────────────────────────────────────────────────────────────────

describe('criarEventoAgenda — idempotência por chaveExterna', () => {
  it('evento ativo com a mesma [ref:] no dia é reaproveitado e nada é criado', async () => {
    calendario = [atividade({ id: 5550000000000001, comments: 'obs\n[ref:n8n-ag#42]', caseId: 1234567890123 })];
    const r = await criarEventoAgenda(input({ contato: { nome: NOME, telefone: TEL } }));

    expect(r).toMatchObject({
      ok: true,
      data: {
        reaproveitado: true,
        evento: { id: '5550000000000001', casoId: '1234567890123', status: 'pendente' },
        atendimento: { id: '1234567890123', criado: false },
      },
    });
    expect(chamadasAppointments()).toHaveLength(0);
    expect(mockBuscarContatos).not.toHaveBeenCalled();
    expect(mockCriarAtendimento).not.toHaveBeenCalled();
  });

  it('evento com a mesma [ref:] mas CANCELADO não conta: cria de novo', async () => {
    calendario = [atividade({ id: 5550000000000002, timeStart: '09:00', timeEnd: '09:30', comments: '[ref:n8n-ag#42]', status: 'CANCELED' })];
    const r = await criarEventoAgenda(input());
    expect(r).toMatchObject({ ok: true, data: { reaproveitado: false, evento: { id: '8888888888888888' } } });
    expect(chamadasAppointments()).toHaveLength(1);
  });

  it('[ref:] de outra chave não conta como o mesmo evento', async () => {
    calendario = [atividade({ timeStart: '09:00', timeEnd: '09:30', comments: '[ref:n8n-ag#41]' })];
    const r = await criarEventoAgenda(input());
    expect(r).toMatchObject({ ok: true, data: { reaproveitado: false } });
    expect(chamadasAppointments()).toHaveLength(1);
  });
});

describe('criarEventoAgenda — conflito', () => {
  it('recusa com CONFLICT sem expor o título (nome de cliente) na mensagem nem nos detalhes', async () => {
    calendario = [atividade({ id: 7000000000000009, title: 'ATENDIMENTO INICIAL - CICLANO', timeStart: '14:15', timeEnd: '14:45' })];
    const r = await criarEventoAgenda(input());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CONFLICT');
    expect(r.error.message).toBe('CONFLICT: horário ocupado no Astrea (2026-09-30 14:15–14:45)');
    expect(JSON.stringify(r.error.details)).not.toContain('CICLANO');
    expect(r.error.details).toEqual({
      conflitos: [
        {
          responsavelId: LETICIA,
          inicio: '2026-09-30T14:15:00-03:00',
          fim: '2026-09-30T14:45:00-03:00',
          origens: [{ eventoId: '7000000000000009', tipo: 'atendimento', diaTodo: false, status: 'pendente', papel: 'responsavel' }],
        },
      ],
    });
    expect(chamadasAppointments()).toHaveLength(0);
  });

  it('bloqueio de dia inteiro também conflita', async () => {
    calendario = [atividade({ allDay: true, title: 'BLOQUEADO', timeStart: '', timeEnd: '' })];
    const r = await criarEventoAgenda(input());
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('evento encostado (termina quando o novo começa) não conflita', async () => {
    calendario = [atividade({ timeStart: '13:30', timeEnd: '14:00' })];
    const r = await criarEventoAgenda(input());
    expect(r.ok).toBe(true);
  });

  it('evento cancelado não conflita', async () => {
    calendario = [atividade({ status: 'CANCELED' })];
    const r = await criarEventoAgenda(input());
    expect(r.ok).toBe(true);
  });

  it('verificarConflito=false cria mesmo com choque', async () => {
    calendario = [atividade()];
    const r = await criarEventoAgenda(input({ verificarConflito: false }));
    expect(r.ok).toBe(true);
    expect(chamadasAppointments()).toHaveLength(1);
  });
});

describe('criarEventoAgenda — reconciliação e falhas', () => {
  it('timeout no POST: relê o dia e, achando a [ref:], devolve o evento criado', async () => {
    let criado = false;
    mockPost.mockImplementation(async (_p: unknown, path: string) => {
      if (path === '/calendar-pro/complete') {
        return { activities: criado ? [atividade({ id: 5990000000000001, comments: 'x\n[ref:n8n-ag#42]' })] : [] };
      }
      if (path === '/appointments') {
        criado = true;
        throw new Error('Timeout 30000ms em POST https://app.astrea.net.br/api/v2/appointments');
      }
      throw new Error(path);
    });

    const r = await criarEventoAgenda(input());
    expect(r).toMatchObject({ ok: true, data: { reaproveitado: false, evento: { id: '5990000000000001' } } });
  });

  it('timeout sem evento encontrado devolve TIMEOUT', async () => {
    respostaAppointment = () => {
      throw new Error('Timeout 30000ms em POST x');
    };
    const r = await criarEventoAgenda(input());
    expect(r).toMatchObject({ ok: false, error: { code: 'TIMEOUT', retryable: true } });
  });

  it('resposta 2xx sem id e sem [ref:] na releitura: erro retentável SEM repostar', async () => {
    respostaAppointment = {};
    const r = await criarEventoAgenda(input());
    expect(r).toMatchObject({ ok: false, error: { code: 'API_ERROR', retryable: true } });
    expect(chamadasAppointments()).toHaveLength(1);
  });

  it('retentativa do withBrowserContext NÃO recria contato/atendimento nem reposta o evento', async () => {
    // Simula o withRetry real: o closure roda de novo depois de um erro de contexto.
    mockWith.mockImplementation(async <T>(op: (page: unknown) => Promise<T>) => {
      try {
        return await op({});
      } catch {
        return await op({});
      }
    });
    mockBuscarContatos.mockResolvedValue([]);
    mockCriarContato.mockResolvedValue('4440000000000009');
    mockCriarAtendimento.mockResolvedValue({ id: '3330000000000009', assunto: 'x', status: 'x' });
    let tentativa = 0;
    mockPost.mockImplementation(async (_p: unknown, path: string) => {
      if (path === '/calendar-pro/complete') {
        // Na 2ª leitura o evento da 1ª tentativa já aparece.
        return { activities: tentativa > 0 ? [atividade({ id: 5990000000000009, comments: '[ref:n8n-ag#42]', caseId: 3330000000000009 })] : [] };
      }
      if (path === '/appointments') {
        tentativa++;
        throw new Error('Execution context was destroyed');
      }
      throw new Error(path);
    });

    const r = await criarEventoAgenda(input({ contato: { nome: NOME, telefone: TEL } }));

    expect(mockCriarContato).toHaveBeenCalledTimes(1);
    expect(mockCriarAtendimento).toHaveBeenCalledTimes(1);
    expect(chamadasAppointments()).toHaveLength(1);
    expect(r).toMatchObject({
      ok: true,
      data: {
        reaproveitado: false,
        evento: { id: '5990000000000009' },
        contato: { id: '4440000000000009', criado: true },
        atendimento: { id: '3330000000000009', criado: true },
      },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Contato + atendimento (D10) — melhor esforço
// ─────────────────────────────────────────────────────────────────────────────

describe('criarEventoAgenda — contato e atendimento', () => {
  it('contato achado pelo telefone é reutilizado; atendimento criado com a [ref:] e vinculado como caseId', async () => {
    mockBuscarContatos.mockResolvedValueOnce([{ id: '4440000000000001', nome: NOME, telefone: TEL_MASCARA }]);
    mockCriarAtendimento.mockResolvedValueOnce({ id: '3330000000000001', assunto: 'x', status: 'EM ANDAMENTO' });

    const r = await criarEventoAgenda(input({ contato: { nome: NOME, telefone: TEL } }));

    expect(mockBuscarContatos).toHaveBeenCalledWith(expect.anything(), NOME, 20);
    expect(mockCriarContato).not.toHaveBeenCalled();
    expect(mockListarAtendimentos).toHaveBeenCalledWith(expect.anything(), '4440000000000001', 20);
    expect(mockCriarAtendimento).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        clienteId: '4440000000000001',
        assunto: TITULO,
        responsavelId: LETICIA,
        data: '2026-09-30',
        hora: '14:00',
        descricao: expect.stringContaining('[ref:n8n-ag#42]'),
      }),
    );
    const [[, , payload]] = chamadasAppointments() as Array<[unknown, string, any]>;
    expect(payload.caseId).toBe('3330000000000001');
    expect(r).toMatchObject({
      ok: true,
      data: {
        contato: { id: '4440000000000001', criado: false },
        atendimento: { id: '3330000000000001', criado: true },
        evento: { casoId: '3330000000000001' },
        parcial: false,
      },
    });
  });

  it('atendimento com a mesma [ref:] (replay do consumidor) é reaproveitado', async () => {
    mockBuscarContatos.mockResolvedValueOnce([{ id: '4440000000000001', nome: NOME, telefone: TEL }]);
    mockListarAtendimentos.mockResolvedValueOnce([
      { id: '3330000000000077', assunto: TITULO, status: 'EM ANDAMENTO', descricao: 'Conversa ...\n[ref:n8n-ag#42]' },
    ]);
    const r = await criarEventoAgenda(input({ contato: { nome: NOME, telefone: TEL } }));
    expect(mockCriarAtendimento).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, data: { atendimento: { id: '3330000000000077', criado: false } } });
  });

  it('busca só pelo nome (o Astrea não indexa telefone): UMA chamada de busca', async () => {
    mockBuscarContatos.mockResolvedValueOnce([{ id: '4440000000000002', nome: NOME, telefone: '+55 27 99000-0001' }]);
    mockCriarAtendimento.mockResolvedValueOnce({ id: '3330000000000002', assunto: 'x', status: 'x' });

    const r = await criarEventoAgenda(input({ contato: { nome: NOME, telefone: TEL } }));

    expect(mockBuscarContatos).toHaveBeenCalledTimes(1);
    expect(mockBuscarContatos).toHaveBeenCalledWith(expect.anything(), NOME, 20);
    expect(r).toMatchObject({ ok: true, data: { contato: { id: '4440000000000002', criado: false } } });
  });

  it('homônimo com outro telefone é outra pessoa: cria contato novo', async () => {
    mockBuscarContatos.mockResolvedValueOnce([{ id: '4440000000000003', nome: NOME, telefone: '27911112222' }]);
    mockCriarContato.mockResolvedValueOnce('4440000000000033');
    mockCriarAtendimento.mockResolvedValueOnce({ id: '3330000000000003', assunto: 'x', status: 'x' });

    const r = await criarEventoAgenda(input({ contato: { nome: NOME, telefone: TEL } }));

    expect(mockCriarContato).toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, data: { contato: { id: '4440000000000033', criado: true } } });
  });

  it('contato inexistente é criado só com nome e telefone (sem CPF), como perfil contato', async () => {
    mockBuscarContatos.mockResolvedValue([]);
    mockCriarContato.mockResolvedValueOnce('4440000000000004');
    mockCriarAtendimento.mockResolvedValueOnce({ id: '3330000000000004', assunto: 'x', status: 'x' });

    const r = await criarEventoAgenda(input({ contato: { nome: `  ${NOME} `, telefone: TEL } }));

    expect(mockCriarContato).toHaveBeenCalledWith(expect.anything(), {
      nome: NOME,
      perfil: 'contato',
      telefone: TEL,
      email: undefined,
    });
    expect(r).toMatchObject({ ok: true, data: { contato: { id: '4440000000000004', criado: true } } });
  });

  it('sem telefone não tenta casar por homônimo: cria contato novo', async () => {
    mockCriarContato.mockResolvedValueOnce('4440000000000005');
    mockCriarAtendimento.mockResolvedValueOnce({ id: '3330000000000005', assunto: 'x', status: 'x' });
    await criarEventoAgenda(input({ contato: { nome: 'Maria' } }));
    expect(mockBuscarContatos).not.toHaveBeenCalled();
    expect(mockCriarContato).toHaveBeenCalled();
  });

  it('falha no contato: evento criado sem vínculo, parcial com erro', async () => {
    mockBuscarContatos.mockResolvedValue([]);
    mockCriarContato.mockRejectedValueOnce(new Error('FORM_UNAVAILABLE: botão não encontrado'));

    const r = await criarEventoAgenda(input({ contato: { nome: NOME, telefone: TEL } }));

    expect(mockCriarAtendimento).not.toHaveBeenCalled();
    expect(chamadasAppointments()).toHaveLength(1);
    expect(r).toMatchObject({ ok: true, data: { contato: null, atendimento: null, parcial: true } });
    if (r.ok) expect(r.data.erros[0]).toMatch(/^contato: /);
  });

  it('falha no atendimento: evento criado sem caseId, contato devolvido, parcial', async () => {
    mockBuscarContatos.mockResolvedValue([{ id: '4440000000000006', nome: NOME, telefone: TEL }]);
    mockCriarAtendimento.mockRejectedValueOnce(new Error('API_ERROR_500: boom'));

    const r = await criarEventoAgenda(input({ contato: { nome: NOME, telefone: TEL } }));

    const [[, , payload]] = chamadasAppointments() as Array<[unknown, string, any]>;
    expect(payload.caseId).toBeNull();
    expect(r).toMatchObject({ ok: true, data: { contato: { id: '4440000000000006' }, atendimento: null, parcial: true } });
    if (r.ok) expect(r.data.erros[0]).toMatch(/^atendimento: /);
  });

  it('criarAtendimento=false: só vincula o contato (sem caseId novo)', async () => {
    mockBuscarContatos.mockResolvedValue([{ id: '4440000000000007', nome: NOME, telefone: TEL }]);
    const r = await criarEventoAgenda(input({ contato: { nome: NOME, telefone: TEL }, criarAtendimento: false }));
    expect(mockCriarAtendimento).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, data: { atendimento: null, parcial: false } });
  });

  it('Astrea recusa (400) o caseId do atendimento: relê, recria sem vínculo e marca parcial', async () => {
    mockBuscarContatos.mockResolvedValue([{ id: '4440000000000008', nome: NOME, telefone: TEL }]);
    mockCriarAtendimento.mockResolvedValueOnce({ id: '3330000000000008', assunto: 'x', status: 'x' });
    let tentativas = 0;
    respostaAppointment = () => {
      tentativas++;
      if (tentativas === 1) throw new Error('API_ERROR_400: invalid case');
      return { id: 8880000000000008 };
    };

    const r = await criarEventoAgenda(input({ contato: { nome: NOME, telefone: TEL } }));

    const chamadas = chamadasAppointments() as Array<[unknown, string, any]>;
    expect(chamadas).toHaveLength(2);
    expect(chamadas[0][2].caseId).toBe('3330000000000008');
    expect(chamadas[1][2].caseId).toBeNull();
    expect(r).toMatchObject({ ok: true, data: { evento: { id: '8880000000000008' }, atendimento: { id: '3330000000000008' }, parcial: true } });
    if (r.ok) expect(r.data.erros.some((e) => e.startsWith('vinculo: '))).toBe(true);
  });

  it.each([
    ['API_ERROR_500: erro interno'],
    ['API_ERROR_401: sessão'],
    ['SEM_ID: o Astrea não retornou o id'],
  ])('erro de resultado incerto (%s) NÃO dispara o fallback sem vínculo', async (msg) => {
    mockBuscarContatos.mockResolvedValue([{ id: '4440000000000010', nome: NOME, telefone: TEL }]);
    mockCriarAtendimento.mockResolvedValueOnce({ id: '3330000000000010', assunto: 'x', status: 'x' });
    respostaAppointment = () => {
      throw new Error(msg);
    };
    const r = await criarEventoAgenda(input({ contato: { nome: NOME, telefone: TEL } }));
    expect(r.ok).toBe(false);
    expect(chamadasAppointments()).toHaveLength(1);
  });
});

describe('criarEventoAgenda — validação', () => {
  it.each([
    [{ responsavelId: 'abc' }, /responsavelId/],
    [{ data: '30/09/2026' }, /data/],
    [{ data: '2026-09-31' }, /data/],
    [{ horaInicio: '25:00' }, /horaInicio/],
    [{ horaInicio: undefined }, /horaInicio/],
    [{ horaFim: '13:00' }, /horaFim/],
    [{ horaInicio: '23:45', horaFim: undefined }, /meia-noite/],
    [{ titulo: '   ' }, /titulo/],
    [{ envolvidosIds: ['x'] }, /envolvidosIds/],
    [{ chaveExterna: 'tem espaço' }, /chaveExterna/],
  ] as const)('%o → VALIDATION_ERROR', async (patch, msg) => {
    const r = await criarEventoAgenda(input(patch as Partial<CriarEventoAgendaInput>));
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    if (!r.ok) expect(r.error.message).toMatch(msg);
    expect(mockPost).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Buscar, cancelar, remarcar, excluir
// ─────────────────────────────────────────────────────────────────────────────

/** DTO real de GET /api/v2/appointments/{id} (capturado em 25/09/2026, dados de teste). */
const DTO_REAL = {
  comments: [{ id: 6640782074478592, text: "Evento criado em '25/09/2026 às 13:20h' por 'automacao'.", type: 'LOG' }],
  owner: '6528036269752320',
  id: '4677806899625984',
  description: 'TESTE API - PODE EXCLUIR',
  descriptionDetails: 'Teste automatizado.\n[ref:teste-api#1]',
  allDay: false,
  fromDate: 1793019600000,
  toDate: 1793021400000,
  whenDate: 20261026,
  toDateInt: 20261026,
  timeStart: '10:00',
  timeEnd: '10:30',
  timeFromTo: '10:00 - 10:30',
  addressType: 'ONLINE_MEETING',
  responsibleId: '6528036269752320',
  status: 'IN_PROGRESS',
  startAt: 1793019600000,
  endAt: 1793021400000,
};

describe('mapAppointmentDTO (formato real)', () => {
  it('lê data de whenDate, horas de timeStart/timeEnd e observações de descriptionDetails (não do log)', () => {
    expect(mapAppointmentDTO(DTO_REAL)).toMatchObject({
      id: '4677806899625984',
      tipo: 'atendimento',
      titulo: 'TESTE API - PODE EXCLUIR',
      dataInicio: '2026-10-26',
      dataFim: '2026-10-26',
      horaInicio: '10:00',
      horaFim: '10:30',
      status: 'pendente',
      responsavelId: '6528036269752320',
      envolvidosIds: [],
      comentarios: 'Teste automatizado.\n[ref:teste-api#1]',
    });
  });

  it('sem whenDate, usa startAt (epoch) convertido para BRT', () => {
    const { whenDate: _w, toDateInt: _t, ...semDatas } = DTO_REAL;
    expect(mapAppointmentDTO(semDatas).dataInicio).toBe('2026-10-26');
  });

  it('formatos alternativos: beginDate, timeFromTo, involvedWithNames, CANCELED', () => {
    expect(
      mapAppointmentDTO({
        id: 1,
        description: 'X',
        beginDate: '20260930',
        timeFromTo: '14:00 - 14:30',
        responsibleId: 2,
        involvedWithNames: { '3': 'Diuiane', '2': 'Resp' },
        caseId: 9,
        status: 'CANCELED',
      }),
    ).toMatchObject({ dataInicio: '2026-09-30', horaInicio: '14:00', horaFim: '14:30', envolvidosIds: ['3'], casoId: '9', status: 'cancelado' });
  });
});

describe('buscarEventoAgenda', () => {
  it('GET /appointments/{id}', async () => {
    mockGet.mockResolvedValueOnce(DTO_REAL);
    const r = await buscarEventoAgenda('4677806899625984');
    expect(mockGet).toHaveBeenCalledWith(expect.anything(), '/appointments/4677806899625984');
    expect(r).toMatchObject({ ok: true, data: { id: '4677806899625984', dataInicio: '2026-10-26' } });
  });

  it('404 e 410 (já excluído) viram NOT_FOUND com mensagem limpa', async () => {
    mockGet.mockRejectedValueOnce(new Error('page.evaluate: Error: API_ERROR_410: Este evento já foi excluído.\n    at eval (eval at evaluate (:290:30), <anonymous>:1:423)'));
    const r = await buscarEventoAgenda('1234567890');
    expect(r).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', message: 'API_ERROR_410: Este evento já foi excluído.' } });
    mockGet.mockRejectedValueOnce(new Error('API_ERROR_404: not found'));
    expect(await buscarEventoAgenda('1234567890')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('id inválido vira VALIDATION_ERROR', async () => {
    expect(await buscarEventoAgenda('abc')).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('cancelar / excluir / remarcar — só eventos da automação (salvo forcar)', () => {
  it('cancelar evento da automação = PUT /appointments/status com CANCELED', async () => {
    mockGet.mockResolvedValueOnce(DTO_REAL);
    mockPut.mockResolvedValueOnce({});
    const r = await cancelarEventoAgenda('4677806899625984', 'cliente desistiu');
    expect(mockPut).toHaveBeenCalledWith(
      expect.anything(),
      '/appointments/status',
      { appointmentId: '4677806899625984', userId: '6528036269752320', status: 'CANCELED', reason: 'cliente desistiu' },
      30_000,
    );
    expect(r).toMatchObject({ ok: true, data: { id: '4677806899625984', status: 'cancelado' } });
  });

  it('evento sem [ref:] (marcado à mão) → FORBIDDEN, nada é alterado', async () => {
    mockGet.mockResolvedValue({ ...DTO_REAL, descriptionDetails: 'marcado pela secretária' });
    expect(await cancelarEventoAgenda('4677806899625984')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await excluirEventoAgenda('4677806899625984')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await remarcarEventoAgenda('4677806899625984', { data: '2026-10-02', horaInicio: '15:00', responsavelId: LETICIA })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(mockPut).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('forcar=true dispensa a checagem (sem GET)', async () => {
    mockDelete.mockResolvedValueOnce({});
    const r = await excluirEventoAgenda('4677806899625984', { forcar: true });
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalledWith(expect.anything(), '/appointments/4677806899625984', 30_000);
    expect(r).toMatchObject({ ok: true, data: { id: '4677806899625984', removido: true } });
  });

  it('excluir inexistente vira NOT_FOUND', async () => {
    mockGet.mockRejectedValueOnce(new Error('API_ERROR_410: Este evento já foi excluído.'));
    expect(await excluirEventoAgenda('4677806899625984')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('remarcar confere conflito na nova data (ignorando o próprio evento) e faz PUT /appointments/reschedule', async () => {
    mockGet.mockResolvedValueOnce(DTO_REAL);
    calendario = [atividade({ id: 4677806899625984, dateStart: '20261002', dateEnd: '20261002', timeStart: '15:00', timeEnd: '15:30' })];
    mockPut.mockResolvedValueOnce({});
    const r = await remarcarEventoAgenda('4677806899625984', { data: '2026-10-02', horaInicio: '15:00', responsavelId: LETICIA });
    expect(mockPut).toHaveBeenCalledWith(
      expect.anything(),
      '/appointments/reschedule',
      expect.objectContaining({ id: '4677806899625984', whenDate: '2026-10-02', timeFromTo: '15:00 - 15:30' }),
      30_000,
    );
    expect(r.ok).toBe(true);
  });

  it('remarcar com conflito na nova data → CONFLICT', async () => {
    mockGet.mockResolvedValueOnce(DTO_REAL);
    calendario = [atividade({ id: 7777777777777777, dateStart: '20261002', dateEnd: '20261002', timeStart: '15:00', timeEnd: '15:30' })];
    const r = await remarcarEventoAgenda('4677806899625984', { data: '2026-10-02', horaInicio: '15:00', responsavelId: LETICIA });
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('remarcar valida data real e meia-noite', async () => {
    expect(await remarcarEventoAgenda('4677806899625984', { data: '2026-02-30', horaInicio: '15:00', responsavelId: LETICIA })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' },
    });
    expect(await remarcarEventoAgenda('4677806899625984', { data: '2026-10-02', horaInicio: '23:45', responsavelId: LETICIA })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' },
    });
  });
});

describe('classificarErro', () => {
  it('limpa o invólucro do Playwright e o stack', () => {
    expect(
      classificarErro(new Error('page.evaluate: Error: API_ERROR_500: falhou\n    at eval (eval at evaluate (:1:1))')),
    ).toMatchObject({ code: 'API_ERROR', message: 'API_ERROR_500: falhou' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Busca de consultas por contato (decisão 6)
// ─────────────────────────────────────────────────────────────────────────────

describe('buscarEventosPorContato', () => {
  beforeEach(() => {
    mockBuscarContatos.mockResolvedValue([{ id: '4440000000000001', nome: NOME, telefone: '27990000001' }]);
    mockListarAtendimentos.mockResolvedValue([
      { id: '3330000000000001', assunto: 'ATENDIMENTO', status: 'EM ANDAMENTO', casoId: '2220000000000001' },
    ]);
  });

  it('acha eventos pela [ref:], pelo caso/atendimento do contato ou pelo telefone nas observações', async () => {
    calendario = [
      atividade({ id: 1, caseId: 3330000000000001, timeStart: '09:00', timeEnd: '09:30' }),
      atividade({ id: 2, caseId: 2220000000000001, timeStart: '10:00', timeEnd: '10:30' }),
      atividade({ id: 3, comments: 'ligar 27 99000-0001', timeStart: '11:00', timeEnd: '11:30' }),
      atividade({ id: 4, comments: 'x [ref:n8n-ag#42]', timeStart: '12:00', timeEnd: '12:30' }),
      atividade({ id: 5, comments: 'outro cliente', timeStart: '13:00', timeEnd: '13:30' }),
      atividade({ id: 6, caseId: 3330000000000001, timeStart: '16:00', timeEnd: '16:30', status: 'CANCELED' }),
    ];

    const r = await buscarEventosPorContato({
      telefone: TEL,
      nome: NOME,
      chaveExterna: 'n8n-ag#42',
      inicio: '2026-09-25',
      fim: '2026-10-10',
      responsavelIds: [LETICIA],
    });

    if (!r.ok) throw new Error(r.error.message);
    expect(r.data.map((e) => [e.id, e.motivo])).toEqual([
      ['1', 'caso'],
      ['2', 'caso'],
      ['3', 'observacoes'],
      ['4', 'ref'],
    ]);
    expect(r.data[0].contato).toEqual({ id: '4440000000000001', nome: NOME });
    expect(mockListarAtendimentos).toHaveBeenCalledWith(expect.anything(), '4440000000000001', 20);
  });

  it('incluirCancelados=true devolve também os cancelados', async () => {
    calendario = [atividade({ id: 6, caseId: 3330000000000001, status: 'CANCELED' })];
    const r = await buscarEventosPorContato({
      telefone: TEL,
      nome: NOME,
      inicio: '2026-09-25',
      fim: '2026-10-10',
      responsavelIds: [LETICIA],
      incluirCancelados: true,
    });
    expect(r).toMatchObject({ ok: true, data: [{ id: '6', status: 'cancelado', motivo: 'caso' }] });
  });

  it('só telefone (sem nome): não busca contato; acha por [ref:]/observações', async () => {
    calendario = [
      atividade({ id: 1, caseId: 3330000000000001 }),
      atividade({ id: 3, comments: 'ligar 27 99000-0001', timeStart: '11:00', timeEnd: '11:30' }),
    ];
    const r = await buscarEventosPorContato({ telefone: TEL, inicio: '2026-09-25', fim: '2026-10-10', responsavelIds: [LETICIA] });
    expect(mockBuscarContatos).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, data: [{ id: '3', motivo: 'observacoes' }] });
  });

  it.each([
    [{}],
    [{ nome: NOME }],
  ])('sem telefone nem chave (%o) → VALIDATION_ERROR (nada de lista vazia enganosa)', async (extra) => {
    const r = await buscarEventosPorContato({ inicio: '2026-09-25', fim: '2026-10-10', responsavelIds: [LETICIA], ...extra });
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });
});
