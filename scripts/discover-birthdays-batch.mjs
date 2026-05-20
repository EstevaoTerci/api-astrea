// Discovery: caça endpoints REST do Astrea relacionados a aniversariantes / batch de contatos.
//
// Uso (PowerShell):
//   $env:DISC_EMAIL='seu@email'; $env:DISC_PASS='sua_senha'; node scripts/discover-birthdays-batch.mjs
// Uso (bash):
//   DISC_EMAIL='seu@email' DISC_PASS='sua_senha' node scripts/discover-birthdays-batch.mjs
//
// O browser abre visível. O script faz login, navega para /main, e te dá 5 min
// pra clicar manualmente em telas suspeitas (Lembretes, Agenda, Alertas, Contatos
// com filtro de aniversário). Todas as chamadas para app.astrea.net.br/api/ ficam
// capturadas com body do request E primeiros 2KB do response — salvas num JSON.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const EMAIL = process.env.DISC_EMAIL;
const PASS = process.env.DISC_PASS;

if (!EMAIL || !PASS) {
  console.error('FALTAM credenciais. Defina DISC_EMAIL e DISC_PASS.');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, `birthdays-discovery-${Date.now()}.json`);

const browser = await chromium.launch({
  headless: false,
  args: ['--start-maximized'],
});

const context = await browser.newContext({
  viewport: null,
  locale: 'pt-BR',
  timezoneId: 'America/Sao_Paulo',
});

const page = await context.newPage();

const captured = [];
const pendingResponses = new Map();
let phase = 'init';

// ── Attach listeners em qualquer aba nova aberta no contexto ────────────────
// Necessário porque a "Ficha completa" do Astrea abre em aba nova (target=_blank
// ou window.open). Sem isso, perdemos toda a request da página que renderiza
// os dados completos.
function attachListeners(targetPage, label) {
  targetPage.on('request', (req) => {
    const url = req.url();
    if (!shouldCapture(url)) return;
    const entry = {
      id: captured.length,
      tab: label,
      phase,
      method: req.method(),
      url,
      postData: req.postData()?.slice(0, 3000),
      timestamp: Date.now(),
    };
    captured.push(entry);
    pendingResponses.set(req, entry);
  });

  targetPage.on('response', async (resp) => {
    const req = resp.request();
    const entry = pendingResponses.get(req);
    if (!entry) return;
    pendingResponses.delete(req);
    entry.status = resp.status();
    try {
      const body = await resp.text();
      entry.responseBody = body.slice(0, 5000);
      entry.responseTotalBytes = body.length;
    } catch (err) {
      entry.responseError = String(err);
    }
  });
}

context.on('page', (newPage) => {
  const idx = context.pages().length;
  const label = `tab-${idx}`;
  console.log(`\n[NEW TAB] ${label} → ${newPage.url() || '(loading)'}`);
  attachListeners(newPage, label);
  newPage.on('framenavigated', (frame) => {
    if (frame === newPage.mainFrame()) {
      console.log(`  [${label} navigated] ${frame.url()}`);
    }
  });
});

function shouldCapture(url) {
  // V2: captura TUDO de app.astrea.net.br (não só /api/), pra pegar
  // navegações da "Ficha completa" que podem ser página HTML em outra rota.
  return (
    url.includes('app.astrea.net.br') &&
    !url.includes('/firebase') &&
    !url.includes('/banner-login') &&
    !url.includes('/discovery/v1') &&
    !url.includes('/feature-toggle/') &&
    !url.includes('/has-active') &&
    !url.endsWith('.js') &&
    !url.endsWith('.css') &&
    !url.endsWith('.svg') &&
    !url.endsWith('.png') &&
    !url.endsWith('.woff') &&
    !url.endsWith('.woff2') &&
    !url.endsWith('.ttf')
  );
}

// Attach na aba original
attachListeners(page, 'tab-1');

console.log(`\nOutput será salvo em: ${OUT_FILE}\n`);

// ── 1. Login ────────────────────────────────────────────────────────────────
phase = 'login';
console.log('[1] Navegando para login...');
await page.goto('https://astrea.net.br/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForSelector('input[placeholder*="email" i]', { timeout: 30_000 });
await page.fill('input[placeholder*="email" i]', EMAIL);
await page.fill('input[type="password"]', PASS);
await page.click('button:has-text("ENTRAR")');

await page.waitForFunction(() => location.hash.includes('/main/'), null, { timeout: 60_000 });
console.log('[2] Login OK. URL atual:', page.url());

// Espera SPA terminar carregamento inicial
await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

// ── 2. Interação manual ─────────────────────────────────────────────────────
phase = 'manual';
const INTERACTION_MS = 5 * 60_000;
console.log(`\n=========================================================`);
console.log(`Browser aberto. Você tem ${INTERACTION_MS / 60000} min pra explorar.`);
console.log(`Sugestões:`);
console.log(`  1. Área de trabalho → cards "Lembretes" / "Estatísticas"`);
console.log(`  2. Agenda → procurar "aniversário" no calendário`);
console.log(`  3. Alertas (sino no header) → ver se aniversariantes aparecem`);
console.log(`  4. Contatos → filtrar "Mês de aniversário: Junho"`);
console.log(`  5. Qualquer tela mobile/exportar/relatório`);
console.log(`=========================================================\n`);

const start = Date.now();
const interval = setInterval(() => {
  const elapsed = Math.floor((Date.now() - start) / 1000);
  const remaining = Math.floor((INTERACTION_MS - (Date.now() - start)) / 1000);
  process.stdout.write(`\r[manual] ${elapsed}s decorrido | ${remaining}s restantes | ${captured.length} requests capturados   `);
}, 2000);

await new Promise((r) => setTimeout(r, INTERACTION_MS));
clearInterval(interval);
console.log('\n[3] Tempo de interação encerrado.');

// ── 3. Tira screenshots da tela final como referência ───────────────────────
try {
  await page.screenshot({
    path: join(__dirname, `birthdays-final-screenshot-${Date.now()}.png`),
    fullPage: false,
  });
} catch (err) {
  console.log('Falha ao tirar screenshot:', err.message);
}

// ── 4. Persiste e encerra ───────────────────────────────────────────────────
writeFileSync(
  OUT_FILE,
  JSON.stringify(
    {
      meta: {
        loginEmail: EMAIL,
        capturedAt: new Date().toISOString(),
        totalRequests: captured.length,
        finalUrl: page.url(),
      },
      requests: captured,
    },
    null,
    2,
  ),
  'utf8',
);

console.log(`\n[4] ${captured.length} requests salvas em ${OUT_FILE}`);
console.log('[5] Fechando browser em 5s...');
await new Promise((r) => setTimeout(r, 5000));
await browser.close();
console.log('Pronto.');
