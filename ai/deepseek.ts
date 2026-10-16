import type { AiModelKind } from "./types";
import { DeepSeekApiError, DeepSeekConfigError, DeepSeekError } from "./errors";
import type {
  AiProvider,
  AiProviderMessage,
  AiProviderName,
  AiProviderResult,
} from "./provider";

export interface DeepSeekConfig {
  apiKey: string;
  baseUrl?: string;
  chatModel?: string;
  reasonerModel?: string;
  timeoutMs?: number;
  jsonMode?: boolean;
}

export type DeepSeekMessage = AiProviderMessage;
export type DeepSeekResult = AiProviderResult;

interface DeepSeekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface DeepSeekChoice {
  message?: {
    content?: string | null;
    reasoning_content?: string | null;
  };
}

interface DeepSeekResponse {
  model?: string;
  choices?: DeepSeekChoice[];
  usage?: DeepSeekUsage;
  error?: { message?: string };
}

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_CHAT_MODEL = "deepseek-flash";
const DEFAULT_REASONER_MODEL = "deepseek-v4-pro";
const DEFAULT_TIMEOUT_MS = 60_000;

export const SYSTEM_PROMPT =
  "Ты — профессиональный трейдер и аналитик финансовых рынков. " +
  "Отвечай строго по заданной схеме, без пояснений вне JSON. " +
  "Используй только предоставленные данные, не выдумывай отсутствующие значения. " +
  "Решения должны учитывать риск-менеджмент: не рискуй больше ограничения на сделку.";

export class DeepSeekClient implements AiProvider {
  readonly name: AiProviderName = "deepseek";
  readonly config: DeepSeekConfig;

  constructor(config: DeepSeekConfig) {
    this.config = {
      baseUrl: (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
      chatModel: config.chatModel ?? DEFAULT_CHAT_MODEL,
      reasonerModel: config.reasonerModel ?? DEFAULT_REASONER_MODEL,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      jsonMode: config.jsonMode !== false,
      apiKey: config.apiKey,
    };
  }

  modelFor(kind: AiModelKind): string {
    return kind === "reasoner"
      ? (this.config.reasonerModel ?? DEFAULT_REASONER_MODEL)
      : (this.config.chatModel ?? DEFAULT_CHAT_MODEL);
  }

  async complete(
    kind: AiModelKind,
    message: DeepSeekMessage
  ): Promise<DeepSeekResult> {
    if (!this.config.apiKey) {
      throw new DeepSeekConfigError(
        "DEEPSEEK_API_KEY не задан. Укажите API-ключ DeepSeek в переменной окружения DEEPSEEK_API_KEY"
      );
    }

    const model = this.modelFor(kind);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const body: Record<string, unknown> = {
        model,
        messages: [
          ...(message.system
            ? [{ role: "system", content: message.system }]
            : []),
          { role: "user", content: message.user },
        ],
        max_tokens: 1500,
      };

      if (kind === "chat") {
        body.temperature = 0.2;
        // У новых моделей DeepSeek (deepseek-flash / deepseek-v4-pro) thinking
        // включён по умолчанию и может съедать весь max_tokens на
        // reasoning_content, из-за чего JSON обрезается и парсинг не проходит.
        // Для быстрых торговых решений отключаем thinking-режим: детерминированный
        // и быстрый JSON, токены тратятся на сам ответ.
        body.reasoning_effort = "none";
        if (this.config.jsonMode) {
          body.response_format = { type: "json_object" };
        }
      }

      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startedAt;

      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const payload = (await response.json()) as {
            error?: { message?: string };
          };
          detail = payload.error?.message ?? detail;
        } catch {
          // тело ошибки не всегда JSON, оставляем HTTP-статус
        }
        throw new DeepSeekApiError(
          `DeepSeek API вернул ошибку: ${detail}`,
          response.status
        );
      }

      const payload = (await response.json()) as DeepSeekResponse;
      if (payload.error?.message) {
        throw new DeepSeekApiError(
          `DeepSeek API вернул ошибку: ${payload.error.message}`,
          response.status
        );
      }

      const choice = payload.choices?.[0];
      const content = choice?.message?.content?.trim() ?? "";
      const reasoningContent = choice?.message?.reasoning_content?.trim() ?? "";
      const usage = payload.usage ?? {};

      return {
        content,
        reasoningContent,
        model: payload.model ?? model,
        latencyMs,
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
        provider: this.name,
      };
    } catch (error) {
      if (error instanceof DeepSeekError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new DeepSeekError(
          `DeepSeek API не ответил за ${this.config.timeoutMs} мс (таймаут)`
        );
      }
      throw new DeepSeekError(
        `Ошибка запроса к DeepSeek: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
