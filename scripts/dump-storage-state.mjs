// Discovery: obtém a FORMA real do storageState do Astrea e valida o RESTAURO.
//
// Faz UM login headless (mesma pegada de um cold-start do pool em prod), dá dump
// do `context.storageState()`, imprime a forma REDIGIDA (sem valores de segredo),
// e então abre um SEGUNDO context com esse estado para confirmar se a sessão é
// restaurada SEM novo login. Responde:
//   - O token de auth vive em cookie (persistente?) ou em localStorage?
//   - Restaurar storageState pula o UI-login (a SPA fica em #/main/)?
//
// Uso: node scripts/dump-storage-state.mjs   (lê ASTREA_EMAIL/ASTREA_PASSWORD do .env)
// O arquivo bruto (com segredos) é gravado em tmpdir e APAGADO ao final.

import { chromium } from 'playwright';
import 'dotenv/config';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const EMAIL = process.env.ASTREA_EMAIL;
const PASS = process.env.ASTREA_PASSWORD;
if (!EMAIL || !PASS) {
  console.error('FALTAM credenciais (ASTREA_EMAIL / ASTREA_PASSWORD no .env).');
  process.exit(1);
}

const OUT = join(tmpdir(), `astrea-storagestate-${Date.now()}.json`);
const ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CTX_OPTS = { userAgent: UA, viewport: { width: 1280, height: 800 }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' };

function redact(state) {
  return {
    cookies: (state.cookies || []).map((c) => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      isSessionCookie: c.expires === -1,
      expiresInDays: c.expires > 0 ? Math.round((c.expires * 1000 - Date.now()) / 86400000) : null,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
      valueLen: (c.value || '').length,
    })),
    origins: (state.origins || []).map((o) => ({
      origin: o.origin,
      localStorageKeys: (o.localStorage || []).map((i) => `${i.name} (len=${(i.value || '').length})`),
    })),
  };
}

const browser = await chromium.launch({ headless: true, args: ARGS });
let raw = null;
try {
  // ── 1. Login (mesmos seletores do pool._doLogin) ──────────────────────────
  const ctx = await browser.newContext(CTX_OPTS);
  const page = await ctx.newPage();
  console.log('[1] Login headless no Astrea...');
  await page.goto('https://astrea.net.br', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input[placeholder="Digite seu email"]', { state: 'visible', timeout: 30000 });
  await page.fill('input[placeholder="Digite seu email"]', EMAIL);
  await page.fill('input[type="password"]', PASS);
  await page.click('button:has-text("Entrar")');
  await page.waitForFunction(() => location.hash.includes('#/main/'), null, { timeout: 45000 });
  await page.waitForTimeout(2000);
  console.log('[2] Login OK. url=', page.url());

  // ── 2. Dump + forma redigida ──────────────────────────────────────────────
  const state = await ctx.storageState();
  raw = OUT;
  writeFileSync(OUT, JSON.stringify(state), 'utf8');
  console.log('[3] FORMA REDIGIDA do storageState (sem valores):');
  console.log(JSON.stringify(redact(state), null, 2));
  console.log(`[3b] cookies=${state.cookies.length} origins=${state.origins.length}`);

  await page.close();
  await ctx.close();

  // ── 3. Teste de RESTAURO em novo context ──────────────────────────────────
  console.log('[4] Testando RESTAURO (novo context com storageState, sem login)...');
  const ctx2 = await browser.newContext({ ...CTX_OPTS, storageState: state });
  const page2 = await ctx2.newPage();
  await page2.goto('https://astrea.net.br/#/main/contacts', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page2.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page2.waitForTimeout(3000);
  const hash2 = await page2.evaluate(() => location.hash);
  const hasLoginForm = await page2.$('input[placeholder="Digite seu email"]').then((el) => !!el).catch(() => false);

  // Probe REST autenticado: $http precisa do token restaurado para um 200.
  const probe = await page2.evaluate(async () => {
    try {
      const http = window.angular?.element(document.body)?.injector()?.get('$http');
      if (!http) return { ok: false, reason: 'sem-$http (SPA não inicializou?)' };
      const r = await http.post('https://app.astrea.net.br/api/v2/contact/all/count', {
        queryCursor: null,
        limit: 30,
        queryDTO: {
          type: '', text: '', order: 'nameUpperCase', selectedTagsIds: [], startsWith: [],
          onlyWithEmail: false, searchInCompany: false, customerNotificationTypeFilter: 'ALL',
          customerNotification: ['CLIPPING', 'AUTOMATIC_HISTORIES'],
          customerNotificationArtificialIntelligenceFilter: 'ALL', birthMonth: 0, state: '',
        },
      });
      return { ok: true, status: r.status, count: r.data?.count };
    } catch (e) {
      return { ok: false, status: e?.status, reason: String(e?.data?.errorMessage || e?.data || e?.message || e).slice(0, 120) };
    }
  });

  console.log('[5] RESULTADO DO RESTAURO:');
  console.log('    hash =', hash2);
  console.log('    loginFormVisivel =', hasLoginForm, '(false = restaurou e ficou logado)');
  console.log('    probeREST =', JSON.stringify(probe));
  console.log(
    hash2.includes('#/main/') && !hasLoginForm && probe.ok
      ? '    ✅ RESTAURO FUNCIONA: sessão restaurada sem novo login, REST autentica.'
      : '    ⚠️  RESTAURO NÃO confirmado — ver sinais acima.',
  );
  await ctx2.close();
} catch (err) {
  console.error('[ERRO]', err?.message || err);
  process.exitCode = 1;
} finally {
  if (raw) {
    try {
      rmSync(raw, { force: true });
      console.log('[6] Arquivo bruto (com segredos) apagado:', raw);
    } catch {}
  }
  await browser.close();
}
