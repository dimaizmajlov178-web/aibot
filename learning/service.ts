import { randomUUID } from "node:crypto";
import type { DeepSeekClient } from "../ai/deepseek";
import { parseAndValidate } from "../ai/parser";
import { toErrorMessage } from "../ai/errors";
import type { TradingSnapshotRepository } from "../db/snapshot-repository";
import type {
  LearningReportRepository,
  StrategyRepository,
  StrategyStateRepository,
} from "../db/learning-repository";
import { buildLearningPrompt, LEARNING_SYSTEM_PROMPT } from "./prompt";
import { learningAnalysisSchema, type LearningAnalysis } from "./schema";
import { computeMetrics, rulesChanged } from "./metrics";
import { ANALYSIS_HISTORY_DAYS, MIN_TRADES_FOR_RULES } from "./types";
import type {
  AbTestComparisonResult,
  AbTestState,
  LearningRecorder,
  LearningReport,
  LearningReportStatus,
  MetricsSnapshot,
  StrategyRule,
  StrategyState,
  StrategyVersion,
  TradeCloseRecord,
  TradeOpenRecord,
  TradingSnapshot,
} from "./types";

export interface LearningServiceDeps {
  snapshots: TradingSnapshotRepository;
  reports: LearningReportRepository;
  strategies: StrategyRepository;
  state: StrategyStateRepository;
  deepseek: DeepSeekClient;
}

function nowIso(): string {
  return new Date().toISOString();
}

function utcToday(): string {
  return new Date().toISOString().split("T")[0]!;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function strategyId(userId: number, version: number): string {
  return `strat:${userId}:v${version}`;
}

/** Нормализует правила от модели в канонический вид стратегии. */
function normalizeRules(adjustments: readonly StrategyRule[]): StrategyRule[] {
  return adjustments.map((adjustment) => ({
    field: adjustment.field.trim().slice(0, 120),
    change: adjustment.change.trim().slice(0, 500),
    reason: adjustment.reason.trim().slice(0, 500),
  }));
}

/**
 * Самообучение без fine-tuning:
 *  - собирает датасет сделок со снимками контекста и результатами;
 *  - раз в сутки генерирует learning-отчёт через DeepSeek;
 *  - при изменениях создаёт новую версию стратегии с расчётом метрик;
 *  - поддерживает A/B сравнение и откат к предыдущим версиям;
 *  - применяет анти-оверфит ограничения (история 60 дней, минимум 30 сделок).
 */
export class LearningService implements LearningRecorder {
  constructor(private readonly deps: LearningServiceDeps) {}

  // -------------------------------------------------------------------------
  // Сбор датасета
  // -------------------------------------------------------------------------

  async recordTradeOpen(record: TradeOpenRecord): Promise<void> {
    const state = await this.ensureState(record.userId);
    const strategyVersion = await this.allocateStrategy(record.userId, state);

    const snapshot: TradingSnapshot = {
      id: randomUUID(),
      userId: record.userId,
      symbol: record.symbol.trim().toUpperCase(),
      timeframe: record.market.timeframe,
      side: record.side,
      strategyVersion,
      decision: {
        action: record.signal.action,
        side: record.signal.side,
        confidence: record.signal.confidence,
        entryPrice: record.signal.entryPrice,
        stopLoss: record.signal.stopLoss,
        takeProfit: record.signal.takeProfit,
        riskPercent: record.signal.riskPercent,
      },
      reasoning: record.signal.reasoning,
      market: {
        price: record.market.price,
        collectedAt: record.market.collectedAt,
        indicators: record.market.indicators,
      },
      entryPrice: record.entryPrice,
      quantity: record.quantity,
      status: "open",
      result: null,
      createdAt: record.openedAt,
      updatedAt: record.openedAt,
    };

    await this.deps.snapshots.save(snapshot);
  }

  async recordTradeClose(record: TradeCloseRecord): Promise<void> {
    let open = await this.deps.snapshots.findOpen(
      record.userId,
      record.symbol,
      record.side
    );
    if (!open) {
      // DynamoDB GSI + Limit может не найти снимок, ищем по списку пользователя.
      const all = await this.deps.snapshots.listByUser(record.userId, 500);
      const normSymbol = record.symbol.trim().toUpperCase();
      open = all.find(
        (s: any) =>
          s.status === "open" &&
          s.symbol === normSymbol &&
          s.side === record.side
      ) ?? null;
    }
    if (!open) {
      console.log("[learning] recordTradeClose: open NOT FOUND", record.userId, record.symbol, record.side);
      return;
    }
    console.log("[learning] recordTradeClose: closing", record.userId, record.symbol, record.side, "exit", record.exitPrice, "closedAt", record.closedAt);

    const direction = open.side === "long" ? 1 : -1;
    const notional = open.entryPrice * open.quantity;
    const pnl = round2(
      direction * (record.exitPrice - open.entryPrice) * open.quantity
    );
    const riskPercent =
      open.decision.riskPercent > 0 ? open.decision.riskPercent : 1;
    const riskAmount = notional * (riskPercent / 100);
    const rMultiple = riskAmount > 0 ? round2(pnl / riskAmount) : 0;

    await this.deps.snapshots.save({
      ...open,
      status: "closed",
      result: {
        pnl,
        rMultiple,
        exitPrice: record.exitPrice,
        closedAt: record.closedAt,
      },
      updatedAt: record.closedAt,
    });
  }

  /** Распределяет новую сделку на стратегию: при активном A/B балансирует. */
  async allocateStrategy(
    userId: number,
    stateIn?: StrategyState
  ): Promise<number> {
    const state = stateIn ?? (await this.ensureState(userId));
    const ab = state.abTest;
    if (ab?.enabled && ab.testVersion != null && ab.referenceVersion != null) {
      const referenceCount = await this.deps.snapshots.countByStrategyVersion(
        userId,
        ab.referenceVersion
      );
      const testCount = await this.deps.snapshots.countByStrategyVersion(
        userId,
        ab.testVersion
      );
      return testCount < referenceCount ? ab.testVersion : ab.referenceVersion;
    }
    return state.activeVersion;
  }

  // -------------------------------------------------------------------------
  // Ежедневный learning-отчёт
  // -------------------------------------------------------------------------

  /**
   * Сверяет открытые снимки с реальными позициями брокера: если позиции на
   * бирже больше нет (стоп/тейк сработал там), сразу фиксирует закрытие
   * в датасете learning (заполняет result и статус closed).
   */
  async reconcileWithBroker(
    getBroker: (userId: number) => Promise<{
      getPositions(): Promise<Array<{ symbol: string; side: string }>>;
      getClosedTrades(limit?: number): Promise<Array<{ symbol: string; side: string; exitPrice: number; closedAt: string }>>;
    } | null>
  ): Promise<number> {
    let fixed = 0;
    const userIds = await this.deps.snapshots
      .listUserIds()
      .catch(() => [] as number[]);
    for (const userId of userIds) {
      const snaps = (await this.deps.snapshots.listByUser(userId, 500)).filter(
        (s) => s.status === "open"
      );
      if (snaps.length === 0) continue;
      const broker = await getBroker(userId);
      if (!broker) continue;
      let positionKeys = new Set<string>();
      try {
        positionKeys = new Set(
          (await broker.getPositions()).map(
            (p2) => String(p2.symbol).trim().toUpperCase() + ":" + p2.side
          )
        );
      } catch {
        continue;
      }
      let closedTrades: Array<any> = [];
      for (const snap of snaps) {
        const key = snap.symbol.trim().toUpperCase() + ":" + snap.side;
        if (positionKeys.has(key)) continue;
        if (closedTrades.length === 0) {
          try {
            closedTrades = await broker.getClosedTrades(50);
          } catch {
            closedTrades = [];
          }
        }
        const closed = closedTrades.find(
          (t) =>
            String(t.symbol).trim().toUpperCase() === snap.symbol.trim().toUpperCase() &&
            t.side === snap.side &&
            t.closedAt >= snap.createdAt
        );
        if (!closed) continue;
        console.log("[learning] reconcile: match", snap.symbol, snap.side, "created", snap.createdAt, "closedAt", closed.closedAt);
        try {
          await this.recordTradeClose({
            userId,
            symbol: snap.symbol,
            side: snap.side,
            exitPrice: closed.exitPrice,
            closedAt: closed.closedAt,
          });
          fixed += 1;
        } catch (e2) {
          console.log("[learning] reconcile: recordTradeClose FAILED", snap.symbol, snap.side, e2 instanceof Error ? e2.message : String(e2));
        }
      }
    }
    return fixed;
  }

  async runDailyReport(
    userId: number,
    opts?: { force?: boolean }
  ): Promise<LearningReport> {
    const state = await this.ensureState(userId);
    const today = utcToday();

    if (!opts?.force && state.lastReportDate === today && state.lastReportId) {
      const existing = await this.deps.reports.get(state.lastReportId);
      if (existing) {
        return existing;
      }
    }

    const snapshots = await this.deps.snapshots.listByUser(userId);
    const cutoff = new Date(
      Date.now() - ANALYSIS_HISTORY_DAYS * 86_400_000
    ).toISOString();
    const eligible = snapshots
      .filter(
        (snapshot) =>
          snapshot.status === "closed" &&
          snapshot.result !== null &&
          snapshot.result.closedAt >= cutoff
      )
      .sort((a, b) =>
        (a.result?.closedAt ?? a.updatedAt).localeCompare(
          b.result?.closedAt ?? b.updatedAt
        )
      );

    const tradeCount = eligible.length;
    const metricsOutcome = computeMetrics(eligible);
    const metrics = metricsOutcome.ok ? metricsOutcome.metrics : null;

    if (tradeCount < MIN_TRADES_FOR_RULES) {
      return this.persistReport(
        userId,
        {
          reportDate: today,
          status: "insufficient_data",
          tradeCount,
          summary: `Недостаточно закрытых сделок: ${tradeCount} за последние ${ANALYSIS_HISTORY_DAYS} дней, минимум ${MIN_TRADES_FOR_RULES}. Правила не корректируются (анти-оверфит).`,
          successPatterns: [],
          failurePatterns: [],
          ruleAdjustments: [],
          strategyVersion: null,
          metrics: null,
          error: null,
          model: "",
        },
        today
      );
    }

    const active = await this.deps.strategies.active(userId);
    const userPrompt = buildLearningPrompt({
      trades: eligible,
      activeVersion: active,
    });

    let analysis: LearningAnalysis;
    let model = "";
    try {
      const result = await this.deps.deepseek.complete("chat", {
        system: LEARNING_SYSTEM_PROMPT,
        user: userPrompt,
      });
      model = result.model;
      analysis = parseAndValidate(result.content, learningAnalysisSchema);
    } catch (error) {
      return this.persistReport(
        userId,
        {
          reportDate: today,
          status: "failed",
          tradeCount,
          summary: `Ошибка генерации learning-отчёта: ${toErrorMessage(error)}`,
          successPatterns: [],
          failurePatterns: [],
          ruleAdjustments: [],
          strategyVersion: null,
          metrics: metricsOutcome.ok ? metricsOutcome.metrics : null,
          error: toErrorMessage(error),
          model: model || "",
        },
        today
      );
    }

    const ruleAdjustments = normalizeRules(analysis.ruleAdjustments);
    const currentRules = active?.rules ?? [];
    const hasChanges = rulesChanged(currentRules, ruleAdjustments);

    let status: LearningReportStatus = "no_changes";
    let strategyVersion: number | null = null;
    let reportId = randomUUID();

    if (hasChanges && metricsOutcome.ok) {
      const created = await this.createStrategyVersion(userId, {
        parentVersion: active?.version ?? null,
        rules: ruleAdjustments,
        metrics: metricsOutcome.metrics,
        sourceReportId: reportId,
        nameFor: (version) => `Стратегия v${version} от ${today}`,
      });
      strategyVersion = created.version;
      status = "strategy_created";
    }

    const report = await this.persistReport(
      userId,
      {
        reportDate: today,
        status,
        tradeCount,
        summary: analysis.summary,
        successPatterns: analysis.successPatterns,
        failurePatterns: analysis.failurePatterns,
        ruleAdjustments,
        strategyVersion,
        metrics,
        error: null,
        model,
      },
      today,
      reportId
    );

    return report;
  }

  private async persistReport(
    userId: number,
    input: {
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
    },
    reportDate: string,
    idOverride?: string
  ): Promise<LearningReport> {
    const report: LearningReport = {
      id: idOverride ?? randomUUID(),
      userId,
      reportDate: input.reportDate,
      status: input.status,
      tradeCount: input.tradeCount,
      summary: input.summary,
      successPatterns: input.successPatterns,
      failurePatterns: input.failurePatterns,
      ruleAdjustments: input.ruleAdjustments,
      strategyVersion: input.strategyVersion,
      metrics: input.metrics,
      error: input.error,
      model: input.model,
      createdAt: nowIso(),
    };
    await this.deps.reports.save(report);
    await this.updateState(userId, {
      lastReportDate: reportDate,
      lastReportId: report.id,
    });
    return report;
  }

  // -------------------------------------------------------------------------
  // Версионирование стратегий и метрики
  // -------------------------------------------------------------------------

  private async createStrategyVersion(
    userId: number,
    params: {
      parentVersion: number | null;
      rules: StrategyRule[];
      metrics: MetricsSnapshot;
      sourceReportId: string;
      nameFor: (version: number) => string;
    }
  ): Promise<StrategyVersion> {
    const versions = await this.deps.strategies.listByUser(userId);
    const nextVersion =
      versions.length > 0
        ? Math.max(...versions.map((version) => version.version)) + 1
        : 1;
    const timestamp = nowIso();
    const strategy: StrategyVersion = {
      id: strategyId(userId, nextVersion),
      userId,
      version: nextVersion,
      name: params.nameFor(nextVersion),
      status: "candidate",
      rules: params.rules,
      metrics: params.metrics,
      parentVersion: params.parentVersion,
      sourceReportId: params.sourceReportId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.deps.strategies.save(strategy);
    return strategy;
  }

  /** Переводит версию стратегии в активную (продвижение/откат). */
  async promoteStrategy(
    userId: number,
    version: number
  ): Promise<StrategyVersion> {
    const state = await this.ensureState(userId);
    const target = await this.deps.strategies.byVersion(userId, version);
    if (!target) {
      throw new Error(`Стратегия v${version} не найдена`);
    }

    const all = await this.deps.strategies.listByUser(userId);
    const timestamp = nowIso();
    for (const strategy of all) {
      if (strategy.version === version && strategy.status !== "active") {
        await this.deps.strategies.save({
          ...strategy,
          status: "active",
          updatedAt: timestamp,
        });
      } else if (strategy.status === "active" && strategy.version !== version) {
        await this.deps.strategies.save({
          ...strategy,
          status: "archived",
          updatedAt: timestamp,
        });
      }
    }

    await this.deps.state.save({
      ...state,
      activeVersion: version,
      abTest: null,
      updatedAt: timestamp,
    });
    return { ...target, status: "active", updatedAt: timestamp };
  }

  /** Откат стратегии админом на любую предыдущую версию. */
  async rollbackStrategy(
    userId: number,
    version: number
  ): Promise<StrategyVersion> {
    return this.promoteStrategy(userId, version);
  }

  // -------------------------------------------------------------------------
  // A/B режим
  // -------------------------------------------------------------------------

  async startAbTest(
    userId: number,
    testVersion: number
  ): Promise<StrategyState> {
    const state = await this.ensureState(userId);
    const target = await this.deps.strategies.byVersion(userId, testVersion);
    if (!target) {
      throw new Error(`Стратегия v${testVersion} не найдена`);
    }
    if (target.status === "active") {
      throw new Error("Нельзя тестировать активную стратегию");
    }

    const ab: AbTestState = {
      enabled: true,
      referenceVersion: state.activeVersion,
      testVersion,
      startedAt: nowIso(),
      endedAt: null,
    };
    const next: StrategyState = {
      ...state,
      abTest: ab,
      updatedAt: ab.startedAt!,
    };
    await this.deps.state.save(next);
    return next;
  }

  async stopAbTest(userId: number): Promise<{
    state: StrategyState;
    comparison: AbTestComparisonResult | null;
  }> {
    const state = await this.ensureState(userId);
    if (!state.abTest?.enabled) {
      throw new Error("A/B тест не активен. Запуск: /strategy_ab <версия>");
    }
    const comparison = await this.abTestComparison(userId, state.abTest);
    const now = nowIso();
    const next: StrategyState = {
      ...state,
      abTest: { ...state.abTest, enabled: false, endedAt: now },
      updatedAt: now,
    };
    await this.deps.state.save(next);
    return { state: next, comparison };
  }

  async abTestComparison(
    userId: number,
    abInput?: AbTestState
  ): Promise<AbTestComparisonResult | null> {
    const state = abInput
      ? ({ abTest: abInput } as StrategyState)
      : await this.ensureState(userId);
    const ab = state.abTest;
    if (
      !ab ||
      ab.referenceVersion == null ||
      ab.testVersion == null ||
      ab.startedAt == null
    ) {
      return null;
    }

    const windowEnd = ab.endedAt ?? nowIso();
    const all = await this.deps.snapshots.listByUser(userId);
    const closed = all.filter(
      (snapshot) =>
        snapshot.status === "closed" &&
        snapshot.result !== null &&
        snapshot.result.closedAt >= ab.startedAt! &&
        snapshot.result.closedAt <= windowEnd
    );

    const referenceSnapshots = closed.filter(
      (snapshot) => snapshot.strategyVersion === ab.referenceVersion
    );
    const testSnapshots = closed.filter(
      (snapshot) => snapshot.strategyVersion === ab.testVersion
    );

    const referenceMetrics = computeMetrics(referenceSnapshots);
    const testMetrics = computeMetrics(testSnapshots);

    return {
      referenceVersion: ab.referenceVersion,
      testVersion: ab.testVersion,
      startedAt: ab.startedAt,
      endedAt: ab.endedAt,
      referenceTrades: referenceSnapshots.length,
      testTrades: testSnapshots.length,
      reference: referenceMetrics.ok ? referenceMetrics.metrics : null,
      test: testMetrics.ok ? testMetrics.metrics : null,
    };
  }

  // -------------------------------------------------------------------------
  // Просмотр
  // -------------------------------------------------------------------------

  async getState(userId: number): Promise<StrategyState> {
    return this.ensureState(userId);
  }

  async listStrategies(userId: number): Promise<StrategyVersion[]> {
    return this.deps.strategies.listByUser(userId);
  }

  async listReports(userId: number, limit = 5): Promise<LearningReport[]> {
    return this.deps.reports.listByUser(userId, limit);
  }

  async listUsersWithData(): Promise<number[]> {
    return this.deps.snapshots.listUserIds();
  }

  // -------------------------------------------------------------------------
  // Внутреннее
  // -------------------------------------------------------------------------

  private async ensureState(userId: number): Promise<StrategyState> {
    const existing = await this.deps.state.get(userId);
    if (existing) {
      return existing;
    }
    await this.ensureBaseStrategy(userId);
    const state: StrategyState = {
      userId,
      activeVersion: 1,
      lastReportDate: null,
      lastReportId: null,
      abTest: null,
      updatedAt: nowIso(),
    };
    await this.deps.state.save(state);
    return state;
  }

  private async ensureBaseStrategy(userId: number): Promise<StrategyVersion> {
    const existing = await this.deps.strategies.active(userId);
    if (existing) {
      return existing;
    }
    const timestamp = nowIso();
    const base: StrategyVersion = {
      id: strategyId(userId, 1),
      userId,
      version: 1,
      name: "Базовая стратегия",
      status: "active",
      rules: [],
      metrics: null,
      parentVersion: null,
      sourceReportId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.deps.strategies.save(base);
    return base;
  }

  private async updateState(
    userId: number,
    patch: { lastReportDate?: string; lastReportId?: string }
  ): Promise<StrategyState> {
    const state = await this.ensureState(userId);
    const next: StrategyState = {
      ...state,
      ...patch,
      updatedAt: nowIso(),
    };
    await this.deps.state.save(next);
    return next;
  }
}
