import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from '../utils/logger.js';
import { createMcpServer } from '../mcp/create-mcp-server.js';

type McpSession = {
  server: ReturnType<typeof createMcpServer>;
  transport: StreamableHTTPServerTransport;
};

const MCP_SESSION_HEADER = 'mcp-session-id';
const sessions = new Map<string, McpSession>();

function getSessionId(req: Request): string | undefined {
  const header = req.headers[MCP_SESSION_HEADER];
  return typeof header === 'string' ? header : undefined;
}

async function createSession(): Promise<McpSession> {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, { server, transport });
      logger.info({ sessionId }, 'Sessao MCP HTTP inicializada');
    },
    onsessionclosed: async (sessionId) => {
      sessions.delete(sessionId);
      await server.close().catch((err) => {
        logger.warn({ err, sessionId }, 'Falha ao encerrar servidor MCP HTTP');
      });
      logger.info({ sessionId }, 'Sessao MCP HTTP encerrada');
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
    }
  };

  transport.onerror = (err) => {
    logger.warn({ err, sessionId: transport.sessionId }, 'Erro no transporte MCP HTTP');
  };

  await server.connect(transport);
  return { server, transport };
}

async function resolveSession(req: Request): Promise<McpSession> {
  const sessionId = getSessionId(req);
  if (!sessionId) {
    if (req.method !== 'POST') {
      throw new Error('Sessao MCP ausente ou invalida.');
    }
    return createSession();
  }

  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('Sessao MCP nao encontrada.');
  }

  return session;
}

async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  try {
    const session = await resolveSession(req);
    const parsedBody = req.method === 'POST' ? req.body : undefined;

    await session.transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    const sessionId = getSessionId(req);
    logger.warn({ err, sessionId, method: req.method }, 'Falha ao processar requisicao MCP HTTP');

    if (!res.headersSent) {
      res.status(sessionId ? 404 : 400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: sessionId ? 'Sessao MCP nao encontrada.' : 'Sessao MCP ausente ou invalida.',
        },
        id: null,
      });
    }
  }
}

export async function shutdownMcpSessions(): Promise<void> {
  const activeSessions = Array.from(sessions.values());
  sessions.clear();

  await Promise.allSettled(
    activeSessions.map(async ({ server, transport }) => {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }),
  );
}

const router = Router();

router.get('/', (req, res) => {
  void handleMcpRequest(req, res);
});

router.post('/', (req, res) => {
  void handleMcpRequest(req, res);
});

router.delete('/', (req, res) => {
  void handleMcpRequest(req, res);
});

export default router;
