/**
 * Discovery PARTE 15 - FINAL DEFINITIVO:
 * 1. Chamar window.fn() diretamente para listar e criar tarefas
 * 2. Encontrar folder ID do ESTEVAO para criar tarefa de caso
 * 3. Capturar requests HTTP feitos pelo window.fn() executor
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

  // Captura TODOS os requests para ver o que window.fn() faz
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('/api/v2') && !url.includes('astrea')) return;
    const skip = ['alerts', 'session/valid', 'clipping', 'search/token', 'help-tip',
      'widgets-config', 'firstxp-config', 'accreditation', 'user-verify',
      'firebase', 'environment', 'honoraries', 'ticket', 'feature-toggle', 'teams',
      'user-config', 'session/login', 'contact/all', 'suggests', 'google',
      'timesheet', 'migration', 'statistics', 'reminders', 'tags', 'contact/notification',
      'contact/query', 'analytical', 'hasfolder'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.includes('astrea.net.br') ? url.replace(/https?:\/\/[^/]+/, '') : url;
    console.log(`\n📤 ${req.method()} ${path}`);
    const pd = req.postData();
    if (pd) { try { console.log('   >', JSON.stringify(JSON.parse(pd), null, 2).slice(0, 500)); } catch { console.log('   >', pd.slice(0, 300)); } }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/api/v2') && !url.includes('astrea')) return;
    const skip = ['alerts', 'session/valid', 'clipping', 'search/token', 'help-tip',
      'widgets-config', 'firstxp-config', 'accreditation', 'user-verify',
      'firebase', 'environment', 'honoraries', 'ticket', 'feature-toggle', 'teams',
      'user-config', 'session/login', 'contact/all', 'suggests', 'google',
      'timesheet', 'migration', 'statistics', 'reminders', 'tags', 'contact/notification',
      'contact/query', 'analytical', 'hasfolder'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.includes('astrea.net.br') ? url.replace(/https?:\/\/[^/]+/, '').split('?')[0] : url;
    const status = res.status();
    try {
      const body = await res.json();
      const bodyStr = JSON.stringify(body);
      if (bodyStr.length > 5) {
        console.log(`\n📥 ${status} ${res.request().method()} ${path}`);
        console.log(`   ${bodyStr.slice(0, 1000)}`);
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
  await page.waitForTimeout(3000);
  console.log('✅ Login OK\n');

  // ── PASSO 1: Verificar window.fn() e testar chamadas diretas ─────────────────
  console.log('=== PASSO 1: window.fn() disponível? ===');
  const fnCheck = await page.evaluate(async (userId) => {
    const results = {};

    // Verifica se window.fn existe
    results.fnExists = typeof window.fn === 'function';
    results.fnType = typeof window.fn;

    if (typeof window.fn !== 'function') {
      // Lista todas as funções no window que poderiam ser o bridge
      results.windowFunctions = Object.keys(window)
        .filter(k => typeof window[k] === 'function' && !k.startsWith('on'))
        .filter(k => !['eval', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURI',
          'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'unescape',
          'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
          'cancelAnimationFrame', 'fetch', 'alert', 'confirm', 'prompt', 'open', 'close',
          'focus', 'blur', 'print', 'stop', 'scrollTo', 'scroll', 'scrollBy',
          'getComputedStyle', 'matchMedia', 'postMessage', 'dispatchEvent', 'addEventListener',
          'removeEventListener', 'queueMicrotask', 'reportError', 'structuredClone',
        ].includes(k))
        .slice(0, 50);
      return results;
    }

    // window.fn existe! Testa chamadas
    results.fnExists = true;
    try {
      const listResult = await new Promise((resolve, reject) => {
        window.fn('workspace.taskListService.listTaskListsByUser')({ userId: String(userId) })
          .execute(r => r.error ? reject(r.error) : resolve(r));
        setTimeout(() => reject(new Error('timeout')), 10000);
      });
      results.listTaskLists = JSON.stringify(listResult).slice(0, 800);
    } catch (e) {
      results.listTaskListsErr = e.message || String(e);
    }

    return results;
  }, AUTOMATION_USER_ID);

  console.log('window.fn check:', JSON.stringify(fnCheck, null, 2).slice(0, 3000));

  // ── PASSO 2: Navegar para workspace e aguardar window.fn estar disponível ─────
  console.log('\n=== PASSO 2: workspace + window.fn ===');
  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  const fnCheckWorkspace = await page.evaluate(async (userId) => {
    const results = { fnExists: typeof window.fn === 'function' };

    if (typeof window.fn !== 'function') {
      // Procura no window por objeto com método fn
      const candidates = Object.keys(window).filter(k => {
        try {
          return window[k] && typeof window[k] === 'object' && typeof window[k].fn === 'function';
        } catch { return false; }
      });
      results.fnCandidates = candidates.slice(0, 10);
      return results;
    }

    // Testa listTaskListsByUser
    try {
      const r = await new Promise((resolve, reject) => {
        window.fn('workspace.taskListService.listTaskListsByUser')({ userId: String(userId) })
          .execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
        setTimeout(() => reject('timeout'), 10000);
      });
      results.listTaskLists = JSON.stringify(r).slice(0, 1000);
    } catch (e) {
      results.listErr = String(e).slice(0, 300);
    }

    // Testa getTasksByCase (precisamos de um caseId real)
    // Primeiro pega o ID de alguma pasta do escopo
    const el = document.querySelector('.task-list');
    const scope = window.angular?.element(el)?.isolateScope?.() || window.angular?.element(el)?.scope?.();
    const ctrl = scope?.$ctrl;
    const taskList = ctrl?.data?.taskList;
    if (taskList) {
      results.taskListId = taskList.id;
      results.taskListName = taskList.name;

      // Tenta carregar task list completo
      try {
        const r = await new Promise((resolve, reject) => {
          window.fn('workspace.taskListService.getTaskList')({
            userId: String(userId),
            taskListId: String(taskList.id),
          }).execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
          setTimeout(() => reject('timeout'), 10000);
        });
        results.getTaskList = JSON.stringify(r).slice(0, 1000);
      } catch (e) {
        results.getTaskListErr = String(e).slice(0, 300);
      }
    }

    return results;
  }, AUTOMATION_USER_ID);

  console.log('workspace fn check:', JSON.stringify(fnCheckWorkspace, null, 2).slice(0, 3000));
  await page.waitForTimeout(3000); // aguarda requests do window.fn

  // ── PASSO 3: Encontrar pasta do ESTEVAO via navegação ────────────────────────
  console.log('\n=== PASSO 3: Encontrar pasta do ESTEVAO ===');

  // Navega para o contato do ESTEVAO e espera mais tempo
  await page.goto(`${ASTREA_URL}/#/main/contacts/${ESTEVAO_CLIENT_CONTACT_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  // Tenta extrair folder IDs de vários elementos
  const estevaoFolderIds = await page.evaluate((contactId) => {
    const results = {
      folderLinks: [],
      ngHrefs: [],
      dataFolders: [],
    };

    // Procura links com folder ID
    const allLinks = document.querySelectorAll('a, [ng-href], [href]');
    for (const link of allLinks) {
      const href = link.getAttribute('href') || link.getAttribute('ng-href') || link.href || '';
      const m = href.match(/folders?\/(\d{10,})/);
      if (m) results.folderLinks.push({ id: m[1], text: link.textContent?.trim().slice(0, 50) });
    }

    // Procura no scope de qualquer elemento com dados de pasta
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      try {
        const scope = window.angular?.element(el)?.isolateScope?.();
        if (!scope) continue;
        const ctrl = scope.$ctrl;
        if (!ctrl) continue;

        // Procura por arrays que podem ter folder/case IDs
        for (const key of Object.keys(ctrl)) {
          const val = ctrl[key];
          if (Array.isArray(val) && val.length > 0 && val[0]?.id) {
            results.dataFolders.push({ key, count: val.length, sample: val.slice(0, 2).map(v => ({ id: v.id, title: v.title || v.name || v.subject })) });
          }
        }
        if (results.dataFolders.length > 0) break;
      } catch {}
    }

    // Procura ng-href com folder no template
    const ngHrefs = document.querySelectorAll('[ng-href*="folder"], [href*="folder"]');
    for (const el of ngHrefs) {
      const href = el.getAttribute('ng-href') || el.getAttribute('href') || '';
      const text = el.textContent?.trim().slice(0, 50);
      if (href) results.ngHrefs.push({ href, text });
    }

    return results;
  }, ESTEVAO_CLIENT_CONTACT_ID);

  console.log('ESTEVAO folder IDs:', JSON.stringify(estevaoFolderIds, null, 2).slice(0, 2000));

  // ── PASSO 4: Navegar para pasta e criar tarefa via window.fn ─────────────────
  const folderId = estevaoFolderIds.folderLinks[0]?.id;
  if (folderId) {
    console.log(`\n=== PASSO 4: Criar tarefa via window.fn no folder ${folderId} ===`);
    await page.goto(`${ASTREA_URL}/#/main/folders/${folderId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);

    const taskCreation = await page.evaluate(async ({ folderId, userId, contactId }) => {
      const results = { fnExists: typeof window.fn === 'function' };
      if (typeof window.fn !== 'function') return results;

      // Tenta criar via window.fn (se existir criação de tarefa)
      const taskActions = [
        'workspace.taskListService.createTask',
        'case.taskService.createTask',
        'task.create',
        'tasks.create',
      ];

      for (const action of taskActions) {
        try {
          const r = await new Promise((resolve, reject) => {
            window.fn(action)({
              userId: String(userId),
              caseId: String(folderId),
              title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
              responsibleId: String(userId),
            }).execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
            setTimeout(() => reject('timeout'), 8000);
          });
          results[action] = { success: true, data: JSON.stringify(r).slice(0, 400) };
        } catch (e) {
          results[action] = { err: String(e).slice(0, 200) };
        }
      }

      // Também tenta via $http com endpoint derivado do GET que funciona
      const http = window.angular?.element(document.body)?.injector()?.get('$http');
      const baseUrl = 'https://app.astrea.net.br/api/v2';

      // GET que funciona: /tasks/case/{caseId}/user/{userId}
      // Tentativas de POST no mesmo padrão:
      const endpoints = [
        `/tasks/case/${folderId}/user/${userId}`,
        `/tasks/case/${folderId}`,
      ];
      for (const ep of endpoints) {
        try {
          const r = await http.post(`${baseUrl}${ep}`, {
            title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
            responsibleId: userId,
          }).then(r => r.data);
          results[`POST ${ep}`] = { status: 200, data: JSON.stringify(r).slice(0, 400) };

          // Deleta se criou
          if (r?.id) {
            try {
              await http.delete(`${baseUrl}/tasks/${r.id}/user/${userId}`).then(r => r.data);
            } catch {}
          }
        } catch (e) {
          results[`POST ${ep}`] = { status: e.status, err: JSON.stringify(e.data).slice(0, 150) };
        }
      }

      return results;
    }, { folderId, userId: AUTOMATION_USER_ID, contactId: ESTEVAO_CLIENT_CONTACT_ID });

    console.log('Task creation:', JSON.stringify(taskCreation, null, 2).slice(0, 2000));
    await page.waitForTimeout(5000); // aguarda requests

    // Botões de tarefa na página do caso
    const taskBtns = await page.evaluate(() => {
      return [...document.querySelectorAll('button, a')]
        .filter(b => b.offsetParent)
        .filter(b => {
          const t = b.textContent?.toLowerCase() || '';
          const nc = b.getAttribute('ng-click') || '';
          return t.includes('tarefa') || t.includes('task') || nc.includes('task') || nc.includes('tarefa');
        })
        .map(b => ({
          text: b.textContent?.trim().slice(0, 50),
          ngClick: b.getAttribute('ng-click') || '',
        })).slice(0, 10);
    });
    console.log('\nTask buttons no caso:', JSON.stringify(taskBtns, null, 2));

    // Clica em botão de tarefa se existir
    for (const btn of taskBtns) {
      if (btn.text && !btn.text.toLowerCase().includes('filtro')) {
        try {
          const btnEl = await page.$(`button:has-text("${btn.text.slice(0, 20)}")`);
          if (btnEl && await btnEl.isVisible()) {
            console.log(`Clicando: "${btn.text}"`);
            await btnEl.click({ timeout: 5000 });
            await page.waitForTimeout(4000);
            break;
          }
        } catch {}
      }
    }
  }

  console.log('\n✅ Discovery 15 completo. Mantendo 120s...');
  await page.waitForTimeout(120000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
