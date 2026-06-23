import { isRetryablePlaywrightError } from '../utils/retry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Classificação pós-login (lógica PURA, sem Playwright)
//
// O login do pool (BrowserPool._doLogin) clica "Entrar" e espera o hash chegar
// em '#/main/'. Quando NÃO chega, hoje o erro é um `Timeout 30000ms` cru, sem
// pista do motivo. Este módulo recebe um snapshot já materializado da página
// (montado no pool, que é a única parte que toca o Playwright) e o classifica
// num estado acionável + monta uma mensagem de erro estruturada.
//
// Mantido sem dependência de Playwright para ser 100% testável em Vitest
// (regra do projeto: Playwright real nunca roda em teste).
// ─────────────────────────────────────────────────────────────────────────────

export type PostLoginState =
  | 'AUTHENTICATED'
  | 'CREDENTIAL_FAILED'
  | 'STILL_ON_LOGIN'
  | 'INTERSTITIAL'
  | 'UNKNOWN';

export interface LoginSnapshot {
  /** `page.url()` no momento da avaliação. */
  url: string;
  /** `location.hash` (ex.: '#/main/contacts' ou '#/login'). */
  hash: string;
  /** `document.title`. */
  title: string;
  /** Se um `input[type=password]` ainda está presente/visível. */
  hasPasswordField: boolean;
  /** Texto de um banner de erro (.alert-danger etc), ou null. */
  alertText: string | null;
  /** Primeiros ~300 chars de `document.body.innerText`. */
  bodyTextSnippet: string;
}

export interface PostLoginClassification {
  state: PostLoginState;
  reason: string;
}

// Indica credencial rejeitada SÓ por sinais fortes — "senha" sozinho não conta
// porque o próprio formulário de login tem o label "Digite sua senha".
const CREDENTIAL_RE = /inv[aá]lid|incorret|credenc|n[aã]o (?:confere|autorizado)/i;
const INTERSTITIAL_RE = /captcha|verifica[çc]|2fa|c[oó]digo|sess[aã]o j[aá]|bloque|robô|robot/i;

/** Hash que indica que a SPA chegou na área autenticada. */
const AUTH_HASH_FRAGMENT = '#/main/';

export function classifyPostLoginState(s: LoginSnapshot): PostLoginClassification {
  if (s.hash.includes(AUTH_HASH_FRAGMENT)) {
    return { state: 'AUTHENTICATED', reason: `hash em ${AUTH_HASH_FRAGMENT}` };
  }

  const alert = s.alertText?.trim();
  if (alert) {
    return { state: 'CREDENTIAL_FAILED', reason: `banner de erro: ${alert}` };
  }
  if (CREDENTIAL_RE.test(s.bodyTextSnippet)) {
    return { state: 'CREDENTIAL_FAILED', reason: 'corpo sugere credencial inválida' };
  }

  if (INTERSTITIAL_RE.test(s.bodyTextSnippet)) {
    return { state: 'INTERSTITIAL', reason: 'tela intermediária (captcha/2FA/sessão/bloqueio)' };
  }

  if (s.hasPasswordField) {
    return { state: 'STILL_ON_LOGIN', reason: 'campo de senha ainda visível após submit' };
  }

  return { state: 'UNKNOWN', reason: 'estado pós-login não reconhecido' };
}

/** Mensagem de erro estruturada para logar/propagar: `LOGIN_FAILED_<STATE>: ...`. */
export function formatLoginDiagnostic(s: LoginSnapshot, c: PostLoginClassification): string {
  return (
    `LOGIN_FAILED_${c.state}: ${c.reason} ` +
    `| url=${s.url} hash=${s.hash} title=${s.title}`
  );
}

/** True se o erro é uma falha de LOGIN (estruturada) — distinta de erro de operação. */
export function isLoginError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /^LOGIN_FAILED_/.test(err.message) || err.message.includes('LOGIN_CIRCUIT_OPEN');
}

/**
 * Decide se vale re-tentar. Falhas de LOGIN NÃO são re-tentadas — re-tentar um
 * login que estourou só gera tempestade de logins (clearCookies + novo
 * UI-login), o padrão que a Astrea trata como uso indevido. Erros de OPERAÇÃO
 * transitórios (net::ERR, Target closed durante a chamada) seguem retryable.
 */
export function shouldRetryLogin(err: unknown): boolean {
  if (isLoginError(err)) return false;
  return isRetryablePlaywrightError(err);
}

/**
 * True se o erro indica que o browser/login está indisponível (deve virar
 * 503 BROWSER_UNAVAILABLE para o consumer): timeout de slot do pool, circuit
 * breaker aberto, ou falha de login estruturada. Usado pelos services para
 * mapear o código de erro de forma consistente.
 */
export function isBrowserUnavailableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('BROWSER_POOL_TIMEOUT') || isLoginError(err);
}
