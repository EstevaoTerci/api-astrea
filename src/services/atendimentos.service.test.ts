import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../browser/astrea-http.js', () => ({
  ANGULAR_PAGE_PATH: '/#/main/contacts',
  withBrowserContext: vi.fn(<T>(op: (page: unknown) => Promise<T>) => op({})),
  astreaApiGet: vi.fn(),
  astreaApiPost: vi.fn(),
  astreaGapiGet: vi.fn(),
  astreaGapiPost: vi.fn(),
  getAstreaUserId: vi.fn().mockResolvedValue('6528036269752320'),
}));

vi.mock('../browser/navigator.js', () => ({
  navigateTo: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./casos.service.js', () => ({
  buscarCaso: vi.fn(),
}));

import {
  criarAtendimento,
  criarAtendimentoNaPagina,
  listarAtendimentosDoContatoNaPagina,
} from './atendimentos.service.js';
import { astreaApiGet, astreaApiPost } from '../browser/astrea-http.js';

const mockGet = vi.mocked(astreaApiGet);
const mockPost = vi.mocked(astreaApiPost);

const LETICIA = '6051920845144064';

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

describe('criarAtendimentoNaPagina', () => {
  it('cria o consulting com o contato como cliente principal e o advogado como responsável', async () => {
    mockGet.mockResolvedValueOnce({ id: 5555555555555555, name: 'Fulano de Tal' });
    mockPost.mockResolvedValueOnce({
      id: 6666666666666666,
      active: true,
      subject: 'ATENDIMENTO INICIAL - FULANO - ONLINE',
      responsibleId: LETICIA,
      customers: [{ id: 5555555555555555, name: 'Fulano de Tal', main: true }],
    });

    const r = await criarAtendimentoNaPagina({} as never, {
      clienteId: '5555555555555555',
      assunto: 'ATENDIMENTO INICIAL - FULANO - ONLINE',
      descricao: 'Resumo do caso',
      data: '2026-09-30',
      hora: '14:00',
      responsavelId: LETICIA,
    });

    expect(mockGet).toHaveBeenCalledWith(expect.anything(), '/contact/5555555555555555/details');
    const [, path, payload] = mockPost.mock.calls[0] as [unknown, string, any];
    expect(path).toBe('/consulting');
    expect(payload.subject).toBe('ATENDIMENTO INICIAL - FULANO - ONLINE');
    expect(payload.message).toBe('Resumo do caso');
    expect(payload.responsibleId).toBe(LETICIA);
    expect(payload.customers).toEqual([{ id: 5555555555555555, name: 'Fulano de Tal', main: true }]);
    expect(payload.messages).toEqual([{ message: 'Resumo do caso', userAuthor: LETICIA }]);
    expect(payload.caseAttached).toBeNull();
    expect(r.id).toBe('6666666666666666');
    expect(r.clienteId).toBe('5555555555555555');
  });

  it('contato inexistente vira NOT_FOUND', async () => {
    mockGet.mockRejectedValueOnce(new Error('API_ERROR_404: not found'));
    await expect(
      criarAtendimentoNaPagina({} as never, {
        clienteId: '1',
        assunto: 'X',
        data: '2026-09-30',
        hora: '14:00',
        responsavelId: LETICIA,
      }),
    ).rejects.toThrow(/NOT_FOUND/);
  });
});

describe('criarAtendimento (service público) continua funcionando via a função na página', () => {
  it('ok com o atendimento mapeado', async () => {
    mockGet.mockResolvedValueOnce({ id: 1, name: 'Fulano' });
    mockPost.mockResolvedValueOnce({ id: 2, subject: 'S', responsibleId: LETICIA, customers: [{ id: 1, name: 'Fulano', main: true }] });
    const r = await criarAtendimento({ clienteId: '1', assunto: 'S', data: '2026-09-30', hora: '14:00', responsavelId: LETICIA });
    expect(r).toMatchObject({ ok: true, data: { id: '2', assunto: 'S', clienteId: '1' } });
  });
});

describe('listarAtendimentosDoContatoNaPagina', () => {
  it('consulta /consulting/query pelo customerId e mapeia (id do caso vinculado incluso)', async () => {
    mockPost.mockResolvedValueOnce({
      consultingDTO: [
        { id: 3330000000000001, subject: 'ATENDIMENTO', active: true, caseAttached: { id: 2220000000000001, title: 'Caso' } },
      ],
      cursor: '',
    });

    const r = await listarAtendimentosDoContatoNaPagina({} as never, '4440000000000001', 20);

    const [, path, payload] = mockPost.mock.calls[0] as [unknown, string, any];
    expect(path).toBe('/consulting/query');
    expect(payload.customerId).toBe(4440000000000001);
    expect(payload.limit).toBe(20);
    expect(r).toEqual([expect.objectContaining({ id: '3330000000000001', casoId: '2220000000000001' })]);
  });
});
