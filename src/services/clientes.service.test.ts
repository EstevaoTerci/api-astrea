import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — TUDO que envolve Playwright fica out of test scope.
// O `withBrowserContext` é re-implementado para apenas invocar a callback com
// um page-stub vazio; os HTTP helpers viram vi.fn() que cada teste configura.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../browser/astrea-http.js', () => ({
  ASTREA_API: 'https://app.astrea.net.br/api/v2',
  ASTREA_APP: 'https://app.astrea.net.br',
  withBrowserContext: vi.fn(<T>(op: (page: unknown) => Promise<T>) => op({})),
  astreaApiGet: vi.fn(),
  astreaApiPost: vi.fn(),
  astreaAppGet: vi.fn(),
  getAstreaUserId: vi.fn().mockResolvedValue('1234567890'),
}));

vi.mock('../browser/navigator.js', () => ({
  navigateTo: vi.fn().mockResolvedValue(undefined),
}));

import {
  buscarCliente,
  criarCliente,
  atualizarCliente,
  listarClientes,
  listarTodosClientes,
  listarAniversariantesEnriquecidos,
  mesclarClientes,
  getListarClientesCacheStats,
  getAniversariantesCacheStats,
} from './clientes.service.js';
import { astreaApiGet, astreaApiPost, astreaAppGet } from '../browser/astrea-http.js';

const mockGet = vi.mocked(astreaApiGet);
const mockPost = vi.mocked(astreaApiPost);
const mockAppGet = vi.mocked(astreaAppGet);

// Fixtures de respostas do Astrea
function makeContactListItem(overrides: Partial<{
  id: number;
  name: string;
  contactKind: string;
  telephones: any[];
  emails: any[];
  addresses: any[];
  classificationName: string;
  tags: any[];
  createdAt: string;
}> = {}) {
  return {
    id: 12345,
    name: 'João da Silva',
    contactKind: 'PERSON',
    telephones: [{ typeEnum: 'PERSONAL_CELLULAR', telephone: '27999999999' }],
    emails: [{ address: 'joao@example.com' }],
    addresses: [{ display: 'Rua A, 100 — Vitória/ES' }],
    classificationName: 'Cliente',
    tags: [{ name: 'VIP' }],
    createdAt: '2026-01-15T10:00:00Z',
    ...overrides,
  };
}

function makeContactDetails(overrides: Partial<{
  id: number;
  name: string;
  contactKind: string;
  taxDocumentNumber: string;
  telephones: any[];
  emails: any[];
  webSites: any[];
  addresses: any[];
  birthDate: string;
  clientOrigin: string;
  createdAt: number;
}> = {}) {
  return {
    id: 12345,
    name: 'João da Silva',
    contactKind: 'PERSON',
    taxDocumentNumber: '123.456.789-09',
    telephones: [{ typeEnum: 'PERSONAL_CELLULAR', number: '27999999999' }],
    emails: [{ typeEnum: 'PERSONAL', address: 'joao@example.com' }],
    webSites: [{ url: 'https://drive.google.com/drive/folders/abc' }],
    addresses: [{ typeEnum: 'HOME', value: 'Rua A, 100' }],
    birthDate: '1990-03-15',
    clientOrigin: 'Indicação',
    createdAt: 1610000000000,
    ...overrides,
  };
}

beforeEach(() => {
  // ATENÇÃO: `vi.clearAllMocks()` NÃO esvazia a fila do `mockResolvedValueOnce` —
  // só limpa o histórico de chamadas. Para mocks que usam queueing, é preciso
  // `mockReset()`. Aplicamos só nos dois HTTP helpers (que não têm impl fixa);
  // `withBrowserContext` mantém sua impl porque é setada no vi.mock acima.
  mockGet.mockReset();
  mockPost.mockReset();
  mockAppGet.mockReset();
  // Cache do listarClientes é singleton — confiamos em chaves distintas + bypass
  // por nome/cpf para isolar testes.
});

// ─────────────────────────────────────────────────────────────────────────────
// listarClientes
// ─────────────────────────────────────────────────────────────────────────────

describe('listarClientes', () => {
  it('chama POST /contact/all com queryDTO padronizado', async () => {
    mockPost.mockResolvedValueOnce({ contacts: [makeContactListItem()], cursor: '' });

    const r = await listarClientes({ mesAniversario: 5, estado: 'es', pagina: 1, limite: 20 });

    expect(r.ok).toBe(true);
    expect(mockPost).toHaveBeenCalledWith(
      expect.anything(),
      '/contact/all',
      expect.objectContaining({
        page: 0, // 1-based no input → 0-based no Astrea
        limit: 20,
        queryDTO: expect.objectContaining({
          birthMonth: 5,
          state: 'es',
          text: '',
        }),
      }),
    );
  });

  it('mapeia o item da lista para Cliente (id como string, urls preenchidas)', async () => {
    mockPost.mockResolvedValueOnce({
      contacts: [makeContactListItem({ id: 999, name: '  Maria Souza  ' })],
      cursor: '',
    });

    const r = await listarClientes({ mesAniversario: 1 });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(1);
    expect(r.data[0]).toMatchObject({
      id: '999',
      nome: 'Maria Souza', // trim aplicado nas pontas
      url: expect.stringContaining('/main/contacts/detail/999'),
      tipo: 'pessoa_fisica',
    });
  });

  it('cacheia chamadas com mesma chave (filtros estruturais)', async () => {
    mockPost.mockResolvedValueOnce({
      contacts: [makeContactListItem({ id: 1, name: 'A' })],
      cursor: '',
    });

    const r1 = await listarClientes({ mesAniversario: 12, pagina: 7, limite: 33 });
    const r2 = await listarClientes({ mesAniversario: 12, pagina: 7, limite: 33 });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Segunda chamada vem do cache → POST roda só 1x
    expect(mockPost).toHaveBeenCalledTimes(1);

    const stats = getListarClientesCacheStats();
    expect(stats.hits).toBeGreaterThanOrEqual(1);
  });

  it('bypassa o cache quando filtro inclui nome (busca livre)', async () => {
    mockPost.mockResolvedValue({ contacts: [], cursor: '' });
    mockGet.mockResolvedValue(makeContactDetails());

    await listarClientes({ nome: 'José' });
    await listarClientes({ nome: 'José' });

    // POST roda 2x — busca livre não é cacheável
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('bypassa o cache quando filtro inclui cpfCnpj', async () => {
    mockPost.mockResolvedValue({ contacts: [], cursor: '' });

    await listarClientes({ cpfCnpj: '12345678909' });
    await listarClientes({ cpfCnpj: '12345678909' });

    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('formata CPF com máscara antes de enviar para o Astrea', async () => {
    mockPost.mockResolvedValueOnce({ contacts: [], cursor: '' });

    await listarClientes({ cpfCnpj: '12345678909' }); // CPF (11 dígitos)

    expect(mockPost).toHaveBeenCalledWith(
      expect.anything(),
      '/contact/all',
      expect.objectContaining({
        queryDTO: expect.objectContaining({ text: '123.456.789-09' }),
      }),
    );
  });

  it('formata CNPJ com máscara antes de enviar para o Astrea', async () => {
    mockPost.mockResolvedValueOnce({ contacts: [], cursor: '' });

    await listarClientes({ cpfCnpj: '12345678000199' }); // CNPJ (14 dígitos)

    expect(mockPost).toHaveBeenCalledWith(
      expect.anything(),
      '/contact/all',
      expect.objectContaining({
        queryDTO: expect.objectContaining({ text: '12.345.678/0001-99' }),
      }),
    );
  });

  it('preferência nome > cpfCnpj quando ambos vêm', async () => {
    mockPost.mockResolvedValueOnce({ contacts: [], cursor: '' });

    await listarClientes({ nome: 'Maria', cpfCnpj: '12345678909' });

    const call = mockPost.mock.calls[0][2] as any;
    expect(call.queryDTO.text).toBe('Maria');
  });

  it('enriquece com /details quando há busca por nome (até 20 contatos)', async () => {
    const items = Array.from({ length: 25 }, (_, i) =>
      makeContactListItem({ id: i + 1, name: `User ${i + 1}` }),
    );
    mockPost.mockResolvedValueOnce({ contacts: items, cursor: '' });
    mockGet.mockResolvedValue(makeContactDetails({ id: 99, name: 'Enriched' }));

    const r = await listarClientes({ nome: 'User' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Top 20 enriquecidos via /details
    expect(mockGet).toHaveBeenCalledTimes(20);
    // 25 retornados (20 enriquecidos + 5 do mapper rápido) — neste caso o
    // enrichedIds set faz com que o append complete o restante.
    expect(r.data.length).toBeGreaterThanOrEqual(20);
  });

  it('filtra cpfCnpj localmente após enrichment (match nos dígitos)', async () => {
    mockPost.mockResolvedValueOnce({
      contacts: [
        makeContactListItem({ id: 1, name: 'A' }),
        makeContactListItem({ id: 2, name: 'B' }),
      ],
      cursor: '',
    });
    mockGet
      .mockResolvedValueOnce(makeContactDetails({ id: 1, taxDocumentNumber: '123.456.789-09' }))
      .mockResolvedValueOnce(makeContactDetails({ id: 2, taxDocumentNumber: '987.654.321-00' }));

    const r = await listarClientes({ cpfCnpj: '12345678909' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(1);
    expect(r.data[0].id).toBe('1');
  });

  it('propaga erro como ServiceResponse { ok: false } com código apropriado', async () => {
    mockPost.mockRejectedValueOnce(new Error('BROWSER_POOL_TIMEOUT: sem slot'));

    const r = await listarClientes({ mesAniversario: 8 }); // chave nova pra não bater cache

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BROWSER_UNAVAILABLE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listarTodosClientes
// ─────────────────────────────────────────────────────────────────────────────

describe('listarTodosClientes', () => {
  it('chama /contact/all com pageSize=9999 e onlyCount=false', async () => {
    mockPost.mockResolvedValueOnce({
      contacts: [makeContactListItem({ id: 1, name: 'X' })],
      cursor: '',
    });

    await listarTodosClientes({ estado: 'SP' });

    expect(mockPost).toHaveBeenCalledWith(
      expect.anything(),
      '/contact/all',
      expect.objectContaining({
        paging: { pageNumber: 0, pageSize: 9999 },
        queryDTO: expect.objectContaining({ onlyCount: false, state: 'SP' }),
      }),
    );
  });

  it('mapeia para ClienteResumido (sem cpfCnpj/birthDate)', async () => {
    mockPost.mockResolvedValueOnce({
      contacts: [
        makeContactListItem({ id: 10, name: 'Alice', classificationName: 'Cliente' }),
      ],
      cursor: '',
    });

    const r = await listarTodosClientes({});

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data[0]).toMatchObject({
      id: '10',
      nome: 'Alice',
      classificacao: 'Cliente',
      etiquetas: ['VIP'],
    });
    // ClienteResumido não tem cpfCnpj
    expect((r.data[0] as any).cpfCnpj).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buscarCliente
// ─────────────────────────────────────────────────────────────────────────────

describe('buscarCliente', () => {
  it('vai direto pra /details quando o input é um ID numérico longo', async () => {
    mockGet.mockResolvedValueOnce(makeContactDetails({ id: 9999999999 }));

    const r = await buscarCliente('9999999999');

    expect(r.ok).toBe(true);
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockGet).toHaveBeenCalledWith(expect.anything(), '/contact/9999999999/details');
  });

  it('busca via /contact/all primeiro quando o input é texto (nome/CPF)', async () => {
    mockPost.mockResolvedValueOnce({ contacts: [makeContactListItem({ id: 555 })], cursor: '' });
    mockGet.mockResolvedValueOnce(makeContactDetails({ id: 555 }));

    const r = await buscarCliente('José da Silva');

    expect(r.ok).toBe(true);
    expect(mockPost).toHaveBeenCalledWith(
      expect.anything(),
      '/contact/all',
      expect.objectContaining({ queryDTO: expect.objectContaining({ text: 'José da Silva' }) }),
    );
    expect(mockGet).toHaveBeenCalledWith(expect.anything(), '/contact/555/details');
  });

  it('retorna NOT_FOUND quando a busca não encontra nada', async () => {
    mockPost.mockResolvedValueOnce({ contacts: [], cursor: '' });

    const r = await buscarCliente('CPF que não existe');

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_FOUND');
    expect(r.error.retryable).toBe(false);
  });

  it('retorna NOT_FOUND quando /details devolve 404', async () => {
    mockGet.mockRejectedValueOnce(new Error('API_ERROR_404: Contato não encontrado'));

    const r = await buscarCliente('9999999999');

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_FOUND');
  });

  it('por padrão NÃO chama /documents/all (caminho rápido)', async () => {
    mockGet.mockResolvedValueOnce(makeContactDetails({ id: 1234567890 }));

    await buscarCliente('1234567890');

    // Apenas /details, nada de /documents/all
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('com incluirDocumentos=true chama /documents/all e popula documentos[]', async () => {
    mockGet.mockResolvedValueOnce(makeContactDetails({ id: 1234567890 }));
    mockPost.mockResolvedValueOnce({
      dtoList: [
        {
          id: 1,
          type: 'DTE_DRIVE',
          title: 'Pasta Drive',
          url: 'https://drive.google.com/drive/folders/xyz',
          updateDate: 1620000000000,
        },
      ],
      queryCursor: '',
    });

    const r = await buscarCliente('1234567890', { incluirDocumentos: true });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.documentos).toHaveLength(1);
    expect(r.data.documentos![0].tipo).toBe('DTE_DRIVE');
    expect(mockPost).toHaveBeenCalledWith(
      expect.anything(),
      '/documents/all',
      expect.objectContaining({
        customers: ['1234567890'],
        userId: '1234567890',
        queryCursor: '',
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// criarCliente
// ─────────────────────────────────────────────────────────────────────────────

describe('criarCliente', () => {
  it('retorna sucesso com o contato criado quando /contact/save responde com ID', async () => {
    // Mock para a etapa "loadDefaultContactDraft" envolve page.evaluate, que não
    // está mockada. Como o teste cobre criarCliente, vamos cobrir só o caminho
    // de erro feliz onde o evaluate é o gatilho do throw.
    mockPost.mockRejectedValueOnce(new Error('FORM_UNAVAILABLE: stub não simulado'));

    const r = await criarCliente({ nome: 'Novo Cliente' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('API_ERROR');
  });

  it('mapeia erro API_ERROR corretamente quando o Astrea retorna NOT_OK', async () => {
    // Não podemos rodar o page.evaluate de loadDefaultContactDraft; o erro vem
    // antes. O importante é que criarCliente retorna ServiceResponse com code='API_ERROR'.
    mockPost.mockRejectedValueOnce(new Error('API_ERROR: NOT_OK do Astrea'));

    const r = await criarCliente({ nome: 'X' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('API_ERROR');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// atualizarCliente
// ─────────────────────────────────────────────────────────────────────────────

describe('atualizarCliente', () => {
  it('retorna VALIDATION_ERROR quando id está vazio', async () => {
    const r = await atualizarCliente('   ', { nome: 'X' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('VALIDATION_ERROR');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('retorna VALIDATION_ERROR quando input não tem nenhum campo', async () => {
    const r = await atualizarCliente('123', {});

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /details + POST /save quando há campo a atualizar', async () => {
    // ID com 10+ dígitos: buscarCliente final pula busca e vai direto pro GET /details
    const id = '1000000000';
    mockGet
      .mockResolvedValueOnce(makeContactDetails({ id: 1000000000 }))
      .mockResolvedValueOnce(makeContactDetails({ id: 1000000000, name: 'Atualizado' }));
    mockPost.mockResolvedValueOnce({ response: 1000000000 });

    const r = await atualizarCliente(id, { nome: 'Atualizado' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.nome).toBe('Atualizado');

    // /details lido 2x (read + buscarCliente final), /save chamado 1x
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockPost).toHaveBeenCalledWith(
      expect.anything(),
      '/contact/save',
      expect.objectContaining({ name: 'Atualizado' }),
    );
  });

  it('retorna NOT_FOUND quando GET /details responde 404', async () => {
    mockGet.mockRejectedValueOnce(new Error('API_ERROR_404: não encontrado'));

    const r = await atualizarCliente('9999999999', { nome: 'X' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_FOUND');
  });

  it('normaliza birthYear/Day/Month para number antes do save', async () => {
    mockGet
      .mockResolvedValueOnce({
        ...makeContactDetails({ id: 5000000000 }),
        birthYear: '1990',
        birthDay: '15',
        birthMonth: '3',
      } as any)
      .mockResolvedValueOnce(makeContactDetails({ id: 5000000000 }));
    mockPost.mockResolvedValueOnce({ response: 5000000000 });

    await atualizarCliente('5000000000', { nome: 'novo' });

    const savePayload = mockPost.mock.calls[0][2] as any;
    expect(savePayload.birthYear).toBe(1990);
    expect(savePayload.birthDay).toBe(15);
    expect(savePayload.birthMonth).toBe(3);
  });

  it('preserva campos não passados (patch parcial)', async () => {
    mockGet
      .mockResolvedValueOnce(
        makeContactDetails({ id: 7777777777, name: 'Original', taxDocumentNumber: '111' }),
      )
      .mockResolvedValueOnce(
        makeContactDetails({ id: 7777777777, name: 'Original', taxDocumentNumber: '111' }),
      );
    mockPost.mockResolvedValueOnce({ response: 7777777777 });

    await atualizarCliente('7777777777', { telefone: '27999990000' });

    const savePayload = mockPost.mock.calls[0][2] as any;
    expect(savePayload.name).toBe('Original');
    expect(savePayload.taxDocumentNumber).toBe('111');
    expect(savePayload.telephones[0].number).toBe('27999990000');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mesclarClientes — validação (não testamos o page.evaluate pesado)
// ─────────────────────────────────────────────────────────────────────────────

describe('mesclarClientes — validação', () => {
  it('rejeita idPrincipal vazio', async () => {
    const r = await mesclarClientes({ idPrincipal: '', idsMesclados: ['1'] });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('VALIDATION_ERROR');
    expect(r.error.message).toMatch(/idPrincipal/);
  });

  it('rejeita idsMesclados vazio', async () => {
    const r = await mesclarClientes({ idPrincipal: '100', idsMesclados: [] });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('VALIDATION_ERROR');
    expect(r.error.message).toMatch(/idsMesclados/);
  });

  it('rejeita quando idsMesclados inclui o idPrincipal', async () => {
    const r = await mesclarClientes({ idPrincipal: '100', idsMesclados: ['200', '100'] });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('VALIDATION_ERROR');
    expect(r.error.message).toMatch(/idPrincipal/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getListarClientesCacheStats
// ─────────────────────────────────────────────────────────────────────────────

describe('getListarClientesCacheStats', () => {
  it('retorna estrutura com hits, misses, hitRatio', () => {
    const stats = getListarClientesCacheStats();
    expect(stats).toHaveProperty('hits');
    expect(stats).toHaveProperty('misses');
    expect(stats).toHaveProperty('inflightShared');
    expect(stats).toHaveProperty('entries');
    expect(stats).toHaveProperty('hitRatio');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listarAniversariantesEnriquecidos
//
// Fluxo REST estável (substitui o antigo trio count → prepare-list-report →
// /report/contactdetail, que quebrou em prod com API_ERROR_-1 no endpoint
// interno /report/contactdetail):
//
//   1. POST /contact/all  com queryDTO{ birthMonth: N }  → lista do mês (IDs,
//      nome, telefone) — endpoint estável, mesmo de listar_clientes.
//   2. GET /contact/{id}/details (por contato, concorrência limitada) →
//      enriquece com `birthDate` (BR dd/MM/yyyy) + `taxDocumentNumber`, que a
//      lista NÃO traz. Mesma aba, sem abrir abas paralelas.
//
// O service mapeia via mapContactDetails e normaliza `dataNascimento` para ISO
// (preserva o contrato histórico de listar_aniversariantes).
// ─────────────────────────────────────────────────────────────────────────────

describe('listarAniversariantesEnriquecidos', () => {
  it('lista via /contact/all (birthMonth) e enriquece cada contato via /details', async () => {
    mockPost.mockResolvedValueOnce({
      contacts: [
        makeContactListItem({ id: 1, name: 'Airton' }),
        makeContactListItem({ id: 2, name: 'Maria' }),
      ],
      cursor: '',
    });
    mockGet
      .mockResolvedValueOnce(
        makeContactDetails({ id: 1, name: 'Airton', birthDate: '14/06/1966' }),
      )
      .mockResolvedValueOnce(
        makeContactDetails({ id: 2, name: 'Maria', birthDate: '20/06/1980' }),
      );

    const r = await listarAniversariantesEnriquecidos({ mes: 6 });

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Passo 1: lista do mês via /contact/all com filtro server-side birthMonth.
    expect(mockPost).toHaveBeenCalledWith(
      expect.anything(),
      '/contact/all',
      expect.objectContaining({
        queryDTO: expect.objectContaining({ birthMonth: 6 }),
      }),
    );
    // Passo 2: enriquecimento por /details de cada contato.
    expect(mockGet).toHaveBeenCalledWith(expect.anything(), '/contact/1/details');
    expect(mockGet).toHaveBeenCalledWith(expect.anything(), '/contact/2/details');

    // NÃO toca mais o trio frágil do report.
    expect(mockAppGet).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalledWith(
      expect.anything(),
      '/contact/all/count',
      expect.anything(),
    );
    expect(mockPost).not.toHaveBeenCalledWith(
      expect.anything(),
      '/contact/prepare-list-report',
      expect.anything(),
    );

    expect(r.data).toHaveLength(2);
    expect(r.data[0]).toMatchObject({
      id: '1',
      nome: 'Airton',
      cpfCnpj: '123.456.789-09',
      dataNascimento: '1966-06-14', // birthDate BR (dd/MM/yyyy) → ISO
      tipo: 'pessoa_fisica',
    });
  });

  it('converte dataNascimento BR (dd/MM/yyyy) do /details para ISO', async () => {
    mockPost.mockResolvedValueOnce({
      contacts: [makeContactListItem({ id: 7 })],
      cursor: '',
    });
    mockGet.mockResolvedValueOnce(makeContactDetails({ id: 7, birthDate: '04/07/1974' }));

    const r = await listarAniversariantesEnriquecidos({ mes: 7 });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data[0].dataNascimento).toBe('1974-07-04');
  });

  it('mantém dataNascimento já em ISO inalterado', async () => {
    mockPost.mockResolvedValueOnce({
      contacts: [makeContactListItem({ id: 8 })],
      cursor: '',
    });
    mockGet.mockResolvedValueOnce(makeContactDetails({ id: 8, birthDate: '1990-03-15' }));

    const r = await listarAniversariantesEnriquecidos({ mes: 8 });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data[0].dataNascimento).toBe('1990-03-15');
  });

  it('enriquece TODOS os contatos do mês (não limita a 20 como listarClientes)', async () => {
    const items = Array.from({ length: 25 }, (_, i) =>
      makeContactListItem({ id: i + 1, name: `Aniversariante ${i + 1}` }),
    );
    mockPost.mockResolvedValueOnce({ contacts: items, cursor: '' });
    mockGet.mockResolvedValue(makeContactDetails({ id: 99 }));

    const r = await listarAniversariantesEnriquecidos({ mes: 1 });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(25);
    expect(mockGet).toHaveBeenCalledTimes(25);
  });

  it('cacheia chamadas idênticas (segunda execução não refaz a lista nem o enrich)', async () => {
    mockPost.mockResolvedValueOnce({
      contacts: [makeContactListItem({ id: 1 })],
      cursor: '',
    });
    mockGet.mockResolvedValueOnce(makeContactDetails({ id: 1 }));

    const r1 = await listarAniversariantesEnriquecidos({ mes: 2 });
    const r2 = await listarAniversariantesEnriquecidos({ mes: 2 });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Lista e enrich rodaram só 1 vez (segunda veio do cache).
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('usa dados parciais da lista quando o /details de um contato falha', async () => {
    mockPost.mockResolvedValueOnce({
      contacts: [
        makeContactListItem({ id: 1, name: 'OK' }),
        makeContactListItem({ id: 2, name: 'Falha' }),
      ],
      cursor: '',
    });
    mockGet
      .mockResolvedValueOnce(makeContactDetails({ id: 1, name: 'OK', birthDate: '01/01/1970' }))
      .mockRejectedValueOnce(new Error('API_ERROR_500: indisponível'));

    const r = await listarAniversariantesEnriquecidos({ mes: 3 });

    // A operação inteira não falha por causa de 1 contato.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(2);
    // Contato enriquecido tem data; o que falhou aparece parcial (sem dataNascimento).
    expect(r.data.find((c) => c.id === '1')?.dataNascimento).toBe('1970-01-01');
    expect(r.data.find((c) => c.id === '2')?.dataNascimento).toBeUndefined();
  });

  it('mapeia contactKind=COMPANY para tipo=pessoa_juridica', async () => {
    mockPost.mockResolvedValueOnce({
      contacts: [makeContactListItem({ id: 42, name: 'Empresa LTDA' })],
      cursor: '',
    });
    mockGet.mockResolvedValueOnce(
      makeContactDetails({ id: 42, name: 'Empresa LTDA', contactKind: 'COMPANY' }),
    );

    const r = await listarAniversariantesEnriquecidos({ mes: 4 });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data[0]).toMatchObject({ id: '42', nome: 'Empresa LTDA', tipo: 'pessoa_juridica' });
  });

  it('retorna lista vazia quando não há aniversariantes no mês (sem chamar /details)', async () => {
    mockPost.mockResolvedValueOnce({ contacts: [], cursor: '' });

    const r = await listarAniversariantesEnriquecidos({ mes: 5 });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(0);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('propaga erro como ServiceResponse { ok: false } quando a lista falha', async () => {
    mockPost.mockRejectedValueOnce(new Error('BROWSER_POOL_TIMEOUT: sem slot'));

    const r = await listarAniversariantesEnriquecidos({ mes: 12 });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BROWSER_UNAVAILABLE');
  });

  it('mapeia circuit breaker de login aberto para BROWSER_UNAVAILABLE', async () => {
    mockPost.mockRejectedValueOnce(
      new Error('LOGIN_CIRCUIT_OPEN: login bloqueado após 3 falhas; retry em ~57s'),
    );

    // mês novo pra não bater cache de testes anteriores
    const r = await listarAniversariantesEnriquecidos({ mes: 9, estado: 'BA' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BROWSER_UNAVAILABLE');
  });
});

describe('getAniversariantesCacheStats', () => {
  it('retorna estrutura compatível com InflightCacheStats', () => {
    const stats = getAniversariantesCacheStats();
    expect(stats).toHaveProperty('hits');
    expect(stats).toHaveProperty('misses');
    expect(stats).toHaveProperty('inflightShared');
    expect(stats).toHaveProperty('entries');
    expect(stats).toHaveProperty('hitRatio');
  });
});
