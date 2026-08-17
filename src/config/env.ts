import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
  // Credenciais do Astrea
  ASTREA_EMAIL: z.string().email('ASTREA_EMAIL deve ser um e-mail válido'),
  ASTREA_PASSWORD: z.string().min(1, 'ASTREA_PASSWORD é obrigatório'),

  // Autenticação da API. Aceita uma OU outra (lista é a forma recomendada,
  // permite uma chave por pessoa com rótulo para auditoria/rotação):
  //   API_KEY=chave_unica_de_no_minimo_32_caracteres        (legada, label `legacy`)
  //   API_KEYS=chave1:label1,chave2:label2,chave3            (≥32 chars por chave)
  API_KEY: z.string().min(32, 'API_KEY deve ter pelo menos 32 caracteres').optional(),
  API_KEYS: z.string().optional(),

  // Configurações do servidor
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  // Configurações do pool de browsers
  // Teto = 5 propositalmente: cada Chromium extra custa ~250 MB RAM E aumenta
  // o risco de a Astrea (servidor externo) detectar uso indevido da conta
  // (múltiplas abas paralelas na mesma sessão logada). Pool > 5 não é seguro.
  BROWSER_POOL_SIZE: z.coerce.number().int().min(1).max(5).default(3),
  BROWSER_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  // Timeout DEDICADO da espera pós-login (clicar "Entrar" → SPA chegar em #/main/).
  // Separado de BROWSER_TIMEOUT_MS: o cold-start do Chromium + boot da SPA tem
  // cauda observada de ~27s (mediana ~12s) perto do teto antigo de 30s; 45s cobre
  // a cauda sem afrouxar o timeout das operações nem custar logins extras.
  BROWSER_LOGIN_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
  // Circuit breaker de login: corta a tempestade de re-logins (uso indevido na
  // Astrea). Abre após N falhas consecutivas e segura novos logins por cooldown.
  LOGIN_BREAKER_THRESHOLD: z.coerce.number().int().min(1).default(3),
  LOGIN_BREAKER_COOLDOWN_MS: z.coerce.number().int().min(0).default(60000),
  BROWSER_IDLE_TTL_MS: z.coerce.number().int().min(0).default(900000),
  BROWSER_EXECUTABLE_PATH: z.string().optional(),
  BROWSER_HEADLESS: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),

  // Configurações de sessão
  // SESSION_REUSE (agora EFETIVAMENTE lido): liga a persistência do storageState
  // em disco, permitindo restaurar a sessão no cold-start em vez de re-logar.
  SESSION_REUSE: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),
  /** Caminho do arquivo de storageState; default = tmpdir/astrea-session.json. */
  SESSION_STATE_PATH: z.string().optional(),
  /** Idade máxima da sessão persistida antes de exigir re-login (default 6h). */
  SESSION_STATE_MAX_AGE_MS: z.coerce.number().int().min(0).default(21_600_000),

  // Rate limiting (por IP, retorna 429 + Retry-After quando excedido)
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(50),

  // Fila de requisições (RequestQueue)
  QUEUE_MAX_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  QUEUE_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),

  // Tenant do Astrea (necessário para chamadas GCP Endpoints / users API)
  ASTREA_TENANT_ID: z.string().default('6692712561442816'),

  // LLM Fallback — suporte a Anthropic, OpenAI e Google Gemini
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  /** Provedor LLM explícito: 'anthropic' | 'openai' | 'google'. Se omitido, detecta pela chave disponível. */
  LLM_PROVIDER: z.enum(['anthropic', 'openai', 'google']).optional(),
  /** Modelo OpenAI a usar no fallback (padrão: gpt-4o-mini). */
  OPENAI_MODEL: z.string().optional(),
  /** Modelo Google a usar no fallback (padrão: gemini-1.5-flash). */
  GOOGLE_MODEL: z.string().optional(),

  // Notificação de incidentes por email
  DEVELOPER_EMAIL: z.string().email().default('estevaoterci@gmail.com'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
});

function parseEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Configuração de ambiente inválida:\n${errors}`);
  }

  if (!result.data.API_KEY && !result.data.API_KEYS) {
    throw new Error(
      'Configuração de ambiente inválida:\n  - API_KEY: defina API_KEY ou API_KEYS (≥32 chars por chave)',
    );
  }

  return result.data;
}

export const env = parseEnv();
export type Env = z.infer<typeof envSchema>;
