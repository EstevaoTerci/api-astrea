import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computarBusy, brtParaIso, isoParaEpoch } from './agenda-disponibilidade.js';
import type { EventoAgenda } from '../models/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE: EventoAgenda[] = JSON.parse(
  readFileSync(join(__dirname, '../../test/fixtures/agenda-astrea-2026-09.json'), 'utf8'),
);

const LETICIA = '6051920845144064';
const VICTOR = '6043699147374592';
const VERNECK = '6472608125059072';
const ALINE = '5774496458801152';
const DIUIANE = '5521380837982208';

function evento(overrides: Partial<EventoAgenda>): EventoAgenda {
  return {
    id: '1',
    tipo: 'atendimento',
    titulo: 'X',
    tituloComResponsavel: 'X',
    diaTodo: false,
    dataInicio: '2026-09-22',
    dataFim: '2026-09-22',
    horaInicio: '14:00',
    horaFim: '14:30',
    status: 'pendente',
    responsavelId: LETICIA,
    envolvidosIds: [],
    ...overrides,
  };
}

describe('brtParaIso / isoParaEpoch', () => {
  it('formata data+hora BRT com offset -03:00', () => {
    expect(brtParaIso('2026-09-22', '14:00')).toBe('2026-09-22T14:00:00-03:00');
    expect(brtParaIso('2026-09-22')).toBe('2026-09-22T00:00:00-03:00');
  });

  it('converte ISO com offset para epoch UTC', () => {
    expect(isoParaEpoch('2026-09-22T14:00:00-03:00')).toBe(Date.UTC(2026, 8, 22, 17, 0));
  });
});

describe('computarBusy — regras de ocupação', () => {
  it('diaTodo bloqueia o dia inteiro em BRT (intervalo semiaberto até 00:00 do dia seguinte)', () => {
    const r = computarBusy(FIXTURE, { responsavelIds: [VICTOR] });
    const bloqueio = r.porResponsavel[VICTOR].find((i) => i.inicio.startsWith('2026-09-10'));
    expect(bloqueio).toMatchObject({
      responsavelId: VICTOR,
      inicio: '2026-09-10T00:00:00-03:00',
      fim: '2026-09-11T00:00:00-03:00',
    });
    expect(bloqueio!.origens[0]).toMatchObject({
      eventoId: '6534926842494976',
      titulo: 'BLOQUEADO',
      diaTodo: true,
      papel: 'responsavel',
    });
  });

  it('diaTodo de vários dias atravessa o limite do mês', () => {
    const r = computarBusy(FIXTURE, { responsavelIds: [VICTOR] });
    const delegacia = r.porResponsavel[VICTOR].find((i) => i.inicio.startsWith('2026-09-30'));
    expect(delegacia).toMatchObject({
      inicio: '2026-09-30T00:00:00-03:00',
      fim: '2026-10-02T00:00:00-03:00',
    });
  });

  it('evento com hora vira intervalo exato', () => {
    const r = computarBusy(FIXTURE, { responsavelIds: [LETICIA] });
    expect(r.porResponsavel[LETICIA]).toContainEqual(
      expect.objectContaining({ inicio: '2026-09-22T14:00:00-03:00', fim: '2026-09-22T14:30:00-03:00' }),
    );
  });

  it('sem horaFim usa horaInicio + duracaoPadraoMin (default 30)', () => {
    const r = computarBusy(FIXTURE, { responsavelIds: [VERNECK] });
    expect(r.porResponsavel[VERNECK]).toEqual([
      expect.objectContaining({ inicio: '2026-09-23T15:00:00-03:00', fim: '2026-09-23T15:30:00-03:00' }),
    ]);
  });

  it('duracaoPadraoMin customizada', () => {
    const r = computarBusy(FIXTURE, { responsavelIds: [VERNECK], duracaoPadraoMin: 45 });
    expect(r.porResponsavel[VERNECK][0].fim).toBe('2026-09-23T15:45:00-03:00');
  });

  it('horaFim <= horaInicio (dado inconsistente) cai na duração padrão', () => {
    const r = computarBusy([evento({ horaInicio: '15:00', horaFim: '14:00' })], {
      responsavelIds: [LETICIA],
    });
    expect(r.porResponsavel[LETICIA][0]).toMatchObject({
      inicio: '2026-09-22T15:00:00-03:00',
      fim: '2026-09-22T15:30:00-03:00',
    });
  });

  it('evento que atravessa a meia-noite (23:00–00:30, mesma data) ocupa até 00:30 do dia seguinte', () => {
    const r = computarBusy([evento({ horaInicio: '23:00', horaFim: '00:30' })], { responsavelIds: [LETICIA] });
    expect(r.porResponsavel[LETICIA][0]).toMatchObject({
      inicio: '2026-09-22T23:00:00-03:00',
      fim: '2026-09-23T00:30:00-03:00',
    });
  });

  it('evento não-diaTodo sem horaInicio é tratado como dia inteiro (conservador)', () => {
    const r = computarBusy([evento({ horaInicio: undefined, horaFim: undefined })], {
      responsavelIds: [LETICIA],
    });
    expect(r.porResponsavel[LETICIA][0]).toMatchObject({
      inicio: '2026-09-22T00:00:00-03:00',
      fim: '2026-09-23T00:00:00-03:00',
    });
  });

  it('status concluido também ocupa', () => {
    const r = computarBusy(FIXTURE, { responsavelIds: [LETICIA] });
    expect(r.porResponsavel[LETICIA]).toContainEqual(
      expect.objectContaining({ inicio: '2026-09-22T13:00:00-03:00', fim: '2026-09-22T13:30:00-03:00' }),
    );
  });

  it('evento cancelado não ocupa', () => {
    const r = computarBusy([evento({ status: 'cancelado' })], { responsavelIds: [LETICIA] });
    expect(r.porResponsavel[LETICIA]).toEqual([]);
  });

  it('tipos default = atendimento + audiencia (prazo e tarefa não ocupam hora)', () => {
    const r = computarBusy(FIXTURE, { responsavelIds: [LETICIA] });
    const origens = r.porResponsavel[LETICIA].flatMap((i) => i.origens);
    expect(origens.find((o) => o.tipo === 'prazo')).toBeUndefined();
    expect(origens.find((o) => o.tipo === 'tarefa')).toBeUndefined();
  });

  it('tipos customizados incluem prazo quando pedido', () => {
    const r = computarBusy(FIXTURE, { responsavelIds: [LETICIA], tipos: ['prazo'] });
    expect(r.porResponsavel[LETICIA]).toHaveLength(1);
    expect(r.porResponsavel[LETICIA][0].origens[0].tipo).toBe('prazo');
  });

  it('evento sem dataInicio (tarefa sem prazo) é ignorado', () => {
    const r = computarBusy(FIXTURE, { responsavelIds: [LETICIA], tipos: ['tarefa'] });
    expect(r.porResponsavel[LETICIA]).toEqual([]);
  });

  it('audiência ocupa o responsável', () => {
    const r = computarBusy(FIXTURE, { responsavelIds: [ALINE] });
    expect(r.porResponsavel[ALINE]).toEqual([
      expect.objectContaining({ inicio: '2026-10-05T14:00:00-03:00', fim: '2026-10-05T14:30:00-03:00' }),
    ]);
  });
});

describe('computarBusy — responsável × envolvido', () => {
  it('evento ocupa o ENVOLVIDO quando ele está em responsavelIds (papel envolvido)', () => {
    const r = computarBusy(FIXTURE, { responsavelIds: [VICTOR] });
    const fox = r.porResponsavel[VICTOR].find((i) => i.inicio === '2026-09-24T14:00:00-03:00');
    expect(fox).toBeDefined();
    expect(fox!.origens[0]).toMatchObject({ eventoId: '7000000000000005', papel: 'envolvido' });
  });

  it('o mesmo evento aparece para responsável e envolvido quando ambos são pedidos', () => {
    const r = computarBusy(FIXTURE, { responsavelIds: [LETICIA, VICTOR] });
    const doEvento = r.busy.filter((i) => i.origens.some((o) => o.eventoId === '7000000000000005'));
    expect(doEvento.map((i) => i.responsavelId).sort()).toEqual([VICTOR, LETICIA].sort());
  });

  it('envolvido fora de responsavelIds é ignorado', () => {
    const r = computarBusy(FIXTURE, { responsavelIds: [VICTOR] });
    expect(Object.keys(r.porResponsavel)).toEqual([VICTOR]);
    expect(r.busy.every((i) => i.responsavelId === VICTOR)).toBe(true);
  });

  it('secretária envolvida é ocupada quando pedida', () => {
    const r = computarBusy(FIXTURE, { responsavelIds: [DIUIANE] });
    expect(r.porResponsavel[DIUIANE]).toEqual([
      expect.objectContaining({ inicio: '2026-09-22T16:00:00-03:00' }),
    ]);
  });

  it('responsável repetido em envolvidosIds não duplica a origem', () => {
    const r = computarBusy([evento({ envolvidosIds: [LETICIA] })], { responsavelIds: [LETICIA] });
    expect(r.porResponsavel[LETICIA]).toHaveLength(1);
    expect(r.porResponsavel[LETICIA][0].origens).toHaveLength(1);
    expect(r.porResponsavel[LETICIA][0].origens[0].papel).toBe('responsavel');
  });
});

describe('computarBusy — merge e forma da saída', () => {
  it('funde intervalos sobrepostos do mesmo responsável, somando as origens', () => {
    const r = computarBusy(FIXTURE, { responsavelIds: [LETICIA] });
    const dia25 = r.porResponsavel[LETICIA].filter((i) => i.inicio.startsWith('2026-08-25'));
    expect(dia25).toHaveLength(1);
    expect(dia25[0]).toMatchObject({
      inicio: '2026-08-25T14:00:00-03:00',
      fim: '2026-08-25T14:45:00-03:00',
    });
    expect(dia25[0].origens.map((o) => o.eventoId).sort()).toEqual([
      '7000000000000008',
      '7000000000000009',
    ]);
  });

  it('funde intervalos encostados (fim == início) e mantém separados os com folga', () => {
    const r = computarBusy(
      [
        evento({ id: 'a', horaInicio: '13:00', horaFim: '13:30' }),
        evento({ id: 'b', horaInicio: '13:30', horaFim: '14:00' }),
        evento({ id: 'c', horaInicio: '14:30', horaFim: '15:00' }),
      ],
      { responsavelIds: [LETICIA] },
    );
    expect(r.porResponsavel[LETICIA].map((i) => [i.inicio.slice(11, 16), i.fim.slice(11, 16)])).toEqual([
      ['13:00', '14:00'],
      ['14:30', '15:00'],
    ]);
  });

  it('bloqueio de dia inteiro absorve os eventos do mesmo dia', () => {
    const r = computarBusy(
      [
        evento({ id: 'bloq', diaTodo: true, horaInicio: undefined, horaFim: undefined }),
        evento({ id: 'at', horaInicio: '14:00', horaFim: '14:30' }),
      ],
      { responsavelIds: [LETICIA] },
    );
    expect(r.porResponsavel[LETICIA]).toHaveLength(1);
    expect(r.porResponsavel[LETICIA][0].origens).toHaveLength(2);
  });

  it('porResponsavel tem chave para todo id pedido, mesmo sem eventos', () => {
    const r = computarBusy([], { responsavelIds: [LETICIA, ALINE] });
    expect(r.porResponsavel).toEqual({ [LETICIA]: [], [ALINE]: [] });
    expect(r.busy).toEqual([]);
  });

  it('busy segue a ordem de responsavelIds e, dentro dela, a ordem cronológica', () => {
    const r = computarBusy(FIXTURE, { responsavelIds: [VICTOR, LETICIA] });
    const ids = r.busy.map((i) => i.responsavelId);
    const primeiroLeticia = ids.indexOf(LETICIA);
    expect(ids.slice(0, primeiroLeticia).every((id) => id === VICTOR)).toBe(true);
    for (const id of [VICTOR, LETICIA]) {
      const inicios = r.porResponsavel[id].map((i) => isoParaEpoch(i.inicio));
      expect(inicios).toEqual([...inicios].sort((a, b) => a - b));
    }
  });

  it('é pura: não altera os eventos de entrada', () => {
    const copia = JSON.parse(JSON.stringify(FIXTURE));
    computarBusy(FIXTURE, { responsavelIds: [LETICIA, VICTOR] });
    expect(FIXTURE).toEqual(copia);
  });
});
