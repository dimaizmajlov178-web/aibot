import type { ZodType } from "zod";
import { AiResponseError } from "./errors";

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractFencedJson(raw: string): unknown | null {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!match) {
    return null;
  }
  return tryParseJson(match[1]!.trim());
}

function extractBracketedJson(raw: string): unknown | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return tryParseJson(raw.slice(start, end + 1));
}

/**
 * Извлекает JSON-объект из произвольного текста модели:
 * чистый JSON, JSON в markdown-блоке или JSON внутри пояснений.
 */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new AiResponseError("Пустой ответ модели: невозможно извлечь JSON");
  }

  const direct = tryParseJson(trimmed);
  if (direct !== null) {
    return direct;
  }

  const fenced = extractFencedJson(trimmed);
  if (fenced !== null) {
    return fenced;
  }

  const bracketed = extractBracketedJson(trimmed);
  if (bracketed !== null) {
    return bracketed;
  }

  throw new AiResponseError("Не удалось извлечь JSON из ответа модели");
}

function formatIssues(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): string {
  const details = error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  return details;
}

/**
 * Парсит ответ модели и валидирует его по zod-схеме.
 * Бросает AiResponseError при невалидном ответе, чтобы цикл мог
 * повторить запрос или пропустить итерацию.
 */
export function parseAndValidate<T>(raw: string, schema: ZodType<T>): T {
  const value = extractJsonObject(raw);
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AiResponseError(
      `Ответ модели не прошёл валидацию схемы: ${formatIssues(parsed.error)}`
    );
  }
  return parsed.data;
}
