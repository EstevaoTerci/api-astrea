import { describe, expect, it, vi } from 'vitest';
import {
  isStateUsable,
  readSessionState,
  writeSessionStateAtomic,
  redactSession,
  type PersistedSession,
  type SessionFs,
  type SessionStorageState,
} from './session-state.js';

const NOW = 1_700_000_000_000;
const SIX_HOURS = 6 * 60 * 60 * 1000;

function storageState(overrides: Partial<SessionStorageState> = {}): SessionStorageState {
  return {
    cookies: [
      {
        name: 'sessionId',
        value: 'abc123',
        domain: 'app.astrea.net.br',
        path: '/',
        expires: NOW / 1000 + 86_400, // expira em 1 dia (segundos)
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ],
    origins: [
      { origin: 'https://app.astrea.net.br', localStorage: [{ name: 'token', value: 'xyz' }] },
    ],
    ...overrides,
  };
}

function persisted(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return { savedAt: NOW, storageState: storageState(), ...overrides };
}

/** fs em memória para teste, sem tocar disco. */
function makeFakeFs(initial: Record<string, string> = {}): SessionFs & { files: Record<string, string> } {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    readFileSync: (p: string) => {
      if (!(p in files)) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return files[p];
    },
    writeFileSync: (p: string, data: string) => {
      files[p] = data;
    },
    renameSync: (oldP: string, newP: string) => {
      files[newP] = files[oldP];
      delete files[oldP];
    },
  };
}

describe('isStateUsable', () => {
  it('true para sessão recente com cookie válido + localStorage', () => {
    expect(isStateUsable(persisted(), NOW + 1000, SIX_HOURS)).toBe(true);
  });

  it('false quando null', () => {
    expect(isStateUsable(null, NOW, SIX_HOURS)).toBe(false);
  });

  it('false quando mais antiga que maxAge', () => {
    expect(isStateUsable(persisted({ savedAt: NOW - SIX_HOURS - 1 }), NOW, SIX_HOURS)).toBe(false);
  });

  it('false quando savedAt está no futuro (relógio inconsistente)', () => {
    expect(isStateUsable(persisted({ savedAt: NOW + 10_000 }), NOW, SIX_HOURS)).toBe(false);
  });

  it('false quando shape é inválido (sem arrays cookies/origins)', () => {
    expect(isStateUsable({ savedAt: NOW, storageState: {} as SessionStorageState }, NOW, SIX_HOURS)).toBe(
      false,
    );
  });

  it('false quando não há material de credencial (cookies e localStorage vazios)', () => {
    expect(
      isStateUsable(
        persisted({ storageState: { cookies: [], origins: [{ origin: 'x', localStorage: [] }] } }),
        NOW,
        SIX_HOURS,
      ),
    ).toBe(false);
  });

  it('false quando TODOS os cookies persistentes já expiraram', () => {
    const expired = storageState({
      cookies: [
        {
          name: 'sessionId',
          value: 'abc',
          domain: 'app.astrea.net.br',
          path: '/',
          expires: NOW / 1000 - 10, // já expirou
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    });
    expect(isStateUsable(persisted({ storageState: expired }), NOW, SIX_HOURS)).toBe(false);
  });

  it('true mesmo com cookie de sessão (-1) desde que haja localStorage', () => {
    const sessionCookie = storageState({
      cookies: [
        {
          name: 'sid',
          value: 'abc',
          domain: 'app.astrea.net.br',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ],
    });
    expect(isStateUsable(persisted({ storageState: sessionCookie }), NOW, SIX_HOURS)).toBe(true);
  });
});

describe('readSessionState', () => {
  it('null quando o arquivo não existe (ENOENT)', () => {
    const fs = makeFakeFs();
    expect(readSessionState({ fs, path: '/tmp/x.json' })).toBeNull();
  });

  it('null quando o JSON está corrompido', () => {
    const fs = makeFakeFs({ '/tmp/x.json': '{ não é json' });
    expect(readSessionState({ fs, path: '/tmp/x.json' })).toBeNull();
  });

  it('retorna o objeto persistido quando válido', () => {
    const fs = makeFakeFs({ '/tmp/x.json': JSON.stringify(persisted()) });
    const r = readSessionState({ fs, path: '/tmp/x.json' });
    expect(r?.savedAt).toBe(NOW);
    expect(r?.storageState.cookies[0].name).toBe('sessionId');
  });
});

describe('writeSessionStateAtomic', () => {
  it('escreve via arquivo temporário + rename (atômico) e embute savedAt', () => {
    const fs = makeFakeFs();
    const renameSpy = vi.spyOn(fs, 'renameSync');
    writeSessionStateAtomic(storageState(), NOW, { fs, path: '/tmp/x.json' });

    expect(renameSpy).toHaveBeenCalledOnce();
    const written = JSON.parse(fs.files['/tmp/x.json']) as PersistedSession;
    expect(written.savedAt).toBe(NOW);
    expect(written.storageState.cookies[0].name).toBe('sessionId');
    // O arquivo temporário não fica para trás.
    expect(Object.keys(fs.files)).toEqual(['/tmp/x.json']);
  });
});

describe('redactSession', () => {
  it('remove valores de cookie e localStorage, preservando metadados', () => {
    const r = redactSession(persisted());
    expect(r.savedAt).toBe(NOW);
    expect(r.cookieCount).toBe(1);
    expect(r.originCount).toBe(1);
    expect(JSON.stringify(r)).not.toContain('abc123'); // valor do cookie
    expect(JSON.stringify(r)).not.toContain('xyz'); // valor do localStorage
  });
});
