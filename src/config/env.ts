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

  // Configurações do pool de browsers
  BROWSER_POOL_SIZE: z.coerce.number().int().min(1).max(10).default(5),
  BROWSER_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
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
});

function parseEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.errors.map((e) => `  - ${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Configuração de ambiente inválida:\n${errors}`);
  }

  return result.data;
}

export const env = parseEnv();
export type Env = z.infer<typeof envSchema>;
