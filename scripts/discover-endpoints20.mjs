/**
 * Discovery PARTE 20 - CAPTURAR payload exato de saveTaskWithList via UI
 * Usar page.route() para interceptar e logar a requisição exata
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
  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Intercepta TODAS as requisições para _ah/api/workspace e loga
  await page.route('**/_ah/api/workspace/**', async (route) => {
    const req = route.request();
    const url = req.url().replace('https://app.astrea.net.br', '');
    const method = req.method();
    const body = req.postData();
    const headers = req.headers();

    if (!url.includes('discovery') && !url.includes('proxy.html')) {
      console.log(`\n🎯 INTERCEPTED: ${method} ${url}`);
      if (body) {
        try {
          console.log('   BODY:', JSON.stringify(JSON.parse(body), null, 2).slice(0, 800));
        } catch {
          console.log('   BODY:', body.slice(0, 400));
        }
      }
      // Log auth headers
      const authHeaders = Object.entries(headers)
        .filter(([k]) => k.toLowerCase().includes('auth') || k.toLowerCase().includes('token') || k.toLowerCase().includes('cookie'))
        .map(([k, v]) => `${k}: ${v.slice(0, 100)}`);
      if (authHeaders.length > 0) console.log('   AUTH HEADERS:', authHeaders.join(', '));
    }

    // Deixa a requisição passar normalmente
    const response = await route.fetch();
    let responseBody;
    try {
      responseBody = await response.json();
    } catch {
      responseBody = null;
    }

    if (!url.includes('discovery') && !url.includes('proxy.html')) {
      console.log(`   RESPONSE ${response.status()}:`, JSON.stringify(responseBody).slice(0, 600));
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

  // Workspace
  console.log('=== Abrindo workspace ===');
  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  // Verifica se o botão está visível
  const taskListInfo = await page.evaluate(() => {
    const taskList = document.querySelector('.task-list, .au-task-list, [class*="workspace-task"]');
    if (!taskList) return { notFound: true };

    const html = taskList.innerHTML.slice(0, 1000);
    const btns = [...taskList.querySelectorAll('button')];
    const allVisibleBtns = [...document.querySelectorAll('button')]
      .filter(b => b.offsetParent !== null)
      .filter(b => (b.textContent?.toLowerCase() || '').includes('tarefa') || (b.textContent?.toLowerCase() || '').includes('adicionar'))
      .map(b => ({
        text: b.textContent?.trim().slice(0, 50),
        cls: b.className?.toString?.().slice(0, 60),
      }));

    return {
      taskListFound: true,
      html: html,
      taskListBtns: btns.map(b => ({ text: b.textContent?.trim(), visible: !!b.offsetParent })),
      allAddBtns: allVisibleBtns,
    };
  });

  console.log('Task list info:', JSON.stringify({
    ...taskListInfo,
    html: taskListInfo.html?.slice(0, 300),
  }, null, 2));

  // Tenta clicar em qualquer botão de adicionar tarefa
  for (const btn of (taskListInfo.allAddBtns || [])) {
    try {
      console.log(`\nTentando clicar: "${btn.text}"`);
      await page.click(`button:has-text("${btn.text?.slice(0, 20)}")`, { timeout: 5000 });
      await page.waitForTimeout(4000);
      console.log('Clicou!');

      // Captura form/modal
      const form = await page.evaluate(() => {
        const visible = [...document.querySelectorAll('[class*="modal"], [class*="panel"], [class*="drawer"], [class*="form"], [class*="popover"]')]
          .filter(el => el.offsetParent !== null && el.querySelectorAll('input, textarea').length > 0);
        return visible.map(el => ({
          cls: el.className?.toString?.().slice(0, 80),
          inputs: [...el.querySelectorAll('input, textarea, select')]
            .map(i => ({ type: i.type, placeholder: i.placeholder, ngModel: i.getAttribute('ng-model') || '', value: i.value })),
          buttons: [...el.querySelectorAll('button')]
            .map(b => ({ text: b.textContent?.trim().slice(0, 30), type: b.type })),
        }));
      });

      if (form.length > 0) {
        console.log('Form encontrado!', JSON.stringify(form, null, 2).slice(0, 1000));

        // Preenche título
        const titleInput = form[0]?.inputs?.find(i =>
          i.placeholder.toLowerCase().includes('título') ||
          i.placeholder.toLowerCase().includes('titulo') ||
          i.ngModel.toLowerCase().includes('title') ||
          i.ngModel.toLowerCase().includes('titulo')
        );

        if (titleInput) {
          const selector = titleInput.ngModel
            ? `input[ng-model="${titleInput.ngModel}"]`
            : `input[placeholder="${titleInput.placeholder}"]`;
          await page.fill(selector, 'TESTE AUTOMAÇÃO - PODE DELETAR');
          await page.waitForTimeout(500);

          // Submete
          const saveBtnEl = await page.$('button[type="submit"], button:has-text("Salvar"), button:has-text("Adicionar"), button:has-text("Criar")');
          if (saveBtnEl && await saveBtnEl.isVisible()) {
            console.log('Submetendo formulário...');
            await saveBtnEl.click();
            await page.waitForTimeout(5000);
            console.log('Formulário submetido! Verificar GCP requests acima.');
          }
        }
        break;
      }
    } catch (err) {
      console.log('Erro ao clicar:', err.message?.slice(0, 100));
    }
  }

  // Se não achou botão, tenta via scope Angular
  console.log('\n=== Tentando via scope Angular ===');
  const scopeResult = await page.evaluate(async (userId) => {
    const el = document.querySelector('.task-list');
    const scope = window.angular?.element(el)?.isolateScope?.() || window.angular?.element(el)?.scope?.();
    const ctrl = scope?.$ctrl;
    if (!ctrl) return { err: 'no ctrl' };

    // Verifica métodos disponíveis
    return {
      ctrlMethods: Object.keys(ctrl).filter(k => typeof ctrl[k] === 'function'),
      taskListId: ctrl.data?.taskList?.id,
      isCollapsed: ctrl.isCollapsed,
    };
  }, AUTOMATION_USER_ID);
  console.log('Scope ctrl methods:', JSON.stringify(scopeResult));

  // Tenta chamar saveTaskWithList diretamente via Angular service
  console.log('\n=== Tentando via taskListService._executeAction ===');
  const executeResult = await page.evaluate(async (userId) => {
    const injector = window.angular?.element(document.body)?.injector?.();
    const svc = injector?.get('taskListService');
    if (!svc) return { err: 'no service' };

    const taskListId = '6465761223671808';

    return new Promise((resolve) => {
      try {
        // _executeAction chama window.fn() diretamente
        // Mas saveTaskWithList não está no registry do window.fn
        // Então vamos chamar diretamente via gapi
        const gapi = window.gapi?.client?.workspace?.taskListService;
        if (!gapi?.saveTaskWithList) {
          resolve({ err: 'no gapi.saveTaskWithList' });
          return;
        }

        // Tenta com o request token (se houver)
        const token = window.gapi?.auth?.getToken?.();
        resolve({ gapiToken: token ? 'exists' : 'null', tokenValue: JSON.stringify(token).slice(0, 100) });
      } catch (e) {
        resolve({ err: e.message?.slice(0, 200) });
      }
    });
  }, AUTOMATION_USER_ID);
  console.log('Execute result:', JSON.stringify(executeResult));

  console.log('\n✅ Discovery 20 completo. Mantendo 90s...');
  await page.waitForTimeout(90000);
  await browser.close();
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
