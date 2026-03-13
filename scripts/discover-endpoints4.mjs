/**
 * Discovery PARTE 4 — payload exato para criar consulting/tarefa
 * ⚠️ Todas as operações de escrita são apenas para ESTEVAO TERCI (ID 6310592766738432)
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
const ESTEVAO_CONTACT_ID = 6310592766738432;
const AUTOMATION_USER_ID = 6528036269752320;

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Captura requests de escrita
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('/api/v2')) return;
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method())) return;
    if (url.includes('alerts') || url.includes('session') || url.includes('clipping') || url.includes('analytical') || url.includes('honorary') || url.includes('search/token')) return;
    const path = url.replace('https://app.astrea.net.br', '');
    console.log(`\n📤 ${req.method()} ${path}`);
    const postData = req.postData();
    if (postData) {
      try { console.log('   Body:', JSON.stringify(JSON.parse(postData), null, 2)); }
      catch { console.log('   Body:', postData.slice(0, 500)); }
    }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/api/v2')) return;
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(res.request().method())) return;
    if (url.includes('alerts') || url.includes('session') || url.includes('clipping') || url.includes('analytical') || url.includes('honorary') || url.includes('search/token')) return;
    const path = url.replace('https://app.astrea.net.br', '');
    const status = res.status();
    try {
      const body = await res.json();
      console.log(`📥 ${status} ${res.request().method()} ${path}`);
      console.log('   Response:', JSON.stringify(body, null, 2).slice(0, 1000));
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

  // Navega para contacts para carregar Angular
  await page.goto(`${ASTREA_URL}/#/main/contacts`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // ── PASSO 1: Criar consulting com payload derivado da response ────────────────
  console.log('\n=== PASSO 1: Criar atendimento (consulting) com payload correto ===');
  const createConsultingResult = await page.evaluate(async ({ contactId, userId }) => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    if (!http) return { error: 'sem $http' };
    const baseUrl = 'https://app.astrea.net.br/api/v2';

    // Payload baseado na estrutura do consultingDTO da response de query
    const payload = {
      active: true,
      customers: [{ id: contactId, main: true }],
      responsibleId: userId,
      ownerId: userId,
      date: '20260320',        // formato YYYYMMDD
      time: '10:00',
      subject: 'TESTE AUTOMAÇÃO - PODE DELETAR',
      description: 'Criado por script de discovery da api-astrea',
      tagIds: [],
    };

    try {
      const r = await http.post(`${baseUrl}/consulting`, payload).then(r => r.data);
      return { success: true, body: r };
    } catch (e) {
      // Tenta formato de data alternativo
      const payload2 = { ...payload, date: '2026-03-20' };
      try {
        const r2 = await http.post(`${baseUrl}/consulting`, payload2).then(r => r.data);
        return { success: true, format: 'date-ISO', body: r2 };
      } catch (e2) {
        // Tenta sem date/time
        const payload3 = {
          active: true,
          customers: [{ id: contactId, main: true }],
          responsibleId: userId,
          subject: 'TESTE AUTOMAÇÃO - PODE DELETAR',
        };
        try {
          const r3 = await http.post(`${baseUrl}/consulting`, payload3).then(r => r.data);
          return { success: true, format: 'sem-data', body: r3 };
        } catch (e3) {
          return {
            error1: `${e.status}: ${JSON.stringify(e.data)}`,
            error2: `${e2.status}: ${JSON.stringify(e2.data)}`,
            error3: `${e3.status}: ${JSON.stringify(e3.data)}`,
          };
        }
      }
    }
  }, { contactId: ESTEVAO_CONTACT_ID, userId: AUTOMATION_USER_ID });

  console.log('Resultado criação consulting:', JSON.stringify(createConsultingResult, null, 2));

  // Se criou com sucesso, deletar
  if (createConsultingResult.success && createConsultingResult.body?.id) {
    const consultingId = createConsultingResult.body.id;
    console.log(`\nDeleting consulting de teste ID: ${consultingId}`);
    const deleteResult = await page.evaluate(async (id) => {
      const http = window.angular?.element(document.body)?.injector()?.get('$http');
      const baseUrl = 'https://app.astrea.net.br/api/v2';
      try {
        await http.delete(`${baseUrl}/consulting/${id}`).then(r => r.data);
        return { deleted: true };
      } catch (e) {
        // Tenta inativar
        try {
          await http.patch(`${baseUrl}/consulting/${id}`, { active: false }).then(r => r.data);
          return { inativado: true };
        } catch (e2) {
          return { error: `${e.status}, ${e2.status}` };
        }
      }
    }, consultingId);
    console.log('Delete result:', JSON.stringify(deleteResult));
  }

  // ── PASSO 2: Tarefas via calendar-pro/complete ────────────────────────────────
  console.log('\n=== PASSO 2: Listar tarefas via calendar-pro/complete ===');
  const calendarTaskResult = await page.evaluate(async (userId) => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    if (!http) return { error: 'sem $http' };
    const baseUrl = 'https://app.astrea.net.br/api/v2';

    try {
      const r = await http.post(`${baseUrl}/calendar-pro/complete`, {
        from: '20260101',
        to: '20261231',
        userId: String(userId),
        cursors: { deadlineCursor: '', eventCursor: '', hearingCursor: '', taskCursor: '' },
        query: {
          cases: [], customers: [], tasks: [], appointments: [], deadlines: [], hearings: [],
          appointmentSelected: false, deadlineSelected: false, hearingSelected: false,
          eventSelected: false, taskSelected: true,
        },
      }).then(r => r.data);
      return { success: true, body: r };
    } catch (e) {
      return { error: `${e.status}: ${JSON.stringify(e.data)}` };
    }
  }, AUTOMATION_USER_ID);

  console.log('Tarefas no calendário:', JSON.stringify(calendarTaskResult, null, 2).slice(0, 2000));

  // ── PASSO 3: Criar tarefa via $http ──────────────────────────────────────────
  console.log('\n=== PASSO 3: Criar tarefa via $http ===');
  const createTaskResult = await page.evaluate(async ({ contactId, userId }) => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    if (!http) return { error: 'sem $http' };
    const baseUrl = 'https://app.astrea.net.br/api/v2';

    const payloads = [
      // Formato 1: básico
      {
        title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
        responsibleId: userId,
        customerId: contactId,
        dueDate: '20260320',
        description: 'Criado por script de discovery',
      },
      // Formato 2: com date como string ISO
      {
        title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
        responsibleId: userId,
        customerId: contactId,
        date: '2026-03-20',
      },
      // Formato 3: com folderId (sem customer)
      {
        title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
        responsibleId: userId,
        date: '2026-03-20',
      },
      // Formato 4: minimal
      { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', responsibleId: userId },
    ];

    const results = [];
    for (const payload of payloads) {
      try {
        const r = await http.post(`${baseUrl}/task`, payload).then(r => r.data);
        results.push({ success: true, payload, body: r });
        break; // Para no primeiro sucesso
      } catch (e) {
        results.push({
          payload,
          status: e.status,
          error: JSON.stringify(e.data?.errorMessage ?? e.data?.statusDescription ?? e.data).slice(0, 200),
        });
      }
    }
    return results;
  }, { contactId: ESTEVAO_CONTACT_ID, userId: AUTOMATION_USER_ID });

  console.log('Resultados criação tarefa:');
  for (const r of createTaskResult) {
    if (r.success) {
      console.log('✅ Sucesso! Payload:', JSON.stringify(r.payload));
      console.log('   Response:', JSON.stringify(r.body, null, 2).slice(0, 500));
    } else {
      console.log(`❌ ${r.status}: ${r.error}`);
      console.log('   Payload:', JSON.stringify(r.payload));
    }
  }

  // Se criou tarefa com sucesso, deletar
  const successTask = createTaskResult.find(r => r.success);
  if (successTask?.body?.id) {
    const taskId = successTask.body.id;
    console.log(`\nDeleting tarefa de teste ID: ${taskId}`);
    const deleteTask = await page.evaluate(async (id) => {
      const http = window.angular?.element(document.body)?.injector()?.get('$http');
      const baseUrl = 'https://app.astrea.net.br/api/v2';
      try {
        await http.delete(`${baseUrl}/task/${id}`).then(r => r.data);
        return { deleted: true };
      } catch (e) {
        return { error: `${e.status}: ${JSON.stringify(e.data)}` };
      }
    }, taskId);
    console.log('Delete tarefa:', JSON.stringify(deleteTask));
  }

  // ── PASSO 4: Inspecionar tarefa já existente na workspace via scope ───────────
  console.log('\n=== PASSO 4: Inspecionar tarefas existentes na workspace ===');
  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  const workspaceDetails = await page.evaluate(() => {
    // Procura todos os componentes AngularJS com scope de tarefas
    const allEls = [...document.querySelectorAll('[ng-controller], au-workspace-tasks, [class*="task"]')];
    const controllers = allEls.map(el => ({
      tag: el.tagName,
      ctrl: el.getAttribute('ng-controller'),
      classes: el.className?.toString().slice(0, 80),
      html: el.innerHTML?.slice(0, 200),
    })).slice(0, 20);

    // Tenta achar o $state atual
    const $state = window.angular?.element(document.body)?.injector()?.get('$state');
    const currentState = $state?.current?.name;

    // Inspeciona o scope raiz para achar propriedades relacionadas a tarefas
    const rootScope = window.angular?.element(document.body)?.scope?.();
    const taskRelated = rootScope ? Object.keys(rootScope).filter(k => k.toLowerCase().includes('task') || k.toLowerCase().includes('activity')) : [];

    return { controllers: controllers.slice(0, 10), currentState, taskRelated };
  });

  console.log('Workspace details:', JSON.stringify(workspaceDetails, null, 2).slice(0, 1000));

  // Tenta listar tarefas da workspace via requests interceptadas
  console.log('\nRequests de listagem feitas ao carregar workspace:');
  // (já interceptadas e exibidas acima)

  console.log('\n\n✅ Discovery 4 completo. Mantendo aberto 120s...');
  await page.waitForTimeout(120000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
