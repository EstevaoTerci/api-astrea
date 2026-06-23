import { describe, expect, it } from 'vitest';
import {
  classifyPostLoginState,
  formatLoginDiagnostic,
  isBrowserUnavailableError,
  isLoginError,
  shouldRetryLogin,
  type LoginSnapshot,
} from './login-state.js';

function snapshot(overrides: Partial<LoginSnapshot> = {}): LoginSnapshot {
  return {
    url: 'https://app.astrea.net.br/#/login',
    hash: '#/login',
    title: 'Astrea',
    hasPasswordField: false,
    alertText: null,
    bodyTextSnippet: '',
    ...overrides,
  };
}

describe('classifyPostLoginState', () => {
  it('AUTHENTICATED quando o hash chegou em #/main/', () => {
    const r = classifyPostLoginState(
      snapshot({ url: 'https://app.astrea.net.br/#/main/contacts', hash: '#/main/contacts' }),
    );
    expect(r.state).toBe('AUTHENTICATED');
  });

  it('CREDENTIAL_FAILED quando há banner de erro (alertText)', () => {
    const r = classifyPostLoginState(snapshot({ alertText: 'Senha inválida', hasPasswordField: true }));
    expect(r.state).toBe('CREDENTIAL_FAILED');
    expect(r.reason).toMatch(/Senha inválida/);
  });

  it('CREDENTIAL_FAILED quando o corpo menciona credencial inválida/incorreta', () => {
    expect(
      classifyPostLoginState(snapshot({ bodyTextSnippet: 'E-mail ou senha incorretos' })).state,
    ).toBe('CREDENTIAL_FAILED');
    expect(
      classifyPostLoginState(snapshot({ bodyTextSnippet: 'Credenciais inválidas' })).state,
    ).toBe('CREDENTIAL_FAILED');
  });

  it('NÃO classifica a tela de login normal como CREDENTIAL_FAILED só por conter a palavra "senha"', () => {
    // O formulário de login legítimo tem o label "Digite sua senha" — não pode
    // ser confundido com erro de credencial. Sem alerta + com campo de senha
    // visível ⇒ ainda na tela de login (cold-start lento), não credencial errada.
    const r = classifyPostLoginState(
      snapshot({
        hasPasswordField: true,
        bodyTextSnippet: 'Digite seu email Digite sua senha Entrar',
      }),
    );
    expect(r.state).toBe('STILL_ON_LOGIN');
  });

  it('INTERSTITIAL quando o corpo sugere captcha/2FA/sessão já ativa', () => {
    expect(classifyPostLoginState(snapshot({ bodyTextSnippet: 'Resolva o captcha' })).state).toBe(
      'INTERSTITIAL',
    );
    expect(
      classifyPostLoginState(snapshot({ bodyTextSnippet: 'Digite o código de verificação' })).state,
    ).toBe('INTERSTITIAL');
    expect(
      classifyPostLoginState(snapshot({ bodyTextSnippet: 'Sessão já ativa em outro dispositivo' }))
        .state,
    ).toBe('INTERSTITIAL');
  });

  it('STILL_ON_LOGIN quando o campo de senha continua visível e nada mais casa', () => {
    expect(classifyPostLoginState(snapshot({ hasPasswordField: true })).state).toBe(
      'STILL_ON_LOGIN',
    );
  });

  it('UNKNOWN como fallback seguro quando nada é reconhecido', () => {
    expect(classifyPostLoginState(snapshot({ hash: '#/algo-novo' })).state).toBe('UNKNOWN');
  });

  it('prioriza AUTHENTICATED mesmo se houver campo de senha residual', () => {
    expect(
      classifyPostLoginState(snapshot({ hash: '#/main/home', hasPasswordField: true })).state,
    ).toBe('AUTHENTICATED');
  });
});

describe('formatLoginDiagnostic', () => {
  it('monta mensagem com prefixo LOGIN_FAILED_<STATE> e contexto (url/hash)', () => {
    const s = snapshot({ url: 'https://app.astrea.net.br/#/login', hash: '#/login' });
    const msg = formatLoginDiagnostic(s, classifyPostLoginState({ ...s, hasPasswordField: true }));
    expect(msg).toMatch(/^LOGIN_FAILED_STILL_ON_LOGIN:/);
    expect(msg).toContain('url=https://app.astrea.net.br/#/login');
    expect(msg).toContain('hash=#/login');
  });
});

describe('isLoginError', () => {
  it('true para erros de login estruturados', () => {
    expect(isLoginError(new Error('LOGIN_FAILED_STILL_ON_LOGIN: ...'))).toBe(true);
    expect(isLoginError(new Error('LOGIN_CIRCUIT_OPEN: aguardando cooldown'))).toBe(true);
  });

  it('false para timeout cru de Playwright e outros erros', () => {
    expect(isLoginError(new Error('page.waitForFunction: Timeout 30000ms exceeded.'))).toBe(false);
    expect(isLoginError(new Error('net::ERR_CONNECTION_RESET'))).toBe(false);
    expect(isLoginError('nem é Error')).toBe(false);
  });
});

describe('shouldRetryLogin', () => {
  it('NÃO retenta erros de login (corta a amplificação K×3)', () => {
    expect(shouldRetryLogin(new Error('LOGIN_FAILED_INTERSTITIAL: ...'))).toBe(false);
    expect(shouldRetryLogin(new Error('LOGIN_CIRCUIT_OPEN: ...'))).toBe(false);
  });

  it('retenta erros de OPERAÇÃO transitórios (net::ERR, Target closed)', () => {
    expect(shouldRetryLogin(new Error('net::ERR_CONNECTION_RESET'))).toBe(true);
    expect(shouldRetryLogin(new Error('Target closed'))).toBe(true);
  });

  it('não retenta erros não-recuperáveis genéricos', () => {
    expect(shouldRetryLogin(new Error('API_ERROR_404: não encontrado'))).toBe(false);
  });
});

describe('isBrowserUnavailableError', () => {
  it('true para timeout do pool, circuit aberto e falha de login', () => {
    expect(isBrowserUnavailableError(new Error('BROWSER_POOL_TIMEOUT: sem slot'))).toBe(true);
    expect(isBrowserUnavailableError(new Error('LOGIN_CIRCUIT_OPEN: ...'))).toBe(true);
    expect(isBrowserUnavailableError(new Error('LOGIN_FAILED_INTERSTITIAL: ...'))).toBe(true);
  });

  it('false para erros de scrape/negócio comuns', () => {
    expect(isBrowserUnavailableError(new Error('API_ERROR_404'))).toBe(false);
    expect(isBrowserUnavailableError(new Error('NOT_FOUND: contato'))).toBe(false);
  });
});
