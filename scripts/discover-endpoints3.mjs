/**
 * Script de descoberta PARTE 3 — criar atendimento e tarefas.
 * ⚠️ Usa APENAS o cliente ESTEVAO TERCI DA SILVA (ID: 6310592766738432)
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
const ESTEVAO_CONTACT_ID = '6310592766738432';

const capturedWrites = [];

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 500 });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Captura APENAS métodos de escrita (POST/PUT/PATCH)
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('/api/v2')) return;
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method())) return;
    const entry = {
      method: req.method(),
      path: url.replace('https://app.astrea.net.br', '').split('?')[0],
      postData: req.postData() ? (() => { try { return JSON.parse(req.postData()); } catch { return req.postData(); } })() : undefined,
    };
    capturedWrites.push(entry);
    console.log(`📤 ${req.method()} ${entry.path}`);
    if (entry.postData) console.log('   Body:', JSON.stringify(entry.postData, null, 2));
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/api/v2')) return;
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(res.request().method())) return;
    const status = res.status();
    const path = url.replace('https://app.astrea.net.br', '').split('?')[0];
    const found = capturedWrites.find(r => r.path === path && r.method === res.request().method());
    try {
      const body = await res.json();
      console.log(`📥 ${status} ${res.request().method()} ${path}`);
      console.log('   Response:', JSON.stringify(body, null, 2).slice(0, 600));
      if (found) found.response = { status, body };
    } catch {
      console.log(`📥 ${status} ${res.request().method()} ${path}`);
      if (found) found.response = { status };
    }
  });

  // Login
  console.log('Fazendo login...');
  await page.goto(ASTREA_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="Digite seu email"]', { timeout: 15000 });
  await page.fill('input[placeholder="Digite seu email"]', env.ASTREA_EMAIL);
  await page.fill('input[type="password"]', env.ASTREA_PASSWORD);
  await page.click('button:has-text("Entrar")');
  await page.waitForFunction(() => window.location.hash.includes('#/main/'), { timeout: 30000 });
  await page.waitForTimeout(2000);
  console.log('✅ Login OK\n');

  // ── Parte 1: Testar endpoint de criação de atendimento via $http ────────────
  console.log('=== PASSO 1: Testar criação de atendimento via $http ===');
  console.log('Navegando para contacts (para carregar Angular)...');
  await page.goto(`${ASTREA_URL}/#/main/contacts`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // Testa GET /consulting/{id} e estrutura de create
  const consultingTest = await page.evaluate(async (contactId) => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    if (!http) return { error: 'sem $http' };

    const results = {};
    const baseUrl = 'https://app.astrea.net.br/api/v2';

    const testGet = async (path) => {
      try {
        const r = await http.get(`${baseUrl}${path}`).then(r => r.data);
        return { success: true, body: r };
      } catch (e) {
        return { error: `${e.status}: ${JSON.stringify(e.data?.errorMessage ?? e.data ?? e.status)}` };
      }
    };

    const testPost = async (path, body) => {
      try {
        const r = await http.post(`${baseUrl}${path}`, body).then(r => r.data);
        return { success: true, body: r };
      } catch (e) {
        return { error: `${e.status}: ${JSON.stringify(e.data?.errorMessage ?? e.data ?? e.status)}` };
      }
    };

    // Testa endpoints de consulting
    results['GET /consulting/{contactId}'] = await testGet(`/consulting/${contactId}`);
    results['GET /consulting/1'] = await testGet('/consulting/1');

    // Testa query de consulting (confirmado no script anterior)
    results['POST /consulting/query (sem filtros)'] = await testPost('/consulting/query', {
      status: '',
      tagIds: [],
      subject: '',
      consultingId: null,
      customerId: null,
      order: '-createDate',
      caseAttached: null,
      limit: 5,
      createdAt: null,
      dateBegin: null,
      dateEnd: null,
      cursor: '',
    });

    // Testa criação de atendimento (DRY-RUN — vamos ver o formato do erro)
    // Com body inválido só para ver o formato da resposta de erro
    results['POST /consulting (dry-run formato)'] = await testPost('/consulting', {
      _test: true,
    });

    // Testa tarefas
    results['POST /task/query'] = await testPost('/task/query', { page: 0, limit: 5 });
    results['POST /task/filter'] = await testPost('/task/filter', { page: 0, limit: 5 });
    results['GET /task/all?userId=6528036269752320'] = await testGet('/task/all?userId=6528036269752320&limit=5');
    results['GET /task/user/6528036269752320'] = await testGet('/task/user/6528036269752320');
    results['POST /activity/query'] = await testPost('/activity/query', { page: 0, limit: 5 });

    return results;
  }, ESTEVAO_CONTACT_ID);

  console.log('\nResultados:');
  for (const [key, val] of Object.entries(consultingTest)) {
    if (val.success) {
      console.log(`✅ ${key}:`);
      console.log(`   ${JSON.stringify(val.body).slice(0, 400)}`);
    } else {
      console.log(`❌ ${key}: ${val.error}`);
    }
  }

  // ── Parte 2: Navegar para tela de atendimentos e criar via UI ──────────────
  console.log('\n=== PASSO 2: Criar atendimento via UI (ESTEVAO TERCI DA SILVA) ===');
  console.log('Navegando para aba Atendimentos do contato Estevao...');

  await page.evaluate((contactId) => {
    const $state = window.angular?.element(document.body)?.injector()?.get('$state');
    if ($state) $state.go('main.contacts-detail.consultings', { contactId });
  }, ESTEVAO_CONTACT_ID);

  await page.waitForTimeout(3000);

  // Encontra e clica em "Novo atendimento"
  const novoAtendBtn = await page.$('button:has-text("Novo atendimento"), button:has-text("Atendimento"), a:has-text("Novo atendimento"), [ng-click*="consulting"], [ng-click*="Consulting"]');
  if (novoAtendBtn) {
    console.log('✅ Botão de novo atendimento encontrado. Clicando...');
    await novoAtendBtn.click();
    await page.waitForTimeout(2000);
    console.log('Modal aberto. Preenchendo dados...');

    // Preenche o formulário (assunto)
    const subjectInput = await page.$('input[placeholder*="assunto"], input[placeholder*="Assunto"], input[ng-model*="subject"]');
    if (subjectInput) {
      await subjectInput.fill('Teste automação - pode deletar');
    }

    // Data: amanhã
    const dateInput = await page.$('input[type="date"], input[placeholder*="data"], input[placeholder*="Data"]');
    if (dateInput) {
      await dateInput.fill('2026-03-13');
    }

    // Salva (sem enviar de verdade — só vamos capturar o request)
    // NÃO salvar — apenas inspecionar o formulário
    console.log('\nInspecionando formulário do modal...');
    const formHtml = await page.evaluate(() => {
      const modal = document.querySelector('[ng-controller*="onsulting"], [ng-controller*="Consulting"], .modal, [class*="modal"]');
      if (modal) return modal.innerHTML.slice(0, 3000);
      return document.body.innerHTML.slice(0, 3000);
    });
    console.log('Form HTML (primeiros 2000 chars):', formHtml.slice(0, 2000));
  } else {
    console.log('⚠️  Botão de novo atendimento não encontrado automaticamente.');
    const buttons = await page.evaluate(() =>
      [...document.querySelectorAll('button, a')].map(b => `"${b.textContent?.trim().slice(0, 40)}" [${b.className?.slice(0, 60)}]`).join('\n')
    );
    console.log('Botões na página:', buttons.slice(0, 2000));
  }

  // ── Parte 3: Tentar criar via $http com payload completo ─────────────────────
  console.log('\n=== PASSO 3: Criar atendimento via $http (payload real) ===');
  const createConsulting = await page.evaluate(async (contactId) => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    if (!http) return { error: 'sem $http' };
    const baseUrl = 'https://app.astrea.net.br/api/v2';

    // Tenta criar atendimento com payload completo
    const payload = {
      customerId: Number(contactId),
      date: '2026-03-20',         // data futura segura para teste
      time: '10:00',
      responsibleId: 6528036269752320, // automação (eu mesmo)
      subject: 'Teste automação - api-astrea discovery',
      description: 'Teste criado por script de discovery. Pode deletar.',
      status: 'PENDING',
      duration: 30,
    };

    try {
      const r = await http.post(`${baseUrl}/consulting`, payload).then(r => r.data);
      return { success: true, body: r };
    } catch (e) {
      return {
        error: `${e.status}`,
        data: e.data,
        // Tenta pegar o body completo para entender o formato esperado
        headers: e.headers ? Object.fromEntries(Object.entries(e.headers())) : undefined,
      };
    }
  }, ESTEVAO_CONTACT_ID);

  console.log('Resultado criação consulting:', JSON.stringify(createConsulting, null, 2).slice(0, 1000));

  // ── Parte 4: Listar tarefas da workspace ─────────────────────────────────────
  console.log('\n=== PASSO 4: Listar tarefas via workspace requests reais ===');
  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Inspeciona o scope da workspace para achar o service de tarefas
  const workspaceScope = await page.evaluate(() => {
    try {
      // Procura o scope da workspace
      const wsEl = document.querySelector('[ng-controller*="orkspace"], [ng-controller*="Workspace"]');
      if (wsEl) {
        const scope = window.angular.element(wsEl).scope?.();
        const keys = scope ? Object.keys(scope).filter(k => !k.startsWith('$')) : [];
        return { found: true, controller: wsEl.getAttribute('ng-controller'), keys };
      }

      // Tenta via injector - pega o serviço de tarefas
      const injector = window.angular?.element(document.body)?.injector?.();
      if (!injector) return { error: 'sem injector' };

      // Lista os serviços disponíveis (não é possível enumerá-los diretamente no Angular)
      // Tenta serviços específicos
      const services = ['TaskService', 'taskService', 'WorkspaceService', 'workspaceService', 'ActivityService'];
      const found = {};
      for (const svc of services) {
        try {
          const s = injector.get(svc);
          found[svc] = Object.keys(s).filter(k => typeof s[k] === 'function');
        } catch {
          found[svc] = 'não encontrado';
        }
      }
      return { services: found };
    } catch (e) {
      return { error: String(e) };
    }
  });
  console.log('Workspace scope:', JSON.stringify(workspaceScope, null, 2));

  // Tenta listar tarefas via $http com vários formatos
  const taskListTests = await page.evaluate(async () => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    if (!http) return { error: 'sem $http' };
    const baseUrl = 'https://app.astrea.net.br/api/v2';
    const results = {};

    const testPost = async (path, body) => {
      try {
        const r = await http.post(`${baseUrl}${path}`, body).then(r => r.data);
        return { success: true, body: r };
      } catch (e) {
        return { error: `${e.status}: ${JSON.stringify(e.data?.errorMessage ?? e.data?.statusDescription ?? e.data ?? e.status)}` };
      }
    };
    const testGet = async (path) => {
      try {
        const r = await http.get(`${baseUrl}${path}`).then(r => r.data);
        return { success: true, body: r };
      } catch (e) {
        return { error: `${e.status}: ${JSON.stringify(e.data?.errorMessage ?? e.data?.statusDescription ?? e.data ?? e.status)}` };
      }
    };

    // Workspace usa taskCursor nos requests — tarefas são parte do calendário?
    results['POST /calendar-pro/complete (tasks)'] = await testPost('/calendar-pro/complete', {
      from: '20260101',
      to: '20261231',
      userId: '6528036269752320',
      cursors: { deadlineCursor: '', eventCursor: '', hearingCursor: '', taskCursor: '' },
      query: {
        cases: [], customers: [], tasks: [], appointments: [], deadlines: [], hearings: [],
        appointmentSelected: false, deadlineSelected: false, hearingSelected: false,
        eventSelected: false, taskSelected: true,  // apenas tarefas
      },
    });

    // Testa task com formato diferente
    results['POST /task/query (formato 2)'] = await testPost('/task/query', {
      userId: '6528036269752320',
      status: 'PENDING',
      page: 0,
      limit: 5,
    });

    results['GET /task?userId=6528036269752320&limit=5'] = await testGet('/task?userId=6528036269752320&limit=5');
    results['GET /activity?userId=6528036269752320'] = await testGet('/activity?userId=6528036269752320&limit=5');

    // workspace dashboard usa elasticsearch para tarefas?
    results['POST /workspace/activities'] = await testPost('/workspace/activities', {
      userId: '6528036269752320',
      page: 0,
      limit: 10,
    });

    results['POST /task/all (workspace format)'] = await testPost('/task/all', {
      userId: '6528036269752320',
      status: [],
      page: 0,
      limit: 5,
    });

    return results;
  });

  console.log('\nTestes de listagem de tarefas:');
  for (const [key, val] of Object.entries(taskListTests)) {
    if (val.success) {
      console.log(`✅ ${key}:`);
      console.log(`   ${JSON.stringify(val.body).slice(0, 500)}`);
    } else {
      console.log(`❌ ${key}: ${val.error}`);
    }
  }

  // ── Parte 5: Criação de tarefa via UI ─────────────────────────────────────────
  console.log('\n=== PASSO 5: Tentar criar tarefa via UI ===');
  // Clica no botão de adicionar tarefa
  const addTaskBtn = await page.$('button:has-text("Adicionar"), button:has-text("Nova"), [ng-click*="task"], [ng-click*="Task"]');
  if (addTaskBtn) {
    console.log('Clicando em adicionar tarefa...');
    await addTaskBtn.click();
    await page.waitForTimeout(2000);
  } else {
    console.log('Botão não encontrado via seletor. Tentando via JavaScript...');
    await page.evaluate(() => {
      // Tenta usar o scope para abrir o modal
      const scope = window.angular?.element(document.querySelector('[ng-controller]'))?.scope?.();
      if (scope?.openNewTask) scope.openNewTask();
      else if (scope?.newTask) scope.newTask();
      else if (scope?.createTask) scope.createTask();
    });
    await page.waitForTimeout(2000);
  }

  // Tenta criar tarefa via $http com body realístico
  console.log('\nTentando criar tarefa via $http...');
  const createTaskTest = await page.evaluate(async () => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    if (!http) return { error: 'sem $http' };
    const baseUrl = 'https://app.astrea.net.br/api/v2';

    const payloads = [
      // Payload 1: simples
      { title: 'Teste discovery - pode deletar', userId: '6528036269752320' },
      // Payload 2: com data
      { title: 'Teste discovery - pode deletar', responsibleId: 6528036269752320, dueDate: '2026-03-20' },
      // Payload 3: com folderId
      { name: 'Teste discovery - pode deletar', responsible: 6528036269752320 },
    ];

    const results = {};
    for (const payload of payloads) {
      const key = `POST /task (${JSON.stringify(payload).slice(0, 50)})`;
      try {
        const r = await http.post(`${baseUrl}/task`, payload).then(r => r.data);
        results[key] = { success: true, body: r };
        break; // Para no primeiro que funcionar
      } catch (e) {
        results[key] = {
          status: e.status,
          error: JSON.stringify(e.data?.errorMessage ?? e.data?.statusDescription ?? e.data ?? e.status).slice(0, 200),
        };
      }
    }

    return results;
  });

  console.log('Testes de criação de tarefa:');
  for (const [key, val] of Object.entries(createTaskTest)) {
    if (val.success) {
      console.log(`✅ ${key}:`);
      console.log(`   ${JSON.stringify(val.body).slice(0, 400)}`);
    } else {
      console.log(`❌ ${key}: status=${val.status} - ${val.error}`);
    }
  }

  console.log('\n\n══════════════════════════════════════════════════');
  console.log('SUMÁRIO DE REQUESTS DE ESCRITA CAPTURADAS VIA REDE:');
  console.log('══════════════════════════════════════════════════');
  for (const r of capturedWrites) {
    console.log(`\n${r.method} ${r.path}`);
    if (r.postData) console.log('  Body:', JSON.stringify(r.postData, null, 2).slice(0, 400));
    if (r.response) console.log('  Response:', JSON.stringify(r.response).slice(0, 400));
  }

  console.log('\n✅ Discovery 3 completo. Mantendo aberto 90s para inspeção manual...');
  await page.waitForTimeout(90000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
