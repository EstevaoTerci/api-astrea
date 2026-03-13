/**
 * Discovery PARTE 11 - FOCO:
 * 1. Ler código fonte do task-list store para encontrar URL
 * 2. Ler tarefas já carregadas no scope da workspace
 * 3. Criar tarefa via UI clicando "Adicionar primeira tarefa"
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

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Captura TODAS as requests /api/v2 (incluindo GET) quando na workspace
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('/api/v2')) return;
    const skip = ['alerts', 'session/valid', 'clipping', 'analytical', 'search/token',
      'help-tip', 'widgets-config', 'firstxp-config', 'accreditation', 'hasfolder',
      'user-verify', 'firebase', 'environment', 'honoraries', 'ticket', 'feature-toggle',
      'teams', 'user-config', 'session/login'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.replace('https://app.astrea.net.br', '');
    console.log(`📤 ${req.method()} ${path}`);
    const pd = req.postData();
    if (pd) { try { console.log('   >', JSON.stringify(JSON.parse(pd), null, 2).slice(0, 400)); } catch { console.log('   >', pd.slice(0, 200)); } }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/api/v2')) return;
    const skip = ['alerts', 'session/valid', 'clipping', 'analytical', 'search/token',
      'help-tip', 'widgets-config', 'firstxp-config', 'accreditation', 'hasfolder',
      'user-verify', 'firebase', 'environment', 'honoraries', 'ticket', 'feature-toggle',
      'teams', 'user-config', 'session/login'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.replace('https://app.astrea.net.br', '').split('?')[0];
    const status = res.status();
    try {
      const body = await res.json();
      const bodyStr = JSON.stringify(body);
      if (bodyStr.length > 5) {
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

  // ── Carrega workspace e espera MAIS (componentes lazy) ────────────────────────
  console.log('=== Carregando workspace ===');
  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(10000); // espera mais para lazy loading

  // ── PASSO 1: Ler store source e dados carregados ──────────────────────────────
  console.log('\n=== PASSO 1: Task-list store source ===');
  const result1 = await page.evaluate(() => {
    const el = document.querySelector('.task-list');
    if (!el) {
      // Tenta encontrar o componente por outros meios
      const all = document.querySelectorAll('[class*="task"]');
      return {
        error: '.task-list not found',
        taskClassEls: [...all].map(e => ({ tag: e.tagName, cls: e.className?.toString?.().slice(0, 80) })).slice(0, 10),
      };
    }

    const scope = window.angular?.element(el)?.isolateScope?.() || window.angular?.element(el)?.scope?.();
    const ctrl = scope?.$ctrl;
    if (!ctrl) return { error: 'no ctrl', scopeKeys: scope ? Object.keys(scope).filter(k => !k.startsWith('$')) : [] };

    const store = ctrl.store;

    // Dados já carregados
    let loadedData = null;
    if (ctrl.data) {
      const d = ctrl.data;
      loadedData = {
        keys: Object.keys(d),
        taskList: d.taskList ? {
          keys: Object.keys(d.taskList),
          activeTasks: d.taskList.activeTasks?.length,
          inactiveTasks: d.taskList.inactiveTasks?.length,
          sample: d.taskList.activeTasks?.slice(0, 3),
        } : null,
      };
    }

    let storeInfo = null;
    if (store) {
      // Extrai código fonte - procura por URLs com "task"
      const src = store.constructor?.toString?.() || '';
      const lines = src.split('\n');
      const taskLines = lines.filter(l => l.includes('task') || l.includes('Task') || l.includes('/api'));
      storeInfo = {
        name: store.constructor?.name,
        keys: Object.keys(store).filter(k => !k.startsWith('$')),
        proto: Object.getOwnPropertyNames(Object.getPrototypeOf(store) || {}).filter(k => k !== 'constructor'),
        taskRelatedCode: taskLines.slice(0, 20).join('\n'),
        fullSource: src.slice(0, 5000),
      };
    }

    // Tenta ler o $q e $http do ctrl
    const injector = window.angular?.element(document.body)?.injector?.();
    let taskServiceFound = null;
    if (injector) {
      // Tenta serviços com "task" no nome
      const candidates = ['TaskService', 'TaskListService', 'WorkspaceTaskService',
        'TaskRepository', 'TaskApi', 'taskService', 'taskListService'];
      for (const name of candidates) {
        try {
          const svc = injector.get(name);
          if (svc) {
            taskServiceFound = {
              name,
              keys: Object.keys(svc).filter(k => !k.startsWith('$')),
              proto: Object.getOwnPropertyNames(Object.getPrototypeOf(svc) || {}).filter(k => k !== 'constructor'),
              source: svc.constructor?.toString?.().slice(0, 2000),
            };
            break;
          }
        } catch {}
      }
    }

    return { loadedData, storeInfo, taskServiceFound };
  });

  console.log(JSON.stringify(result1, null, 2).slice(0, 6000));

  // ── PASSO 2: Forçar carregamento clicando no cabeçalho da lista de tarefas ───
  console.log('\n=== PASSO 2: Expandir lista de tarefas ===');
  // Tenta clicar em "Tarefas" ou no header da seção
  const taskHeaders = await page.$$('h2:has-text("Tarefa"), h3:has-text("Tarefa"), [class*="header"]:has-text("Tarefa"), button:has-text("Tarefa")');
  console.log(`Headers de tarefa encontrados: ${taskHeaders.length}`);

  // Também tenta scrollar para o componente .task-list
  await page.evaluate(() => {
    const el = document.querySelector('.task-list');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
      // Dispara eventos de visibilidade
      el.dispatchEvent(new Event('scroll'));
      const event = new IntersectionObserver(entries => {});
    }
  });
  await page.waitForTimeout(3000);

  // Relê os dados após tentar carregar
  const result2 = await page.evaluate(() => {
    const el = document.querySelector('.task-list');
    const scope = window.angular?.element(el)?.isolateScope?.() || window.angular?.element(el)?.scope?.();
    const ctrl = scope?.$ctrl;
    if (!ctrl?.data?.taskList) return { noData: true };

    const tl = ctrl.data.taskList;
    return {
      keys: Object.keys(tl),
      activeTasks: tl.activeTasks?.length,
      sample: tl.activeTasks?.slice(0, 3),
    };
  });
  console.log('TaskList após scroll:', JSON.stringify(result2, null, 2));

  // ── PASSO 3: Criar tarefa via UI ─────────────────────────────────────────────
  console.log('\n=== PASSO 3: Criar tarefa via UI ===');
  try {
    // Procura por botão visível de adicionar tarefa
    const allBtns = await page.evaluate(() => {
      return [...document.querySelectorAll('button')]
        .filter(b => b.offsetParent !== null)
        .map(b => b.textContent?.trim().slice(0, 60))
        .filter(Boolean)
        .filter(t => t.toLowerCase().includes('tarefa') || t.toLowerCase().includes('adicionar') || t.toLowerCase().includes('criar'));
    });
    console.log('Botões de tarefa visíveis:', allBtns);

    // Clica na seção de tarefas (header para expandir se colapsado)
    const collapsedTask = await page.$('.task-list .collapsible-header, .task-list [ng-click*="toggle" i]');
    if (collapsedTask) {
      console.log('Clicando para expandir seção de tarefas...');
      await collapsedTask.click({ force: true });
      await page.waitForTimeout(2000);
    }

    // Tenta "Adicionar primeira tarefa" — pode estar dentro do componente
    const taskListEl = await page.$('.task-list');
    if (taskListEl) {
      const innerBtns = await taskListEl.$$('button');
      for (const btn of innerBtns) {
        const txt = await btn.textContent();
        const isVisible = await btn.isVisible();
        console.log(`  Botão no .task-list: "${txt?.trim().slice(0, 50)}" | visível: ${isVisible}`);
      }

      // Clica no primeiro botão visível que parece ser de adicionar
      for (const btn of innerBtns) {
        const txt = await btn.textContent();
        const isVisible = await btn.isVisible();
        if (isVisible && (txt?.includes('tarefa') || txt?.includes('Adicionar') || txt?.includes('Nova'))) {
          console.log(`Clicando em: "${txt?.trim()}"`);
          await btn.click({ timeout: 5000 });
          await page.waitForTimeout(3000);

          // Inspeciona formulário aberto
          const formHTML = await page.evaluate(() => {
            const modals = [...document.querySelectorAll('.modal-content, [class*="overlay"], [class*="popup"], [class*="dialog"]')];
            const visible = modals.filter(m => m.offsetParent !== null);
            if (visible.length) return visible.map(m => m.innerHTML.slice(0, 1000)).join('\n---\n');
            // Tenta qualquer novo elemento visível
            const forms = [...document.querySelectorAll('form, [ng-submit]')];
            return forms.filter(f => f.offsetParent).map(f => f.innerHTML.slice(0, 500)).join('\n---\n');
          });
          if (formHTML) {
            console.log('Form/modal HTML:', formHTML.slice(0, 1000));
          }
          break;
        }
      }
    }
  } catch (err) {
    console.log('Erro em Passo 3:', err.message.slice(0, 200));
  }

  await page.waitForTimeout(3000);
  console.log('\n✅ Discovery 11 completo. Mantendo 120s...');
  await page.waitForTimeout(120000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
