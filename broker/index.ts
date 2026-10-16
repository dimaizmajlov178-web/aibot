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
export {
  UpscaleBroker,
  UpscaleApiError,
  PositionNotOpenedError,
  DEFAULT_UPSCALE_BASE_URL,
  toFp9,
  fromFp9,
} from "./upscale";
export type {
  UpscaleBrokerOptions,
  BrokerMarket,
  EquityPoint,
} from "./upscale";
export { createBroker, isSupportedBrokerType } from "./factory";
export type { BrokerType, CreateBrokerOptions } from "./factory";
export { BrokerService } from "./service";
export type { ConnectResult, BrokerServiceDeps } from "./service";
export { brokerApiKeySchema, parseBrokerApiKey } from "./validation";
export type { BrokerApiKeyInput } from "./validation";
