import type { BotModule } from "../core/modules";

export const brokerModule: BotModule = { name: "broker" };

export { BaseBroker, BrokerConnectionError } from "./base";
export type {
  BrokerAccount,
  BrokerStats,
  ClosedTrade,
  OpenPosition,
  OrderAction,
  OrderReceipt,
  OrderRequest,
  PositionSide,
} from "./base";
export { StubBroker } from "./stub";
export { createBroker, isSupportedBrokerType } from "./factory";
export type { BrokerType } from "./factory";
export { BrokerService } from "./service";
export type { ConnectResult, BrokerServiceDeps } from "./service";
export { brokerApiKeySchema, parseBrokerApiKey } from "./validation";
export type { BrokerApiKeyInput } from "./validation";
