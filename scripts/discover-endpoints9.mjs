/**
 * Discovery PARTE 9:
 * 1. Deletar consulting de teste via navegação UI
 * 2. Inspecionar task-list store para descobrir URL de tarefas
 * 3. Navegar para caso/processo do ESTEVAO e capturar requests de tarefas
 * 4. Adicionar response listener para /task endpoints
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

  // Captura TODAS as responses de /api/v2
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/api/v2')) return;
    const skip = ['alerts', 'session/valid', 'clipping', 'analytical', 'honorary', 'search/token',
      'contact/all', 'suggests', 'help-tip', 'widgets-config', 'firstxp-config', 'accreditation',
      'hasfolder', 'user-verify'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.replace('https://app.astrea.net.br', '').split('?')[0];
    const status = res.status();
    try {
      const body = await res.json();
      const bodyStr = JSON.stringify(body);
      // Só loga se relevante
      if (bodyStr.length > 5 && bodyStr !== '{}' && bodyStr !== 'null') {
        console.log(`📥 ${status} ${res.request().method()} ${path}`);
        console.log(`   ${bodyStr.slice(0, 600)}`);
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

  // ── PASSO 1: Deletar consulting via UI ────────────────────────────────────────
  console.log('=== PASSO 1: Deletar consulting via UI ===');

  // Primeiro tenta via $http com userId no payload
  const deleteAttempt = await page.evaluate(async (id) => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    const baseUrl = 'https://app.astrea.net.br/api/v2';

    // GET para ver estrutura
    let existing;
    try {
      existing = await http.get(`${baseUrl}/consulting/${id}`).then(r => r.data);
    } catch (e) {
      return { getErr: `${e.status}: ${JSON.stringify(e.data).slice(0, 200)}` };
    }

    // Tenta PUT com userId (e não ownerId)
    const payloads = [
      { ...existing, active: false, caseAttached: null, userId: existing.ownerId },
      { ...existing, active: false, caseAttached: null, user: { id: existing.ownerId } },
      {
        id: existing.id,
        active: false,
        subject: existing.subject,
        customers: existing.customers,
        responsibleId: existing.responsibleId,
        ownerId: existing.ownerId,
        tagIds: [],
        messages: [],
        caseAttached: null,
        userId: existing.ownerId,
      },
    ];

    const errs = [];
    for (const [i, payload] of payloads.entries()) {
      try {
        const r = await http.put(`${baseUrl}/consulting/${id}`, payload).then(r => r.data);
        return { success: true, payloadIndex: i, body: r };
      } catch (e) {
        errs.push(`[${i}] ${e.status}: ${JSON.stringify(e.data?.errorMessage || e.data).slice(0, 100)}`);
      }
    }
    return { errs, existing: JSON.stringify(existing).slice(0, 500) };
  }, TEST_CONSULTING_ID);

  console.log('Delete attempt:', JSON.stringify(deleteAttempt, null, 2).slice(0, 800));

  if (!deleteAttempt.success) {
    // Navega para o atendimento e tenta deletar pela UI
    console.log('\nTentando deletar via UI...');
    await page.goto(`${ASTREA_URL}/#/main/consulting/${TEST_CONSULTING_ID}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Procura botão de deletar/remover/inativar
    const deleteBtn = await page.$('button:has-text("Deletar"), button:has-text("Remover"), button:has-text("Excluir"), button:has-text("Inativar"), [title*="deletar" i], [title*="excluir" i], [ng-click*="delete" i], [ng-click*="remove" i], [ng-click*="inativ" i]');
    if (deleteBtn) {
      const btnText = await deleteBtn.textContent();
      console.log(`Clicando: "${btnText}"`);
      await deleteBtn.click();
      await page.waitForTimeout(2000);

      // Confirma modal se aparecer
      const confirmBtn = await page.$('button:has-text("Confirmar"), button:has-text("Sim"), button:has-text("OK"), .modal button:has-text("Deletar")');
      if (confirmBtn) {
        await confirmBtn.click();
        await page.waitForTimeout(2000);
        console.log('Confirmado!');
      }
    } else {
      // Lista botões na página do consulting
      const pageContent = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button, a[ng-click], [class*="btn"]')];
        return btns
          .filter(b => b.offsetParent)
          .map(b => `"${b.textContent?.trim().slice(0, 40)}" ng-click="${b.getAttribute('ng-click') || ''}" title="${b.title}"`)
          .slice(0, 30);
      });
      console.log('Botões na página do consulting:\n', pageContent.join('\n'));

      // Tenta clicar nos 3 pontos / menu de ações
      const menuBtn = await page.$('[class*="menu"], [class*="action"], [class*="more"], [class*="ellipsis"], button:has-text("...")');
      if (menuBtn) {
        await menuBtn.click();
        await page.waitForTimeout(1000);
        const afterMenu = await page.evaluate(() =>
          [...document.querySelectorAll('button, a, li[role="menuitem"]')]
            .filter(b => b.offsetParent)
            .map(b => `"${b.textContent?.trim().slice(0, 40)}"`)
            .slice(0, 20)
        );
        console.log('Menu itens:', afterMenu.join(', '));
      }
    }
  }

  // ── PASSO 2: Inspecionar task-list store ─────────────────────────────────────
  console.log('\n=== PASSO 2: Workspace - inspecionar task-list store ===');
  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  const storeInspection = await page.evaluate((userId) => {
    const el = document.querySelector('.task-list');
    if (!el) return { error: '.task-list not found' };

    const scope = window.angular?.element(el)?.isolateScope?.() || window.angular?.element(el)?.scope?.();
    if (!scope) return { error: 'no scope' };

    const ctrl = scope.$ctrl;
    if (!ctrl) return { error: 'no $ctrl', scopeKeys: Object.keys(scope).filter(k => !k.startsWith('$')) };

    const store = ctrl.store;
    if (!store) return { error: 'no store', ctrlKeys: Object.keys(ctrl).filter(k => !k.startsWith('$')) };

    // Inspeciona o store
    const storeInfo = {
      keys: Object.keys(store).filter(k => !k.startsWith('$')),
      prototype: Object.getOwnPropertyNames(Object.getPrototypeOf(store) || {}).filter(k => !k.startsWith('_')),
    };

    // Tenta achar a URL hardcoded no store
    const storeStr = store.constructor?.toString?.()?.slice(0, 2000) || '';

    // data já carregado?
    const data = ctrl.data;
    const dataKeys = data ? Object.keys(data).filter(k => !k.startsWith('$')) : [];

    // taskList já tem dados?
    let taskSample = null;
    if (data?.taskList) {
      const tl = data.taskList;
      taskSample = {
        taskListKeys: Object.keys(tl),
        activeCount: tl.activeTasks?.length,
        sample: tl.activeTasks?.slice(0, 2),
      };
    }

    // Tenta chamar o store para buscar as tarefas
    let fetchResult = null;
    if (typeof store.fetchTasks === 'function') {
      fetchResult = 'store.fetchTasks exists';
    } else if (typeof store.load === 'function') {
      fetchResult = 'store.load exists';
    } else if (typeof store.getTasks === 'function') {
      fetchResult = 'store.getTasks exists';
    } else if (typeof store.getAll === 'function') {
      fetchResult = 'store.getAll exists';
    }

    return { storeInfo, dataKeys, taskSample, fetchResult };
  }, AUTOMATION_USER_ID);

  console.log('Store inspection:', JSON.stringify(storeInspection, null, 2).slice(0, 2000));

  // ── PASSO 3: Chamar store methods para disparar request de tarefas ───────────
  console.log('\n=== PASSO 3: Chamar store para forçar load de tarefas ===');

  // Adiciona listener específico para /task
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('task') && !url.includes('Task')) return;
    console.log(`📤 TASK REQ: ${req.method()} ${url.replace('https://app.astrea.net.br', '')}`);
    const pd = req.postData();
    if (pd) console.log('   Body:', pd.slice(0, 400));
  });

  const storeCallResult = await page.evaluate(async (userId) => {
    const el = document.querySelector('.task-list');
    if (!el) return { error: '.task-list not found' };

    const scope = window.angular?.element(el)?.isolateScope?.() || window.angular?.element(el)?.scope?.();
    const ctrl = scope?.$ctrl;
    const store = ctrl?.store;
    if (!store) return { error: 'no store' };

    const results = {};

    // Tenta todos os métodos do store
    for (const key of Object.keys(store)) {
      if (typeof store[key] === 'function') {
        try {
          const r = await store[key](userId);
          results[key] = { called: true, result: JSON.stringify(r).slice(0, 200) };
        } catch (e) {
          results[key] = { err: e.message?.slice(0, 100) };
        }
      }
    }

    // Também tenta os métodos do prototype
    for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(store) || {})) {
      if (key === 'constructor' || key.startsWith('_')) continue;
      if (typeof store[key] === 'function') {
        try {
          const r = await store[key](userId);
          results[`proto.${key}`] = { called: true, result: JSON.stringify(r).slice(0, 200) };
        } catch (e) {
          results[`proto.${key}`] = { err: e.message?.slice(0, 100) };
        }
      }
    }

    // Tenta ctrl methods que parecem ser de carregamento
    if (ctrl.selectList) {
      try {
        ctrl.selectList(); // pode disparar carga de tarefas
        results['ctrl.selectList'] = { called: true };
      } catch (e) {
        results['ctrl.selectList'] = { err: e.message };
      }
    }

    // Verifica o data após chamadas
    await new Promise(resolve => setTimeout(resolve, 2000));
    const data = ctrl.data;
    if (data?.taskList?.activeTasks?.length) {
      results._tasks = data.taskList.activeTasks.slice(0, 2);
    }

    return results;
  }, AUTOMATION_USER_ID);

  console.log('Store call results:', JSON.stringify(storeCallResult, null, 2).slice(0, 3000));
  await page.waitForTimeout(3000);

  // ── PASSO 4: Navegar para caso do ESTEVAO e capturar requests ────────────────
  console.log('\n=== PASSO 4: Navegar para processo do ESTEVAO ===');
  // Busca casos do estevao
  const estevaoCase = await page.evaluate(async (contactId) => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    const baseUrl = 'https://app.astrea.net.br/api/v2';
    try {
      // Pega os casos do ESTEVAO
      const r = await http.get(`${baseUrl}/contact/${contactId}/details`).then(r => r.data);
      // Retorna IDs de pastas/processos
      const folderIds = (r.folders || r.cases || r.processes || []).slice(0, 3).map(f => f.id || f.folderId);
      return { folderIds, keys: Object.keys(r) };
    } catch (e) {
      return { err: `${e.status}: ${JSON.stringify(e.data).slice(0, 200)}` };
    }
  }, ESTEVAO_CLIENT_CONTACT_ID);

  console.log('ESTEVAO cases:', JSON.stringify(estevaoCase, null, 2));

  // Se achou pasta/processo, navega para ele
  if (estevaoCase.folderIds?.length) {
    const folderId = estevaoCase.folderIds[0];
    console.log(`\nNavegando para processo ${folderId}...`);
    await page.goto(`${ASTREA_URL}/#/main/folders/${folderId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);

    // Lista requests feitos
    // (já capturados pelo listener de response global)

    // Inspeciona scope do caso
    const caseScope = await page.evaluate((userId) => {
      const taskEls = document.querySelectorAll('.task, [class*="task"], au-task, au-tasks, [ng-controller*="task" i]');
      const elInfo = [...taskEls].slice(0, 5).map(el => ({
        tag: el.tagName,
        cls: el.className?.toString?.().slice(0, 80),
        ngCtrl: el.getAttribute('ng-controller'),
      }));

      // Tenta buscar tarefas do caso via $http
      return { taskElements: elInfo };
    }, AUTOMATION_USER_ID);

    console.log('Case task elements:', JSON.stringify(caseScope, null, 2));
  }

  console.log('\n✅ Discovery 9 completo. Mantendo 120s...');
  await page.waitForTimeout(120000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
