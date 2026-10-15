import type { AiModelKind } from "./types";
import {
  OpenRouterApiError,
  OpenRouterConfigError,
  OpenRouterError,
} from "./errors";
import type {
  AiProvider,
  AiProviderMessage,
  AiProviderName,
  AiProviderResult,
} from "./provider";

export interface OpenRouterConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  jsonMode?: boolean;
}

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenRouterChoice {
  message?: {
    content?: string | null;
    reasoning_content?: string | null;
  };
}

interface OpenRouterResponse {
  model?: string;
  choices?: OpenRouterChoice[];
  usage?: OpenRouterUsage;
  error?: { message?: string };
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Клиент OpenRouter (совместимый с OpenAI API) — используется как запасной
 * AI-провайдер, когда DeepSeek недоступен или перегружен.
 */
export class OpenRouterClient implements AiProvider {
  readonly name: AiProviderName = "openrouter";
  readonly config: OpenRouterConfig;

  constructor(config: OpenRouterConfig) {
    this.config = {
      baseUrl: (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
      model: config.model ?? DEFAULT_MODEL,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      jsonMode: config.jsonMode !== false,
      apiKey: config.apiKey,
    };
  }

  modelFor(_kind: AiModelKind): string {
    return this.config.model ?? DEFAULT_MODEL;
  }

  async complete(
    kind: AiModelKind,
    message: AiProviderMessage
  ): Promise<AiProviderResult> {
    if (!this.config.apiKey) {
      throw new OpenRouterConfigError(
        "OPENROUTER_API_KEY не задан. Укажите API-ключ OpenRouter в переменной окружения OPENROUTER_API_KEY"
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
        throw new OpenRouterApiError(
          `OpenRouter API вернул ошибку: ${detail}`,
          response.status
        );
      }

      const payload = (await response.json()) as OpenRouterResponse;
      if (payload.error?.message) {
        throw new OpenRouterApiError(
          `OpenRouter API вернул ошибку: ${payload.error.message}`,
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
      if (error instanceof OpenRouterError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new OpenRouterError(
          `OpenRouter API не ответил за ${this.config.timeoutMs} мс (таймаут)`
        );
      }
      throw new OpenRouterError(
        `Ошибка запроса к OpenRouter: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
