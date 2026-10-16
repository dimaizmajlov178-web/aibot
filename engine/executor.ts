import type { BaseBroker, OrderReceipt, OrderRequest } from "../broker/base";
import { PositionNotOpenedError } from "../broker";

export const DEFAULT_MAX_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 500;

export class OrderExecutionError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "OrderExecutionError";
  }
}

export interface OrderExecutorDeps {
  /** Задержка между ретраями (мс) — инжектится для тестируемости. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

/**
 * Исполняет ордер через broker.executeOrder() с обработкой ошибок и ретраями.
 * Если все попытки исчерпаны, бросает OrderExecutionError.
 */
export class OrderExecutor {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(deps: OrderExecutorDeps = {}) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async execute(
    broker: BaseBroker,
    order: OrderRequest
  ): Promise<OrderReceipt> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await broker.executeOrder(order);
      } catch (error) {
        if (error instanceof PositionNotOpenedError) {
          // Ордер уже передан брокеру, но позиция не подтверждена. Ретрай
          // создаст дубль ордера, поэтому пробрасываем сразу, без повторных
          // попыток — открытие не засчитывается в счётчик сделок.
          throw error;
        }
        lastError = error;
        if (attempt < this.maxRetries) {
          const delay = RETRY_BASE_DELAY_MS * attempt;
          await this.sleep(delay);
        }
      }
    }

    const message =
      lastError instanceof Error
        ? lastError.message
        : String(lastError ?? "неизвестная ошибка");
    throw new OrderExecutionError(
      `Не удалось исполнить ордер ${order.symbol} после ${this.maxRetries} попыток: ${message}`,
      this.maxRetries,
      lastError
    );
  }
}
