/**
 * Discovery PARTE 24 - SCHEMA completo de saveTaskWithList + UI submit fix
 * 1. Fetcha discovery doc completo e extrai schema de saveTaskWithList
 * 2. Tenta UI: digita descrição e usa CTRL+Enter ou busca botão dinâmico
 * 3. Tenta saveTaskWithList via window.fn() (Angular service) ao invés de gapi.client direto
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
      if (body) { try { console.log('   BODY:', JSON.stringify(JSON.parse(body), null, 2).slice(0, 1500)); } catch {} }
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

  // ── PASSO 1: Discovery doc - schema de saveTaskWithList ─────────────────────
  console.log('=== PASSO 1: Schema do saveTaskWithList no discovery doc ===');
  const schema = await page.evaluate(async () => {
    const r = await fetch('https://app.astrea.net.br/_ah/api/discovery/v1/apis/workspace/v1/rest', {
      credentials: 'include',
    });
    const doc = await r.json();

    const method = doc?.resources?.taskListService?.methods?.saveTaskWithList;
    if (!method) return { err: 'saveTaskWithList not found', resources: Object.keys(doc?.resources || {}) };

    return {
      method: {
        httpMethod: method.httpMethod,
        path: method.path,
        parameters: method.parameters,
        request: method.request,
        response: method.response,
        scopes: method.scopes,
      },
      schemas: doc.schemas ? Object.keys(doc.schemas) : [],
      // Pega os schemas relevantes
      taskInfoDTOSchema: doc.schemas?.TaskInfoDTO,
      saveTaskWithListRequestSchema: method.request ? doc.schemas?.[method.request.$ref] : null,
    };
  });

  console.log('saveTaskWithList schema:', JSON.stringify(schema, null, 2).slice(0, 5000));

  // ── PASSO 2: Tenta via window.fn() ───────────────────────────────────────────
  console.log('\n=== PASSO 2: saveTaskWithList via window.fn() ===');
  const fnResult = await page.evaluate(async ({ userId, taskListId }) => {
    const results = {};

    const callFn = (action, payload) => new Promise((resolve, reject) => {
      try {
        window.fn(action)(payload).execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
        setTimeout(() => reject('timeout 12s'), 12000);
      } catch (e) {
        reject(e.message || String(e));
      }
    });

    // Tenta via window.fn - que é como o Angular usa
    try {
      const r = await callFn('workspace.taskListService.saveTaskWithList', {
        taskInfoDTO: { title: 'TESTE AUTOMAÇÃO - PODE DELETAR' },
        taskListId: String(taskListId),
        userId: String(userId),
      });
      results.fn_basic = { success: true, data: JSON.stringify(r).slice(0, 400) };
    } catch (e) {
      results.fn_basic = { err: String(e).slice(0, 200) };
    }

    return results;
  }, { userId: AUTOMATION_USER_ID, taskListId: TASK_LIST_ID });

  console.log('window.fn result:', JSON.stringify(fnResult, null, 2));

  // ── PASSO 3: UI - digita e faz scroll para encontrar botão ──────────────────
  console.log('\n=== PASSO 3: UI submit com scroll/wait para botão ===');
  try {
    await page.click('button:has-text("Adicionar primeira tarefa")', { timeout: 5000 });
    await page.waitForTimeout(2000);
    console.log('Form aberto');

    const textarea = await page.$('textarea[id="description"], textarea[placeholder="Digite a descrição da tarefa"]');
    if (textarea) {
      await textarea.click();
      // Digita letra por letra para disparar eventos React
      await page.keyboard.type('TESTE AUTOMAÇÃO - PODE DELETAR');
      await page.waitForTimeout(1000);
      console.log('Digitou no textarea');

      // Tira screenshot
      await page.screenshot({ path: 'scripts/task-form-after-typing.png' });

      // Verifica se apareceu algum botão novo
      const newBtns = await page.evaluate(() => {
        return [...document.querySelectorAll('button')]
          .filter(b => b.offsetParent !== null)
          .map(b => ({
            text: b.textContent?.trim().slice(0, 60),
            cls: b.className?.toString?.().slice(0, 80),
            type: b.type,
          }));
      });
      console.log('Botões após digitar:', JSON.stringify(newBtns, null, 2));

      // Tenta submeter de várias formas
      // 1. Tab + Enter
      await page.keyboard.press('Tab');
      await page.waitForTimeout(500);
      await page.keyboard.press('Tab');
      await page.waitForTimeout(500);

      // 2. Procura qualquer botão de submit
      const submitBtn = await page.$('button[type="submit"]:not([class*="toggle"])');
      if (submitBtn) {
        const isVis = await submitBtn.isVisible();
        if (isVis) {
          console.log('Encontrou submit button!');
          await submitBtn.click();
          await page.waitForTimeout(4000);
        }
      }

      // 3. Ctrl+Enter
      await page.keyboard.press('Control+Enter');
      await page.waitForTimeout(3000);

      // 4. Procura qualquer botão com texto de ação
      const actionBtns = await page.$$('button');
      for (const btn of actionBtns) {
        const text = await btn.innerText().catch(() => '');
        const vis = await btn.isVisible().catch(() => false);
        if (vis && text && !text.includes('Ocultar') && !text.includes('Adicionar') && !text.includes('pesquisar')) {
          console.log(`Botão encontrado: "${text}"`);
          await btn.click();
          await page.waitForTimeout(3000);
          break;
        }
      }
    }
  } catch (err) {
    console.log('Erro UI:', err.message?.slice(0, 200));
  }

  // ── PASSO 4: Verifica se task foi criada ───────────────────────────────────
  await page.waitForTimeout(2000);
  const taskListCheck = await page.evaluate(async (taskListId) => {
    const svc = window.gapi?.client?.workspace?.taskListService;
    if (!svc) return 'no svc';
    return new Promise((resolve, reject) => {
      svc.getTaskList({ taskListId: String(taskListId), limit: 10 }).execute(r => {
        r.error ? reject(JSON.stringify(r.error)) : resolve(`sizeActive: ${r.sizeActive}`);
      });
      setTimeout(() => reject('timeout'), 8000);
    });
  }, TASK_LIST_ID);
  console.log('\nTask list check:', taskListCheck);

  console.log('\n✅ Discovery 24 completo. Mantendo 20s...');
  await page.waitForTimeout(20000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
