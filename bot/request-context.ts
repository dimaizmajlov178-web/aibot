import type { Context } from "telegraf";
import { createRequestId } from "../core/request-id";
import { BotLogger, defaultLogger } from "../core/logger";

const REQUEST_ID_KEY = Symbol("requestId");
const LOGGER_KEY = Symbol("logger");

type WithSymbols = Record<symbol, unknown>;

/**
 * Прикрепляет к Telegram-контексту уникальный requestId и структурный логгер
 * (с полями userId/requestId) для связки логов и аудита с конкретным запросом.
 */
export function attachRequestContext(ctx: Context): {
  requestId: string;
  logger: BotLogger;
} {
  const holder = ctx as unknown as WithSymbols;
  const existing = holder[REQUEST_ID_KEY];
  if (typeof existing === "string") {
    return {
      requestId: existing,
      logger: (holder[LOGGER_KEY] as BotLogger) ?? defaultLogger,
    };
  }

  const requestId = createRequestId();
  const userId = ctx.from?.id ?? null;
  const logger = defaultLogger.child({ userId, requestId });

  Object.defineProperties(ctx, {
    [REQUEST_ID_KEY]: { value: requestId, enumerable: false },
    [LOGGER_KEY]: { value: logger, enumerable: false },
  });

  return { requestId, logger };
}

export function getRequestId(ctx: Context): string | null {
  const requestId = (ctx as unknown as WithSymbols)[REQUEST_ID_KEY];
  return typeof requestId === "string" ? requestId : null;
}

export function getRequestLogger(ctx: Context): BotLogger {
  const logger = (ctx as unknown as WithSymbols)[LOGGER_KEY];
  return logger instanceof BotLogger ? logger : defaultLogger;
}

export function getRequestContext(ctx: Context): {
  requestId: string | null;
  logger: BotLogger;
} {
  return { requestId: getRequestId(ctx), logger: getRequestLogger(ctx) };
}
