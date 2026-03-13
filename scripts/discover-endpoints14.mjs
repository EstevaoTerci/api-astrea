/**
 * Discovery PARTE 14 - FINAL:
 * 1. Navegar para contato ESTEVAO e capturar requests de folders
 * 2. Tentar criar tarefa via POST /tasks/case/{caseId}
 * 3. Criar tarefa via UI no caso e capturar request
 * 4. Extrair taskListService method source via prototype traversal
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
const ESTEVAO_CLIENT_CONTACT_ID = 5732697556058112; // client contact
const ESTEVAO_USER_ID = 4873854936612864; // user account of Estevao
const AUTOMATION_USER_ID = 6528036269752320;

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Captura requests/responses relevantes
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('/api/v2')) return;
    const skip = ['alerts', 'session/valid', 'clipping', 'search/token', 'help-tip',
      'widgets-config', 'firstxp-config', 'accreditation', 'user-verify',
      'firebase', 'environment', 'honoraries', 'ticket', 'feature-toggle', 'teams',
      'user-config', 'session/login', 'contact/all', 'kanbans', 'suggests', 'google',
      'timesheet', 'migration', 'statistics', 'reminders', 'tags', 'contact/notification',
      'contact/query', 'analytical'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.replace('https://app.astrea.net.br', '');
    console.log(`\n📤 ${req.method()} ${path}`);
    const pd = req.postData();
    if (pd) { try { console.log('   >', JSON.stringify(JSON.parse(pd), null, 2).slice(0, 400)); } catch { console.log('   >', pd.slice(0, 200)); } }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/api/v2')) return;
    const skip = ['alerts', 'session/valid', 'clipping', 'search/token', 'help-tip',
      'widgets-config', 'firstxp-config', 'accreditation', 'user-verify',
      'firebase', 'environment', 'honoraries', 'ticket', 'feature-toggle', 'teams',
      'user-config', 'session/login', 'contact/all', 'kanbans', 'suggests', 'google',
      'timesheet', 'migration', 'statistics', 'reminders', 'tags', 'contact/notification',
      'contact/query', 'analytical'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.replace('https://app.astrea.net.br', '').split('?')[0];
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
  await page.waitForTimeout(2000);
  console.log('✅ Login OK\n');

  await page.goto(`${ASTREA_URL}/#/main/contacts`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // ── PASSO 1: Extrair método source do taskListService ────────────────────────
  console.log('=== PASSO 1: TaskListService methods source ===');
  const serviceMethodSources = await page.evaluate(() => {
    const injector = window.angular?.element(document.body)?.injector?.();
    const svc = injector?.get('taskListService');
    if (!svc) return { error: 'not found' };

    const proto = Object.getPrototypeOf(svc);
    const sources = {};
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor') continue;
      if (typeof proto[key] === 'function') {
        sources[key] = proto[key].toString().slice(0, 500);
      }
    }
    return sources;
  });

  console.log('Method sources:');
  for (const [name, src] of Object.entries(serviceMethodSources)) {
    console.log(`\n  [${name}]`);
    console.log(`  ${src}`);
  }

  // ── PASSO 2: Navegar para página do contato ESTEVAO ───────────────────────────
  console.log('\n=== PASSO 2: Navegar para ESTEVAO e capturar folder requests ===');
  await page.goto(`${ASTREA_URL}/#/main/contacts/${ESTEVAO_CLIENT_CONTACT_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Captura folderIds do scope da página de contato
  const contactData = await page.evaluate((contactId) => {
    // Procura elementos com folders/processos
    const folderEls = document.querySelectorAll('[class*="folder"], [class*="process"], [class*="case"], [ng-controller*="case" i], [ng-controller*="folder" i]');
    const elInfo = [...folderEls].slice(0, 5).map(el => ({
      cls: el.className?.toString?.().slice(0, 60),
      ngCtrl: el.getAttribute('ng-controller'),
    }));

    // Tenta ler via scope
    const rootEl = document.querySelector('[ng-controller="ContactController"], [ng-controller="contactController"], au-contact-detail, [class*="contact-detail"]');
    let scopeData = null;
    if (rootEl) {
      const scope = window.angular?.element(rootEl)?.scope?.();
      if (scope) {
        const ctrl = scope.$ctrl || scope;
        scopeData = {
          keys: Object.keys(ctrl).filter(k => !k.startsWith('$')).slice(0, 20),
          folders: ctrl.folders?.map?.(f => ({ id: f.id, title: f.title || f.name }))?.slice(0, 5),
          contact: ctrl.contact ? { id: ctrl.contact.id, name: ctrl.contact.name } : null,
        };
      }
    }
    return { elements: elInfo, scopeData };
  }, ESTEVAO_CLIENT_CONTACT_ID);
  console.log('Contact data:', JSON.stringify(contactData, null, 2).slice(0, 1000));

  // Aguarda requests capturados pelo listener global
  await page.waitForTimeout(3000);

  // ── PASSO 3: Tentar criar tarefa com paths alternativos ──────────────────────
  console.log('\n=== PASSO 3: Criar tarefa com endpoint path de caso ===');

  // Pega o primeiro folder do ESTEVAO via contact details
  const folderResult = await page.evaluate(async (contactId) => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    const baseUrl = 'https://app.astrea.net.br/api/v2';
    try {
      const details = await http.get(`${baseUrl}/contact/${contactId}/details`).then(r => r.data);
      return { keys: Object.keys(details), folders: (details.folders || details.cases || []).slice(0, 5) };
    } catch (e) {
      return { err: `${e.status}: ${JSON.stringify(e.data).slice(0, 100)}` };
    }
  }, ESTEVAO_CLIENT_CONTACT_ID);
  console.log('Contact details (folders):', JSON.stringify(folderResult, null, 2).slice(0, 800));

  // Navega para o folder do ESTEVAO
  // Usa o ID obtido da aba de processos na consulta ou via scope
  let folderId = null;

  // Tenta extrair folderIDs da página atual
  const folderIds = await page.evaluate(() => {
    // Procura links para folders na página
    const links = [...document.querySelectorAll('a[href*="folders/"], [ng-click*="folder" i], [ng-click*="caso" i]')];
    return links.slice(0, 5).map(l => ({
      href: l.href || l.getAttribute('ng-click'),
      text: l.textContent?.trim().slice(0, 50),
    }));
  });
  console.log('Folder links na página:', JSON.stringify(folderIds, null, 2));

  // ── PASSO 4: Navegar para lista de folders e capturar IDs ────────────────────
  console.log('\n=== PASSO 4: Navegar para lista de processos/pastas ===');
  await page.goto(`${ASTREA_URL}/#/main/folders`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Captura scope da lista de folders
  const foldersScope = await page.evaluate(() => {
    const allEls = document.querySelectorAll('[ng-controller], au-folder-list, [class*="folder-list"], [class*="folders"]');
    const found = [];
    for (const el of allEls) {
      const scope = window.angular?.element(el)?.isolateScope?.() || window.angular?.element(el)?.scope?.();
      if (!scope) continue;
      const ctrl = scope.$ctrl || scope;
      if (ctrl.folders || ctrl.cases || ctrl.items) {
        const items = ctrl.folders || ctrl.cases || ctrl.items || [];
        found.push({
          tag: el.tagName,
          count: items.length,
          sample: items.slice(0, 3).map(f => ({ id: f.id, title: f.title || f.name || f.subject })),
        });
      }
    }
    return found;
  });
  console.log('Folders scope:', JSON.stringify(foldersScope, null, 2).slice(0, 1000));

  // Espera requests de folder list serem capturados
  await page.waitForTimeout(3000);

  // ── PASSO 5: Criar tarefa em um caso do ESTEVAO via UI ───────────────────────
  console.log('\n=== PASSO 5: Criar tarefa em caso via UI ===');

  // Navega para a página de um caso do ESTEVAO
  // Usa o folderId que aparece nos requests GET /folder/{id}
  // Se não achou ainda, tenta via scope da página de folders
  const knownFolderIds = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href*="#/main/folders/"]')];
    return [...new Set(links.map(l => {
      const m = l.href?.match(/folders\/(\d+)/);
      return m ? m[1] : null;
    }).filter(Boolean))].slice(0, 5);
  });
  console.log('Known folder IDs from DOM:', knownFolderIds);

  if (knownFolderIds.length > 0) {
    folderId = knownFolderIds[0];
    console.log(`\nNavegando para folder ${folderId}...`);
    await page.goto(`${ASTREA_URL}/#/main/folders/${folderId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);

    // Captura requests feitos para o folder
    // (já capturado pelo listener global)

    // Tenta criar tarefa via $http com paths de caso
    const taskCreate = await page.evaluate(async ({ folderId, userId, contactId }) => {
      const http = window.angular?.element(document.body)?.injector()?.get('$http');
      const baseUrl = 'https://app.astrea.net.br/api/v2';
      const results = {};

      // Tenta paths de criação de tarefa baseados no GET que funciona
      const tryPost = async (key, path, body) => {
        try {
          const r = await http.post(`${baseUrl}${path}`, body).then(r => r.data);
          results[key] = { status: 200, data: JSON.stringify(r).slice(0, 500) };
        } catch (e) {
          results[key] = { status: e.status, err: JSON.stringify(e.data).slice(0, 200) };
        }
      };

      // GET que funciona: /tasks/case/{caseId}/user/{userId}
      // POST hipóteses:
      await tryPost('POST_case', `/tasks/case/${folderId}/user/${userId}`, {
        title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
        responsibleId: userId,
      });
      await tryPost('POST_case_body', `/tasks/case/${folderId}`, {
        title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
        responsibleId: userId,
        userId,
      });
      await tryPost('POST_tasks_caseId', `/tasks`, {
        title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
        responsibleId: userId,
        caseId: String(folderId),
      });
      await tryPost('POST_tasks_folderIdStr', `/tasks`, {
        title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
        responsibleId: userId,
        folderId: String(folderId),
      });

      return results;
    }, { folderId, userId: AUTOMATION_USER_ID, contactId: ESTEVAO_CLIENT_CONTACT_ID });

    console.log('\nTask creation attempts:');
    for (const [k, v] of Object.entries(taskCreate)) {
      const icon = (v.status === 200 || v.status === 201) ? '✅' : '❌';
      console.log(`  ${icon} ${k} → ${v.status}`);
      if (v.data) console.log(`    ${v.data}`);
      if (v.err) console.log(`    ERR: ${v.err}`);
    }

    // Procura botão de "Nova tarefa" na página do caso
    const taskBtn = await page.evaluate(() => {
      return [...document.querySelectorAll('button, a')]
        .filter(b => b.offsetParent)
        .filter(b => {
          const txt = b.textContent?.toLowerCase();
          return txt?.includes('tarefa') || txt?.includes('nova atividade') || txt?.includes('add task');
        })
        .map(b => ({
          text: b.textContent?.trim().slice(0, 50),
          ngClick: b.getAttribute('ng-click') || '',
          href: b.href || '',
        }));
    });
    console.log('\nTask buttons no caso:', JSON.stringify(taskBtn, null, 2));

    // Clica em um botão de tarefa se encontrado
    for (const btn of taskBtn) {
      if (btn.text) {
        try {
          console.log(`Tentando clicar: "${btn.text}"`);
          const el = await page.$(`button:has-text("${btn.text.slice(0, 20)}")`);
          if (el && await el.isVisible()) {
            await el.click({ timeout: 5000 });
            await page.waitForTimeout(3000);
            // Captura form/modal
            const modal = await page.evaluate(() => {
              const modals = [...document.querySelectorAll('.modal-content, [class*="overlay"], [class*="drawer"]')]
                .filter(m => m.offsetParent);
              return modals.map(m => m.innerHTML.slice(0, 500)).join('\n---\n');
            });
            if (modal) console.log('Modal:', modal.slice(0, 1000));
            break;
          }
        } catch {}
      }
    }
  }

  console.log('\n✅ Discovery 14 completo. Mantendo 120s...');
  await page.waitForTimeout(120000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
