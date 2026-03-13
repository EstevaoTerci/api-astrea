/**
 * Discovery PARTE 27 - Combinações precisas baseadas nos erros anteriores:
 * idUser resolve o session user, responsibleId identifica o responsável,
 * createDate é obrigatório, userId (Long) causa conflito com idUser
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

  await page.route('**/_ah/api/workspace/**', async (route) => {
    const req = route.request();
    const url = req.url().replace('https://app.astrea.net.br', '');
    const body = req.postData();
    if (!url.includes('discovery') && !url.includes('proxy.html') && !url.includes('listTaskLists') && !url.includes('getTaskList?')) {
      console.log(`\n🎯 ${req.method()} ${url}`);
      if (body) { try { console.log('   BODY:', JSON.stringify(JSON.parse(body), null, 2).slice(0, 1500)); } catch {} }
      const response = await route.fetch();
      try {
        const rb = await response.json();
        console.log(`   RESP ${response.status()}:`, JSON.stringify(rb).slice(0, 1500));
      } catch {}
      await route.fulfill({ response });
    } else {
      await route.continue();
    }
  });

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

  console.log('=== saveTaskWithList: idUser + responsibleId + createDate ===');
  const results = await page.evaluate(async (userId) => {
    const svc = window.gapi?.client?.workspace?.taskListService;
    if (!svc) return { err: 'no svc' };

    const taskListId = '6465761223671808';
    const now = new Date().toISOString();

    const call = (method, params, body) => new Promise((resolve, reject) => {
      const req = body !== undefined ? svc[method](params, body) : svc[method](params);
      req.execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
      setTimeout(() => reject('timeout 12s'), 12000);
    });

    const res = {};

    // V1: idUser ONLY (sem userId) + responsibleId top-level + createDate
    try {
      const r = await call('saveTaskWithList', {}, {
        taskInfoDTO: {
          description: 'TESTE AUTOMAÇÃO - PODE DELETAR',
          responsibleId: String(userId),
          createDate: now,
        },
        idCurrentTaskList: String(taskListId),
        idUser: String(userId),
        responsibleId: String(userId),
      });
      res.v1_idUser_only = { success: true, data: JSON.stringify(r).slice(0, 1000) };
      const id = r.id || r.taskInfoDTO?.id;
      if (id) { res.taskId = id; console.log('✅ TAREFA CRIADA! ID:', id); }
    } catch (e) { res.v1_idUser_only = { err: String(e).slice(0, 300) }; }

    if (res.v1_idUser_only?.success) return res;

    // V2: sem nenhum userId/idUser externo, só dentro do taskInfoDTO via responsibleId
    try {
      const r = await call('saveTaskWithList', {}, {
        taskInfoDTO: {
          description: 'TESTE AUTOMAÇÃO - PODE DELETAR',
          responsibleId: String(userId),
          createDate: now,
          currentTaskList: String(taskListId),
        },
        idCurrentTaskList: String(taskListId),
        responsibleId: String(userId),
      });
      res.v2_no_userId_at_all = { success: true, data: JSON.stringify(r).slice(0, 1000) };
      const id = r.id || r.taskInfoDTO?.id;
      if (id) { res.taskId = id; console.log('✅ TAREFA CRIADA! ID:', id); }
    } catch (e) { res.v2_no_userId_at_all = { err: String(e).slice(0, 300) }; }

    if (res.v2_no_userId_at_all?.success) return res;

    // V3: userId como número (Long nativo) ao invés de string
    // Talvez o problema seja que quando passamos string, o GCP Endpoints
    // não popula o campo userId (Long) porque já tem idUser
    try {
      const r = await call('saveTaskWithList', {}, {
        taskInfoDTO: {
          description: 'TESTE AUTOMAÇÃO - PODE DELETAR',
          responsibleId: String(userId),
          createDate: now,
        },
        idCurrentTaskList: String(taskListId),
        userId: String(userId),
        idUser: String(userId),
        responsibleId: String(userId),
        id: String(taskListId), // taskSaveParameter.id = task list?
      });
      res.v3_with_id_field = { success: true, data: JSON.stringify(r).slice(0, 1000) };
      const id = r.id || r.taskInfoDTO?.id;
      if (id) { res.taskId = id; }
    } catch (e) { res.v3_with_id_field = { err: String(e).slice(0, 300) }; }

    if (res.v3_with_id_field?.success) return res;

    // V4: Tenta entender o "userId is null" - talvez userId venha de outro campo
    // TaskSaveParameter.id = taskId para update, TaskSaveParameter.userId = operator
    // Talvez userId aqui seja o ID do TASK LIST USER, não do current user
    // E idUser = current logged user
    try {
      const r = await call('saveTaskWithList', {}, {
        taskInfoDTO: {
          description: 'TESTE AUTOMAÇÃO - PODE DELETAR',
          responsibleId: String(userId),
          createDate: now,
          ownerId: String(userId), // ownerId pode ser o "userId" que está null
        },
        idCurrentTaskList: String(taskListId),
        idUser: String(userId),
        responsibleId: String(userId),
      });
      res.v4_ownerId_in_dto = { success: true, data: JSON.stringify(r).slice(0, 1000) };
      const id = r.id || r.taskInfoDTO?.id;
      if (id) { res.taskId = id; }
    } catch (e) { res.v4_ownerId_in_dto = { err: String(e).slice(0, 300) }; }

    if (res.v4_ownerId_in_dto?.success) return res;

    // V5: Tenta com idCurrentTaskList E taskListId E rootCaseId null
    try {
      const r = await call('saveTaskWithList', {}, {
        taskInfoDTO: {
          description: 'TESTE AUTOMAÇÃO - PODE DELETAR',
          responsibleId: String(userId),
          createDate: now,
        },
        idCurrentTaskList: String(taskListId),
        idOldTaskList: String(taskListId),
        idUser: String(userId),
        responsibleId: String(userId),
      });
      res.v5_old_and_new_list = { success: true, data: JSON.stringify(r).slice(0, 1000) };
      const id = r.id || r.taskInfoDTO?.id;
      if (id) { res.taskId = id; }
    } catch (e) { res.v5_old_and_new_list = { err: String(e).slice(0, 300) }; }

    return res;
  }, AUTOMATION_USER_ID);

  console.log('\nResults:', JSON.stringify(results, null, 2).slice(0, 4000));

  if (results.taskId) {
    const del = await page.evaluate(async ({ taskId, userId }) => {
      const svc = window.gapi?.client?.workspace?.taskListService;
      if (!svc) return 'no svc';
      return new Promise((res, rej) => {
        svc.deleteTask({}, { taskId: String(taskId), userId: String(userId) })
          .execute(r => r.error ? rej(JSON.stringify(r.error)) : res('DELETED ✅: ' + JSON.stringify(r).slice(0, 100)));
        setTimeout(() => rej('timeout'), 8000);
      });
    }, { taskId: results.taskId, userId: AUTOMATION_USER_ID });
    console.log('\nDelete:', del);
  }

  console.log('\n✅ Discovery 27 completo. Mantendo 10s...');
  await page.waitForTimeout(10000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
