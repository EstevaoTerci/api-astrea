import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { browserPool } from '../browser/pool.js';
import { logger } from '../utils/logger.js';
import { createMcpServer } from './create-mcp-server.js';

async function main() {
  const server = createMcpServer();

  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('Servidor MCP Astrea iniciado via stdio');

    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Encerrando servidor MCP Astrea...');
      await server.close().catch((err) => {
        logger.warn({ err }, 'Falha ao encerrar sessão MCP stdio.');
      });
      await browserPool.shutdown().catch((err) => {
        logger.warn({ err }, 'Falha ao encerrar browser pool do MCP.');
      });
      process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (err) {
    logger.fatal({ err }, 'Falha ao iniciar servidor MCP');
    process.exit(1);
  }
}

main();
