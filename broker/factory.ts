import { BaseBroker } from "./base";
import { StubBroker } from "./stub";

export type BrokerType = "stub";

export function isSupportedBrokerType(type: string): type is BrokerType {
  return type === "stub";
}

export function createBroker(type: string, apiKey: string): BaseBroker {
  if (!isSupportedBrokerType(type)) {
    console.warn(
      `[broker] тип "${type}" не поддерживается, используется StubBroker`
    );
  }
  return new StubBroker(apiKey);
}
