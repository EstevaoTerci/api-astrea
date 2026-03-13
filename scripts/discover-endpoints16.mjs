/**
 * Discovery PARTE 16 - DEFINITIVO:
 * 1. Ler discovery API completa do workspace (Google Cloud Endpoints)
 * 2. Criar tarefa via window.fn() com action name correto
 * 3. Atualizar/deletar tarefa via window.fn()
 * 4. Chamar getTasksByCase para buscar tarefas de um caso
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
const ESTEVAO_CLIENT_CONTACT_ID = 5732697556058112;
const AUTOMATION_USER_ID = 6528036269752320;
const TENANT_ID = 6692712561442816;

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Captura requests para GCP Endpoints
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('_ah/api')) return;
    const skip = ['discovery', 'initialize', 'numberFeatures'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.replace('https://app.astrea.net.br', '');
    console.log(`\n📤 ${req.method()} ${path}`);
    const pd = req.postData();
    if (pd) { try { console.log('   >', JSON.stringify(JSON.parse(pd), null, 2).slice(0, 400)); } catch { console.log('   >', pd.slice(0, 300)); } }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('_ah/api')) return;
    const skip = ['discovery', 'initialize', 'numberFeatures'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.replace('https://app.astrea.net.br', '').split('?')[0];
    const status = res.status();
    try {
      const body = await res.json();
      console.log(`\n📥 ${status} ${res.request().method()} ${path}`);
      console.log(`   ${JSON.stringify(body).slice(0, 1000)}`);
    } catch {}
  });

  // Login
  await page.goto(ASTREA_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="Digite seu email"]', { timeout: 15000 });
  await page.fill('input[placeholder="Digite seu email"]', env.ASTREA_EMAIL);
  await page.fill('input[type="password"]', env.ASTREA_PASSWORD);
  await page.click('button:has-text("Entrar")');
  await page.waitForFunction(() => window.location.hash.includes('#/main/'), { timeout: 30000 });
  await page.waitForTimeout(3000);
  console.log('✅ Login OK\n');

  await page.goto(`${ASTREA_URL}/#/main/contacts`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // ── PASSO 1: Ler discovery completa do workspace ─────────────────────────────
  console.log('=== PASSO 1: Discovery API completa do workspace ===');
  const discoveryDoc = await page.evaluate(async () => {
    const r = await fetch('https://app.astrea.net.br/_ah/api/discovery/v1/apis/workspace/v1/rest', {
      credentials: 'include',
    });
    return r.json();
  });

  if (discoveryDoc.resources) {
    for (const [resourceName, resource] of Object.entries(discoveryDoc.resources)) {
      console.log(`\nResource: ${resourceName}`);
      if (resource.methods) {
        for (const [methodName, method] of Object.entries(resource.methods)) {
          const params = method.parameters ? Object.keys(method.parameters).join(', ') : '';
          console.log(`  ${method.httpMethod} ${method.path} [${methodName}] params: ${params}`);
        }
      }
    }
  }

  // ── PASSO 2: Chamar window.fn() para criar tarefa ────────────────────────────
  console.log('\n=== PASSO 2: Criar tarefa via window.fn() ===');
  const createTask = await page.evaluate(async ({ userId, contactId, taskListId }) => {
    const results = {};

    const callFn = (action, payload) => new Promise((resolve, reject) => {
      window.fn(action)(payload).execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
      setTimeout(() => reject('timeout 10s'), 10000);
    });

    // Tenta diferentes action names para criação de tarefa
    const createActions = [
      'workspace.taskListService.createTask',
      'workspace.taskListService.addTask',
      'workspace.taskService.createTask',
      'workspace.taskService.addTask',
      'workspace.task.create',
      'workspace.task.insert',
    ];

    const payload = {
      userId: String(userId),
      taskListId: String(taskListId),
      title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
      responsibleId: String(userId),
    };

    for (const action of createActions) {
      try {
        const r = await callFn(action, payload);
        results[action] = { success: true, data: JSON.stringify(r).slice(0, 400) };
        break;
      } catch (e) {
        results[action] = { err: String(e).slice(0, 150) };
      }
    }

    return results;
  }, { userId: AUTOMATION_USER_ID, contactId: ESTEVAO_CLIENT_CONTACT_ID, taskListId: '6465761223671808' });

  console.log('Create results:', JSON.stringify(createTask, null, 2).slice(0, 2000));
  await page.waitForTimeout(3000);

  // ── PASSO 3: Explorar GCP API via gapi.client ─────────────────────────────────
  console.log('\n=== PASSO 3: Explorar gapi.client diretamente ===');
  const gapiExplore = await page.evaluate(async (userId) => {
    const results = {};

    // Verifica se gapi.client existe
    if (!window.gapi?.client) {
      results.gapiExists = false;
      return results;
    }

    results.gapiExists = true;
    const client = window.gapi.client;
    results.clientKeys = Object.keys(client).filter(k => !['setToken', 'getToken', 'setApiKey', 'request', 'newHttpBatch'].includes(k));

    // Verifica se workspace API está carregada
    if (client.workspace) {
      results.workspaceKeys = Object.keys(client.workspace);
      if (client.workspace.taskListService) {
        results.taskListServiceKeys = Object.keys(client.workspace.taskListService);
      }
    }

    return results;
  }, AUTOMATION_USER_ID);

  console.log('gapi.client explore:', JSON.stringify(gapiExplore, null, 2).slice(0, 1000));

  // ── PASSO 4: Navegar para workspace e criar tarefa via gapi.client ────────────
  console.log('\n=== PASSO 4: workspace + gapi.client create task ===');
  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  const createViaGapi = await page.evaluate(async (userId) => {
    const results = {};

    if (!window.gapi?.client?.workspace?.taskListService) {
      results.err = 'gapi.client.workspace.taskListService not available';

      // Lista o que está em gapi.client
      if (window.gapi?.client) {
        results.clientKeys = Object.keys(window.gapi.client);
      }
      return results;
    }

    const svc = window.gapi.client.workspace.taskListService;
    results.methods = Object.keys(svc);

    // Tenta criar tarefa
    if (svc.createTask) {
      try {
        const createPayload = {
          userId: String(userId),
          title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
          responsibleId: String(userId),
        };
        const r = await new Promise((resolve, reject) => {
          svc.createTask(createPayload).execute(r => r.error ? reject(r.error) : resolve(r));
          setTimeout(() => reject('timeout'), 8000);
        });
        results.createTask = { data: JSON.stringify(r).slice(0, 400) };
      } catch (e) {
        results.createTaskErr = String(e).slice(0, 200);
      }
    }

    return results;
  }, AUTOMATION_USER_ID);

  console.log('gapi.client create:', JSON.stringify(createViaGapi, null, 2).slice(0, 1000));
  await page.waitForTimeout(3000);

  // ── PASSO 5: Listar métodos do workspace GCP API via discovery ────────────────
  console.log('\n=== PASSO 5: Chamar getTaskListWithAllTasks ===');
  const getWithAllTasks = await page.evaluate(async (userId) => {
    const callFn = (action, payload) => new Promise((resolve, reject) => {
      window.fn(action)(payload).execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
      setTimeout(() => reject('timeout 10s'), 10000);
    });

    const results = {};

    // Lista task lists do usuário
    try {
      const lists = await callFn('workspace.taskListService.listTaskListsByUser', { userId: String(userId) });
      results.lists = lists.items;

      // Para cada lista, busca todas as tarefas
      for (const list of (lists.items || []).slice(0, 2)) {
        try {
          const tasks = await callFn('workspace.taskListService.getTaskListWithAllTasks', {
            userId: String(userId),
            taskListId: String(list.id),
          });
          results[`tasks_${list.id}`] = JSON.stringify(tasks).slice(0, 600);
        } catch (e) {
          results[`tasks_${list.id}_err`] = String(e).slice(0, 200);
        }
      }
    } catch (e) {
      results.listErr = String(e).slice(0, 200);
    }

    // Tenta criar tarefa via window.fn com action names baseados no discovery
    // Formato: 'workspace.taskListService.methodName'
    // Verifica o que o discovery retorna como endpoints
    try {
      // Testa endpoint de criar task com payload mais completo
      const createResult = await callFn('workspace.taskListService.createTask', {
        userId: String(userId),
        taskListId: '6465761223671808',
        title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
      });
      results.createTask = { success: true, data: JSON.stringify(createResult).slice(0, 400) };
    } catch (e) {
      results.createTaskErr = String(e).slice(0, 200);
    }

    return results;
  }, AUTOMATION_USER_ID);

  console.log('getWithAllTasks:', JSON.stringify(getWithAllTasks, null, 2).slice(0, 3000));
  await page.waitForTimeout(5000);

  // ── PASSO 6: Criar tarefa via UI e capturar request GCP ──────────────────────
  console.log('\n=== PASSO 6: Criar tarefa via UI (capturar GCP request) ===');

  // Monitor GCP requests
  page.on('request', (req) => {
    if (req.url().includes('_ah/api') && !req.url().includes('discovery')) {
      console.log(`\n🎯 GCP: ${req.method()} ${req.url().replace('https://app.astrea.net.br', '')}`);
      const pd = req.postData();
      if (pd) { try { console.log('   Body:', JSON.stringify(JSON.parse(pd), null, 2)); } catch { console.log('   Body:', pd.slice(0, 400)); } }
    }
  });

  // Tenta clicar "Adicionar primeira tarefa" na workspace
  try {
    // Espera aparecer o botão
    await page.waitForTimeout(2000);
    const btn = await page.$('button:has-text("Adicionar")');
    if (btn && await btn.isVisible()) {
      await btn.click();
      await page.waitForTimeout(3000);
      console.log('Botão clicado!');
    }
  } catch {}

  console.log('\n✅ Discovery 16 completo. Mantendo 120s...');
  await page.waitForTimeout(120000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
