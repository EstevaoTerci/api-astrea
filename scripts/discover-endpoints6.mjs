/**
 * Discovery PARTE 6 — estrutura de consulting existente + criar tarefa da workspace
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
  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('/api/v2')) return;
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method())) return;
    const skip = ['alerts', 'session', 'clipping', 'analytical', 'honorary', 'search/token', 'contact/all', 'suggests'];
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
    const skip = ['alerts', 'session', 'clipping', 'analytical', 'honorary', 'search/token', 'contact/all', 'suggests'];
    if (skip.some(s => url.includes(s))) return;
    const path = url.replace('https://app.astrea.net.br', '');
    const status = res.status();
    try {
      const body = await res.json();
      console.log(`📥 ${status} ${res.request().method()} ${path}`);
      console.log('   Resp:', JSON.stringify(body, null, 2).slice(0, 1000));
    } catch { console.log(`📥 ${status} ${res.request().method()} ${path}`); }
  });

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

  // ── PASSO 1: Inspecionar um consulting existente ──────────────────────────────
  console.log('\n=== PASSO 1: Inspecionar consulting existente ===');
  const existingConsulting = await page.evaluate(async (userId) => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    const baseUrl = 'https://app.astrea.net.br/api/v2';

    // Lista os primeiros 3 consultings
    try {
      const list = await http.post(`${baseUrl}/consulting/query`, {
        status: '', tagIds: [], subject: '', consultingId: null,
        customerId: null, order: '-createDate', caseAttached: null,
        limit: 3, createdAt: null, dateBegin: null, dateEnd: null, cursor: '',
      }).then(r => r.data);

      const items = list.consultingDTO || [];
      if (!items.length) return { empty: true };

      // GET no primeiro para ver estrutura completa
      const first = items[0];
      let fullItem;
      try {
        fullItem = await http.get(`${baseUrl}/consulting/${first.id}`).then(r => r.data);
      } catch (e) {
        fullItem = { getError: `${e.status}: ${JSON.stringify(e.data)}` };
      }

      return { listItem: first, fullItem };
    } catch (e) {
      return { error: `${e.status}: ${JSON.stringify(e.data)}` };
    }
  }, AUTOMATION_USER_ID);

  console.log('Consulting existente:', JSON.stringify(existingConsulting, null, 2).slice(0, 3000));

  // ── PASSO 2: Criar consulting replicando estrutura exata ─────────────────────
  console.log('\n=== PASSO 2: Criar consulting replicando estrutura exata ===');
  if (existingConsulting.listItem) {
    const template = existingConsulting.listItem;
    const full = existingConsulting.fullItem;

    const payload = {
      active: true,
      messages: full.messages !== undefined ? [] : undefined,
      consultingHistories: full.consultingHistories !== undefined ? [] : undefined,
      customers: [{ id: ESTEVAO_CLIENT_CONTACT_ID, main: true, photo: '', telephone: '' }],
      responsibleId: AUTOMATION_USER_ID,
      ownerId: AUTOMATION_USER_ID,
      date: full.date || template.date || '2026-03-20',
      time: full.time || template.time || '10:00',
      subject: 'TESTE AUTOMAÇÃO - PODE DELETAR',
      description: '',
      tagIds: [],
      caseAttached: null,
      status: full.status || template.status || '',
    };

    // Remove undefined
    for (const k of Object.keys(payload)) {
      if (payload[k] === undefined) delete payload[k];
    }

    const createResult = await page.evaluate(async (p) => {
      const http = window.angular?.element(document.body)?.injector()?.get('$http');
      const baseUrl = 'https://app.astrea.net.br/api/v2';
      try {
        const r = await http.post(`${baseUrl}/consulting`, p).then(r => r.data);
        return { success: true, body: r };
      } catch (e) {
        return { status: e.status, error: JSON.stringify(e.data).slice(0, 300) };
      }
    }, payload);

    console.log('Create result:', JSON.stringify(createResult, null, 2).slice(0, 1000));

    if (createResult.success && createResult.body?.id) {
      console.log(`✅ CONSULTING CRIADO! ID: ${createResult.body.id}`);
      // Deleta imediatamente
      await page.evaluate(async (id) => {
        const http = window.angular?.element(document.body)?.injector()?.get('$http');
        const baseUrl = 'https://app.astrea.net.br/api/v2';
        try { await http.delete(`${baseUrl}/consulting/${id}`).then(r => r.data); }
        catch (e) {
          try { await http.patch(`${baseUrl}/consulting/${id}`, { active: false }); } catch {}
        }
      }, createResult.body.id);
      console.log('Deletado.');
    }
  }

  // ── PASSO 3: Criar tarefa a partir da página workspace ────────────────────────
  console.log('\n=== PASSO 3: Criar tarefa a partir da workspace ===');
  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Tenta criar tarefa a partir daqui
  const createTaskWS = await page.evaluate(async ({ contactId, userId }) => {
    const http = window.angular?.element(document.body)?.injector()?.get('$http');
    if (!http) return { error: 'sem $http' };
    const baseUrl = 'https://app.astrea.net.br/api/v2';
    const results = {};

    const tryPost = async (key, payload) => {
      try {
        const r = await http.post(`${baseUrl}/task`, payload).then(r => r.data);
        results[key] = { success: true, body: r };
      } catch (e) {
        results[key] = { status: e.status, error: JSON.stringify(e.data?.errorMessage ?? e.data).slice(0, 200) };
      }
    };

    // Formato 1: minimal
    await tryPost('minimal', { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', responsibleId: userId });
    if (results.minimal.success) return results;

    // Formato 2: com folderId (caso)
    // Primeiro precisa saber um folderId do ESTEVAO...
    // Tenta buscar casos do Estevao via $state
    await tryPost('comData', { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', responsibleId: userId, dueDate: '2026-03-20' });
    if (results.comData.success) return results;

    await tryPost('comStatus', { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', responsibleId: userId, status: 'PENDING' });
    if (results.comStatus.success) return results;

    await tryPost('comTudo', {
      title: 'TESTE AUTOMAÇÃO - PODE DELETAR',
      responsibleId: userId,
      customerId: contactId,
      dueDate: '2026-03-20',
      status: 'PENDING',
      description: 'Discovery',
    });

    return results;
  }, { contactId: ESTEVAO_CLIENT_CONTACT_ID, userId: AUTOMATION_USER_ID });

  console.log('Create task results:', JSON.stringify(createTaskWS, null, 2).slice(0, 1000));

  // Se sucesso, deleta
  for (const [k, v] of Object.entries(createTaskWS)) {
    if (v.success && v.body?.id) {
      console.log(`✅ TAREFA CRIADA! ID: ${v.body.id}`);
      console.log('Estrutura:', JSON.stringify(v.body, null, 2).slice(0, 500));
      await page.evaluate(async (id) => {
        const http = window.angular?.element(document.body)?.injector()?.get('$http');
        const baseUrl = 'https://app.astrea.net.br/api/v2';
        try { await http.delete(`${baseUrl}/task/${id}`).then(r => r.data); }
        catch (e) { console.log('Erro ao deletar:', e.status); }
      }, v.body.id);
      console.log('Deletada.');
    }
  }

  console.log('\n✅ Discovery 6 completo. Mantendo 120s...');
  await page.waitForTimeout(120000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
