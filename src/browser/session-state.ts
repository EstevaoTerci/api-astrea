import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { env } from '../config/env.js';

// ─────────────────────────────────────────────────────────────────────────────
// session-state — persistência durável da sessão do Astrea (lógica PURA + I/O
// injetável). Motivo: o cold-login pós idle-shutdown (browser destruído por TTL)
// pagava um UI-login completo de 12-30s, batendo no teto e gerando churn de
// logins. Salvando o `storageState` (cookies + localStorage) em disco, o
// cold-start vira RESTORE (sub-segundo) e o login só ocorre quando a sessão
// restaurada se mostra inválida (via recovery de 401 já existente).
//
// Toda a decisão "tenho sessão reutilizável?" fica em funções puras (fs e clock
// injetáveis) para ser 100% testável sem Playwright nem tocar disco.
// ─────────────────────────────────────────────────────────────────────────────

/** Cookie no formato do storageState do Playwright. */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Em SEGUNDos epoch; -1 = cookie de sessão. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface StoredOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

/** Shape do `context.storageState()` do Playwright. */
export interface SessionStorageState {
  cookies: StoredCookie[];
  origins: StoredOrigin[];
}

/** Envelope persistido em disco: o storageState + quando foi salvo. */
export interface PersistedSession {
  savedAt: number;
  storageState: SessionStorageState;
}

/** Subconjunto de `node:fs` que o módulo usa — injetável em teste. */
export interface SessionFs {
  readFileSync(path: string, encoding: 'utf-8'): string;
  writeFileSync(path: string, data: string): void;
  renameSync(oldPath: string, newPath: string): void;
}

interface SessionDeps {
  fs?: SessionFs;
  path?: string;
}

const defaultFs: SessionFs = { readFileSync, writeFileSync, renameSync };

/** Caminho do arquivo de sessão (env.SESSION_STATE_PATH ou tmpdir/astrea-session.json). */
export function sessionStatePath(): string {
  return env.SESSION_STATE_PATH || join(tmpdir(), 'astrea-session.json');
}

/** Lê o estado persistido; null em ausência/corrupção (defensivo, nunca lança). */
export function readSessionState(deps: SessionDeps = {}): PersistedSession | null {
  const fs = deps.fs ?? defaultFs;
  const path = deps.path ?? sessionStatePath();
  try {
    const raw = fs.readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as PersistedSession;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Grava o storageState de forma atômica (tmp + rename), embutindo savedAt=now. */
export function writeSessionStateAtomic(
  storageState: SessionStorageState,
  now: number,
  deps: SessionDeps = {},
): void {
  const fs = deps.fs ?? defaultFs;
  const path = deps.path ?? sessionStatePath();
  const payload: PersistedSession = { savedAt: now, storageState };
  const tmp = `${path}.tmp`;

  // Garante o diretório (best-effort; só no fs real).
  if (fs === defaultFs) {
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch {
      // ignore — writeFileSync abaixo reporta se realmente falhar
    }
  }

  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, path);
}

/**
 * Decide se vale RESTAURAR a sessão persistida. Conservador: descarta estados
 * vazios, antigos demais (> maxAgeMs) ou com todos os cookies persistentes
 * expirados. NÃO valida a sessão server-side — isso fica para o probe implícito
 * (primeira operação → recovery de 401), que é a rede de segurança.
 */
export function isStateUsable(
  persisted: PersistedSession | null,
  now: number,
  maxAgeMs: number,
): boolean {
  if (!persisted) return false;
  const ss = persisted.storageState;
  if (!ss || !Array.isArray(ss.cookies) || !Array.isArray(ss.origins)) return false;
  if (typeof persisted.savedAt !== 'number' || !Number.isFinite(persisted.savedAt)) return false;

  const age = now - persisted.savedAt;
  if (age < 0 || age > maxAgeMs) return false; // futuro (relógio) ou velha demais

  const hasCredentialMaterial =
    ss.cookies.length > 0 ||
    ss.origins.some((o) => Array.isArray(o.localStorage) && o.localStorage.length > 0);
  if (!hasCredentialMaterial) return false;

  // Se há cookies persistentes e TODOS já expiraram, a sessão está morta.
  const persistentCookies = ss.cookies.filter(
    (c) => typeof c.expires === 'number' && c.expires > 0,
  );
  if (persistentCookies.length > 0 && persistentCookies.every((c) => c.expires * 1000 <= now)) {
    return false;
  }

  return true;
}

/** Versão sem segredos (valores de cookie/token) para logar com segurança. */
export function redactSession(persisted: PersistedSession): {
  savedAt: number;
  cookieCount: number;
  originCount: number;
} {
  return {
    savedAt: persisted.savedAt,
    cookieCount: persisted.storageState.cookies?.length ?? 0,
    originCount: persisted.storageState.origins?.length ?? 0,
  };
}

/** Idade (ms) da sessão persistida, ou null. Útil para o /health. */
export function sessionAgeMs(persisted: PersistedSession | null, now: number): number | null {
  if (!persisted || typeof persisted.savedAt !== 'number') return null;
  return Math.max(0, now - persisted.savedAt);
}
