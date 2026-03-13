/**
 * Deleta a task de teste criada no discovery 27
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
const TEST_TASK_ID = '4597514431397888';

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(ASTREA_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="Digite seu email"]', { timeout: 15000 });
  await page.fill('input[placeholder="Digite seu email"]', env.ASTREA_EMAIL);
  await page.fill('input[type="password"]', env.ASTREA_PASSWORD);
  await page.click('button:has-text("Entrar")');
  await page.waitForFunction(() => window.location.hash.includes('#/main/'), { timeout: 30000 });
  await page.waitForTimeout(3000);
  console.log('✅ Login OK');

  await page.goto(`${ASTREA_URL}/#/main/workspace/%5B,%5D`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  const result = await page.evaluate(async ({ taskId, userId }) => {
    const svc = window.gapi?.client?.workspace?.taskListService;
    if (!svc) return { err: 'no svc' };

    const call = (method, params, body) => new Promise((resolve, reject) => {
      const req = body !== undefined ? svc[method](params, body) : svc[method](params);
      req.execute(r => r.error ? reject(JSON.stringify(r.error)) : resolve(r));
      setTimeout(() => reject('timeout 12s'), 12000);
    });

    const results = {};

    // loadEditTask para ver os campos do task e versão
    try {
      const task = await call('loadEditTask', {}, { taskId: String(taskId), userId: String(userId) });
      results.loadEditTask = JSON.stringify(task).slice(0, 1000);
      results.version = task.version;
    } catch (e) {
      results.loadEditTaskErr = String(e).slice(0, 200);
    }

    // Tenta deleteTask com versão
    try {
      const r = await call('deleteTask', {}, {
        taskId: String(taskId),
        userId: String(userId),
        taskVersion: results.version || 2,
      });
      results.deleteWithVersion = { success: true, data: JSON.stringify(r).slice(0, 200) };
    } catch (e) {
      results.deleteWithVersionErr = String(e).slice(0, 200);
    }

    if (!results.deleteWithVersion?.success) {
      // Tenta sem versão
      try {
        const r = await call('deleteTask', {}, { taskId: String(taskId), userId: String(userId) });
        results.deleteBasic = { success: true, data: JSON.stringify(r).slice(0, 200) };
      } catch (e) {
        results.deleteBasicErr = String(e).slice(0, 200);
      }
    }

    return results;
  }, { taskId: TEST_TASK_ID, userId: AUTOMATION_USER_ID });

  console.log('Delete result:', JSON.stringify(result, null, 2));

  await browser.close();
}

main().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
