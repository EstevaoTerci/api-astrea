import { navigateTo } from '../browser/navigator.js';
import {
  withBrowserContext,
  gapiCall,
  WORKSPACE_PAGE_PATH,
} from '../browser/astrea-http.js';
import { TtlCache } from '../utils/cache.js';
import { logger } from '../utils/logger.js';
import { isRetryablePlaywrightError } from '../utils/retry.js';
import type { Usuario, ServiceResponse } from '../types/index.js';

// Cache de 10 minutos para a lista de usuários
const cache = new TtlCache<Usuario[]>(10 * 60_000);

// ─────────────────────────────────────────────────────────────────────────────
// Tipos internos GCP
// ─────────────────────────────────────────────────────────────────────────────

interface GcpUser {
  id?: string | number;
  userId?: string | number;
  nome?: string;
  name?: string;
  email?: string;
  apelido?: string;
  nickname?: string;
  foto?: string;
  photo?: string;
  photoUrl?: string;
  admin?: boolean;
  status?: string;
  perfil?: string;
  profile?: string;
  contatoId?: string | number;
  contactId?: string | number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapeamento GcpUser → Usuario
// ─────────────────────────────────────────────────────────────────────────────

function mapGcpUserToUsuario(u: GcpUser): Usuario {
  return {
    id: String(u.id ?? u.userId ?? ''),
    nome: u.nome ?? u.name ?? '',
    email: u.email ?? '',
    apelido: u.apelido ?? u.nickname ?? undefined,
    foto: u.foto ?? u.photo ?? u.photoUrl ?? undefined,
    admin: u.admin ?? undefined,
    status: u.status ?? undefined,
    perfil: u.perfil ?? u.profile ?? undefined,
    contatoId: u.contatoId != null
      ? String(u.contatoId)
      : u.contactId != null
        ? String(u.contactId)
        : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// listarUsuarios
// ─────────────────────────────────────────────────────────────────────────────

export async function listarUsuarios(): Promise<ServiceResponse<Usuario[]>> {
  // Verificar cache primeiro
  const cached = cache.get('all');
  if (cached) {
    logger.debug({ count: cached.length }, 'Usuários retornados do cache');
    return { ok: true, data: cached };
  }

  try {
    const usuarios = await withBrowserContext(async (page) => {
      await navigateTo(page, WORKSPACE_PAGE_PATH);

      const res = await gapiCall<any>(
        page,
        'users.userService',
        'getAllUsers',
        {},
      );

      // Response may be array directly, or wrapped in items/users/data
      let rawUsers: GcpUser[] = [];
      if (Array.isArray(res)) {
        rawUsers = res as GcpUser[];
      } else if (Array.isArray(res?.items)) {
        rawUsers = res.items as GcpUser[];
      } else if (Array.isArray(res?.users)) {
        rawUsers = res.users as GcpUser[];
      } else if (Array.isArray(res?.data)) {
        rawUsers = res.data as GcpUser[];
      } else {
        logger.warn({ res }, 'Resposta inesperada de getAllUsers — retornando vazio');
      }

      return rawUsers.map(mapGcpUserToUsuario);
    });

    cache.set('all', usuarios);
    logger.debug({ count: usuarios.length }, 'Usuários carregados e armazenados em cache');

    return { ok: true, data: usuarios };
  } catch (err) {
    logger.error({ err }, 'Erro em listarUsuarios');
    return {
      ok: false,
      error: {
        message: err instanceof Error ? err.message : 'Erro desconhecido',
        code: 'API_ERROR',
        retryable: isRetryablePlaywrightError(err),
      },
    };
  }
}
