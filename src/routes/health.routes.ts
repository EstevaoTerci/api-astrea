import { Router, Request, Response } from 'express';
import { browserPool } from '../browser/pool.js';

const router = Router();

/** GET /health — sem autenticação */
router.get('/', (_req: Request, res: Response) => {
  const { pool: poolStats, queue: queueStats } = browserPool.stats;

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    pool: poolStats,
    queue: queueStats,
    memory: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      unit: 'MB',
    },
  });
});

export default router;
