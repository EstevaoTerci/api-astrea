/**
 * Script de descoberta de endpoints da API interna do Astrea.
 *
 * Intercepta TODAS as requisições XHR/fetch durante ações específicas na SPA Angular.
 * Executa em modo não-headless para inspeção manual quando necessário.
 *
 * Uso: node scripts/discover-endpoints.mjs
 *
 * ⚠️  ATENÇÃO: Todas as operações de escrita são feitas APENAS no cliente ESTEVAO TERCI DA SILVA
 */

import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Carrega credenciais do .env
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
const API_BASE = 'https://app.astrea.net.br/api/v2';

const capturedRequests = [];
const capturedResponses = {};

async function main() {
  console.log('🚀 Iniciando discovery de endpoints do Astrea...\n');

  const browser = await chromium.launch({ headless: false, slowMo: 500 });
  const context = await browser.newContext();
  const page = await context.newPage();

  // ── Interceptação de rede ────────────────────────────────────────────────────
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('/api/v2')) return;
    const entry = {
      method: req.method(),
      url,
      path: url.replace('https://app.astrea.net.br', ''),
      postData: req.postData() ? (() => { try { return JSON.parse(req.postData()); } catch { return req.postData(); } })() : undefined,
    };
    capturedRequests.push(entry);
    console.log(`📤 ${req.method()} ${entry.path}`);
    if (entry.postData) console.log('   Body:', JSON.stringify(entry.postData, null, 2).slice(0, 400));
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/api/v2')) return;
    try {
      const body = await res.json();
      const path = url.replace('https://app.astrea.net.br', '');
      capturedResponses[`${res.request().method()} ${path}`] = body;
      console.log(`📥 ${res.status()} ${res.request().method()} ${path}`);
    } catch { /* ignora respostas não-JSON */ }
  });

  // ── Login ────────────────────────────────────────────────────────────────────
  console.log('\n=== PASSO 1: Login ===');
  await page.goto(ASTREA_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="Digite seu email"]', { timeout: 15000 });
  await page.fill('input[placeholder="Digite seu email"]', env.ASTREA_EMAIL);
  await page.fill('input[type="password"]', env.ASTREA_PASSWORD);
  await page.click('button:has-text("Entrar")');
  await page.waitForFunction(() => window.location.hash.includes('#/main/'), { timeout: 30000 });
  await page.waitForTimeout(2000);
  console.log('✅ Login realizado com sucesso\n');

  // ── Discovery: Usuários ──────────────────────────────────────────────────────
  console.log('\n=== PASSO 2: Descobrir endpoint de usuários (dropdown Responsável) ===');
  console.log('Navegando para criação de tarefa...');
  capturedRequests.length = 0;

  // Navega para a página de workspace (onde aparecem tarefas)
  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Procura botão de nova tarefa
  const newTaskBtn = await page.$('button:has-text("Nova tarefa"), button:has-text("Criar tarefa"), [data-test="new-task"], button[title*="tarefa"], button[title*="Tarefa"]');
  if (newTaskBtn) {
    console.log('Clicando em "Nova Tarefa"...');
    await newTaskBtn.click();
    await page.waitForTimeout(2000);
    console.log('Requests capturadas após abrir modal de nova tarefa:');
  } else {
    console.log('⚠️  Botão de nova tarefa não encontrado automaticamente. Verifique manualmente.');
    console.log('Aguardando 15s para inspeção manual...');
    await page.waitForTimeout(15000);
  }

  console.log('\nRequests capturadas até agora:');
  capturedRequests.forEach(r => {
    console.log(`  ${r.method} ${r.path}`);
  });

  // ── Discovery: Listar tarefas via API ────────────────────────────────────────
  console.log('\n=== PASSO 3: Descobrir endpoint de listagem de tarefas ===');
  capturedRequests.length = 0;

  // Injeta interceptador de $http para capturar chamadas internas do Angular
  await page.goto(`${ASTREA_URL}/#/main/contacts`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const taskListResult = await page.evaluate(async () => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    if (!http) return { error: 'Angular $http não disponível' };

    // Tenta endpoints conhecidos de tarefas
    const candidates = [
      '/api/v2/task/all',
      '/api/v2/tasks/all',
      '/api/v2/activity/all',
    ];

    const results = {};
    for (const path of candidates) {
      try {
        const url = `https://app.astrea.net.br${path}`;
        // Tenta POST primeiro (padrão do Astrea para listagens)
        try {
          const r = await http.post(url, { page: 0, limit: 5 }).then(r => r.data);
          results[`POST ${path}`] = { success: true, keys: Object.keys(r || {}), sample: JSON.stringify(r).slice(0, 300) };
        } catch (e) {
          results[`POST ${path}`] = { error: `${e.status}: ${JSON.stringify(e.data?.errorMessage || e.data || e.status)}` };
        }
        // Tenta GET
        try {
          const r = await http.get(url).then(r => r.data);
          results[`GET ${path}`] = { success: true, keys: Object.keys(r || {}), sample: JSON.stringify(r).slice(0, 300) };
        } catch (e) {
          results[`GET ${path}`] = { error: `${e.status}: ${JSON.stringify(e.data?.errorMessage || e.data || e.status)}` };
        }
      } catch (e) {
        results[path] = { error: String(e) };
      }
    }
    return results;
  });

  console.log('\nResultados da sondagem de endpoints de tarefas:');
  console.log(JSON.stringify(taskListResult, null, 2));

  // ── Discovery: Atendimentos (consulting) ─────────────────────────────────────
  console.log('\n=== PASSO 4: Descobrir endpoint de atendimentos (consulting) ===');

  const consultingResult = await page.evaluate(async () => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    if (!http) return { error: 'Angular $http não disponível' };

    const candidates = [
      '/api/v2/consulting/all',
      '/api/v2/consultings/all',
      '/api/v2/appointment/all',
      '/api/v2/service/all',
    ];

    const results = {};
    for (const path of candidates) {
      try {
        const url = `https://app.astrea.net.br${path}`;
        try {
          const r = await http.post(url, { page: 0, limit: 5 }).then(r => r.data);
          results[`POST ${path}`] = { success: true, keys: Object.keys(r || {}), sample: JSON.stringify(r).slice(0, 300) };
        } catch (e) {
          results[`POST ${path}`] = { error: `${e.status}: ${JSON.stringify(e.data?.errorMessage || e.data || e.status)}` };
        }
        try {
          const r = await http.get(url).then(r => r.data);
          results[`GET ${path}`] = { success: true, keys: Object.keys(r || {}), sample: JSON.stringify(r).slice(0, 300) };
        } catch (e) {
          results[`GET ${path}`] = { error: `${e.status}: ${JSON.stringify(e.data?.errorMessage || e.data || e.status)}` };
        }
      } catch (e) {
        results[path] = { error: String(e) };
      }
    }
    return results;
  });

  console.log('\nResultados da sondagem de endpoints de atendimentos:');
  console.log(JSON.stringify(consultingResult, null, 2));

  // ── Discovery: Usuários ──────────────────────────────────────────────────────
  console.log('\n=== PASSO 5: Descobrir endpoint de listagem de usuários ===');

  const usersResult = await page.evaluate(async () => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    if (!http) return { error: 'Angular $http não disponível' };

    const candidates = [
      '/api/v2/user/all',
      '/api/v2/users/all',
      '/api/v2/team/members',
      '/api/v2/office/users',
      '/api/v2/member/all',
    ];

    const results = {};
    for (const path of candidates) {
      try {
        const url = `https://app.astrea.net.br${path}`;
        try {
          const r = await http.get(url).then(r => r.data);
          results[`GET ${path}`] = { success: true, keys: Object.keys(r || {}), sample: JSON.stringify(r).slice(0, 400) };
        } catch (e) {
          results[`GET ${path}`] = { error: `${e.status}: ${JSON.stringify(e.data?.errorMessage || e.data || e.status)}` };
        }
        try {
          const r = await http.post(url, {}).then(r => r.data);
          results[`POST ${path}`] = { success: true, keys: Object.keys(r || {}), sample: JSON.stringify(r).slice(0, 400) };
        } catch (e) {
          results[`POST ${path}`] = { error: `${e.status}: ${JSON.stringify(e.data?.errorMessage || e.data || e.status)}` };
        }
      } catch (e) {
        results[path] = { error: String(e) };
      }
    }
    return results;
  });

  console.log('\nResultados da sondagem de endpoints de usuários:');
  console.log(JSON.stringify(usersResult, null, 2));

  // ── Discovery: Criar tarefa no caso de ESTEVAO TERCI DA SILVA ───────────────
  console.log('\n=== PASSO 6: Descobrir estrutura de criação de tarefa ===');
  console.log('Navegando para página de workspace e interceptando criação de tarefa...');
  capturedRequests.length = 0;

  // Navega para workspace para interceptar via network
  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`);
  await page.waitForTimeout(3000);

  console.log('\nRequests de listagem na workspace:');
  capturedRequests.forEach(r => {
    console.log(`  ${r.method} ${r.path}`);
    if (r.postData) console.log(`    Body: ${JSON.stringify(r.postData).slice(0, 200)}`);
  });

  // ── Sumário Final ─────────────────────────────────────────────────────────────
  console.log('\n\n══════════════════════════════════════════════════════');
  console.log('SUMÁRIO DE TODAS AS REQUESTS /api/v2 CAPTURADAS:');
  console.log('══════════════════════════════════════════════════════');

  const allReqs = [...capturedRequests];
  const seen = new Set();
  for (const r of allReqs) {
    const key = `${r.method} ${r.path.split('?')[0]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`\n${r.method} ${r.path.split('?')[0]}`);
    if (r.postData) console.log(`  Body: ${JSON.stringify(r.postData).slice(0, 300)}`);
  }

  console.log('\n\nResponses capturadas:');
  for (const [key, body] of Object.entries(capturedResponses)) {
    console.log(`\n${key}:`);
    console.log(JSON.stringify(body, null, 2).slice(0, 500));
  }

  console.log('\n\n✅ Discovery completo. Mantendo browser aberto por 30s para inspeção manual...');
  await page.waitForTimeout(30000);
  await browser.close();
}

main().catch(err => {
  console.error('❌ Erro no discovery:', err);
  process.exit(1);
});
