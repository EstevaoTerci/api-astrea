/**
 * Discovery PARTE 17 - FINAL:
 * 1. Criar tarefa via gapi.client.workspace.taskListService.saveTaskWithList
 * 2. Buscar tarefas de caso via getTasksByCase
 * 3. Buscar tarefas da workspace via getTaskListWithAllTasks
 * 4. Ver estrutura completa de tarefa via loadEditTask
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
  await page.waitForTimeout(3000);

  // ── PASSO 1: Criar tarefa via gapi.client.workspace.taskListService ───────────
  console.log('=== PASSO 1: Criar tarefa via saveTaskWithList ===');
  const createResult = await page.evaluate(async ({ userId, contactId, taskListId }) => {
    const svc = window.gapi?.client?.workspace?.taskListService;
    if (!svc) return { err: 'gapi.client.workspace.taskListService not available' };

    const call = (method, params, body) => new Promise((resolve, reject) => {
      const req = body ? svc[method](params, body) : svc[method](params);
      req.execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
      setTimeout(() => reject('timeout 10s'), 10000);
    });

    const results = {};

    // Tenta saveTaskWithList com diferentes payloads
    const payloads = [
      // Payload 1: mínimo
      {
        params: {},
        body: {
          title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
          responsibleId: String(userId),
          taskListId: String(taskListId),
        }
      },
      // Payload 2: com userId no body
      {
        params: {},
        body: {
          title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
          responsibleId: String(userId),
          taskListId: String(taskListId),
          userId: String(userId),
        }
      },
      // Payload 3: tudo como query params
      {
        params: {
          title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
          responsibleId: String(userId),
          taskListId: String(taskListId),
          userId: String(userId),
        },
        body: undefined,
      },
    ];

    for (const [i, p] of payloads.entries()) {
      try {
        const r = p.body
          ? await call('saveTaskWithList', p.params, p.body)
          : await call('saveTaskWithList', p.params);
        results[`payload_${i}`] = { success: true, data: JSON.stringify(r).slice(0, 600) };

        // Deleta se criou
        if (r.id) {
          try {
            await call('deleteTask', { taskId: String(r.id), userId: String(userId) });
            results[`payload_${i}`].deleted = true;
          } catch {}
        }
        break;
      } catch (e) {
        results[`payload_${i}`] = { err: String(e).slice(0, 200) };
      }
    }

    return results;
  }, { userId: AUTOMATION_USER_ID, contactId: ESTEVAO_CLIENT_CONTACT_ID, taskListId: '6465761223671808' });

  console.log('Create results:', JSON.stringify(createResult, null, 2).slice(0, 2000));
  await page.waitForTimeout(3000);

  // ── PASSO 2: Buscar tarefas por caso (getTasksByCase) ─────────────────────────
  console.log('\n=== PASSO 2: getTasksByCase + folder IDs do ESTEVAO ===');

  // Primeiro, busca os casos do ESTEVAO navegando para a página de contatos
  await page.goto(`${ASTREA_URL}/#/main/contacts/${ESTEVAO_CLIENT_CONTACT_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  // Pega folder IDs do DOM depois de esperar mais
  const folderIds = await page.evaluate(() => {
    // Procura em todos os links da página
    const ids = new Set();
    document.querySelectorAll('a').forEach(a => {
      const m = (a.href || '').match(/folders\/(\d{10,})/);
      if (m) ids.add(m[1]);
    });

    // Também procura em ng-href
    document.querySelectorAll('[ng-href]').forEach(el => {
      const href = el.getAttribute('ng-href') || '';
      const m = href.match(/folders\/(\d{10,})/);
      if (m) ids.add(m[1]);
    });

    // Procura em data attributes
    document.querySelectorAll('[data-id], [data-folder-id]').forEach(el => {
      const id = el.getAttribute('data-id') || el.getAttribute('data-folder-id');
      if (id && id.length > 10) ids.add(id);
    });

    // Procura scope/ctrl com folders
    const elems = document.querySelectorAll('*');
    for (const el of elems) {
      try {
        const scope = window.angular?.element(el)?.isolateScope?.();
        if (!scope?.$ctrl) continue;
        const ctrl = scope.$ctrl;
        // Procura arrays de folders
        for (const key in ctrl) {
          const v = ctrl[key];
          if (Array.isArray(v) && v.length && v[0]?.id) {
            v.forEach(item => {
              if (String(item.id).length > 10) ids.add(String(item.id));
            });
          }
        }
      } catch {}
      if (ids.size > 5) break;
    }

    return [...ids].slice(0, 10);
  });

  console.log('Folder IDs encontrados:', folderIds);

  if (folderIds.length > 0) {
    const caseId = folderIds[0];
    const caseTasksResult = await page.evaluate(async ({ caseId, userId }) => {
      const svc = window.gapi?.client?.workspace?.taskListService;
      if (!svc) return { err: 'no gapi' };

      const call = (method, params, body) => new Promise((resolve, reject) => {
        const req = body ? svc[method](params, body) : svc[method](params);
        req.execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
        setTimeout(() => reject('timeout 10s'), 10000);
      });

      try {
        const r = await call('getTasksByCase', { caseId: String(caseId), userId: String(userId) });
        return { success: true, data: JSON.stringify(r).slice(0, 1000) };
      } catch (e) {
        // Tenta com body
        try {
          const r2 = await call('getTasksByCase', {}, { caseId: String(caseId), userId: String(userId) });
          return { success: true, withBody: true, data: JSON.stringify(r2).slice(0, 1000) };
        } catch (e2) {
          return { err: String(e).slice(0, 200), err2: String(e2).slice(0, 200) };
        }
      }
    }, { caseId, userId: AUTOMATION_USER_ID });

    console.log('getTasksByCase:', JSON.stringify(caseTasksResult, null, 2).slice(0, 1000));
  }

  // ── PASSO 3: getTaskListWithAllTasks com orderBy ──────────────────────────────
  console.log('\n=== PASSO 3: getTaskListWithAllTasks ===');
  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  const allTasksResult = await page.evaluate(async (userId) => {
    const svc = window.gapi?.client?.workspace?.taskListService;
    if (!svc) return { err: 'no gapi' };

    const call = (method, params, body) => new Promise((resolve, reject) => {
      const req = body ? svc[method](params, body) : svc[method](params);
      req.execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
      setTimeout(() => reject('timeout 10s'), 10000);
    });

    const results = {};

    // getTaskListWithAllTasks - requer orderBy
    const orderByValues = ['ORDER', 'dueDate', 'DUE_DATE', 'createdAt', 'title', 'priority', 'PRIORITY'];
    for (const orderBy of orderByValues) {
      try {
        const r = await call('getTaskListWithAllTasks', {
          userId: String(userId),
          limit: 10,
          orderBy,
          taskListId: '6465761223671808',
        });
        results.getTaskListWithAllTasks = { orderBy, data: JSON.stringify(r).slice(0, 1000) };
        break;
      } catch (e) {
        results[`getWithAllTasks_${orderBy}`] = { err: String(e).slice(0, 150) };
      }
    }

    // getTaskList simples
    try {
      const r = await call('getTaskList', { taskListId: '6465761223671808', limit: 20 });
      results.getTaskList = JSON.stringify(r).slice(0, 600);
    } catch (e) {
      results.getTaskListErr = String(e).slice(0, 150);
    }

    return results;
  }, AUTOMATION_USER_ID);

  console.log('allTasksResult:', JSON.stringify(allTasksResult, null, 2).slice(0, 2000));
  await page.waitForTimeout(3000);

  // ── PASSO 4: Criar tarefa via UI e capturar GCP request ──────────────────────
  console.log('\n=== PASSO 4: Criar tarefa via UI ===');

  // Registra listener adicional para GCP requests
  const gcpRequests = [];
  page.on('request', (req) => {
    if (req.url().includes('_ah/api') && !req.url().includes('discovery')) {
      gcpRequests.push({ method: req.method(), url: req.url(), body: req.postData() });
    }
  });

  try {
    // Clica em "Adicionar primeira tarefa"
    const btn = await page.$('button:has-text("Adicionar")');
    if (btn && await btn.isVisible()) {
      await btn.click();
      await page.waitForTimeout(2000);

      // Inspeciona modal aberto
      const modalInfo = await page.evaluate(() => {
        const modals = [...document.querySelectorAll('.modal-content, [class*="overlay"], [class*="drawer"], [class*="panel"]')]
          .filter(m => m.offsetParent && !m.closest('[hidden]'));
        if (!modals.length) return { noModal: true };
        return modals.map(m => ({
          cls: m.className?.toString?.().slice(0, 80),
          text: m.textContent?.trim().slice(0, 200),
          inputs: [...m.querySelectorAll('input, textarea, select')]
            .map(i => ({ type: i.type, placeholder: i.placeholder, ngModel: i.getAttribute('ng-model') || '' })),
        }));
      });
      console.log('Modal:', JSON.stringify(modalInfo, null, 2).slice(0, 1000));

      // Preenche e submete
      const titleInput = await page.$('.modal-content input[type="text"], .modal-content textarea, input[ng-model*="title"], input[ng-model*="name"]');
      if (titleInput && await titleInput.isVisible()) {
        await titleInput.fill('TESTE AUTOMAÇÃO - PODE DELETAR');
        await page.waitForTimeout(500);

        const saveBtn = await page.$('button[type="submit"], button:has-text("Salvar"), button:has-text("Criar"), button:has-text("Confirmar"), button:has-text("Adicionar")');
        if (saveBtn && await saveBtn.isVisible()) {
          await saveBtn.click();
          await page.waitForTimeout(3000);
          console.log('Formulário submetido!');
        }
      }
    }
  } catch (err) {
    console.log('Erro UI:', err.message?.slice(0, 200));
  }

  await page.waitForTimeout(3000);

  console.log('\nGCP requests capturados após clique:');
  for (const r of gcpRequests) {
    console.log(`  ${r.method} ${r.url.replace('https://app.astrea.net.br', '')}`);
    if (r.body) { try { console.log(`    Body: ${r.body.slice(0, 300)}`); } catch {} }
  }

  console.log('\n✅ Discovery 17 completo. Mantendo 120s...');
  await page.waitForTimeout(120000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
