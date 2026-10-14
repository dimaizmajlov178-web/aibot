import type { PositionSide } from "../broker/base";
import type { MarketContext, Timeframe } from "../ai/types";
import type { TradeSignal } from "../ai/schema";

/** Анти-оверфит: глубина истории для анализа сделок (дней). */
export const ANALYSIS_HISTORY_DAYS = 60;
/** Анти-оверфит: минимум закрытых сделок для корректировки правил. */
export const MIN_TRADES_FOR_RULES = 30;
/** Максимум сделок, отправляемых модели в learning-промт. */
export const LEARNING_SAMPLE_SIZE = 40;

export type SnapshotStatus = "open" | "closed";

export interface TradeResult {
  pnl: number;
  rMultiple: number;
  exitPrice: number;
  closedAt: string;
}

/**
 * Снимок контекста сделки: рынок, индикаторы, решение AI и reasoning,
 * результат после закрытия. Сохраняется в trading_snapshots.
 */
export interface TradingSnapshot {
  id: string;
  userId: number;
  symbol: string;
  timeframe: Timeframe;
  side: PositionSide;
  /** Версия стратегии, по которой открыта сделка. */
  strategyVersion: number;
  decision: {
    action: TradeSignal["action"];
    side: TradeSignal["side"];
    confidence: number;
    entryPrice: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    riskPercent: number;
  };
  reasoning: string;
  market: {
    price: number;
    collectedAt: string;
    indicators: MarketContext["indicators"];
  };
  entryPrice: number;
  quantity: number;
  status: SnapshotStatus;
  result: TradeResult | null;
  createdAt: string;
  updatedAt: string;
}

export type LearningReportStatus =
  | "strategy_created"
  | "no_changes"
  | "insufficient_data"
  | "failed";

export interface StrategyRule {
  field: string;
  change: string;
  reason: string;
}

export interface MetricsSnapshot {
  totalTrades: number;
  wins: number;
  losses: number;
  /** Винрейт в процентах 0-100. */
  winrate: number;
  /** Профит-фактор (gross profit / gross loss); 99 = бесконечность. */
  profitFactor: number;
  /** Максимальная просадка в процентах от кривой суммарного PnL. */
  maxDrawdownPercent: number;
  averageR: number;
  netPnl: number;
  periodStart: string;
  periodEnd: string;
}

export type StrategyStatus = "active" | "candidate" | "archived";

export interface StrategyVersion {
  id: string;
  userId: number;
  version: number;
  name: string;
  status: StrategyStatus;
  rules: StrategyRule[];
  metrics: MetricsSnapshot | null;
  parentVersion: number | null;
  sourceReportId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AbTestState {
  enabled: boolean;
  referenceVersion: number | null;
  testVersion: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

/** Состояние стратегий пользователя (активная версия, A/B тест). */
export interface StrategyState {
  userId: number;
  activeVersion: number;
  lastReportDate: string | null;
  lastReportId: string | null;
  abTest: AbTestState | null;
  updatedAt: string;
}

export interface LearningReport {
  id: string;
  userId: number;
  reportDate: string;
  status: LearningReportStatus;
  tradeCount: number;
  summary: string;
  successPatterns: string[];
  failurePatterns: string[];
  ruleAdjustments: StrategyRule[];
  strategyVersion: number | null;
  metrics: MetricsSnapshot | null;
  error: string | null;
  model: string;
  createdAt: string;
}

export interface AbTestComparisonResult {
  referenceVersion: number;
  testVersion: number;
  startedAt: string | null;
  endedAt: string | null;
  referenceTrades: number;
  testTrades: number;
  reference: MetricsSnapshot | null;
  test: MetricsSnapshot | null;
}

/** Запись открытия сделки для снятия снимка контекста. */
export interface TradeOpenRecord {
  userId: number;
  symbol: string;
  side: PositionSide;
  market: MarketContext;
  signal: TradeSignal;
  entryPrice: number;
  quantity: number;
  openedAt: string;
}

/** Запись закрытия сделки для проставления результата. */
export interface TradeCloseRecord {
  userId: number;
  symbol: string;
  side: PositionSide;
  exitPrice: number;
  closedAt: string;
}

/** Контракт записи сделок в датасет обучения. Используется engine/. */
export interface LearningRecorder {
  recordTradeOpen(record: TradeOpenRecord): Promise<void>;
  recordTradeClose(record: TradeCloseRecord): Promise<void>;
}
