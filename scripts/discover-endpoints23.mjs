/**
 * Discovery PARTE 23 - ÚLTIMO:
 * 1. Tenta criar task via UI pressionando Enter no form (React form sem botão)
 * 2. Testa REST API /api/v2/tasks para criação
 * 3. Tenta changeStatus e loadEditTask para entender User.i18n
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
const AUTOMATION_USER_ID = 6528036269752320;
const TASK_LIST_ID = '6465761223671808';

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Intercept GCP workspace requests
  await page.route('**/_ah/api/workspace/**', async (route) => {
    const req = route.request();
    const url = req.url().replace('https://app.astrea.net.br', '');
    const body = req.postData();
    if (!url.includes('discovery') && !url.includes('proxy.html') && !url.includes('listTaskLists') && !url.includes('getTaskList?')) {
      console.log(`\n🎯 ${req.method()} ${url}`);
      if (body) { try { console.log('   BODY:', JSON.stringify(JSON.parse(body), null, 2).slice(0, 1200)); } catch {} }
      const response = await route.fetch();
      try {
        const rb = await response.json();
        console.log(`   RESP ${response.status()}:`, JSON.stringify(rb).slice(0, 800));
      } catch {}
      await route.fulfill({ response });
    } else {
      await route.continue();
    }
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

  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  // ── PASSO 1: Criar via UI com Enter ──────────────────────────────────────────
  console.log('=== PASSO 1: Criar via UI com Enter ===');
  try {
    await page.click('button:has-text("Adicionar primeira tarefa")', { timeout: 5000 });
    await page.waitForTimeout(2000);

    // Preenche o textarea de descrição (que provavelmente é o título)
    const textarea = await page.$('textarea[id="description"], textarea[placeholder="Digite a descrição da tarefa"]');
    if (textarea) {
      await textarea.click();
      await textarea.fill('TESTE AUTOMAÇÃO - PODE DELETAR');
      await page.waitForTimeout(500);
      console.log('Preencheu descrição. Pressionando Enter...');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(4000);
      console.log('Enter pressionado. Verificar GCP request acima.');
    } else {
      console.log('Textarea não encontrado!');
    }
  } catch (err) {
    console.log('Erro UI Enter:', err.message?.slice(0, 200));
  }

  await page.waitForTimeout(2000);

  // ── PASSO 2: Verificar se a task foi criada ───────────────────────────────────
  console.log('\n=== PASSO 2: Verifica tasks após submit UI ===');
  const taskListAfter = await page.evaluate(async ({ userId, taskListId }) => {
    const svc = window.gapi?.client?.workspace?.taskListService;
    if (!svc) return { err: 'no svc' };

    return new Promise((resolve, reject) => {
      svc.getTaskList({ taskListId: String(taskListId), limit: 10 })
        .execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
      setTimeout(() => reject('timeout'), 10000);
    });
  }, { userId: AUTOMATION_USER_ID, taskListId: TASK_LIST_ID });

  console.log('Task list after:', JSON.stringify(taskListAfter));

  // ── PASSO 3: REST API - tentar criar task via /api/v2 ─────────────────────────
  console.log('\n=== PASSO 3: REST API task creation ===');
  const restTaskResult = await page.evaluate(async ({ userId, taskListId }) => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    if (!http) return { err: 'no $http' };

    const results = {};

    // Descobre estrutura via GET primeiro
    try {
      const r = await http.get(`/api/v2/tasks/case/6045374649761792/user/${userId}`)
        .then(r => r.data)
        .catch(e => ({ error: true, status: e.status, data: JSON.stringify(e.data).slice(0, 200) }));
      results.getCaseTasks = r;
    } catch (e) {
      results.getCaseTasksErr = String(e).slice(0, 200);
    }

    // POST /api/v2/tasks
    const payloads = [
      { key: 'tasks_basic', url: '/api/v2/tasks', method: 'post', body: { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', taskListId, responsibleId: userId } },
      { key: 'tasks_with_user', url: '/api/v2/tasks', method: 'post', body: { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', taskListId, userId } },
      { key: 'task_create', url: '/api/v2/task/create', method: 'post', body: { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', taskListId, responsibleId: userId } },
      { key: 'workspace_task', url: '/api/v2/workspace/task', method: 'post', body: { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', taskListId } },
    ];

    for (const p of payloads) {
      try {
        const r = await http[p.method](p.url, p.body)
          .then(r => ({ status: r.status, data: JSON.stringify(r.data).slice(0, 400) }))
          .catch(e => ({ error: true, status: e.status, data: JSON.stringify(e.data).slice(0, 200) }));
        results[p.key] = r;
      } catch (e) {
        results[p.key] = { err: String(e).slice(0, 200) };
      }
    }

    return results;
  }, { userId: String(AUTOMATION_USER_ID), taskListId: TASK_LIST_ID });

  console.log('REST task results:', JSON.stringify(restTaskResult, null, 2).slice(0, 3000));

  // ── PASSO 4: Tenta entender User.i18n via getById ─────────────────────────────
  console.log('\n=== PASSO 4: getById de usuário via gapi.users.userService ===');
  const userById = await page.evaluate(async (userId) => {
    const userSvc = window.gapi?.client?.users?.userService;
    if (!userSvc) return { err: 'no userService' };

    const call = (method, params, body) => new Promise((resolve, reject) => {
      const req = body !== undefined ? userSvc[method](params, body) : userSvc[method](params);
      req.execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
      setTimeout(() => reject('timeout 10s'), 10000);
    });

    const results = {};

    // Tenta getById
    try {
      const r = await call('getById', { userId: String(userId) });
      results.getById = r;
    } catch (e) {
      results.getByIdErr = String(e).slice(0, 200);
    }

    // Tenta getActiveUsersSimple
    try {
      const r = await call('getActiveUsersSimple', {});
      results.getActiveUsersSimple = { count: (r.users || r.items || []).length, first: (r.users || r.items || [])[0] };
    } catch (e) {
      results.getActiveUsersSimpleErr = String(e).slice(0, 200);
    }

    return results;
  }, AUTOMATION_USER_ID);

  console.log('User by ID:', JSON.stringify(userById, null, 2).slice(0, 2000));

  // ── PASSO 5: saveTaskWithList com userId como número ──────────────────────────
  console.log('\n=== PASSO 5: saveTaskWithList - userId como número, sem taskListId ===');
  const saveVariants = await page.evaluate(async (userId) => {
    const svc = window.gapi?.client?.workspace?.taskListService;
    if (!svc) return { err: 'no svc' };

    const call = (method, params, body) => new Promise((resolve, reject) => {
      const req = body !== undefined ? svc[method](params, body) : svc[method](params);
      req.execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
      setTimeout(() => reject('timeout 12s'), 12000);
    });

    const results = {};
    const taskListId = '6465761223671808';

    // Tenta com userId como número
    try {
      const r = await call('saveTaskWithList', {}, {
        taskInfoDTO: { title: 'TESTE AUTOMAÇÃO - PODE DELETAR' },
        taskListId,
        userId, // number, not string
      });
      results.userId_number = { success: true, data: JSON.stringify(r).slice(0, 400) };
    } catch (e) {
      results.userId_number = { err: String(e).slice(0, 200) };
    }

    // Tenta sem taskListId (usa a padrão)
    try {
      const r = await call('saveTaskWithList', {}, {
        taskInfoDTO: { title: 'TESTE AUTOMAÇÃO - PODE DELETAR' },
        userId: String(userId),
      });
      results.no_taskListId = { success: true, data: JSON.stringify(r).slice(0, 400) };
    } catch (e) {
      results.no_taskListId = { err: String(e).slice(0, 200) };
    }

    // Tenta sem taskInfoDTO wrapper, apenas title flat
    try {
      const r = await call('saveTaskWithList', {}, {
        title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
        taskListId,
        userId: String(userId),
      });
      results.flat_title = { success: true, data: JSON.stringify(r).slice(0, 400) };
    } catch (e) {
      results.flat_title = { err: String(e).slice(0, 200) };
    }

    // Tenta com tenantId
    try {
      const r = await call('saveTaskWithList', {}, {
        taskInfoDTO: {
          title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
          tenantId: '6692712561442816',
        },
        taskListId,
        userId: String(userId),
      });
      results.with_tenantId = { success: true, data: JSON.stringify(r).slice(0, 400) };
    } catch (e) {
      results.with_tenantId = { err: String(e).slice(0, 200) };
    }

    return results;
  }, AUTOMATION_USER_ID);

  console.log('Save variants:', JSON.stringify(saveVariants, null, 2).slice(0, 3000));

  console.log('\n✅ Discovery 23 completo. Mantendo 20s...');
  await page.waitForTimeout(20000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
