import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { browserPool } from './browser/pool.js';
import { apiKeyAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/error-handler.js';
import { rateLimiter } from './middleware/rate-limiter.js';

// Rotas
import healthRoutes from './routes/health.routes.js';
import clientesRoutes from './routes/clientes.routes.js';
import casosRoutes from './routes/casos.routes.js';
import andamentosRoutes from './routes/andamentos.routes.js';
import tarefasRoutes from './routes/tarefas.routes.js';
import publicacoesRoutes from './routes/publicacoes.routes.js';

const app = express();

// ─────────────────────────────────────────────────────────────────────────────
// Segurança e parsing
// ─────────────────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: env.NODE_ENV === 'production' ? false : '*',
    methods: ['GET'],
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting (global, exceto /health)
// ─────────────────────────────────────────────────────────────────────────────
app.use(rateLimiter);

// ─────────────────────────────────────────────────────────────────────────────
// Health check — sem autenticação
// ─────────────────────────────────────────────────────────────────────────────
app.use('/health', healthRoutes);

// ─────────────────────────────────────────────────────────────────────────────
// Rotas protegidas por API Key
// ─────────────────────────────────────────────────────────────────────────────
app.use('/api', apiKeyAuth);
app.use('/api/clientes', clientesRoutes);
app.use('/api/casos', casosRoutes);
app.use('/api/andamentos', andamentosRoutes);
app.use('/api/tarefas', tarefasRoutes);
app.use('/api/publicacoes', publicacoesRoutes);

// Rota catch-all para 404
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint não encontrado.', code: 'NOT_FOUND' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handler global (deve ser o último middleware)
// ─────────────────────────────────────────────────────────────────────────────
app.use(errorHandler);

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  try {
    logger.info('Iniciando API Astrea...');

    // Inicializa o pool de browser antes de aceitar requisições
    await browserPool.initialize();

    const server = app.listen(env.PORT, () => {
      logger.info(
        {
          port: env.PORT,
          env: env.NODE_ENV,
          poolSize: env.BROWSER_POOL_SIZE,
        },
        `API Astrea rodando em http://localhost:${env.PORT}`,
      );
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Graceful shutdown
    // ─────────────────────────────────────────────────────────────────────────
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Sinal de encerramento recebido. Encerrando...');

      server.close(async () => {
        await browserPool.shutdown();
        logger.info('API encerrada com sucesso.');
        process.exit(0);
      });

      // Força encerramento após 30s se não fechar elegantemente
      setTimeout(() => {
        logger.error('Timeout de graceful shutdown. Forçando encerramento.');
        process.exit(1);
      }, 30000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.fatal({ err }, 'Falha ao iniciar a API.');
    process.exit(1);
  }
}

start();
