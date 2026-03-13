/**
 * Discovery PARTE 12 - FINAL:
 * 1. Deletar todos os consulting de teste via DELETE /consulting/{id}/user/{userId}
 * 2. Extrair URLs do taskListService (astreaApi)
 * 3. Chamar listTaskListsByUser para descobrir endpoint de listagem
 * 4. Criar tarefa via taskListService e capturar request
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

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Captura todas as requests/responses relevantes
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('/api/v2')) return;
    const skip = ['alerts', 'session/valid', 'clipping', 'search/token', 'help-tip',
      'widgets-config', 'firstxp-config', 'accreditation', 'hasfolder', 'user-verify',
      'firebase', 'environment', 'honoraries', 'ticket', 'feature-toggle', 'teams',
      'user-config', 'session/login', 'contact/all', 'kanbans', 'suggests', 'google',
      'timesheet', 'migration', 'statistics', 'reminders', 'tags', 'contact/notification'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.replace('https://app.astrea.net.br', '');
    console.log(`\n📤 ${req.method()} ${path}`);
    const pd = req.postData();
    if (pd) { try { console.log('   >', JSON.stringify(JSON.parse(pd), null, 2).slice(0, 400)); } catch { console.log('   >', pd.slice(0, 200)); } }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/api/v2')) return;
    const skip = ['alerts', 'session/valid', 'clipping', 'search/token', 'help-tip',
      'widgets-config', 'firstxp-config', 'accreditation', 'hasfolder', 'user-verify',
      'firebase', 'environment', 'honoraries', 'ticket', 'feature-toggle', 'teams',
      'user-config', 'session/login', 'contact/all', 'kanbans', 'suggests', 'google',
      'timesheet', 'migration', 'statistics', 'reminders', 'tags', 'contact/notification'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.replace('https://app.astrea.net.br', '').split('?')[0];
    const status = res.status();
    try {
      const body = await res.json();
      const bodyStr = JSON.stringify(body);
      if (bodyStr.length > 5) {
        console.log(`\n📥 ${status} ${res.request().method()} ${path}`);
        console.log(`   ${bodyStr.slice(0, 1000)}`);
      }
    } catch {}
  });

  // Login
  await page.goto(ASTREA_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="Digite seu email"]', { timeout: 15000 });
  await page.fill('input[placeholder="Digite seu email"]', env.ASTREA_EMAIL);
  await page.fill('input[type="password"]', env.ASTREA_PASSWORD);
  await page.click('button:has-text("Entrar")');
  await page.waitForFunction(() => window.location.hash.includes('#/main/'), { timeout: 30000 });
  await page.waitForTimeout(2000);
  console.log('✅ Login OK\n');

  await page.goto(`${ASTREA_URL}/#/main/contacts`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // ── PASSO 1: Deletar todos os consultings de teste ────────────────────────────
  console.log('=== PASSO 1: Deletar consultings de teste ===');
  const deleteResult = await page.evaluate(async (userId) => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    const baseUrl = 'https://app.astrea.net.br/api/v2';

    // Lista todos os consultings "TESTE AUTOMAÇÃO"
    const list = await http.post(`${baseUrl}/consulting/query`, {
      status: '',
      tagIds: [],
      subject: 'TESTE AUTOMAÇÃO',
      consultingId: null,
      customerId: null,
      order: '-createDate',
      caseAttached: null,
      limit: 100,
      createdAt: null,
      dateBegin: null,
      dateEnd: null,
      cursor: '',
    }).then(r => r.data).catch(() => null);

    if (!list?.consultingDTO?.length) return { notFound: true };

    const ids = list.consultingDTO.map(c => c.id);
    const results = [];
    for (const id of ids) {
      try {
        // Endpoint correto: DELETE /consulting/{id}/user/{userId}
        const r = await http.delete(`${baseUrl}/consulting/${id}/user/${userId}`).then(r => r.data);
        results.push({ id, deleted: true, body: JSON.stringify(r).slice(0, 100) });
      } catch (e) {
        results.push({ id, err: `${e.status}: ${JSON.stringify(e.data).slice(0, 100)}` });
      }
    }
    return { ids, results };
  }, AUTOMATION_USER_ID);

  console.log('Delete result:', JSON.stringify(deleteResult, null, 2).slice(0, 2000));

  // ── PASSO 2: Extrair URLs do taskListService ──────────────────────────────────
  console.log('\n=== PASSO 2: TaskListService - extrair URLs ===');
  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  const serviceInfo = await page.evaluate((userId) => {
    const injector = window.angular?.element(document.body)?.injector?.();
    if (!injector) return { error: 'no injector' };

    let svc;
    try { svc = injector.get('taskListService'); } catch { return { error: 'taskListService not found' }; }

    const results = { name: 'taskListService' };

    // Pega o astreaApi object
    const api = svc.astreaApi;
    if (api) {
      results.apiKeys = Object.keys(api).filter(k => !k.startsWith('$'));
      results.apiProto = Object.getOwnPropertyNames(Object.getPrototypeOf(api) || {}).filter(k => k !== 'constructor');
      results.apiSource = api.constructor?.toString?.().slice(0, 3000);
    }

    // Extrai o fonte completo do serviço
    const svcSrc = svc.constructor?.toString?.() || '';
    results.serviceSource = svcSrc.slice(0, 5000);

    // Tenta extrair URLs do fonte
    const urlMatches = svcSrc.match(/\/api\/v\d[^"'` )]+/g) || [];
    results.urlsFound = [...new Set(urlMatches)];

    // Procura por template strings com 'tasks' ou 'task'
    const taskMatches = svcSrc.match(/`[^`]*task[^`]*`/gi) || [];
    results.templateStrings = taskMatches.slice(0, 20);

    // Tenta chamar listTaskListsByUser
    results.listCall = {};
    try {
      const promise = svc.listTaskListsByUser(userId);
      if (promise && typeof promise.then === 'function') {
        results.listCall.isPromise = true;
      }
    } catch (e) {
      results.listCall.err = e.message?.slice(0, 200);
    }

    return results;
  }, AUTOMATION_USER_ID);

  console.log('\nService info:');
  console.log('  API keys:', serviceInfo.apiKeys);
  console.log('  API proto:', serviceInfo.apiProto);
  console.log('  URLs found:', serviceInfo.urlsFound);
  console.log('  Template strings:', serviceInfo.templateStrings);
  console.log('  API source:', (serviceInfo.apiSource || '').slice(0, 2000));
  console.log('  Service source:', (serviceInfo.serviceSource || '').slice(0, 2000));

  // Aguarda o resultado do listTaskListsByUser
  await page.waitForTimeout(3000);

  // ── PASSO 3: Chamar listTaskListsByUser e capturar resultado ─────────────────
  console.log('\n=== PASSO 3: Chamar taskListService methods ===');
  const methodResults = await page.evaluate(async (userId) => {
    const injector = window.angular?.element(document.body)?.injector?.();
    const svc = injector?.get('taskListService');
    if (!svc) return { error: 'no svc' };

    const results = {};

    // Tenta cada método do prototype
    const methods = ['listTaskListsByUser', 'getTaskListById', 'getTaskListWithAllTasks', 'getAllDeactiveTasks'];
    for (const method of methods) {
      if (typeof svc[method] === 'function') {
        try {
          const r = await svc[method](userId);
          results[method] = { ok: true, data: JSON.stringify(r).slice(0, 500) };
        } catch (e) {
          results[method] = { err: e.message?.slice(0, 200) };
        }
      }
    }

    // Tenta via $http direto com URLs deduzidas
    const http = injector.get('$http');
    const baseUrl = 'https://app.astrea.net.br/api/v2';
    const tryGet = async (key, path) => {
      try {
        const r = await http.get(`${baseUrl}${path}`).then(r => r.data);
        results[key] = { status: 200, data: JSON.stringify(r).slice(0, 600) };
      } catch (e) {
        results[key] = { status: e.status, err: JSON.stringify(e.data).slice(0, 150) };
      }
    };
    const tryPost = async (key, path, body) => {
      try {
        const r = await http.post(`${baseUrl}${path}`, body).then(r => r.data);
        results[key] = { status: 200, data: JSON.stringify(r).slice(0, 600) };
      } catch (e) {
        results[key] = { status: e.status, err: JSON.stringify(e.data).slice(0, 150) };
      }
    };

    // Endpoints de task-list
    await tryGet('task_lists_user', `/task-list?userId=${userId}`);
    await tryGet('task_lists_user2', `/task-lists?userId=${userId}`);
    await tryPost('task_list_query', '/task-list/query', { userId, limit: 10 });
    await tryGet('tasks_user', `/tasks/user/${userId}`);
    await tryGet('tasks_user_v2', `/tasks?userId=${userId}&limit=10`);
    await tryPost('tasks_query', '/tasks/query', { userId, limit: 10, page: 0 });

    return results;
  }, AUTOMATION_USER_ID);

  console.log('\nMétodos chamados:');
  for (const [k, v] of Object.entries(methodResults)) {
    const status = v.ok ? '✅ OK' : v.status ? `${v.status}` : `ERR`;
    console.log(`  ${k} → ${status}`);
    if (v.data) console.log(`    ${v.data.slice(0, 400)}`);
    if (v.err) console.log(`    ERR: ${v.err.slice(0, 200)}`);
  }

  // ── PASSO 4: Criar tarefa via taskListService ────────────────────────────────
  console.log('\n=== PASSO 4: Criar tarefa via taskListService ===');

  // Pega o taskList atual da workspace
  const currentTaskList = await page.evaluate(() => {
    const el = document.querySelector('.task-list');
    const scope = window.angular?.element(el)?.isolateScope?.() || window.angular?.element(el)?.scope?.();
    const ctrl = scope?.$ctrl;
    const tl = ctrl?.data?.taskList;
    if (!tl) return null;
    return { id: tl.id, name: tl.name, user: tl.user, sizeActive: tl.sizeActive };
  });

  console.log('Current task list:', JSON.stringify(currentTaskList));

  if (currentTaskList?.id) {
    const createResult = await page.evaluate(async ({ userId, taskListId, contactId }) => {
      const http = window.angular?.element(document.body)?.injector()?.get('$http');
      const baseUrl = 'https://app.astrea.net.br/api/v2';
      const results = {};

      const tryPost = async (key, path, body) => {
        try {
          const r = await http.post(`${baseUrl}${path}`, body).then(r => r.data);
          results[key] = { status: 200, data: JSON.stringify(r).slice(0, 600) };
        } catch (e) {
          results[key] = { status: e.status, err: JSON.stringify(e.data).slice(0, 200) };
        }
      };

      // Tenta criar com taskListId
      await tryPost('withList', '/tasks', {
        title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
        responsibleId: userId,
        taskListId,
        customerId: contactId,
      });
      await tryPost('withListAndDate', '/tasks', {
        title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
        responsibleId: userId,
        taskListId,
        dueDate: '2026-03-20',
      });
      // Payload mínimo
      await tryPost('minimal', '/tasks', {
        title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
        responsibleId: userId,
        taskListId,
      });

      return results;
    }, { userId: AUTOMATION_USER_ID, taskListId: currentTaskList.id, contactId: ESTEVAO_CLIENT_CONTACT_ID });

    console.log('Create task results:');
    for (const [k, v] of Object.entries(createResult)) {
      console.log(`  ${k} → ${v.status}`);
      if (v.data) console.log(`    ${v.data.slice(0, 400)}`);
      if (v.err) console.log(`    ERR: ${v.err}`);
    }

    // Deleta tarefas criadas
    for (const [k, v] of Object.entries(createResult)) {
      if (v.status === 200 || v.status === 201) {
        try {
          const id = JSON.parse(v.data)?.id;
          if (id) {
            await page.evaluate(async (taskId) => {
              const http = window.angular?.element(document.body)?.injector()?.get('$http');
              await http.delete(`https://app.astrea.net.br/api/v2/tasks/${taskId}`).catch(() => {
                return http.delete(`https://app.astrea.net.br/api/v2/task/${taskId}`);
              });
            }, id);
            console.log(`Tarefa ${id} deletada.`);
          }
        } catch {}
      }
    }
  }

  console.log('\n✅ Discovery 12 completo. Mantendo 120s...');
  await page.waitForTimeout(120000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
