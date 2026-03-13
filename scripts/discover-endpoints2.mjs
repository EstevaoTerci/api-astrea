/**
 * Script de descoberta PARTE 2 — tarefas e atendimentos.
 * Captura requests reais de rede ao carregar páginas específicas.
 */

import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = join(__dirname, '..', '.env');
  const content = readFileSync(envPath, 'utf8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

const env = loadEnv();
const ASTREA_URL = 'https://astrea.net.br';

const allRequests = [];

async function captureRequests(page, label, fn, waitMs = 4000) {
  const captured = [];
  const onReq = (req) => {
    const url = req.url();
    if (!url.includes('/api/v2')) return;
    const entry = {
      method: req.method(),
      path: url.replace('https://app.astrea.net.br', '').split('?')[0],
      query: url.includes('?') ? url.split('?')[1] : undefined,
      postData: req.postData() ? (() => { try { return JSON.parse(req.postData()); } catch { return req.postData(); } })() : undefined,
    };
    captured.push(entry);
    allRequests.push({ label, ...entry });
  };

  const onRes = async (res) => {
    const url = res.url();
    if (!url.includes('/api/v2')) return;
    const path = url.replace('https://app.astrea.net.br', '').split('?')[0];
    const status = res.status();
    if (status === 200) {
      try {
        const body = await res.json();
        const found = captured.find(r => r.path === path && r.method === res.request().method());
        if (found) found.response = { status, body };
      } catch {}
    } else {
      const found = captured.find(r => r.path === path && r.method === res.request().method());
      if (found) found.response = { status };
    }
  };

  page.on('request', onReq);
  page.on('response', onRes);

  await fn();
  await page.waitForTimeout(waitMs);

  page.removeListener('request', onReq);
  page.removeListener('response', onRes);

  console.log(`\n── ${label} ──`);
  for (const r of captured) {
    console.log(`  ${r.method} ${r.path}${r.query ? '?' + r.query : ''} → ${r.response?.status ?? 'pending'}`);
    if (r.postData) console.log(`    Body: ${JSON.stringify(r.postData).slice(0, 300)}`);
    if (r.response?.body) {
      const sample = JSON.stringify(r.response.body).slice(0, 500);
      console.log(`    Response: ${sample}`);
    }
  }

  return captured;
}

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Login
  console.log('Fazendo login...');
  await page.goto(ASTREA_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="Digite seu email"]', { timeout: 15000 });
  await page.fill('input[placeholder="Digite seu email"]', env.ASTREA_EMAIL);
  await page.fill('input[type="password"]', env.ASTREA_PASSWORD);
  await page.click('button:has-text("Entrar")');
  await page.waitForFunction(() => window.location.hash.includes('#/main/'), { timeout: 30000 });
  await page.waitForTimeout(2000);
  console.log('✅ Login OK\n');

  // ── Passo 1: Tela de Atendimentos ─────────────────────────────────────────────
  await captureRequests(page, 'Tela Atendimentos /#/main/consultings', async () => {
    await page.goto(`${ASTREA_URL}/#/main/consultings`, { waitUntil: 'domcontentloaded' });
  }, 5000);

  // ── Passo 2: Workspace (tarefas) ─────────────────────────────────────────────
  const workspaceCaptured = await captureRequests(page, 'Workspace (tarefas)', async () => {
    await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  }, 5000);

  // ── Passo 3: Abrir modal de nova tarefa ──────────────────────────────────────
  console.log('\nTentando abrir modal de nova tarefa...');
  const newTaskBtnSelectors = [
    'button:has-text("Nova tarefa")',
    'button:has-text("Criar")',
    '[data-action="new-task"]',
    'a:has-text("Nova tarefa")',
    'button.new-task',
    '[ng-click*="task"]',
    '[ng-click*="Task"]',
  ];

  let taskModalOpened = false;
  for (const sel of newTaskBtnSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        console.log(`  Encontrado botão: ${sel}`);
        await captureRequests(page, 'Modal nova tarefa', async () => {
          await btn.click();
        }, 3000);
        taskModalOpened = true;
        break;
      }
    } catch {}
  }

  if (!taskModalOpened) {
    console.log('  Botão automático não encontrado. Verificando HTML da workspace...');
    const html = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, a')];
      return buttons.map(b => `${b.tagName} "${b.textContent?.trim().slice(0, 50)}" [${b.className?.slice(0, 60)}]`).join('\n');
    });
    console.log('Botões na página:');
    console.log(html.slice(0, 2000));
  }

  // ── Passo 4: Inspecionar scope Angular da workspace ──────────────────────────
  console.log('\n── Inspecionando scope Angular da workspace ──');
  const scopeInfo = await page.evaluate(() => {
    try {
      const body = document.body;
      const injector = window.angular?.element(body)?.injector?.();
      if (!injector) return { error: 'sem injector' };

      // Tenta achar o controller da workspace
      const mainEl = document.querySelector('[ng-controller]') || document.querySelector('[data-ng-controller]');
      if (mainEl) {
        const scope = window.angular.element(mainEl).scope?.();
        if (scope) {
          const keys = Object.keys(scope).filter(k => !k.startsWith('$'));
          return { controller: mainEl.getAttribute('ng-controller') || mainEl.getAttribute('data-ng-controller'), scopeKeys: keys };
        }
      }

      // Lista todos os controllers na página
      const controllers = [...document.querySelectorAll('[ng-controller],[data-ng-controller]')]
        .map(el => ({
          ctrl: el.getAttribute('ng-controller') || el.getAttribute('data-ng-controller'),
          tag: el.tagName,
        }));
      return { controllers };
    } catch (e) {
      return { error: String(e) };
    }
  });
  console.log(JSON.stringify(scopeInfo, null, 2));

  // ── Passo 5: Capturar requests via XHR direto (bypass page.evaluate timeout) ─
  console.log('\n── Testando endpoints de tarefa com fetch direto ──');
  const taskTest = await page.evaluate(async () => {
    const session = document.cookie.match(/JSESSIONID=([^;]+)/)?.[1] || '';
    const baseUrl = 'https://app.astrea.net.br/api/v2';
    const results = {};

    const test = async (method, path, body) => {
      const key = `${method} ${path}`;
      try {
        const opts = {
          method,
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(`${baseUrl}${path}`, opts);
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { json = text.slice(0, 200); }
        results[key] = { status: res.status, body: json };
      } catch (e) {
        results[key] = { error: String(e) };
      }
    };

    // Tarefas
    await test('GET', '/task');
    await test('POST', '/task/filter', { page: 0, limit: 5 });
    await test('POST', '/task/query', { page: 0, limit: 5 });
    await test('POST', '/task/list', { page: 0, limit: 5 });
    await test('GET', '/task/user/6528036269752320');
    await test('POST', '/activity/filter', { page: 0, limit: 5 });

    // Atendimentos / consulting
    await test('GET', '/consulting');
    await test('GET', '/consulting/user/6528036269752320');
    await test('POST', '/consulting/filter', { page: 0, limit: 5 });
    await test('POST', '/consulting/query', { page: 0, limit: 5 });
    await test('GET', '/consulting/query?page=0&limit=5&userId=6528036269752320');

    return results;
  });

  console.log('\nResultados dos testes diretos:');
  for (const [key, val] of Object.entries(taskTest)) {
    const status = val.error ? `ERR: ${val.error}` : val.status;
    console.log(`  ${key} → ${status}`);
    if (val.body && val.status === 200) {
      console.log(`    ${JSON.stringify(val.body).slice(0, 400)}`);
    }
  }

  // ── Passo 6: Navegar para case do ESTEVAO para ver atendimentos ──────────────
  console.log('\n── Buscando caso do ESTEVAO TERCI DA SILVA ──');
  const estevaoCasos = await page.evaluate(async () => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    if (!http) return { error: 'sem $http' };
    try {
      const r = await http.post('https://app.astrea.net.br/api/v2/contact/all', {
        queryDTO: { type: '', text: 'Estevao Terci', order: 'nameUpperCase', selectedTagsIds: [], startsWith: [], onlyWithEmail: false, searchInCompany: false, customerNotificationTypeFilter: 'ALL', customerNotification: ['CLIPPING', 'AUTOMATIC_HISTORIES'], customerNotificationArtificialIntelligenceFilter: 'ALL', birthMonth: 0, state: '' },
        page: 0,
        limit: 5,
      }).then(r => r.data);
      return r;
    } catch (e) {
      return { error: `${e.status}: ${JSON.stringify(e.data)}` };
    }
  });
  console.log('Contato Estevao:', JSON.stringify(estevaoCasos, null, 2).slice(0, 800));

  // ── Passo 7: Navegar para agenda/calendário ───────────────────────────────────
  await captureRequests(page, 'Tela Calendário/Agenda /#/main/calendar', async () => {
    await page.goto(`${ASTREA_URL}/#/main/calendar`, { waitUntil: 'domcontentloaded' });
  }, 5000);

  // ── Passo 8: Navegar para a URL de atendimentos do contato ───────────────────
  if (estevaoCasos?.contacts?.[0]?.id) {
    const contactId = estevaoCasos.contacts[0].id;
    console.log(`\nNavegando para atendimentos do contato ${contactId} (Estevao)...`);
    await captureRequests(page, `Atendimentos do contato ${contactId}`, async () => {
      await page.evaluate((cId) => {
        const $state = window.angular?.element(document.body)?.injector()?.get('$state');
        if ($state) $state.go('main.contacts-detail.consultings', { contactId: cId });
      }, contactId);
    }, 5000);
  }

  console.log('\n✅ Discovery 2 completo. Mantendo aberto por 60s para inspeção manual...');
  await page.waitForTimeout(60000);
  await browser.close();
}

main().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
