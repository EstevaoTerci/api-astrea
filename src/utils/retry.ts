export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoff?: 'exponential' | 'linear' | 'fixed';
  retryIf?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'retryIf' | 'onRetry'>> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 15000,
  backoff: 'exponential',
};

function calculateDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  backoff: 'exponential' | 'linear' | 'fixed',
): number {
  let delay: number;

  switch (backoff) {
    case 'exponential':
      delay = baseDelayMs * Math.pow(2, attempt - 1);
      break;
    case 'linear':
      delay = baseDelayMs * attempt;
      break;
    case 'fixed':
    default:
      delay = baseDelayMs;
  }

  // Jitter: ±20% para evitar thundering herd
  const jitter = delay * 0.2 * (Math.random() * 2 - 1);
  return Math.min(delay + jitter, maxDelayMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executa uma função com retry automático.
 * Retorna o resultado ou lança o último erro após esgotar as tentativas.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const config = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const shouldRetry = config.retryIf ? config.retryIf(error) : true;

      if (!shouldRetry || attempt === config.maxAttempts) {
        throw error;
      }

      const delay = calculateDelay(attempt, config.baseDelayMs, config.maxDelayMs, config.backoff);

      if (config.onRetry) {
        config.onRetry(error, attempt);
      } else {
        console.warn(
          `[retry] Tentativa ${attempt} falhou. Próxima em ${Math.round(delay)}ms. Erro: ${String(error)}`,
        );
      }

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Verifica se um erro é relacionado ao Playwright e pode ser recuperável.
 */
export function isRetryablePlaywrightError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const retryableMessages = [
    'timeout',
    'net::ERR_',
    'Navigation failed',
    'context was destroyed',
    'Target closed',
    'Session closed',
    'browser has been closed',
  ];

  const msg = error.message.toLowerCase();
  return retryableMessages.some((pattern) => msg.includes(pattern.toLowerCase()));
}
