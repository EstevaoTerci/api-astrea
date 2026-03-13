/**
 * Discovery PARTE 21 - Resolver "User.getI18n() null"
 * 1. Navega para workspace para inicializar gapi.client
 * 2. Pega user object do Angular session
 * 3. Tenta saveTaskWithList com user object completo
 * 4. Verifica gapi OAuth token
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
const TASK_LIST_ID = '6465761223671808';

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Intercept ALL GCP workspace requests com page.route para ver headers completos
  await page.route('**/_ah/api/workspace/**', async (route) => {
    const req = route.request();
    const url = req.url().replace('https://app.astrea.net.br', '');
    const method = req.method();
    const body = req.postData();
    if (!url.includes('discovery') && !url.includes('proxy.html')) {
      console.log(`\n🎯 ROUTE: ${method} ${url}`);
      if (body) {
        try { console.log('   BODY:', JSON.stringify(JSON.parse(body), null, 2).slice(0, 1000)); }
        catch { console.log('   BODY:', body.slice(0, 400)); }
      }
      const authH = Object.entries(req.headers())
        .filter(([k]) => k.match(/auth|token|cookie|x-/i))
        .map(([k, v]) => `${k}: ${v.slice(0, 80)}`);
      if (authH.length) console.log('   HEADERS:', authH.slice(0, 5).join(' | '));
    }
    const response = await route.fetch();
    if (!url.includes('discovery') && !url.includes('proxy.html')) {
      try {
        const rb = await response.json();
        console.log(`   RESP ${response.status()}:`, JSON.stringify(rb).slice(0, 600));
      } catch {}
    }
    await route.fulfill({ response });
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

  // Navega para workspace para carregar gapi.client.workspace
  console.log('=== Navegando para workspace ===');
  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  // ── PASSO 1: Inspeciona gapi e pega user do Angular ──────────────────────────
  console.log('=== PASSO 1: Inspeciona gapi e Angular session user ===');
  const gapiAndUser = await page.evaluate((userId) => {
    const result = {};

    // gapi token
    try {
      const token = window.gapi?.auth?.getToken?.();
      result.gapiToken = token ? { exists: true, keys: Object.keys(token), accessToken: token.access_token?.slice(0, 30) } : 'null/undefined';
    } catch (e) {
      result.gapiTokenErr = String(e).slice(0, 100);
    }

    // gapi.client keys
    try {
      result.gapiClientKeys = Object.keys(window.gapi?.client || {});
    } catch {}

    // gapi.client.workspace.taskListService methods
    try {
      result.taskListServiceMethods = Object.keys(window.gapi?.client?.workspace?.taskListService || {});
    } catch {}

    // Angular session user
    try {
      const injector = window.angular?.element(document.body)?.injector?.();
      const session = injector?.get('session');
      result.sessionServiceKeys = session ? Object.keys(session) : 'no session service';

      // Tenta pegar o user do session
      if (session) {
        const user = session.user || session.currentUser || session.getUser?.() || session.data?.user;
        result.sessionUser = user ? JSON.stringify(user).slice(0, 500) : 'no user in session';

        // Tenta outros padrões de acesso
        const allKeys = Object.keys(session);
        const userLike = allKeys.filter(k => k.toLowerCase().includes('user') || k.toLowerCase().includes('current'));
        result.sessionUserLikeKeys = userLike;

        for (const k of userLike) {
          if (session[k]) result[`session_${k}`] = JSON.stringify(session[k]).slice(0, 300);
        }
      }
    } catch (e) {
      result.sessionErr = String(e).slice(0, 200);
    }

    // Tenta localStorage/sessionStorage para o user
    try {
      const storageKeys = Object.keys(localStorage);
      const userKeys = storageKeys.filter(k => k.toLowerCase().includes('user') || k.toLowerCase().includes('session'));
      result.localStorageUserKeys = userKeys;
      for (const k of userKeys.slice(0, 3)) {
        result[`ls_${k}`] = String(localStorage.getItem(k)).slice(0, 300);
      }
    } catch {}

    // Redux store no workspace
    try {
      const el = document.querySelector('[ng-app]');
      const scope = window.angular?.element(el)?.scope?.();
      if (scope?.store) {
        const state = scope.store.getState();
        result.reduxState = JSON.stringify(state).slice(0, 500);
      }
    } catch {}

    return result;
  }, AUTOMATION_USER_ID);

  console.log('gapi & user:', JSON.stringify(gapiAndUser, null, 2).slice(0, 3000));
  await page.waitForTimeout(1000);

  // ── PASSO 2: Tenta getAllUsers no workspace ────────────────────────────────────
  console.log('\n=== PASSO 2: getAllUsers via gapi.client.users ===');
  const allUsers = await page.evaluate(async ({ tenantId, userId }) => {
    const svc = window.gapi?.client?.users;
    if (!svc) return { err: 'gapi.client.users not available', clientKeys: Object.keys(window.gapi?.client || {}) };

    const usersKeys = Object.keys(svc);
    const call = (method, params, body) => new Promise((resolve, reject) => {
      const req = body !== undefined ? svc[method](params, body) : svc[method](params);
      req.execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
      setTimeout(() => reject('timeout 10s'), 10000);
    });

    try {
      const r = await call('getAllUsers', { tenantId }, {});
      const users = r.users || r.items || [];
      const me = users.find(u => String(u.id) === String(userId));
      return { total: users.length, me, usersKeys, first2: users.slice(0, 2) };
    } catch (e) {
      return { err: String(e).slice(0, 300), usersKeys };
    }
  }, { tenantId: '6692712561442816', userId: AUTOMATION_USER_ID });

  console.log('getAllUsers:', JSON.stringify(allUsers, null, 2).slice(0, 2000));
  const fullUser = allUsers.me;
  await page.waitForTimeout(1000);

  // ── PASSO 3: saveTaskWithList com user object do Angular session ──────────────
  console.log('\n=== PASSO 3: saveTaskWithList com diferentes user objects ===');
  const saveResults = await page.evaluate(async ({ userId, taskListId, fullUser }) => {
    const svc = window.gapi?.client?.workspace?.taskListService;
    if (!svc) return { err: 'no svc' };

    const injector = window.angular?.element(document.body)?.injector?.();

    // Tenta pegar session user via Angular
    let sessionUser = null;
    try {
      const session = injector?.get('session');
      if (session) {
        sessionUser = session.user || session.currentUser || session.data?.user;
        if (!sessionUser) {
          for (const k of Object.keys(session)) {
            const v = session[k];
            if (v && typeof v === 'object' && (v.id || v.email)) {
              sessionUser = v;
              break;
            }
          }
        }
      }
    } catch {}

    const call = (method, params, body) => new Promise((resolve, reject) => {
      const req = body !== undefined ? svc[method](params, body) : svc[method](params);
      req.execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
      setTimeout(() => reject('timeout 12s'), 12000);
    });

    const results = { sessionUser: sessionUser ? JSON.stringify(sessionUser).slice(0, 300) : 'null' };

    const variants = [
      // 1. sessionUser in taskInfoDTO.user
      {
        key: 'session_user_obj',
        body: {
          taskInfoDTO: { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', user: sessionUser },
          taskListId: String(taskListId),
          userId: String(userId),
        },
      },
      // 2. fullUser from getAllUsers in taskInfoDTO.user
      {
        key: 'full_user_obj',
        body: {
          taskInfoDTO: { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', user: fullUser },
          taskListId: String(taskListId),
          userId: String(userId),
        },
      },
      // 3. só title (sem user/responsible)
      {
        key: 'title_only',
        body: {
          taskInfoDTO: { title: 'TESTE AUTOMAÇÃO - PODE DELETAR' },
          taskListId: String(taskListId),
          userId: String(userId),
        },
      },
      // 4. taskInfoDTO com responsibleId como número
      {
        key: 'responsible_number',
        body: {
          taskInfoDTO: { title: 'TESTE AUTOMAÇÃO - PODE DELETAR', responsibleId: userId },
          taskListId: String(taskListId),
          userId: String(userId),
        },
      },
    ];

    for (const v of variants) {
      if (v.body.taskInfoDTO?.user === null || v.body.taskInfoDTO?.user === undefined) {
        if (v.key !== 'title_only') continue; // skip if user is null (except title_only)
      }
      try {
        const r = await call('saveTaskWithList', {}, v.body);
        results[v.key] = { success: true, data: JSON.stringify(r).slice(0, 600) };
        const taskId = r.id || r.taskInfoDTO?.id || r.taskId;
        if (taskId) {
          try { await call('deleteTask', {}, { taskId: String(taskId), userId: String(userId) }); } catch {}
        }
        break;
      } catch (e) {
        results[v.key] = { err: String(e).slice(0, 250) };
      }
    }

    return results;
  }, { userId: AUTOMATION_USER_ID, taskListId: TASK_LIST_ID, fullUser: fullUser || null });

  console.log('Save results:', JSON.stringify(saveResults, null, 2).slice(0, 3000));
  await page.waitForTimeout(1000);

  // ── PASSO 4: Tenta criar task clicando na UI e capturando request ─────────────
  console.log('\n=== PASSO 4: Clicar UI para criar task ===');
  const uiBtns = await page.evaluate(() => {
    return [...document.querySelectorAll('button')]
      .filter(b => b.offsetParent !== null)
      .map(b => ({ text: b.textContent?.trim().slice(0, 60), cls: b.className?.toString?.().slice(0, 60) }))
      .filter(b => b.text);
  });
  console.log('Buttons:', JSON.stringify(uiBtns.slice(0, 10)));

  const addBtn = uiBtns.find(b =>
    b.text.toLowerCase().includes('tarefa') ||
    b.text.toLowerCase().includes('adicionar') ||
    b.text.toLowerCase().includes('+')
  );

  if (addBtn) {
    console.log(`Clicando: "${addBtn.text}"`);
    try {
      await page.click(`button:has-text("${addBtn.text.slice(0, 25)}")`, { timeout: 5000 });
      await page.waitForTimeout(4000);

      const inputs = await page.evaluate(() =>
        [...document.querySelectorAll('input, textarea')]
          .filter(el => el.offsetParent !== null)
          .map(el => ({ type: el.type, placeholder: el.placeholder, ngModel: el.getAttribute('ng-model') || '' }))
      );
      console.log('Form inputs:', JSON.stringify(inputs));

      // Tenta preencher e submeter
      if (inputs.length > 0) {
        const titleInput = inputs.find(i =>
          i.placeholder.toLowerCase().includes('título') ||
          i.placeholder.toLowerCase().includes('titulo') ||
          i.ngModel.toLowerCase().includes('title')
        ) || inputs[0];

        const sel = titleInput.ngModel ? `input[ng-model="${titleInput.ngModel}"]` : `input[type="${titleInput.type}"]`;
        await page.fill(sel, 'TESTE AUTOMAÇÃO - PODE DELETAR');
        await page.waitForTimeout(500);

        const saveBtn = await page.$('button[type="submit"], button:has-text("Salvar"), button:has-text("Confirmar"), button:has-text("Adicionar"), button:has-text("Criar")');
        if (saveBtn && await saveBtn.isVisible()) {
          console.log('Submetendo...');
          await saveBtn.click();
          await page.waitForTimeout(5000);
          console.log('Formulário submetido! Ver GCP requests acima (interceptados por page.route).');
        }
      }
    } catch (err) {
      console.log('Erro:', err.message?.slice(0, 100));
    }
  } else {
    console.log('Nenhum botão de adicionar tarefa encontrado.');
    // Dump all content para diagnóstico
    const pageContent = await page.evaluate(() => {
      return {
        taskListCount: document.querySelectorAll('.task-list, au-task-list').length,
        mainContent: document.querySelector('[ui-view="content"], .main-content, main')?.innerHTML?.slice(0, 500) || '',
        h1s: [...document.querySelectorAll('h1, h2, h3')].map(h => h.textContent?.trim()).slice(0, 5),
      };
    });
    console.log('Page content:', JSON.stringify(pageContent));
  }

  console.log('\n✅ Discovery 21 completo. Mantendo 20s...');
  await page.waitForTimeout(20000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
