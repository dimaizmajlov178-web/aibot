import type { AiModelKind } from "./types";
import { DeepSeekApiError, DeepSeekError } from "./errors";

export type AiProviderName = "deepseek" | "openrouter";

export interface AiProviderMessage {
  system?: string;
  user: string;
}

export interface AiProviderResult {
  content: string;
  reasoningContent: string;
  model: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Провайдер, который фактически обслужил запрос. */
  provider: AiProviderName;
}

export interface AiProvider {
  readonly name: AiProviderName;
  modelFor(kind: AiModelKind): string;
  complete(
    kind: AiModelKind,
    message: AiProviderMessage
  ): Promise<AiProviderResult>;
}

/**
 * Является ли ошибка провайдера "транзиентной" — когда стоит переключиться
 * на fallback-провайдера: 429 rate limit, 5xx, service_unavailable_error,
 * таймаут.
 */
export function isTransientAiError(error: unknown): boolean {
  if (error instanceof DeepSeekApiError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  if (error instanceof DeepSeekError) {
    const message = error.message.toLowerCase();
    return (
      message.includes("service_unavailable_error") ||
      message.includes("rate limit") ||
      message.includes("таймаут")
    );
  }
  return false;
}
