import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
  // Credenciais do Astrea
  ASTREA_EMAIL: z.string().email('ASTREA_EMAIL deve ser um e-mail válido'),
  ASTREA_PASSWORD: z.string().min(1, 'ASTREA_PASSWORD é obrigatório'),

  // Autenticação da API
  API_KEY: z.string().min(32, 'API_KEY deve ter pelo menos 32 caracteres'),

  // Configurações do servidor
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  // Configurações do pool de browsers
  BROWSER_POOL_SIZE: z.coerce.number().int().min(1).max(10).default(3),
  BROWSER_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  BROWSER_IDLE_TTL_MS: z.coerce.number().int().min(0).default(900000),
  BROWSER_EXECUTABLE_PATH: z.string().optional(),
  BROWSER_HEADLESS: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),

  // Configurações de sessão
  SESSION_REUSE: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(30),

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

  return result.data;
}

export const env = parseEnv();
export type Env = z.infer<typeof envSchema>;
