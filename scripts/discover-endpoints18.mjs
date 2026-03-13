/**
 * Discovery PARTE 18 - ÚLTIMO:
 * 1. saveTaskWithList com taskInfoDTO wrapper
 * 2. getTaskListWithAllTasks com isReverse: false
 * 3. getTasksByCase com ID de consulting existente
 * 4. loadEditTask para ver estrutura
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

  // Captura GCP API requests
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('_ah/api') || url.includes('discovery') || url.includes('proxy.html')) return;
    const path = url.replace('https://app.astrea.net.br', '');
    console.log(`\n📤 ${req.method()} ${path}`);
    const pd = req.postData();
    if (pd) { try { console.log('   >', JSON.stringify(JSON.parse(pd), null, 2).slice(0, 500)); } catch { console.log('   >', pd.slice(0, 300)); } }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('_ah/api') || url.includes('discovery') || url.includes('proxy.html')) return;
    const path = url.replace('https://app.astrea.net.br', '').split('?')[0];
    const status = res.status();
    try {
      const body = await res.json();
      console.log(`\n📥 ${status} ${res.request().method()} ${path}`);
      console.log(`   ${JSON.stringify(body).slice(0, 1200)}`);
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

  // ── PASSO 1: saveTaskWithList com taskInfoDTO ─────────────────────────────────
  console.log('=== PASSO 1: saveTaskWithList com taskInfoDTO wrapper ===');
  const createResult = await page.evaluate(async ({ userId, taskListId }) => {
    const svc = window.gapi?.client?.workspace?.taskListService;
    if (!svc) return { err: 'no svc' };

    const call = (method, params, body) => new Promise((resolve, reject) => {
      const req = body !== undefined ? svc[method](params, body) : svc[method](params);
      req.execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
      setTimeout(() => reject('timeout 10s'), 10000);
    });

    const results = {};

    // Tenta diferentes estruturas de payload
    const variants = [
      // 1. Task wrapped in taskInfoDTO
      {
        key: 'wrapped_taskInfoDTO',
        params: {},
        body: {
          taskInfoDTO: {
            title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
            responsibleId: String(userId),
          },
          taskListId: String(taskListId),
          userId: String(userId),
        },
      },
      // 2. Task in "task" key
      {
        key: 'wrapped_task',
        params: { taskListId: String(taskListId) },
        body: {
          task: {
            title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
            responsibleId: String(userId),
          },
          userId: String(userId),
        },
      },
      // 3. task e taskListId
      {
        key: 'flat_with_params',
        params: { taskListId: String(taskListId), userId: String(userId) },
        body: {
          title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
          responsibleId: String(userId),
        },
      },
      // 4. taskInfoDTO with id: null
      {
        key: 'taskInfoDTO_with_null_id',
        params: {},
        body: {
          taskInfoDTO: {
            id: null,
            title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
            responsibleId: String(userId),
            taskListId: String(taskListId),
          },
          taskListId: String(taskListId),
          userId: String(userId),
        },
      },
      // 5. Body como array
      {
        key: 'array_body',
        params: { taskListId: String(taskListId), userId: String(userId) },
        body: [{
          title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
          responsibleId: String(userId),
        }],
      },
    ];

    for (const v of variants) {
      try {
        const r = await call('saveTaskWithList', v.params, v.body);
        results[v.key] = { success: true, data: JSON.stringify(r).slice(0, 600) };
        // Tenta deletar se criou
        if (r.id || r.taskInfoDTO?.id) {
          const taskId = r.id || r.taskInfoDTO?.id;
          try {
            await call('deleteTask', {}, { taskId: String(taskId), userId: String(userId) });
            results[v.key].deleted = true;
          } catch {}
        }
        break; // Para no primeiro sucesso
      } catch (e) {
        results[v.key] = { err: String(e).slice(0, 200) };
      }
    }

    return results;
  }, { userId: AUTOMATION_USER_ID, taskListId: TASK_LIST_ID });

  console.log('Create results:', JSON.stringify(createResult, null, 2).slice(0, 3000));
  await page.waitForTimeout(2000);

  // ── PASSO 2: getTaskListWithAllTasks com isReverse ────────────────────────────
  console.log('\n=== PASSO 2: getTaskListWithAllTasks com isReverse ===');
  const allTasks = await page.evaluate(async ({ userId, taskListId }) => {
    const svc = window.gapi?.client?.workspace?.taskListService;
    if (!svc) return { err: 'no svc' };

    const call = (method, params) => new Promise((resolve, reject) => {
      svc[method](params).execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
      setTimeout(() => reject('timeout 10s'), 10000);
    });

    try {
      const r = await call('getTaskListWithAllTasks', {
        userId: String(userId),
        taskListId: String(taskListId),
        limit: 20,
        orderBy: 'ORDER',
        isReverse: false,
      });
      return { success: true, data: JSON.stringify(r).slice(0, 1000) };
    } catch (e) {
      return { err: String(e).slice(0, 300) };
    }
  }, { userId: AUTOMATION_USER_ID, taskListId: TASK_LIST_ID });

  console.log('getTaskListWithAllTasks:', JSON.stringify(allTasks, null, 2));
  await page.waitForTimeout(2000);

  // ── PASSO 3: getTasksByCase ────────────────────────────────────────────────────
  console.log('\n=== PASSO 3: getTasksByCase ===');

  // Primeiro cria um consulting para ter um ID de caso
  const consultingAndTasks = await page.evaluate(async (userId) => {
    const svc = window.gapi?.client?.workspace?.taskListService;
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    const baseUrl = 'https://app.astrea.net.br/api/v2';

    const call = (method, params, body) => new Promise((resolve, reject) => {
      const req = body !== undefined ? svc[method](params, body) : svc[method](params);
      req.execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
      setTimeout(() => reject('timeout 10s'), 10000);
    });

    const results = {};

    // Tenta getTasksByCase com diferentes IDs conhecidos
    const testIds = [
      '5732697556058112', // contact ID do ESTEVAO
      '6528036269752320', // automation user ID
    ];

    for (const caseId of testIds) {
      try {
        const r = await call('getTasksByCase', { caseId, userId: String(userId) });
        results[`params_${caseId}`] = { success: true, data: JSON.stringify(r).slice(0, 400) };
      } catch (e) {
        results[`params_${caseId}`] = { err: String(e).slice(0, 100) };
      }

      try {
        const r2 = await call('getTasksByCase', {}, { caseId, userId: String(userId) });
        results[`body_${caseId}`] = { success: true, data: JSON.stringify(r2).slice(0, 400) };
      } catch (e2) {
        results[`body_${caseId}`] = { err: String(e2).slice(0, 100) };
      }
    }

    // Tenta buscar um consulting para pegar o caseAttached.id
    try {
      const list = await http.post(`${baseUrl}/consulting/query`, {
        status: 'Active', tagIds: [], subject: '', consultingId: null,
        customerId: null, order: '-createDate', caseAttached: null,
        limit: 3, cursor: '', createdAt: null, dateBegin: null, dateEnd: null,
      }).then(r => r.data);

      const consultings = list?.consultingDTO || [];
      for (const c of consultings) {
        if (c.caseAttached?.id) {
          const caseId = String(c.caseAttached.id);
          try {
            const r = await call('getTasksByCase', {}, { caseId, userId: String(userId) });
            results[`case_from_consulting_${caseId}`] = { success: true, data: JSON.stringify(r).slice(0, 600) };
          } catch (e) {
            results[`case_from_consulting_${caseId}`] = { err: String(e).slice(0, 100) };
          }
        }
      }

      results.consultings = consultings.slice(0, 2).map(c => ({
        id: c.id,
        subject: c.subject,
        caseAttached: c.caseAttached,
      }));
    } catch (e) {
      results.consultingsErr = String(e).slice(0, 100);
    }

    return results;
  }, AUTOMATION_USER_ID);

  console.log('getTasksByCase results:', JSON.stringify(consultingAndTasks, null, 2).slice(0, 3000));
  await page.waitForTimeout(2000);

  // ── PASSO 4: getAllTaskLists ────────────────────────────────────────────────────
  console.log('\n=== PASSO 4: getAllTaskLists (outro endpoint de listagem) ===');
  const allLists = await page.evaluate(async (userId) => {
    const svc = window.gapi?.client?.workspace?.taskListService;
    if (!svc) return { err: 'no svc' };

    const call = (method, params) => new Promise((resolve, reject) => {
      svc[method](params).execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
      setTimeout(() => reject('timeout 10s'), 10000);
    });

    try {
      const r = await call('getAllTaskLists', { userId: String(userId) });
      return { success: true, data: JSON.stringify(r).slice(0, 800) };
    } catch (e) {
      return { err: String(e).slice(0, 200) };
    }
  }, AUTOMATION_USER_ID);

  console.log('getAllTaskLists:', JSON.stringify(allLists, null, 2).slice(0, 600));
  await page.waitForTimeout(2000);

  console.log('\n✅ Discovery 18 completo. Mantendo 90s...');
  await page.waitForTimeout(90000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
