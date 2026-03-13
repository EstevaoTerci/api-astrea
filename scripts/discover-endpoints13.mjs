/**
 * Discovery PARTE 13 - FOCO FINAL:
 * 1. Criar tarefa via clique em "Adicionar primeira tarefa" (workspace)
 * 2. Criar tarefa em caso específico do ESTEVAO e capturar request
 * 3. Verificar window.astreaApi e taskListService.astreaApi
 * 4. Confirmar endpoint de criação de tarefa
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

  // Captura requests/responses relevantes
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('/api/v2') && !url.includes('firebaseio.com')) return;
    const skip = ['alerts', 'session/valid', 'clipping', 'search/token', 'help-tip',
      'widgets-config', 'firstxp-config', 'accreditation', 'hasfolder', 'user-verify',
      'firebase', 'environment', 'honoraries', 'ticket', 'feature-toggle', 'teams',
      'user-config', 'session/login', 'contact/all', 'kanbans', 'suggests', 'google',
      'timesheet', 'migration', 'statistics', 'reminders', 'tags', 'contact/notification',
      'contact/query'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.replace('https://app.astrea.net.br', '');
    console.log(`\n📤 ${req.method()} ${path}`);
    const pd = req.postData();
    if (pd) { try { console.log('   >', JSON.stringify(JSON.parse(pd), null, 2).slice(0, 500)); } catch { console.log('   >', pd.slice(0, 300)); } }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/api/v2') && !url.includes('firebaseio.com')) return;
    const skip = ['alerts', 'session/valid', 'clipping', 'search/token', 'help-tip',
      'widgets-config', 'firstxp-config', 'accreditation', 'hasfolder', 'user-verify',
      'firebase', 'environment', 'honoraries', 'ticket', 'feature-toggle', 'teams',
      'user-config', 'session/login', 'contact/all', 'kanbans', 'suggests', 'google',
      'timesheet', 'migration', 'statistics', 'reminders', 'tags', 'contact/notification',
      'contact/query'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.replace('https://app.astrea.net.br', '').split('?')[0];
    const status = res.status();
    try {
      const body = await res.json();
      const bodyStr = JSON.stringify(body);
      if (bodyStr.length > 5) {
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

  // ── PASSO 1: Verificar window.astreaApi ───────────────────────────────────────
  console.log('=== PASSO 1: Verificar window.astreaApi ===');
  await page.goto(`${ASTREA_URL}/#/main/contacts`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const windowApi = await page.evaluate(() => {
    // Verifica se existe astreaApi no window
    if (window.astreaApi) {
      return {
        exists: true,
        keys: Object.keys(window.astreaApi).filter(k => !k.startsWith('$')),
        proto: Object.getOwnPropertyNames(Object.getPrototypeOf(window.astreaApi) || {}).filter(k => k !== 'constructor'),
        source: window.astreaApi.constructor?.toString?.().slice(0, 1000),
      };
    }

    // Procura por módulo angular que possa ter astreaApi
    const injector = window.angular?.element(document.body)?.injector?.();
    if (!injector) return { noInjector: true };

    // Tenta nomes comuns de serviços HTTP
    const candidates = ['astreaApi', 'AstreaApi', 'httpService', 'apiService', 'AstreaHttpService',
      'astreaHttpService', 'baseApi', 'restApi'];
    const found = {};
    for (const name of candidates) {
      try {
        const svc = injector.get(name);
        if (svc) {
          found[name] = {
            keys: Object.keys(svc).filter(k => !k.startsWith('$')).slice(0, 20),
            proto: Object.getOwnPropertyNames(Object.getPrototypeOf(svc) || {}).filter(k => k !== 'constructor').slice(0, 20),
          };
        }
      } catch {}
    }

    // TaskListService - tenta com parâmetro correto
    try {
      const tls = injector.get('taskListService');
      const api = tls?.astreaApi;
      return {
        windowAstreaApiExists: !!window.astreaApi,
        taskListServiceFound: !!tls,
        astreaApiType: typeof api,
        astreaApiConstructorName: api?.constructor?.name,
        isWindowObj: api === window,
        apiOwnKeys: api ? Object.getOwnPropertyNames(api).slice(0, 20) : [],
        found,
      };
    } catch (e) {
      return { err: e.message, found };
    }
  });
  console.log('Window API:', JSON.stringify(windowApi, null, 2).slice(0, 1000));

  // ── PASSO 2: Navegar para workspace e clicar "Adicionar primeira tarefa" ──────
  console.log('\n=== PASSO 2: Criar tarefa via UI ===');
  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  // Localiza o botão especificamente dentro de .task-list
  const clicked = await page.evaluate(async () => {
    // Procura dentro do componente .task-list
    const taskListEl = document.querySelector('.task-list, .au-task-list, [class*="workspace-task"]');
    if (!taskListEl) return { error: 'task-list not found' };

    // Procura botões dentro
    const btns = taskListEl.querySelectorAll('button, a[ng-click], [class*="btn"]');
    const btnInfo = [...btns].map(b => ({
      text: b.textContent?.trim().slice(0, 50),
      visible: !!b.offsetParent,
      ngClick: b.getAttribute('ng-click') || '',
      type: b.type || '',
      cls: b.className?.toString?.().slice(0, 60),
    }));
    return { taskListFound: true, buttons: btnInfo };
  });
  console.log('Task-list buttons:', JSON.stringify(clicked, null, 2).slice(0, 1000));

  // Tenta clicar via JavaScript (force click)
  try {
    await page.evaluate(() => {
      const taskListEl = document.querySelector('.task-list');
      if (!taskListEl) return;
      const btns = [...taskListEl.querySelectorAll('button')];
      const addBtn = btns.find(b => b.textContent?.includes('Adicionar') || b.textContent?.includes('tarefa'));
      if (addBtn) {
        addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    });
    await page.waitForTimeout(3000);

    // Captura modal/form aberto
    const modal = await page.evaluate(() => {
      const modals = [...document.querySelectorAll('.modal-content, [class*="overlay"]:not([hidden]), [class*="popup"], [class*="drawer"], [class*="panel"]')];
      const visible = modals.filter(m => m.offsetParent !== null);
      return visible.map(m => ({
        cls: m.className?.toString?.().slice(0, 80),
        html: m.innerHTML.slice(0, 1000),
      }));
    });
    if (modal.length > 0) {
      console.log('Modal aberto!', JSON.stringify(modal, null, 2).slice(0, 2000));
    } else {
      console.log('Nenhum modal detectado após click.');
    }
  } catch (err) {
    console.log('Erro ao clicar:', err.message.slice(0, 200));
  }

  // ── PASSO 3: Criar tarefa em caso específico do ESTEVAO ───────────────────────
  console.log('\n=== PASSO 3: Criar tarefa em caso do ESTEVAO ===');

  // Busca folders do ESTEVAO
  const estevaoFolders = await page.evaluate(async (contactId) => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    const baseUrl = 'https://app.astrea.net.br/api/v2';
    try {
      const r = await http.post(`${baseUrl}/folder/query`, {
        text: '',
        customersIds: [contactId],
        page: 0,
        limit: 3,
        order: 'lastUpdateDate',
        status: 'ACTIVE',
      }).then(r => r.data);
      return r;
    } catch (e) {
      // Tenta endpoint alternativo
      try {
        const r2 = await http.get(`${baseUrl}/folder?customerId=${contactId}&limit=3`).then(r => r.data);
        return r2;
      } catch (e2) {
        return { err: `${e.status}: ${JSON.stringify(e.data).slice(0, 100)}` };
      }
    }
  }, ESTEVAO_CLIENT_CONTACT_ID);

  console.log('ESTEVAO folders:', JSON.stringify(estevaoFolders, null, 2).slice(0, 1000));

  // Navega para o folder do ESTEVAO e captura requests de tarefa
  if (estevaoFolders?.folders?.[0]?.id || estevaoFolders?.[0]?.id) {
    const folderId = estevaoFolders?.folders?.[0]?.id || estevaoFolders?.[0]?.id;
    console.log(`\nNavegando para pasta/processo ${folderId}...`);
    await page.goto(`${ASTREA_URL}/#/main/folders/${folderId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);

    // Tenta clicar em "Adicionar tarefa" na página do caso
    const caseTaskBtns = await page.evaluate(() => {
      return [...document.querySelectorAll('button, a')]
        .filter(b => b.offsetParent)
        .filter(b => b.textContent?.toLowerCase().includes('tarefa') || b.textContent?.toLowerCase().includes('task'))
        .map(b => ({
          text: b.textContent?.trim().slice(0, 50),
          ngClick: b.getAttribute('ng-click') || '',
          cls: b.className?.toString?.().slice(0, 60),
        }));
    });
    console.log('Task buttons no caso:', JSON.stringify(caseTaskBtns, null, 2));

    // Cria tarefa diretamente via $http com caseId/folderId
    const createTaskInCase = await page.evaluate(async ({ folderId, userId, contactId }) => {
      const http = window.angular?.element(document.body)?.injector()?.get('$http');
      const baseUrl = 'https://app.astrea.net.br/api/v2';
      const results = {};

      // Pega tasks existentes do caso
      try {
        const existing = await http.get(`${baseUrl}/tasks/case/${folderId}/user/${userId}`).then(r => r.data);
        results.existingTasks = existing;
      } catch (e) {
        results.existingTasksErr = e.status;
      }

      // Tenta criar tarefa no caso
      const payloads = [
        { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', responsibleId: userId, caseId: folderId },
        { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', responsibleId: userId, folderId },
        { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', responsibleId: userId, caseId: folderId, dueDate: '2026-03-20' },
        { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', responsibleId: userId, case: { id: folderId } },
      ];

      for (const [i, payload] of payloads.entries()) {
        try {
          const r = await http.post(`${baseUrl}/tasks`, payload).then(r => r.data);
          results[`create_${i}`] = { success: true, data: JSON.stringify(r).slice(0, 400) };
          // Deleta se criou
          if (r?.id) {
            try { await http.delete(`${baseUrl}/tasks/${r.id}/user/${userId}`).then(r => r.data); } catch {}
          }
          break; // Para no primeiro sucesso
        } catch (e) {
          results[`create_${i}`] = { status: e.status, err: JSON.stringify(e.data).slice(0, 150) };
        }
      }

      return results;
    }, { folderId, userId: AUTOMATION_USER_ID, contactId: ESTEVAO_CLIENT_CONTACT_ID });

    console.log('\nCreate task in case:', JSON.stringify(createTaskInCase, null, 2).slice(0, 2000));
  }

  console.log('\n✅ Discovery 13 completo. Mantendo 120s...');
  await page.waitForTimeout(120000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
