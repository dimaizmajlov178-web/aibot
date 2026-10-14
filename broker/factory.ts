import { BaseBroker } from "./base";
import { StubBroker } from "./stub";
import { UpscaleBroker } from "./upscale";

export type BrokerType = "stub" | "upscale";

export interface CreateBrokerOptions {
  /** Базовый URL API брокера (BROKER_API_BASE_URL). */
  baseUrl?: string;
  /** HTTP-заголовок с API-ключом (BROKER_API_KEY_HEADER). */
  apiKeyHeader?: string;
  /** Инжектируемый fetch (для тестов). */
  fetchImpl?: typeof fetch;
}

export function isSupportedBrokerType(type: string): type is BrokerType {
  return type === "stub" || type === "upscale";
}

export function createBroker(
  type: string,
  apiKey: string,
  options: CreateBrokerOptions = {}
): BaseBroker {
  if (type === "upscale") {
    return new UpscaleBroker({
      apiKey,
      baseUrl: options.baseUrl,
      apiKeyHeader: options.apiKeyHeader,
      fetchImpl: options.fetchImpl,
    });
  }
  if (!isSupportedBrokerType(type)) {
    console.warn(
      `[broker] тип "${type}" не поддерживается, используется StubBroker`
    );
  }
  return new StubBroker(apiKey);
}
