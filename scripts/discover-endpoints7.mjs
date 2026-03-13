/**
 * Discovery PARTE 7:
 * 1. Deletar consulting de teste (ID: 6752082057527296)
 * 2. Descobrir endpoint de tarefas via fetch() nativo (sem Angular $http)
 * 3. Descobrir a estrutura de update de consulting
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
const TEST_CONSULTING_ID = 6752082057527296; // Criado nos scripts anteriores

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

  // ── PASSO 1: Deletar consulting de teste ──────────────────────────────────────
  console.log('=== PASSO 1: Deletar consulting de teste ===');
  const deleteResult = await page.evaluate(async (id) => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    const baseUrl = 'https://app.astrea.net.br/api/v2';
    try {
      const r = await http.delete(`${baseUrl}/consulting/${id}`).then(r => r.data);
      return { deleted: true, body: r };
    } catch (e) {
      // Tenta inativar
      try {
        const r2 = await http.patch(`${baseUrl}/consulting/${id}`, { active: false }).then(r => r.data);
        return { patched: true, body: r2 };
      } catch (e2) {
        // Tenta PUT com active: false
        try {
          const existing = await http.get(`${baseUrl}/consulting/${id}`).then(r => r.data);
          const r3 = await http.put(`${baseUrl}/consulting/${id}`, { ...existing, active: false }).then(r => r.data);
          return { put: true, body: r3 };
        } catch (e3) {
          return {
            deleteErr: `${e.status}: ${JSON.stringify(e.data)}`,
            patchErr: `${e2.status}: ${JSON.stringify(e2.data)}`,
            putErr: `${e3.status}: ${JSON.stringify(e3.data)}`,
          };
        }
      }
    }
  }, TEST_CONSULTING_ID);
  console.log('Delete consulting result:', JSON.stringify(deleteResult, null, 2));

  // ── PASSO 2: Descobrir endpoint de tarefas via fetch nativo ──────────────────
  console.log('\n=== PASSO 2: Endpoints de tarefa via fetch nativo ===');
  const taskDiscovery = await page.evaluate(async (userId) => {
    const baseUrl = 'https://app.astrea.net.br/api/v2';
    const results = {};

    const tryFetch = async (method, path, body) => {
      const key = `${method} ${path}`;
      try {
        const opts = {
          method,
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(`${baseUrl}${path}`, opts);
        let json;
        try { json = await res.json(); } catch { json = null; }
        results[key] = { status: res.status, body: json };
      } catch (e) {
        results[key] = { error: String(e) };
      }
    };

    // Tarefas — vários endpoints possíveis
    await tryFetch('GET', `/task?userId=${userId}&limit=5`);
    await tryFetch('GET', `/task/${userId}`);
    await tryFetch('POST', '/task/query', { page: 0, limit: 5 });
    await tryFetch('POST', '/task/filter', { page: 0, limit: 5, userId });
    await tryFetch('GET', `/workspace-task?userId=${userId}`);
    await tryFetch('GET', `/workspace/task?userId=${userId}`);

    // Workspace
    await tryFetch('POST', '/workspace/activities', { userId: String(userId), page: 0, limit: 10 });
    await tryFetch('GET', `/workspace?userId=${userId}`);

    // Calendar tasks
    await tryFetch('POST', '/calendar-pro/complete', {
      from: '20260101', to: '20261231',
      userId: String(userId),
      cursors: { deadlineCursor: '', eventCursor: '', hearingCursor: '', taskCursor: '' },
      query: {
        cases: [], customers: [], tasks: [], appointments: [],
        deadlines: [], hearings: [],
        appointmentSelected: false, deadlineSelected: false,
        hearingSelected: false, eventSelected: false,
        taskSelected: true, taskStatus: ['PENDING', 'IN_PROGRESS'],
      },
    });

    return results;
  }, AUTOMATION_USER_ID);

  console.log('\nResultados:');
  for (const [key, val] of Object.entries(taskDiscovery)) {
    const s = val.error ? `ERR: ${val.error}` : val.status;
    console.log(`  ${key} → ${s}`);
    if (val.status === 200) {
      console.log(`    ${JSON.stringify(val.body).slice(0, 500)}`);
    } else if (val.body && val.status !== 200) {
      console.log(`    ${JSON.stringify(val.body).slice(0, 200)}`);
    }
  }

  // ── PASSO 3: Criar tarefa via fetch nativo ────────────────────────────────────
  console.log('\n=== PASSO 3: Criar tarefa via fetch nativo ===');
  const createTaskFetch = await page.evaluate(async ({ contactId, userId }) => {
    const baseUrl = 'https://app.astrea.net.br/api/v2';
    const results = {};

    const tryCreate = async (key, payload) => {
      try {
        const res = await fetch(`${baseUrl}/task`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(payload),
        });
        let json;
        try { json = await res.json(); } catch { json = null; }
        results[key] = { status: res.status, body: json };
      } catch (e) {
        results[key] = { error: String(e) };
      }
    };

    await tryCreate('minimal', { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', responsibleId: userId });
    await tryCreate('comDueDate', { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', responsibleId: userId, dueDate: '2026-03-20' });
    await tryCreate('comCustomer', { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', responsibleId: userId, customerId: contactId });
    await tryCreate('comStatus', { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', responsibleId: userId, status: 'PENDING' });

    return results;
  }, { contactId: ESTEVAO_CLIENT_CONTACT_ID, userId: AUTOMATION_USER_ID });

  console.log('\nResultados criação via fetch:');
  for (const [key, val] of Object.entries(createTaskFetch)) {
    console.log(`  ${key} → ${val.error || val.status}`);
    if (val.body) console.log(`    ${JSON.stringify(val.body).slice(0, 400)}`);
  }

  // Deleta tarefas criadas com sucesso
  for (const [k, v] of Object.entries(createTaskFetch)) {
    if (v.status === 200 || v.status === 201) {
      const id = v.body?.id;
      if (id) {
        console.log(`Deletando tarefa ${id}...`);
        await page.evaluate(async (tid) => {
          await fetch(`https://app.astrea.net.br/api/v2/task/${tid}`, {
            method: 'DELETE', credentials: 'include',
          });
        }, id);
      }
    }
  }

  // ── PASSO 4: Navegar para módulo de tarefas e capturar requests ──────────────
  console.log('\n=== PASSO 4: Módulo de tarefas e workspace ===');
  // Monitora requests ao carregar workspace
  const taskRequests = [];
  const onReq = (req) => {
    const url = req.url();
    if (!url.includes('/api/v2')) return;
    const path = url.replace('https://app.astrea.net.br', '');
    taskRequests.push({ method: req.method(), path: path.split('?')[0] });
  };
  page.on('request', onReq);

  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  page.removeListener('request', onReq);

  const unique = new Set();
  for (const r of taskRequests) {
    const key = `${r.method} ${r.path}`;
    if (!unique.has(key)) {
      unique.add(key);
      console.log(`  ${key}`);
    }
  }

  console.log('\n✅ Discovery 7 completo. Mantendo 120s...');
  await page.waitForTimeout(120000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
