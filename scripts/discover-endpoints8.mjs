/**
 * Discovery PARTE 8:
 * 1. Deletar consulting via PUT com caseAttached: null
 * 2. Descobrir tarefas via GET /statistics e GET /reminders
 * 3. Inspecionar scope Angular da workspace mais profundamente
 * 4. Capturar request de criação de tarefa via UI
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
const APP_URL = 'https://app.astrea.net.br/api/v2';
const ESTEVAO_CLIENT_CONTACT_ID = 5732697556058112;
const AUTOMATION_USER_ID = 6528036269752320;
const TEST_CONSULTING_ID = 6752082057527296;

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const context = await browser.newContext();
  const page = await context.newPage();

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

  // ── PASSO 1: Deletar consulting via PUT com caseAttached: null ────────────────
  console.log('=== PASSO 1: Deletar consulting (PUT com caseAttached: null) ===');
  const deleteResult = await page.evaluate(async (id) => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    const baseUrl = 'https://app.astrea.net.br/api/v2';

    // Primeiro GET para pegar a estrutura atual
    let existing;
    try {
      existing = await http.get(`${baseUrl}/consulting/${id}`).then(r => r.data);
      console.log('Consulting atual:', JSON.stringify(existing).slice(0, 500));
    } catch (e) {
      return { getErr: `${e.status}: ${JSON.stringify(e.data).slice(0, 200)}` };
    }

    // PUT com caseAttached: null e active: false
    try {
      const payload = {
        ...existing,
        active: false,
        caseAttached: null,
        customers: existing.customers || [],
        messages: existing.messages || [],
        consultingHistories: existing.consultingHistories || [],
      };
      const r = await http.put(`${baseUrl}/consulting/${id}`, payload).then(r => r.data);
      return { put: true, body: r };
    } catch (e) {
      const putErr = `${e.status}: ${JSON.stringify(e.data).slice(0, 200)}`;

      // Tenta POST para endpoint de inativação específico
      try {
        const r2 = await http.post(`${baseUrl}/consulting/${id}/inactive`).then(r => r.data);
        return { inactive: true, body: r2 };
      } catch (e2) {
        try {
          const r3 = await http.post(`${baseUrl}/consulting/inactive/${id}`).then(r => r.data);
          return { inactive2: true, body: r3 };
        } catch (e3) {
          return {
            putErr,
            inactiveErr: `${e2.status}: ${JSON.stringify(e2.data).slice(0, 100)}`,
            inactive2Err: `${e3.status}: ${JSON.stringify(e3.data).slice(0, 100)}`,
            existingStructure: JSON.stringify(existing).slice(0, 800),
          };
        }
      }
    }
  }, TEST_CONSULTING_ID);
  console.log('Resultado:', JSON.stringify(deleteResult, null, 2).slice(0, 1000));

  // ── PASSO 2: Inspecionar /statistics e /reminders ─────────────────────────────
  console.log('\n=== PASSO 2: Inspecionar /statistics e /reminders ===');
  const statsAndReminders = await page.evaluate(async (userId) => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    const baseUrl = 'https://app.astrea.net.br/api/v2';
    const results = {};

    const tryGet = async (key, path) => {
      try {
        const r = await http.get(`${baseUrl}${path}`).then(r => r.data);
        results[key] = { status: 200, body: r };
      } catch (e) {
        results[key] = { status: e.status, err: JSON.stringify(e.data).slice(0, 200) };
      }
    };

    await tryGet('statistics', '/statistics');
    await tryGet('reminders', '/reminders');
    await tryGet('statisticsUser', `/statistics?userId=${userId}`);
    await tryGet('task_list', `/task?userId=${userId}&limit=10&page=0`);
    await tryGet('workspace_task', `/workspace/tasks?userId=${userId}`);
    await tryGet('task_all', '/task/all');

    return results;
  }, AUTOMATION_USER_ID);

  for (const [k, v] of Object.entries(statsAndReminders)) {
    console.log(`  ${k} → ${v.status || v.err}`);
    if (v.status === 200) {
      console.log(`    ${JSON.stringify(v.body).slice(0, 800)}`);
    }
  }

  // ── PASSO 3: Navegar workspace e capturar TODOS os requests (GET também) ──────
  console.log('\n=== PASSO 3: Workspace - capturar TODOS requests + respostas ===');
  const allRequests = [];

  const onReq = (req) => {
    const url = req.url();
    if (!url.includes('/api/v2')) return;
    const skip = ['alerts', 'session', 'search/token', 'clipping'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.replace('https://app.astrea.net.br', '');
    allRequests.push({ method: req.method(), path: path.split('?')[0], query: path.includes('?') ? path.split('?')[1] : '' });
  };

  page.on('request', onReq);
  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  page.removeListener('request', onReq);

  const uniqueReqs = new Map();
  for (const r of allRequests) {
    const key = `${r.method} ${r.path}`;
    if (!uniqueReqs.has(key)) uniqueReqs.set(key, r.query);
  }
  console.log('Requests workspace (únicos):');
  for (const [key, q] of uniqueReqs) {
    console.log(`  ${key}${q ? '?' + q.slice(0, 100) : ''}`);
  }

  // ── PASSO 4: Inspecionar scope Angular profundo da workspace ──────────────────
  console.log('\n=== PASSO 4: Scope Angular profundo ===');
  const scopeData = await page.evaluate((userId) => {
    const results = {};

    // Tenta achar componente de tarefas por vários seletores
    const selectors = [
      'au-workspace-tasks',
      '[data-component="workspace-tasks"]',
      '.au-workspace-tasks',
      'au-task-list',
      '.task-list',
      '[ng-controller*="task" i]',
      '[ng-controller*="Task"]',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const scope = window.angular?.element(el)?.isolateScope?.() || window.angular?.element(el)?.scope?.();
      if (!scope) continue;
      const ctrl = scope.$ctrl || scope;
      results[sel] = {
        ctrlKeys: Object.keys(ctrl).filter(k => !k.startsWith('$')).slice(0, 20),
      };
      // Tenta achar taskList
      if (ctrl.tasks) results[sel].tasks = JSON.stringify(ctrl.tasks).slice(0, 500);
      if (ctrl.data?.tasks) results[sel].dataTasks = JSON.stringify(ctrl.data.tasks).slice(0, 500);
      if (ctrl.taskList) results[sel].taskList = JSON.stringify(ctrl.taskList).slice(0, 500);
    }

    // Busca geral no scope root
    const rootScope = window.angular?.element(document.body)?.scope?.();
    if (rootScope) {
      results.rootScopeTaskKeys = Object.keys(rootScope).filter(k =>
        k.toLowerCase().includes('task') || k.toLowerCase().includes('tarefa')
      );
    }

    // Procura serviço de tarefas via injector
    const injector = window.angular?.element(document.body)?.injector?.();
    if (injector) {
      const svcNames = ['TaskService', 'taskService', 'WorkspaceTaskService', 'workspaceTaskService',
        'TaskResource', 'taskResource', 'WorkspaceService', 'workspaceService'];
      results.services = {};
      for (const name of svcNames) {
        try {
          const svc = injector.get(name);
          results.services[name] = Object.keys(svc).filter(k => !k.startsWith('$')).slice(0, 15);
        } catch {}
      }
    }

    return results;
  }, AUTOMATION_USER_ID);

  console.log('Scope data:', JSON.stringify(scopeData, null, 2).slice(0, 3000));

  // ── PASSO 5: Tentar criar tarefa via UI e capturar request ───────────────────
  console.log('\n=== PASSO 5: Criar tarefa via UI (monitorar request) ===');
  const taskMutations = [];
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('/api/v2')) return;
    if (!['POST', 'PUT', 'PATCH'].includes(req.method())) return;
    const skip = ['alerts', 'session', 'clipping', 'analytical', 'honorary', 'search/token'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.replace('https://app.astrea.net.br', '').split('?')[0];
    const body = req.postData();
    taskMutations.push({ method: req.method(), path, body: body?.slice(0, 500) });
    console.log(`\n📤 ${req.method()} ${path}`);
    if (body) { try { console.log('   Body:', JSON.stringify(JSON.parse(body), null, 2).slice(0, 400)); } catch { console.log('   Body:', body.slice(0, 300)); } }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/api/v2')) return;
    if (!['POST', 'PUT', 'PATCH'].includes(res.request().method())) return;
    const skip = ['alerts', 'session', 'clipping', 'analytical', 'honorary', 'search/token'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.replace('https://app.astrea.net.br', '').split('?')[0];
    try {
      const body = await res.json();
      console.log(`📥 ${res.status()} ${res.request().method()} ${path}`);
      console.log('   Resp:', JSON.stringify(body, null, 2).slice(0, 600));
    } catch {}
  });

  // Tenta clicar em botão de adicionar tarefa
  try {
    // Aguarda o componente de workspace carregar
    await page.waitForTimeout(2000);

    // Procura pelo botão de adicionar tarefa
    const addBtn = await page.$('button:has-text("Adicionar"), a:has-text("Adicionar"), [title*="tarefa" i], [title*="task" i]');
    if (addBtn) {
      console.log('Botão encontrado, clicando...');
      await addBtn.click();
      await page.waitForTimeout(3000);
    } else {
      // Lista todos os botões visíveis
      const btns = await page.evaluate(() => {
        const all = [...document.querySelectorAll('button, a[href]')];
        return all
          .filter(b => b.offsetParent !== null) // visible
          .map(b => `"${b.textContent?.trim().slice(0, 50)}" | title="${b.title}" | ng-click="${b.getAttribute('ng-click') || ''}"`)
          .filter(t => t.length > 5)
          .slice(0, 30);
      });
      console.log('Botões visíveis:', btns.join('\n'));
    }
  } catch (err) {
    console.log('Erro ao clicar em botão:', err.message.slice(0, 200));
  }

  // ── PASSO 6: Chamar task service via $injector ────────────────────────────────
  console.log('\n=== PASSO 6: Listar tarefas via injector ===');
  const taskViaInjector = await page.evaluate(async (userId) => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    const baseUrl = 'https://app.astrea.net.br/api/v2';
    const results = {};

    // Tenta endpoints que aparecem nos requests da workspace
    const endpoints = [
      { key: 'statistics', method: 'GET', path: '/statistics' },
      { key: 'reminders', method: 'GET', path: '/reminders' },
      { key: 'folder_hasfolder', method: 'GET', path: '/folder/hasfolder' },
      { key: 'widgets_config', method: 'GET', path: `/user-config/${userId}/widgets-config` },
      // Tenta listar tarefas via POST com body
      { key: 'task_query_post', method: 'POST', path: '/task/query', body: { userId, limit: 10, page: 0 } },
      { key: 'task_post', method: 'POST', path: '/task/filter', body: { responsibleIds: [userId], limit: 10 } },
      { key: 'task_search', method: 'POST', path: '/task/search', body: { responsibleId: userId, limit: 10, page: 0 } },
    ];

    for (const ep of endpoints) {
      try {
        let r;
        if (ep.method === 'GET') {
          r = await http.get(`${baseUrl}${ep.path}`).then(r => r.data);
        } else {
          r = await http.post(`${baseUrl}${ep.path}`, ep.body).then(r => r.data);
        }
        results[ep.key] = { status: 200, body: JSON.stringify(r).slice(0, 800) };
      } catch (e) {
        results[ep.key] = { status: e.status, err: JSON.stringify(e.data).slice(0, 200) };
      }
    }
    return results;
  }, AUTOMATION_USER_ID);

  console.log('\nResultados injector:');
  for (const [k, v] of Object.entries(taskViaInjector)) {
    console.log(`  ${k} → ${v.status}`);
    if (v.status === 200) console.log(`    ${v.body.slice(0, 600)}`);
    else if (v.err) console.log(`    ${v.err}`);
  }

  console.log('\n✅ Discovery 8 completo. Mantendo 120s...');
  await page.waitForTimeout(120000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
