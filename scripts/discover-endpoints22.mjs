/**
 * Discovery PARTE 22 - FINAL
 * 1. Busca full user object via gapi.client.users.userService.getAllUsers
 * 2. Tenta saveTaskWithList com full user em taskInfoDTO.user
 * 3. Também tenta criar task via UI (submit do form com keyboard)
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
const TENANT_ID = '6692712561442816';

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

  // ── PASSO 1: getAllUsers via gapi.client.users.userService ────────────────────
  console.log('=== PASSO 1: getAllUsers via userService ===');
  const fullUserResult = await page.evaluate(async ({ tenantId, userId }) => {
    const userSvc = window.gapi?.client?.users?.userService;
    if (!userSvc) return { err: 'no userService', keys: Object.keys(window.gapi?.client?.users || {}) };

    const svcKeys = Object.keys(userSvc);
    const call = (method, params, body) => new Promise((resolve, reject) => {
      const req = body !== undefined ? userSvc[method](params, body) : userSvc[method](params);
      req.execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
      setTimeout(() => reject('timeout 10s'), 10000);
    });

    try {
      // getAllUsers pode ter parâmetros como tenantId no params ou body
      let r = null;
      try {
        r = await call('getAllUsers', { tenantId }, {});
      } catch {
        r = await call('getAllUsers', {}, { tenantId });
      }

      const users = r?.users || r?.items || r?.userList || [];
      const me = users.find(u => String(u.id) === String(userId));
      return {
        total: users.length,
        me,
        svcKeys,
        first2: users.slice(0, 2),
        rawKeys: r ? Object.keys(r) : [],
      };
    } catch (e) {
      // Tenta métodos alternativos
      const results = { svcKeys, err: String(e).slice(0, 200) };
      for (const method of svcKeys.filter(k => k.toLowerCase().includes('user') || k.toLowerCase().includes('get'))) {
        try {
          const r2 = await call(method, { tenantId }, {});
          results[`${method}_result`] = JSON.stringify(r2).slice(0, 400);
          break;
        } catch (e2) {
          results[`${method}_err`] = String(e2).slice(0, 100);
        }
      }
      return results;
    }
  }, { tenantId: TENANT_ID, userId: AUTOMATION_USER_ID });

  console.log('getAllUsers result:', JSON.stringify(fullUserResult, null, 2).slice(0, 3000));
  const fullUser = fullUserResult?.me || null;
  console.log('\nFull user:', JSON.stringify(fullUser, null, 2)?.slice(0, 1000));
  await page.waitForTimeout(1000);

  // ── PASSO 2: saveTaskWithList com full user de userService ────────────────────
  console.log('\n=== PASSO 2: saveTaskWithList com full user object ===');
  const saveResult = await page.evaluate(async ({ userId, taskListId, fullUser }) => {
    const svc = window.gapi?.client?.workspace?.taskListService;
    if (!svc) return { err: 'no svc' };

    const call = (method, params, body) => new Promise((resolve, reject) => {
      const req = body !== undefined ? svc[method](params, body) : svc[method](params);
      req.execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
      setTimeout(() => reject('timeout 12s'), 12000);
    });

    const variants = [];

    // Se fullUser existir, usa ele
    if (fullUser) {
      variants.push({
        key: 'full_user_obj',
        body: { taskInfoDTO: { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', user: fullUser }, taskListId: String(taskListId), userId: String(userId) },
      });
    }

    // Tenta com user tendo apenas id (como número)
    variants.push({
      key: 'user_id_number',
      body: { taskInfoDTO: { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', user: { id: userId } }, taskListId: String(taskListId), userId: String(userId) },
    });

    // Tenta sem userId no outer body, só no taskInfoDTO
    variants.push({
      key: 'no_outer_userId',
      body: { taskInfoDTO: { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', responsibleId: String(userId) }, taskListId: String(taskListId) },
    });

    // Tenta com responsibleId como campo separado fora do taskInfoDTO mas dentro do body
    variants.push({
      key: 'responsible_separate',
      body: {
        taskInfoDTO: { title: 'TESTE AUTOMAÇÃO - PODE DELETAR' },
        taskListId: String(taskListId),
        userId: String(userId),
        responsibleId: String(userId),
      },
    });

    // Tenta passar taskList object ao invés de taskListId string
    variants.push({
      key: 'taskList_as_object',
      body: {
        taskInfoDTO: { title: 'TESTE AUTOMAÇÃO - PODE DELETAR' },
        taskList: { id: String(taskListId) },
        userId: String(userId),
      },
    });

    const results = {};
    for (const v of variants) {
      try {
        const r = await call('saveTaskWithList', {}, v.body);
        results[v.key] = { success: true, data: JSON.stringify(r).slice(0, 600) };
        const taskId = r.id || r.taskInfoDTO?.id || r.taskId;
        if (taskId) {
          try { await call('deleteTask', {}, { taskId: String(taskId), userId: String(userId) }); } catch {}
        }
        break;
      } catch (e) {
        results[v.key] = { err: String(e).slice(0, 300) };
      }
    }
    return results;
  }, { userId: AUTOMATION_USER_ID, taskListId: TASK_LIST_ID, fullUser });

  console.log('Save results:', JSON.stringify(saveResult, null, 2).slice(0, 3000));
  await page.waitForTimeout(1000);

  // ── PASSO 3: Criar via UI e capturar request ──────────────────────────────────
  console.log('\n=== PASSO 3: Criar via UI ===');
  try {
    await page.click('button:has-text("Adicionar primeira tarefa")', { timeout: 5000 });
    await page.waitForTimeout(3000);
    console.log('Clicou no botão!');

    // Tirar screenshot para ver o estado
    await page.screenshot({ path: 'scripts/task-form-screenshot.png' });
    console.log('Screenshot salvo em scripts/task-form-screenshot.png');

    // Encontra todos os elementos visíveis interativos
    const interactive = await page.evaluate(() => {
      return {
        inputs: [...document.querySelectorAll('input, textarea')]
          .filter(el => el.offsetParent !== null)
          .map(el => ({
            tag: el.tagName,
            type: el.type,
            placeholder: el.placeholder,
            ngModel: el.getAttribute('ng-model') || '',
            id: el.id,
            cls: el.className?.toString?.().slice(0, 60),
          })),
        buttons: [...document.querySelectorAll('button')]
          .filter(el => el.offsetParent !== null)
          .map(el => ({
            text: el.textContent?.trim().slice(0, 50),
            type: el.type,
            cls: el.className?.toString?.().slice(0, 60),
            ngClick: el.getAttribute('ng-click') || '',
          })),
      };
    });
    console.log('Interactive elements:', JSON.stringify(interactive, null, 2).slice(0, 3000));

    // Preenche o campo de descrição (que parece ser o título)
    const descInput = await page.$('textarea[placeholder="Digite a descrição da tarefa"], input[ng-model*="title"], textarea[ng-model*="title"], textarea[ng-model*="description"]');
    if (descInput) {
      await descInput.fill('TESTE AUTOMAÇÃO - PODE DELETAR');
      await page.waitForTimeout(500);
      console.log('Preencheu descrição/título');
    }

    // Tenta clicar qualquer botão de salvar
    const saveButtons = interactive.buttons.filter(b =>
      b.text.toLowerCase().includes('salvar') ||
      b.text.toLowerCase().includes('confirmar') ||
      b.text.toLowerCase().includes('criar') ||
      b.text.toLowerCase().includes('adicionar') ||
      b.type === 'submit'
    );
    console.log('Save buttons found:', JSON.stringify(saveButtons));

    if (saveButtons.length > 0) {
      // Clica pelo índice
      const allBtns = await page.$$('button');
      for (const btn of allBtns) {
        const text = await btn.innerText().catch(() => '');
        const visible = await btn.isVisible().catch(() => false);
        if (visible && (text.includes('Salvar') || text.includes('Confirmar') || text.includes('Criar'))) {
          console.log(`Clicando botão: "${text}"`);
          await btn.click();
          await page.waitForTimeout(5000);
          break;
        }
      }
    } else {
      // Tenta keyboard shortcut (Ctrl+Enter ou Enter)
      console.log('Tentando Enter...');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
    }

  } catch (err) {
    console.log('Erro UI:', err.message?.slice(0, 200));
  }

  console.log('\n✅ Discovery 22 completo. Mantendo 20s...');
  await page.waitForTimeout(20000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
