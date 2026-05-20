import express, { type Express, type RequestHandler } from 'express';

/**
 * Cria um mini-app Express isolado para testes de middleware e rotas.
 *
 * Não importa `src/server.ts` deliberadamente — `server.ts` instancia o
 * `browserPool` (Playwright) e cria handlers de SIGINT/SIGTERM, o que polui
 * o ambiente de teste. Aqui montamos só o que cada teste pediu.
 */
export function buildApp(setup: (app: Express) => void): Express {
  const app = express();
  app.use(express.json());
  setup(app);
  return app;
}

/**
 * Atalho: cria app com um único middleware + um handler dummy em GET /test
 * que devolve `{ ok: true }`. Útil para validar 401/403 vs passthrough.
 */
export function buildAppWith(
  middleware: RequestHandler,
  options?: { protectedHandler?: RequestHandler },
): Express {
  return buildApp((app) => {
    app.get(
      '/test',
      middleware,
      options?.protectedHandler ?? ((_req, res) => res.json({ ok: true })),
    );
  });
}
