/**
 * Discovery PARTE 26 - createDate é necessário no taskInfoDTO!
 * V1 do script 25 passou o user check mas falhou em createDate.
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

  console.log('=== saveTaskWithList com createDate ===');
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

    // V1: com createDate no taskInfoDTO
    try {
      const r = await call('saveTaskWithList', {}, {
        taskInfoDTO: {
          description: 'TESTE AUTOMAÇÃO - PODE DELETAR',
          responsibleId: String(userId),
          createDate: now,
        },
        idCurrentTaskList: String(taskListId),
        idUser: String(userId),
        userId: String(userId),
        responsibleId: String(userId),
      });
      res.v1_with_createDate = { success: true, data: JSON.stringify(r).slice(0, 1000) };
      const id = r.id || r.taskInfoDTO?.id;
      if (id) {
        console.log('✅ TASK CRIADA! ID:', id);
        // Não deleta imediatamente para verificar
        res.taskId = id;
      }
    } catch (e) { res.v1_with_createDate = { err: String(e).slice(0, 300) }; }

    if (res.v1_with_createDate?.success) return res;

    // V2: createDate + mais campos opcionais
    try {
      const r = await call('saveTaskWithList', {}, {
        taskInfoDTO: {
          description: 'TESTE AUTOMAÇÃO - PODE DELETAR',
          responsibleId: String(userId),
          createDate: now,
          done: false,
        },
        idCurrentTaskList: String(taskListId),
        userId: String(userId),
        responsibleId: String(userId),
      });
      res.v2_extra_fields = { success: true, data: JSON.stringify(r).slice(0, 1000) };
      const id = r.id || r.taskInfoDTO?.id;
      if (id) { res.taskId = id; }
    } catch (e) { res.v2_extra_fields = { err: String(e).slice(0, 300) }; }

    if (res.v2_extra_fields?.success) return res;

    // V3: só idCurrentTaskList e userId (sem responsibleId duplicado)
    try {
      const r = await call('saveTaskWithList', {}, {
        taskInfoDTO: {
          description: 'TESTE AUTOMAÇÃO - PODE DELETAR',
          responsibleId: String(userId),
          createDate: now,
        },
        idCurrentTaskList: String(taskListId),
        userId: String(userId),
      });
      res.v3_no_top_responsible = { success: true, data: JSON.stringify(r).slice(0, 1000) };
      const id = r.id || r.taskInfoDTO?.id;
      if (id) { res.taskId = id; }
    } catch (e) { res.v3_no_top_responsible = { err: String(e).slice(0, 300) }; }

    return res;
  }, AUTOMATION_USER_ID);

  console.log('\nResults:', JSON.stringify(results, null, 2).slice(0, 3000));

  // Deleta task se foi criada com sucesso
  if (results.taskId) {
    const deleteResult = await page.evaluate(async ({ taskId, userId }) => {
      const svc = window.gapi?.client?.workspace?.taskListService;
      if (!svc) return 'no svc';
      return new Promise((res, rej) => {
        svc.deleteTask({}, { taskId: String(taskId), userId: String(userId) })
          .execute(r => r.error ? rej(JSON.stringify(r.error)) : res('deleted: ' + JSON.stringify(r).slice(0, 100)));
        setTimeout(() => rej('timeout'), 8000);
      });
    }, { taskId: results.taskId, userId: AUTOMATION_USER_ID });
    console.log('\nDelete result:', deleteResult);
  }

  // Task list check
  const check = await page.evaluate(async (taskListId) => {
    const svc = window.gapi?.client?.workspace?.taskListService;
    if (!svc) return 'no svc';
    return new Promise((res, rej) => {
      svc.getTaskList({ taskListId: String(taskListId), limit: 10 }).execute(r => {
        r.error ? rej(r.error) : res(`sizeActive: ${r.sizeActive}, sizeDeactive: ${r.sizeDeactive}`);
      });
      setTimeout(() => rej('timeout'), 8000);
    });
  }, TASK_LIST_ID);
  console.log('\nTask list check:', check);

  console.log('\n✅ Discovery 26 completo. Mantendo 10s...');
  await page.waitForTimeout(10000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
