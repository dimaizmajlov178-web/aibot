export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Структурированный контекст лога. Ключевые поля — userId и requestId,
 * которые позволяют связать запись с пользователем и конкретным запросом.
 */
export type LogContext = Record<string, unknown>;

function writeLine(level: LogLevel, message: string, fields: LogContext): void {
  const record: LogContext = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  };
  const line = JSON.stringify(record);
  if (level === "warn" || level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

/**
 * Логгер с JSON-выводом (построчно) и контекстом. Создаётся через child()
 * с userId/requestId и используется во всех компонентах бота.
 */
export class BotLogger {
  constructor(private readonly context: LogContext = {}) {}

  child(context: LogContext): BotLogger {
    return new BotLogger({ ...this.context, ...context });
  }

  withUser(userId: number | null): BotLogger {
    return this.child({ userId: userId ?? null });
  }

  withRequest(requestId: string | null): BotLogger {
    return this.child({ requestId: requestId ?? null });
  }

  debug(message: string, fields: LogContext = {}): void {
    writeLine("debug", message, { ...this.context, ...fields });
  }

  info(message: string, fields: LogContext = {}): void {
    writeLine("info", message, { ...this.context, ...fields });
  }

  warn(message: string, fields: LogContext = {}): void {
    writeLine("warn", message, { ...this.context, ...fields });
  }

  error(message: string, fields: LogContext = {}): void {
    writeLine("error", message, { ...this.context, ...fields });
  }
}

export const defaultLogger = new BotLogger();
