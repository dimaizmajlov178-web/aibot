import type { BotModule } from "../core/modules";

export const learningModule: BotModule = { name: "learning" };

export { LearningService } from "./service";
export type { LearningServiceDeps } from "./service";
export {
  startDailyLearningScheduler,
  DEFAULT_LEARNING_INTERVAL_MS,
} from "./scheduler";
export type {
  DailyLearningScheduler,
  DailyLearningSchedulerDeps,
} from "./scheduler";
export { LEARNING_SYSTEM_PROMPT, buildLearningPrompt } from "./prompt";
export { learningAnalysisSchema, strategyRuleSchema } from "./schema";
export type { LearningAnalysis, StrategyRuleInput } from "./schema";
export { computeMetrics, rulesChanged } from "./metrics";
export type { MetricsOutcome } from "./metrics";
export {
  ANALYSIS_HISTORY_DAYS,
  MIN_TRADES_FOR_RULES,
  LEARNING_SAMPLE_SIZE,
} from "./types";
export type {
  AbTestComparisonResult,
  AbTestState,
  LearningRecorder,
  LearningReport,
  LearningReportStatus,
  MetricsSnapshot,
  SnapshotStatus,
  StrategyRule,
  StrategyState,
  StrategyStatus,
  StrategyVersion,
  TradeCloseRecord,
  TradeOpenRecord,
  TradeResult,
  TradingSnapshot,
} from "./types";
