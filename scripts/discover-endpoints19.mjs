/**
 * Discovery PARTE 19:
 * 1. Capturar GCP request de criação de tarefa via UI clicando botão na workspace
 * 2. Descobrir orderBy enum para getTaskListWithAllTasks
 * 3. Testar saveTaskWithList com user object no taskInfoDTO
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
  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Captura GCP API requests
  const gcpRequests = [];
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('_ah/api') || url.includes('discovery') || url.includes('proxy.html')) return;
    const path = url.replace('https://app.astrea.net.br', '');
    const pd = req.postData();
    gcpRequests.push({ method: req.method(), path, body: pd });
    console.log(`\n📤 ${req.method()} ${path}`);
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

  // ── PASSO 1: getTaskListWithAllTasks com enums válidos ─────────────────────────
  console.log('=== PASSO 1: getTaskListWithAllTasks - testar enums válidos ===');
  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  const enumTest = await page.evaluate(async ({ userId, taskListId }) => {
    const svc = window.gapi?.client?.workspace?.taskListService;
    if (!svc) return { err: 'no svc' };

    const call = (method, params) => new Promise((resolve, reject) => {
      svc[method](params).execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
      setTimeout(() => reject('timeout 8s'), 8000);
    });

    const results = {};

    // Tenta enums comuns de ordenação
    const enums = ['DUE_DATE', 'TITLE', 'PRIORITY', 'CREATION_DATE', 'MANUAL', 'POSITION',
      'CREATED_AT', 'UPDATED_AT', 'NAME', 'DATE', 'STATUS', 'RESPONSIBLE', 'DEFAULT'];
    for (const orderBy of enums) {
      try {
        const r = await call('getTaskListWithAllTasks', {
          userId: String(userId),
          taskListId: String(taskListId),
          limit: 10,
          orderBy,
          isReverse: false,
        });
        results[orderBy] = { success: true, data: JSON.stringify(r).slice(0, 400) };
        break; // Para no primeiro sucesso
      } catch (e) {
        const err = String(e).slice(0, 150);
        if (!err.includes('No enum constant') && !err.includes('IllegalArgumentException')) {
          results[orderBy] = { err }; // Erro diferente, pode ser útil
        } else {
          results[orderBy] = { invalidEnum: true };
        }
      }
    }

    return results;
  }, { userId: AUTOMATION_USER_ID, taskListId: TASK_LIST_ID });

  const successEnum = Object.entries(enumTest).find(([_, v]) => v.success);
  const invalidEnums = Object.entries(enumTest).filter(([_, v]) => v.invalidEnum).map(([k]) => k);
  const differentError = Object.entries(enumTest).filter(([_, v]) => !v.invalidEnum && !v.success);
  console.log('Success enum:', successEnum);
  console.log('Invalid enums:', invalidEnums);
  console.log('Different errors:', differentError);
  await page.waitForTimeout(2000);

  // ── PASSO 2: saveTaskWithList com user object ─────────────────────────────────
  console.log('\n=== PASSO 2: saveTaskWithList com user variants ===');
  const saveTest = await page.evaluate(async ({ userId, taskListId }) => {
    const svc = window.gapi?.client?.workspace?.taskListService;
    if (!svc) return { err: 'no svc' };

    const call = (method, params, body) => new Promise((resolve, reject) => {
      const req = body !== undefined ? svc[method](params, body) : svc[method](params);
      req.execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
      setTimeout(() => reject('timeout 10s'), 10000);
    });

    const results = {};

    // O erro era "User.getI18n() because 'user' is null"
    // Significa que o backend tenta pegar o user a partir do responsibleId
    // e está nulo. Talvez responsibleId precisa ser String ou Int
    const variants = [
      // 1. responsibleId como número
      {
        key: 'responsible_as_number',
        body: {
          taskInfoDTO: {
            title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
            responsibleId: Number(userId),
          },
          taskListId: String(taskListId),
          userId: String(userId),
        },
      },
      // 2. sem responsibleId
      {
        key: 'no_responsible',
        body: {
          taskInfoDTO: {
            title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
          },
          taskListId: String(taskListId),
          userId: String(userId),
        },
      },
      // 3. responsibleId como string mas no body top-level
      {
        key: 'responsible_top_level',
        body: {
          taskInfoDTO: {
            title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
          },
          taskListId: String(taskListId),
          userId: String(userId),
          responsibleId: String(userId),
        },
      },
      // 4. user como objeto no taskInfoDTO
      {
        key: 'user_obj_in_taskInfoDTO',
        body: {
          taskInfoDTO: {
            title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
            user: { id: String(userId) },
          },
          taskListId: String(taskListId),
          userId: String(userId),
        },
      },
    ];

    for (const v of variants) {
      try {
        const r = await call('saveTaskWithList', {}, v.body);
        results[v.key] = { success: true, data: JSON.stringify(r).slice(0, 600) };
        // Deleta
        const taskId = r.id || r.taskInfoDTO?.id;
        if (taskId) {
          try { await call('deleteTask', {}, { taskId: String(taskId), userId: String(userId) }); } catch {}
        }
        break;
      } catch (e) {
        results[v.key] = { err: String(e).slice(0, 200) };
      }
    }

    return results;
  }, { userId: AUTOMATION_USER_ID, taskListId: TASK_LIST_ID });

  console.log('Save test results:', JSON.stringify(saveTest, null, 2).slice(0, 2000));
  await page.waitForTimeout(2000);

  // ── PASSO 3: Criar tarefa via UI (capturar GCP request exato) ─────────────────
  console.log('\n=== PASSO 3: Criar tarefa via UI ===');
  gcpRequests.length = 0; // limpa requests anteriores

  // Tenta encontrar e clicar o botão "Adicionar primeira tarefa"
  const btnFound = await page.evaluate(() => {
    const el = document.querySelector('.task-list');
    if (!el) return { error: 'no .task-list' };
    const btns = [...el.querySelectorAll('button')];
    return {
      count: btns.length,
      buttons: btns.map(b => ({
        text: b.textContent?.trim().slice(0, 50),
        visible: !!b.offsetParent,
        classes: b.className?.toString?.().slice(0, 80),
      })),
    };
  });
  console.log('Buttons in .task-list:', JSON.stringify(btnFound));

  try {
    // Clica no botão via JS puro (dispara eventos de click)
    const clicked = await page.evaluate(() => {
      const el = document.querySelector('.task-list');
      if (!el) return false;
      const btns = [...el.querySelectorAll('button')];
      const addBtn = btns.find(b => b.textContent?.includes('Adicionar') || b.textContent?.includes('primeira'));
      if (addBtn) {
        addBtn.click();
        return { text: addBtn.textContent?.trim() };
      }
      // Tenta click em qualquer botão visível
      for (const btn of btns) {
        if (btn.offsetParent) {
          btn.click();
          return { text: btn.textContent?.trim(), forced: true };
        }
      }
      return false;
    });
    console.log('Click result:', JSON.stringify(clicked));
    await page.waitForTimeout(4000);

    // Captura DOM depois do click
    const domAfterClick = await page.evaluate(() => {
      // Procura novos elementos que apareceram
      const newEls = [...document.querySelectorAll('[class*="modal"], [class*="overlay"], [class*="drawer"], [class*="popup"], [class*="form"]')]
        .filter(el => el.offsetParent !== null);
      return {
        count: newEls.length,
        elements: newEls.map(el => ({
          tag: el.tagName,
          cls: el.className?.toString?.().slice(0, 80),
          text: el.textContent?.trim().slice(0, 100),
          inputs: [...el.querySelectorAll('input, textarea')].map(i => ({
            type: i.type,
            placeholder: i.placeholder,
            ngModel: i.getAttribute('ng-model') || '',
            value: i.value,
          })),
        })),
      };
    });
    console.log('DOM after click:', JSON.stringify(domAfterClick, null, 2).slice(0, 2000));

    // Se encontrou form/modal, preenche e submete
    if (domAfterClick.count > 0) {
      const firstEl = domAfterClick.elements[0];
      const titleInput = firstEl.inputs.find(i => i.placeholder.toLowerCase().includes('título') || i.ngModel.toLowerCase().includes('title'));
      if (titleInput) {
        await page.fill(`input[ng-model="${titleInput.ngModel}"], input[placeholder="${titleInput.placeholder}"]`,
          'TESTE AUTOMAÇÃO - PODE DELETAR');
        await page.waitForTimeout(500);

        const saveBtn = await page.$('button[type="submit"], button:has-text("Salvar"), button:has-text("Confirmar")');
        if (saveBtn && await saveBtn.isVisible()) {
          await saveBtn.click();
          await page.waitForTimeout(3000);
        }
      }
    }
  } catch (err) {
    console.log('Erro UI:', err.message?.slice(0, 200));
  }

  await page.waitForTimeout(3000);
  console.log('\nGCP requests after UI interaction:');
  for (const r of gcpRequests) {
    console.log(`  ${r.method} ${r.path}`);
    if (r.body) { try { console.log(`    ${r.body.slice(0, 400)}`); } catch {} }
  }

  console.log('\n✅ Discovery 19 completo. Mantendo 90s...');
  await page.waitForTimeout(90000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
