/**
 * Discovery PARTE 5 — payload consulting com messages + scope de tarefas
 * ⚠️ Escrita apenas para ESTEVAO TERCI (ID 6310592766738432 / 5732697556058112)
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
const ESTEVAO_CLIENT_CONTACT_ID = 5732697556058112; // "Estêvão Terci Da Silva" (cliente)
const AUTOMATION_USER_ID = 6528036269752320;

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Captura apenas requests de escrita relevantes
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('/api/v2')) return;
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method())) return;
    const skip = ['alerts', 'session', 'clipping', 'analytical', 'honorary', 'search/token', 'contact/all'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.replace('https://app.astrea.net.br', '');
    console.log(`\n📤 ${req.method()} ${path}`);
    const pd = req.postData();
    if (pd) { try { console.log('   Body:', JSON.stringify(JSON.parse(pd), null, 2).slice(0, 600)); } catch { console.log('   Body:', pd.slice(0, 300)); } }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/api/v2')) return;
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(res.request().method())) return;
    const skip = ['alerts', 'session', 'clipping', 'analytical', 'honorary', 'search/token', 'contact/all'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.replace('https://app.astrea.net.br', '');
    const status = res.status();
    try {
      const body = await res.json();
      console.log(`📥 ${status} ${res.request().method()} ${path}`);
      console.log('   Resp:', JSON.stringify(body, null, 2).slice(0, 800));
    } catch {
      console.log(`📥 ${status} ${res.request().method()} ${path}`);
    }
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

  // ── PASSO 1: Consulting com messages: [] ─────────────────────────────────────
  console.log('\n=== PASSO 1: Consulting com messages: [] ===');
  const r1 = await page.evaluate(async ({ contactId, userId }) => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    const baseUrl = 'https://app.astrea.net.br/api/v2';
    const results = {};

    const tryPost = async (key, payload) => {
      try {
        const r = await http.post(`${baseUrl}/consulting`, payload).then(r => r.data);
        results[key] = { success: true, body: r };
      } catch (e) {
        results[key] = { status: e.status, error: JSON.stringify(e.data?.errorMessage ?? e.data).slice(0, 300) };
      }
    };

    // Payload 1: com messages: []
    await tryPost('messages:[]', {
      active: true,
      messages: [],
      customers: [{ id: contactId, main: true }],
      responsibleId: userId,
      ownerId: userId,
      date: '2026-03-20',
      time: '10:00',
      subject: 'TESTE AUTOMAÇÃO - PODE DELETAR',
      tagIds: [],
    });

    // Payload 2: com todos os campos que aparecem no consultingDTO da response
    if (!results['messages:[]'].success) {
      await tryPost('completo', {
        active: true,
        messages: [],
        tagIds: [],
        customers: [{ id: contactId, main: true, photo: '', telephone: '' }],
        responsibleId: userId,
        ownerId: userId,
        createdDate: Date.now(),
        date: '2026-03-20',
        time: '10:00',
        subject: 'TESTE AUTOMAÇÃO - PODE DELETAR',
        description: '',
        caseAttached: null,
        status: '',
        consultingHistories: [],
      });
    }

    return results;
  }, { contactId: ESTEVAO_CLIENT_CONTACT_ID, userId: AUTOMATION_USER_ID });

  console.log('\nResultado consulting:', JSON.stringify(r1, null, 2).slice(0, 1000));

  // Se criou, captura a estrutura e deleta
  for (const [key, val] of Object.entries(r1)) {
    if (val.success && val.body?.id) {
      console.log(`\n✅ CONSULTING CRIADO! Key: ${key}, ID: ${val.body.id}`);
      console.log('Estrutura completa:', JSON.stringify(val.body, null, 2).slice(0, 1000));
      // Deleta
      await page.evaluate(async (id) => {
        const http = window.angular?.element(document.body)?.injector()?.get('$http');
        const baseUrl = 'https://app.astrea.net.br/api/v2';
        try {
          await http.delete(`${baseUrl}/consulting/${id}`).then(r => r.data);
        } catch (e) {
          try { await http.patch(`${baseUrl}/consulting/${id}`, { active: false }).then(r => r.data); } catch {}
        }
      }, val.body.id);
      console.log('Deletado.');
    }
  }

  // ── PASSO 2: Ler tarefas do scope da workspace ─────────────────────────────────
  console.log('\n=== PASSO 2: Ler tarefas do scope da workspace ===');
  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  const workspaceTasks = await page.evaluate(() => {
    // O componente de tarefas tem class "collapsible-wrapper task-list"
    const taskListEl = document.querySelector('.collapsible-wrapper.task-list');
    if (!taskListEl) {
      // Tenta outro seletor
      const els = [...document.querySelectorAll('[class*="task"]')];
      return { notFound: true, available: els.map(e => ({ tag: e.tagName, cls: e.className?.toString().slice(0, 60) })).slice(0, 10) };
    }

    // Tenta ler o scope isolado do componente pai
    let el = taskListEl;
    while (el) {
      const scope = window.angular?.element(el)?.isolateScope?.();
      if (scope) {
        const ctrl = scope.$ctrl;
        if (ctrl) {
          const taskList = ctrl.data?.taskList;
          if (taskList) {
            const active = (taskList.activeTasks || []).map(t => ({
              id: t.id,
              title: t.title || t.name,
              status: t.status,
              dueDate: t.dueDate || t.date,
              responsibleId: t.responsibleId,
              responsibleName: t.responsibleName,
              folderId: t.folderId,
              folderTitle: t.folderTitle,
              customerId: t.customerId,
            }));
            return { found: true, activeCount: active.length, sample: active.slice(0, 3), allKeys: Object.keys(taskList) };
          }
        }
        // Tenta scope.$ctrl sem isolate
        const s = window.angular?.element(el)?.scope?.();
        if (s?.$ctrl?.data?.taskList) {
          return { found: true, viaScope: true, keys: Object.keys(s.$ctrl.data.taskList) };
        }
      }
      el = el.parentElement;
      if (!el || el === document.body) break;
    }

    // Tenta via componente au-workspace
    const auWorkspace = document.querySelector('au-workspace, [au-workspace]');
    if (auWorkspace) {
      const scope = window.angular?.element(auWorkspace)?.isolateScope?.();
      return { auWorkspace: true, scopeKeys: scope ? Object.keys(scope).filter(k => !k.startsWith('$')) : [] };
    }

    return { notFound: true, html: taskListEl.innerHTML.slice(0, 500) };
  });

  console.log('Workspace tasks:', JSON.stringify(workspaceTasks, null, 2).slice(0, 2000));

  // ── PASSO 3: Criar tarefa via UI da workspace ───────────────────────────────────
  console.log('\n=== PASSO 3: Criar tarefa via UI da workspace ===');
  // Busca pelo botão "Adicionar primeira tarefa" ou similar
  const taskBtnText = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, a[class*="button"], [class*="button"]')];
    return btns.map(b => `"${b.textContent?.trim().slice(0, 40)}" data-action="${b.getAttribute('data-action') || ''}" ng-click="${b.getAttribute('ng-click') || ''}"`).filter(t => t.includes('arefa') || t.includes('task') || t.includes('Adicionar')).join('\n');
  });
  console.log('Botões de tarefa:', taskBtnText);

  // Clica no botão de adicionar tarefa e monitora o request
  try {
    const addBtn = await page.$('button:has-text("Adicionar primeira tarefa")');
    if (addBtn) {
      console.log('Clicando em "Adicionar primeira tarefa"...');
      await addBtn.click();
      await page.waitForTimeout(3000);
      console.log('Modal aberto. Inspecionando formulário...');

      // Captura o HTML do modal
      const modalHtml = await page.evaluate(() => {
        const modals = document.querySelectorAll('.modal-content, [class*="modal"], .au-modal');
        if (modals.length) return [...modals].map(m => m.innerHTML.slice(0, 1000)).join('\n\n---\n\n');
        // Tenta qualquer overlay
        const overlays = document.querySelectorAll('[class*="overlay"], [class*="popup"]');
        if (overlays.length) return [...overlays].map(m => m.innerHTML.slice(0, 1000)).join('\n\n');
        return 'Nenhum modal encontrado';
      });
      console.log('Modal HTML:', modalHtml.slice(0, 2000));

      // Tenta preencher o campo de título
      const titleInput = await page.$('input[placeholder*="tarefa"], input[placeholder*="Tarefa"], input[placeholder*="título"], input[ng-model*="title"], input[ng-model*="Title"]');
      if (titleInput) {
        await titleInput.fill('TESTE AUTOMAÇÃO - PODE DELETAR');
        await page.waitForTimeout(500);

        // Tenta submeter e capturar o request
        const submitBtn = await page.$('button[type="submit"], button:has-text("Salvar"), button:has-text("Criar"), button:has-text("Confirmar")');
        if (submitBtn) {
          console.log('\nSubmetendo tarefa...');
          await submitBtn.click();
          await page.waitForTimeout(3000);
        } else {
          console.log('Botão submit não encontrado. Verificando modal...');
        }
      } else {
        console.log('Input de título não encontrado. HTML dos inputs visíveis:');
        const inputs = await page.evaluate(() =>
          [...document.querySelectorAll('input:not([type="hidden"])')].map(i =>
            `<input type="${i.type}" placeholder="${i.placeholder}" ng-model="${i.getAttribute('ng-model') || ''}" class="${i.className.slice(0, 40)}">`
          ).join('\n')
        );
        console.log(inputs.slice(0, 1000));
      }
    }
  } catch (err) {
    console.log('Erro ao interagir com botão de tarefa:', err.message.slice(0, 200));
  }

  console.log('\n✅ Discovery 5 completo. Browser aberto por 90s para inspeção manual...');
  await page.waitForTimeout(90000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
