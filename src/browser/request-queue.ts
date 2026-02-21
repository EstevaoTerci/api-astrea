import { logger } from '../utils/logger.js';

interface QueueItem {
  resolve: () => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
}

/**
 * Fila de requisições FIFO baseada em Promises.
 *
 * Substitui o busy-wait polling do pool por um sistema de enfileiramento
 * eficiente que garante ordem (FIFO), limita o tamanho da fila para
 * rejeição rápida, e não desperdiça CPU com polling.
 *
 * Fluxo:
 * 1. `enqueue()` → se há slot livre, resolve imediatamente
 * 2. Se não, entra na fila e aguarda via Promise
 * 3. Se a fila está cheia, rejeita imediatamente (backpressure)
 * 4. `dequeue()` → libera o próximo da fila (FIFO)
 */
export class RequestQueue {
  private currentActive = 0;
  private readonly queue: QueueItem[] = [];
  private readonly maxConcurrent: number;
  private readonly maxQueueSize: number;
  private readonly queueTimeoutMs: number;

  // Métricas
  private totalProcessed = 0;
  private totalRejected = 0;
  private totalTimedOut = 0;

  constructor(options: {
    maxConcurrent: number;
    maxQueueSize: number;
    queueTimeoutMs: number;
  }) {
    this.maxConcurrent = options.maxConcurrent;
    this.maxQueueSize = options.maxQueueSize;
    this.queueTimeoutMs = options.queueTimeoutMs;
  }

  /**
   * Solicita um slot de execução.
   * - Se há slots livres: resolve imediatamente.
   * - Se não: entra na fila e aguarda.
   * - Se a fila está cheia: rejeita com erro de backpressure.
   * - Se o tempo na fila excede `queueTimeoutMs`: rejeita com timeout.
   */
  async enqueue(): Promise<void> {
    // Slot livre — executa imediatamente
    if (this.currentActive < this.maxConcurrent) {
      this.currentActive++;
      this.totalProcessed++;
      logger.debug(
        { active: this.currentActive, queued: this.queue.length },
        'Request adquiriu slot imediatamente.',
      );
      return;
    }

    // Fila cheia — rejeição rápida (backpressure)
    if (this.queue.length >= this.maxQueueSize) {
      this.totalRejected++;
      logger.warn(
        { active: this.currentActive, queued: this.queue.length, maxQueue: this.maxQueueSize },
        'Fila cheia — requisição rejeitada (backpressure).',
      );
      throw new Error(
        'QUEUE_FULL: Servidor sobrecarregado. Tente novamente em alguns segundos.',
      );
    }

    // Entra na fila e aguarda
    return new Promise<void>((resolve, reject) => {
      const item: QueueItem = {
        resolve,
        reject,
        enqueuedAt: Date.now(),
      };

      this.queue.push(item);
      logger.debug(
        { position: this.queue.length, active: this.currentActive },
        'Request enfileirada, aguardando slot...',
      );

      // Timeout na fila
      const timer = setTimeout(() => {
        const idx = this.queue.indexOf(item);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          this.totalTimedOut++;
          logger.warn(
            { waitedMs: Date.now() - item.enqueuedAt, queueSize: this.queue.length },
            'Request removida da fila por timeout.',
          );
          reject(
            new Error(
              'QUEUE_TIMEOUT: Tempo de espera na fila excedido. Tente novamente.',
            ),
          );
        }
      }, this.queueTimeoutMs);

      // Guarda referência do timer para limpar quando resolver
      const originalResolve = item.resolve;
      item.resolve = () => {
        clearTimeout(timer);
        this.totalProcessed++;
        originalResolve();
      };

      const originalReject = item.reject;
      item.reject = (err: Error) => {
        clearTimeout(timer);
        originalReject(err);
      };
    });
  }

  /**
   * Libera um slot e ativa o próximo da fila (FIFO).
   */
  dequeue(): void {
    // Próximo na fila
    const next = this.queue.shift();
    if (next) {
      // Não decrementa currentActive porque o slot é transferido
      const waitedMs = Date.now() - next.enqueuedAt;
      logger.debug(
        { waitedMs, remaining: this.queue.length },
        'Slot transferido para próximo da fila.',
      );
      next.resolve();
    } else {
      this.currentActive--;
      logger.debug(
        { active: this.currentActive },
        'Slot liberado, fila vazia.',
      );
    }
  }

  /**
   * Retorna métricas atuais da fila.
   */
  get stats() {
    return {
      active: this.currentActive,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueueSize: this.maxQueueSize,
      totalProcessed: this.totalProcessed,
      totalRejected: this.totalRejected,
      totalTimedOut: this.totalTimedOut,
    };
  }
}
