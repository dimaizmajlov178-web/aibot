import { randomUUID } from "node:crypto";

/** Генерирует уникальный идентификатор запроса для структурных логов/аудита. */
export function createRequestId(prefix = "req"): string {
  return `${prefix}_${randomUUID()}`;
}
