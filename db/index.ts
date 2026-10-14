import type { BotModule } from "../core/modules";

export const dbModule: BotModule = { name: "db" };

export {
  createInMemoryBrokerRepository,
  createDynamoDbBrokerRepository,
} from "./broker-repository";
export type { BrokerConnection, BrokerRepository } from "./broker-repository";
export {
  createInMemoryAiDecisionRepository,
  createDynamoDbAiDecisionRepository,
  createAiDecision,
} from "./ai-decision-repository";
export type {
  AiDecision,
  AiDecisionInput,
  AiDecisionRepository,
} from "./ai-decision-repository";
export {
  createInMemoryTradingSettingsRepository,
  createDynamoDbTradingSettingsRepository,
  createInMemoryTradingStateRepository,
  createDynamoDbTradingStateRepository,
} from "./trading-repository";
export type {
  TradingSettingsRepository,
  TradingStateRepository,
} from "./trading-repository";
export {
  createInMemoryTradingSnapshotRepository,
  createDynamoDbTradingSnapshotRepository,
} from "./snapshot-repository";
export type { TradingSnapshotRepository } from "./snapshot-repository";
export {
  createInMemoryLearningReportRepository,
  createDynamoDbLearningReportRepository,
  createInMemoryStrategyRepository,
  createDynamoDbStrategyRepository,
  createInMemoryStrategyStateRepository,
  createDynamoDbStrategyStateRepository,
} from "./learning-repository";
export type {
  LearningReportRepository,
  StrategyRepository,
  StrategyStateRepository,
} from "./learning-repository";
export {
  createInMemoryUserRepository,
  createDynamoDbUserRepository,
} from "./user-repository";
export type { User, UserRepository, StoredRole } from "./user-repository";
export {
  createInMemoryGlobalStateRepository,
  createDynamoDbGlobalStateRepository,
} from "./global-state-repository";
export type { GlobalStateRepository } from "./global-state-repository";
export {
  createInMemoryAuditRepository,
  createDynamoDbAuditRepository,
} from "./audit-repository";
export type {
  AuditLog,
  AuditRepository,
  AuditActorRole,
} from "./audit-repository";
