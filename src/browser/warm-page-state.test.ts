import { describe, expect, it } from 'vitest';
import { WarmPageSlot, naRotaPadrao } from './warm-page-state.js';

describe('naRotaPadrao', () => {
  it('só aceita a rota Angular exata de estacionamento', () => {
    expect(naRotaPadrao('https://astrea.net.br/#/main/contacts')).toBe(true);
    expect(naRotaPadrao('https://app.astrea.net.br/#/main/contacts')).toBe(true);
    expect(naRotaPadrao('https://astrea.net.br/#/main/contacts/add-edit-merge/%5B,%5D/personal')).toBe(false);
    expect(naRotaPadrao('https://astrea.net.br/#/login/BR')).toBe(false);
    expect(naRotaPadrao('about:blank')).toBe(false);
  });
});

interface FakePage {
  id: string;
  closed: boolean;
}
const page = (id: string): FakePage => ({ id, closed: false });
const usable = (p: FakePage) => !p.closed;

describe('WarmPageSlot', () => {
  it('slot vazio: take devolve null (miss) e adopt transforma a página nova na quente', () => {
    const slot = new WarmPageSlot<FakePage>();
    expect(slot.take(usable)).toBeNull();
    const p = page('a');
    expect(slot.adopt(p)).toBe(true);
    expect(slot.stats).toMatchObject({ parked: false, inUse: true, hits: 0, misses: 1 });
  });

  it('release da página quente a estaciona (não fecha) e o próximo take reutiliza (hit)', () => {
    const slot = new WarmPageSlot<FakePage>();
    const p = page('a');
    slot.take(usable);
    slot.adopt(p);
    expect(slot.release(p)).toBe(true);
    expect(slot.stats).toMatchObject({ parked: true, inUse: false });
    expect(slot.take(usable)).toBe(p);
    expect(slot.stats).toMatchObject({ parked: false, inUse: true, hits: 1 });
  });

  it('página quente ocupada: take devolve null (o chamador abre aba comum) e adopt recusa a nova', () => {
    const slot = new WarmPageSlot<FakePage>();
    const quente = page('a');
    slot.adopt(quente);
    expect(slot.take(usable)).toBeNull();
    const comum = page('b');
    expect(slot.adopt(comum)).toBe(false);
    expect(slot.release(comum)).toBe(false);
    expect(slot.release(quente)).toBe(true);
  });

  it('página estacionada que foi fechada é descartada no take', () => {
    const slot = new WarmPageSlot<FakePage>();
    const p = page('a');
    slot.adopt(p);
    slot.release(p);
    p.closed = true;
    expect(slot.take(usable)).toBeNull();
    expect(slot.stats).toMatchObject({ parked: false, inUse: false, discards: 1 });
    const nova = page('b');
    expect(slot.adopt(nova)).toBe(true);
  });

  it('invalidate com página estacionada devolve-a para o chamador fechar', () => {
    const slot = new WarmPageSlot<FakePage>();
    const p = page('a');
    slot.adopt(p);
    slot.release(p);
    expect(slot.invalidate()).toBe(p);
    expect(slot.stats).toMatchObject({ parked: false, inUse: false });
  });

  it('invalidate com página EM USO não a devolve (seria fechada no meio da operação) e a descarta no release', () => {
    const slot = new WarmPageSlot<FakePage>();
    const p = page('a');
    slot.adopt(p);
    expect(slot.invalidate()).toBeNull();
    expect(slot.release(p)).toBe(false);
    expect(slot.stats).toMatchObject({ parked: false, inUse: false });
    expect(slot.adopt(page('b'))).toBe(true);
  });

  it('release com reutilizavel=false (erro na operação / fora da rota) descarta a aba quente', () => {
    const slot = new WarmPageSlot<FakePage>();
    const p = page('a');
    slot.adopt(p);
    expect(slot.release(p, false)).toBe(false);
    expect(slot.stats).toMatchObject({ parked: false, inUse: false, discards: 1 });
    expect(slot.adopt(page('b'))).toBe(true);
  });

  it('release de aba comum com reutilizavel=false continua devolvendo false (fechar)', () => {
    const slot = new WarmPageSlot<FakePage>();
    expect(slot.release(page('x'), false)).toBe(false);
  });

  it('reset esquece tudo (browser/context encerrado)', () => {
    const slot = new WarmPageSlot<FakePage>();
    const p = page('a');
    slot.adopt(p);
    slot.release(p);
    slot.reset();
    expect(slot.take(usable)).toBeNull();
    expect(slot.release(p)).toBe(false);
  });
});
