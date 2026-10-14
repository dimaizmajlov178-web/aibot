import type { BotModule } from "../core/modules";

export const engineModule: BotModule = { name: "engine" };

export {
  TradingCore,
  DEFAULT_DECISION_INTERVAL_MS,
  DEFAULT_LOCK_TTL_MS,
} from "./trading-core";
export type {
  TradingCoreDeps,
  EngineEvent,
  EngineEventType,
} from "./trading-core";
export {
  RiskManager,
  createDefaultState,
  aiModeMultiplier,
  utcToday,
} from "./risk-manager";
export type {
  RiskDecision,
  RiskBlockCode,
  BrokerSnapshot,
  RiskManagerDeps,
} from "./risk-manager";
export {
  OrderExecutor,
  OrderExecutionError,
  DEFAULT_MAX_RETRIES,
} from "./executor";
export type { OrderExecutorDeps } from "./executor";
export { createInMemoryLockStore, createRedisLockStore } from "./lock";
export type { LockStore, RedisLikeClient } from "./lock";
export {
  defaultSettings,
  applySettingsPatch,
  parseSettingsPayload,
  tradingSettingsSchema,
} from "./settings";
export type { TradingSettingsInput, TradingSettingsDefaults } from "./settings";
export type {
  TradingSettings,
  TradingSettingsPatch,
  TradingState,
  AiMode,
  OrderDirection,
} from "./types";
export { isSymbolAllowed } from "./types";
