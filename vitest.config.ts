import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'coverage'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/server.ts',
        'src/mcp/**',
        // Infra de browser/log/email/llm — não unit-testáveis sem Playwright real.
        'src/utils/logger.ts',
        'src/utils/mailer.ts',
        'src/utils/llm-navigator.ts',
        'src/browser/pool.ts',
        'src/browser/session.ts',
        'src/browser/navigator.ts',
        'src/browser/astrea-http.ts',
        // Tipos/modelos puros (sem código executável).
        'src/types/**',
        'src/models/**',
        // ─────────────────────────────────────────────────────────────────────
        // TODO(TDD): mover esses arquivos de volta pra cobertura conforme
        // a suite for crescendo. Cada vez que alguém adicionar testes para um
        // service/route abaixo, remova a entrada correspondente desta lista —
        // o threshold global vai validar o ganho automaticamente.
        // ─────────────────────────────────────────────────────────────────────
        'src/services/agenda.service.ts',
        'src/services/andamentos.service.ts',
        'src/services/atendimentos.service.ts',
        'src/services/casos.service.ts',
        'src/services/documentos.service.ts',
        'src/services/kanban.service.ts',
        'src/services/publicacoes.service.ts',
        'src/services/tarefas.service.ts',
        'src/services/usuarios.service.ts',
        'src/routes/agenda.routes.ts',
        'src/routes/andamentos.routes.ts',
        'src/routes/atendimentos.routes.ts',
        'src/routes/casos.routes.ts',
        'src/routes/kanban.routes.ts',
        'src/routes/mcp.routes.ts',
        'src/routes/publicacoes.routes.ts',
        'src/routes/tarefas.routes.ts',
        'src/routes/usuarios.routes.ts',
      ],
      thresholds: {
        // Threshold sobre o ESCOPO ATUAL da suite (utils + middleware +
        // request-queue + clientes service/routes + health). Conforme novos
        // services/routes ganharem testes via TDD e saírem do `exclude` acima,
        // este número deve ser preservado/elevado — não baixado.
        lines: 70,
        functions: 70,
        branches: 65,
        statements: 70,
      },
    },
  },
});
