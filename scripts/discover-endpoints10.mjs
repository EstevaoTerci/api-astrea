/**
 * Discovery PARTE 10:
 * 1. Deletar consulting via navegação para lista de atendimentos + UI
 * 2. Inspecionar código fonte do task-list store para achar URL de tarefas
 * 3. Testar endpoints de kanban cards
 * 4. Criar tarefa via UI e capturar o request exato
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
const TEST_CONSULTING_ID = 6752082057527296;

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Captura responses relevantes
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/api/v2')) return;
    const skip = ['alerts', 'session/valid', 'clipping', 'analytical', 'search/token',
      'contact/all', 'suggests', 'help-tip', 'widgets-config', 'firstxp-config', 'accreditation',
      'hasfolder', 'user-verify', 'firebase', 'environment/init', 'honoraries/query/summary',
      'ticket', 'feature-toggle', 'teams', 'user-config', 'session/login'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.replace('https://app.astrea.net.br', '').split('?')[0];
    const status = res.status();
    try {
      const body = await res.json();
      const bodyStr = JSON.stringify(body);
      if (bodyStr.length > 5 && bodyStr !== '{}' && bodyStr !== 'null') {
        console.log(`\n📥 ${status} ${res.request().method()} ${path}`);
        console.log(`   ${bodyStr.slice(0, 800)}`);
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

  // ── PASSO 1: Deletar consulting via lista de atendimentos ─────────────────────
  console.log('=== PASSO 1: Deletar consulting de teste ===');

  // Navega para lista de atendimentos
  await page.goto(`${ASTREA_URL}/#/main/consulting`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // Busca pelo consulting com o subject "TESTE AUTOMAÇÃO"
  const testeEls = await page.$$('text=TESTE AUTOMAÇÃO');
  if (testeEls.length > 0) {
    console.log(`Encontrou ${testeEls.length} elemento(s) com "TESTE AUTOMAÇÃO"`);

    // Clica no primeiro para abrir
    await testeEls[0].click();
    await page.waitForTimeout(3000);

    // Procura opção de deletar/inativar no menu de ações
    const actionBtns = await page.$$('button:has-text("Inativar"), button:has-text("Deletar"), button:has-text("Excluir"), button:has-text("Arquivar"), [ng-click*="inativ" i], [ng-click*="delete" i], [ng-click*="remove" i]');
    for (const btn of actionBtns) {
      const visible = await btn.isVisible();
      if (visible) {
        const txt = await btn.textContent();
        console.log(`Clicando: "${txt}"`);
        await btn.click();
        await page.waitForTimeout(2000);
        // Confirma
        const confirm = await page.$('button:has-text("Sim"), button:has-text("Confirmar"), .modal-footer button:last-child');
        if (confirm && await confirm.isVisible()) {
          await confirm.click();
          await page.waitForTimeout(2000);
          console.log('Consulting inativado/deletado!');
        }
        break;
      }
    }
  } else {
    // Tenta via $http com user como objeto dentro do payload
    console.log('Não encontrou elemento "TESTE AUTOMAÇÃO" na lista. Tentando via $http...');
    const deleteResult = await page.evaluate(async (id) => {
      const http = window.angular?.element(document.body)?.injector()?.get('$http');
      const baseUrl = 'https://app.astrea.net.br/api/v2';

      // Tenta com "user" como o objeto "user-session"
      const session = window.angular?.element(document.body)?.injector()?.get('session');
      const sessionUser = session?.user || {};

      let existing;
      try { existing = await http.get(`${baseUrl}/consulting/${id}`).then(r => r.data); } catch (e) { return { getErr: e.status }; }

      // Tenta payloads com "user"
      const attempts = [
        { ...existing, active: false, caseAttached: null, user: sessionUser },
        { ...existing, active: false, caseAttached: null, user: { id: existing.ownerId } },
        { ...existing, active: false, caseAttached: null, user: String(existing.ownerId) },
        // Sem caseAttached mas com user
        {
          id: existing.id,
          active: false,
          subject: existing.subject,
          customers: existing.customers,
          responsibleId: existing.responsibleId,
          ownerId: existing.ownerId,
          tagIds: [],
          messages: [],
          user: String(existing.ownerId),
        },
      ];

      const errs = [];
      for (const [i, payload] of attempts.entries()) {
        try {
          const r = await http.put(`${baseUrl}/consulting/${id}`, payload).then(r => r.data);
          return { success: true, idx: i, body: r };
        } catch (e) {
          errs.push(`[${i}] ${e.status}: ${JSON.stringify(e.data?.errorMessage || e.data).slice(0, 100)}`);
        }
      }
      return { errs, sessionUserKeys: Object.keys(sessionUser) };
    }, TEST_CONSULTING_ID);
    console.log('Delete result:', JSON.stringify(deleteResult, null, 2).slice(0, 500));
  }

  // ── PASSO 2: Inspecionar código do task-list store ────────────────────────────
  console.log('\n=== PASSO 2: Inspecionar task-list store source ===');
  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  const storeSource = await page.evaluate(() => {
    const el = document.querySelector('.task-list');
    if (!el) return { error: '.task-list not found' };

    const scope = window.angular?.element(el)?.isolateScope?.() || window.angular?.element(el)?.scope?.();
    const ctrl = scope?.$ctrl;
    const store = ctrl?.store;
    if (!store) return { error: 'no store' };

    const results = {
      constructorName: store.constructor?.name,
      storeKeys: Object.keys(store).filter(k => !k.startsWith('$')),
      protoMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(store) || {}).filter(k => k !== 'constructor'),
    };

    // Tenta extrair o código fonte para encontrar URLs
    const constructorStr = store.constructor?.toString?.() || '';
    results.sourceSnippet = constructorStr.slice(0, 3000);

    // Procura por "task" no source
    const taskIdx = constructorStr.toLowerCase().indexOf('task');
    if (taskIdx > 0) {
      results.taskContext = constructorStr.slice(Math.max(0, taskIdx - 100), taskIdx + 200);
    }

    // Inspeciona cada propriedade para encontrar refs ao $http
    for (const key of Object.keys(store)) {
      const val = store[key];
      if (val && typeof val === 'object' && val.constructor?.name?.includes('Http')) {
        results.httpServiceKey = key;
      }
      if (typeof val === 'function') {
        results[`fn_${key}`] = val.toString().slice(0, 200);
      }
    }

    // Tenta o $state atual
    const $state = window.angular?.element(document.body)?.injector?.()?.get('$state');
    results.currentState = $state?.current?.name;

    // Verifica se há dados já carregados
    if (ctrl.data?.taskList) {
      results.taskListKeys = Object.keys(ctrl.data.taskList);
      const active = ctrl.data.taskList.activeTasks || [];
      results.taskCount = active.length;
      results.taskSample = active.slice(0, 2);
    }

    return results;
  });

  console.log('Store source:', JSON.stringify(storeSource, null, 2).slice(0, 4000));

  // ── PASSO 3: Testar endpoints de kanban ──────────────────────────────────────
  console.log('\n=== PASSO 3: Testar endpoints de kanban/task ===');
  const kanbanTests = await page.evaluate(async (userId) => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    const baseUrl = 'https://app.astrea.net.br/api/v2';
    const results = {};

    const tryReq = async (key, method, path, body) => {
      try {
        let r;
        if (method === 'GET') r = await http.get(`${baseUrl}${path}`).then(r => r.data);
        else r = await http.post(`${baseUrl}${path}`, body).then(r => r.data);
        results[key] = { status: 200, body: JSON.stringify(r).slice(0, 600) };
      } catch (e) {
        results[key] = { status: e.status, err: JSON.stringify(e.data).slice(0, 200) };
      }
    };

    // Lista kanbans
    await tryReq('kanbans_list', 'GET', '/kanbans');

    // Tenta buscar tarefas via kanban endpoints
    await tryReq('kanban_tasks', 'POST', '/kanban/task/query', { userId, limit: 10, page: 0 });
    await tryReq('kanban_items', 'POST', '/kanban/item/query', { userId, limit: 10 });
    await tryReq('kanban_cards', 'GET', `/kanban/cards?userId=${userId}&limit=10`);

    // Tenta task via $resource pattern
    await tryReq('task_by_user', 'GET', `/task/user/${userId}?limit=10`);
    await tryReq('task_responsible', 'GET', `/task?responsibleId=${userId}&limit=10&status=PENDING`);
    await tryReq('task_workspace', 'POST', '/task/workspace', { userId, limit: 10 });
    await tryReq('task_active', 'GET', `/task/active?userId=${userId}`);

    // Tenta com timestamp de hoje
    const today = new Date().toISOString().split('T')[0];
    await tryReq('task_today', 'GET', `/task?userId=${userId}&date=${today}&limit=20`);

    // Tenta formato alternativo
    await tryReq('tasks_v2', 'POST', '/tasks', { userId, page: 0, limit: 10 });

    return results;
  }, AUTOMATION_USER_ID);

  console.log('\nResultados kanban/task:');
  for (const [k, v] of Object.entries(kanbanTests)) {
    const icon = v.status === 200 ? '✅' : '❌';
    console.log(`  ${icon} ${k} → ${v.status || v.err}`);
    if (v.status === 200) console.log(`    ${v.body.slice(0, 400)}`);
  }

  // ── PASSO 4: Criar tarefa via UI e capturar request ──────────────────────────
  console.log('\n=== PASSO 4: Criar tarefa via UI ===');

  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('/api/v2')) return;
    if (!['POST', 'PUT', 'PATCH'].includes(req.method())) return;
    const skip = ['alerts', 'session', 'clipping', 'analytical', 'honorary', 'search/token', 'contact/all', 'suggests'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.replace('https://app.astrea.net.br', '');
    console.log(`\n📤 ${req.method()} ${path}`);
    const pd = req.postData();
    if (pd) { try { console.log('   Body:', JSON.stringify(JSON.parse(pd), null, 2).slice(0, 600)); } catch { console.log('   Body:', pd.slice(0, 300)); } }
  });

  // Tenta clicar em "Adicionar primeira tarefa" - só se o botão existir
  try {
    const addTaskBtnAll = await page.$$('text=Adicionar primeira tarefa');
    console.log(`Botões "Adicionar primeira tarefa" encontrados: ${addTaskBtnAll.length}`);

    for (const btn of addTaskBtnAll) {
      const visible = await btn.isVisible().catch(() => false);
      console.log(`  Visível: ${visible}`);
      if (visible) {
        await btn.click({ timeout: 5000 });
        await page.waitForTimeout(3000);

        // Procura form de criação de tarefa
        const form = await page.evaluate(() => {
          const inputs = [...document.querySelectorAll('input:not([type="hidden"]), textarea')];
          return inputs
            .filter(i => i.offsetParent)
            .map(i => `<${i.tagName.toLowerCase()} type="${i.type}" placeholder="${i.placeholder}" ng-model="${i.getAttribute('ng-model') || ''}" />`);
        });
        console.log('Form inputs:', form.join('\n'));

        // Preenche título se achar input
        const titleInput = await page.$('input[placeholder*="tarefa" i], input[placeholder*="título" i], input[ng-model*="title" i], input[ng-model*="titulo" i]');
        if (titleInput) {
          await titleInput.fill('TESTE AUTOMAÇÃO - PODE DELETAR');
          await page.waitForTimeout(500);

          const submitBtn = await page.$('button[type="submit"], button:has-text("Salvar"), button:has-text("Criar"), button:has-text("Confirmar"), button:has-text("Adicionar")');
          if (submitBtn && await submitBtn.isVisible()) {
            console.log('Submetendo...');
            await submitBtn.click();
            await page.waitForTimeout(3000);
          }
        }
        break;
      }
    }
  } catch (err) {
    console.log('Erro ao criar tarefa via UI:', err.message.slice(0, 200));
  }

  // Aguarda requests
  await page.waitForTimeout(3000);

  console.log('\n✅ Discovery 10 completo. Mantendo 120s...');
  await page.waitForTimeout(120000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
