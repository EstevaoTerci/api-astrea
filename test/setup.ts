/**
 * Setup global do Vitest.
 *
 * 1. Stub das variáveis de ambiente exigidas por `src/config/env.ts` antes que
 *    qualquer módulo de produção rode `parseEnv()` na importação. Sem isso, a
 *    importação de `env` lança e a suite inteira morre.
 * 2. Mock global do logger (pino) para silenciar saída em testes. Pode ser
 *    sobrescrito em um teste específico se você precisar inspecionar logs.
 */

import { vi } from 'vitest';

process.env['ASTREA_EMAIL'] = process.env['ASTREA_EMAIL'] ?? 'test@example.com';
process.env['ASTREA_PASSWORD'] = process.env['ASTREA_PASSWORD'] ?? 'test-password';
process.env['API_KEY'] =
  process.env['API_KEY'] ?? 'test-api-key-with-at-least-32-characters-long-aaa';
process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '3000';
process.env['BROWSER_POOL_SIZE'] = '1';
process.env['QUEUE_MAX_SIZE'] = '5';
process.env['QUEUE_TIMEOUT_MS'] = '5000';
process.env['RATE_LIMIT_WINDOW_MS'] = '60000';
process.env['RATE_LIMIT_MAX_REQUESTS'] = '50';

// Mock global do logger — pino-pretty roda em worker thread no NODE_ENV=test
// (porque `isDev !== 'production'`), o que polui o output e atrasa a suite.
// Use `vi.mocked(logger).debug.mock.calls` etc se precisar inspecionar.
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// Silencia console.warn/error/log/info que o código de produção usa em fallback
// (ex.: retry.ts faz console.warn quando não há onRetry). Sobrescrita direta
// (não-spy) sobrevive ao `vi.restoreAllMocks()` que cada teste possa chamar.
const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;
console.error = noop;
