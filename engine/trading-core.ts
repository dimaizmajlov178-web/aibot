import type { BaseBroker, PositionSide } from "../broker/base";
import type { AnalyzeResult, AiAnalysisService } from "../ai/service";
import type { TradeSignal } from "../ai/schema";
import type { MarketDataProvider } from "../ai/market-data";
import { isSymbolAllowed } from "./types";
import { RiskManager, type BrokerSnapshot } from "./risk-manager";
import { OrderExecutor } from "./executor";
import type { LockStore } from "./lock";
import type { LearningRecorder } from "../learning/types";
import type { AuditService } from "../core/audit";
import { createRequestId } from "../core/request-id";

export const DEFAULT_DECISION_INTERVAL_MS = 60_000;
export const DEFAULT_LOCK_TTL_MS = 30_000;

export type EngineEventType =
  | "signal"
  | "trade_open"
  | "trade_close"
  | "risk_block"
  | "dup_skip"
  | "admin_notify"
  | "pause_changed"
  | "error";

export interface EngineEvent {
  type: EngineEventType;
  userId: number;
  symbol: string;
  side?: PositionSide;
  message: string;
  data?: Record<string, unknown>;
  at: string;
  requestId?: string;
}

export interface TradingCoreDeps {
  riskManager: RiskManager;
  executor: OrderExecutor;
  lockStore: LockStore;
  ai: AiAnalysisService;
  marketData: MarketDataProvider;
  resolveBroker: (userId: number) => Promise<BaseBroker | null>;
  resolveUserIds: () => Promise<number[]>;
  /** Колбэк уведомления админа (например, при общей просадке). */
  notifyAdmin?: (userId: number, message: string) => void;
  /** Все известные символы, доступные для торговли. */
  supportedSymbols: readonly string[];
  decisionIntervalMs?: number;
  lockTtlMs?: number;
  /** Внешний наблюдатель событий (телеметрия/логирование). */
  onEvent?: (event: EngineEvent) => void;
  /** Запись датасета сделок для самообучения. */
  learning: LearningRecorder;
  /** Глобальная пауза (/global_pause): при true торговля остановлена у всех. */
  isGlobalPaused?: () => Promise<boolean> | boolean;
  /** Журнал аудита (торговые действия, риск-блокировки, ошибки). */
  audit?: AuditService;
}

function roundQuantity(value: number): number {
  if (value <= 0) {
    return 0;
  }
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Торговое ядро: запускает цикл решений по таймеру и по событиям
 * (закрытие свечи, резкое движение), исполняет ордера через
 * broker.execute_order() с ретраями, применяет риск-контроль и защиту
 * от дублей.
 */
export class TradingCore {
  private readonly decisionIntervalMs: number;
  private readonly lockTtlMs: number;
  private readonly supportedSymbols: readonly string[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: TradingCoreDeps) {
    this.decisionIntervalMs =
      deps.decisionIntervalMs ?? DEFAULT_DECISION_INTERVAL_MS;
    this.lockTtlMs = deps.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    this.supportedSymbols = [...deps.supportedSymbols];
  }

  /** Запускает цикл решений по таймеру. */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.decisionIntervalMs);
    this.timer.unref?.();
  }

  /** Останавливает таймер. Команда-резерв для /global_pause. */
  stopPumping(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  /** Полный цикл решений по таймеру для всех пользователей и символов. */
  async tick(): Promise<void> {
    let userIds: number[];
    try {
      userIds = await this.deps.resolveUserIds();
    } catch {
      return;
    }

    for (const userId of userIds) {
      const symbols = await this.symbolsForUser(userId);
      for (const symbol of symbols) {
        await this.evaluateSymbol(userId, symbol, "timer");
      }
    }
  }

  /** Событие: закрытие свечи. */
  async onCandleClose(symbol: string, _timeframe?: string): Promise<void> {
    await this.runForEvent(symbol, "candle_close");
  }

  /** Событие: резкое движение цены (процент и направление). */
  async onSharpMove(symbol: string, percent: number): Promise<void> {
    const threshold = 2;
    if (Math.abs(percent) < threshold) {
      return;
    }
    await this.runForEvent(symbol, "sharp_move");
  }

  private async runForEvent(symbol: string, source: string): Promise<void> {
    let userIds: number[];
    try {
      userIds = await this.deps.resolveUserIds();
    } catch {
      return;
    }
    for (const userId of userIds) {
      const settings = await this.deps.riskManager.getSettings(userId);
      if (isSymbolAllowed(settings, symbol)) {
        await this.evaluateSymbol(userId, symbol, source);
      }
    }
  }

  private async symbolsForUser(userId: number): Promise<string[]> {
    const settings = await this.deps.riskManager.getSettings(userId);
    if (settings.symbols.length > 0) {
      return this.supportedSymbols.filter((symbol) =>
        isSymbolAllowed(settings, symbol)
      );
    }
    return [...this.supportedSymbols];
  }

  private emit(event: EngineEvent): void {
    this.deps.onEvent?.(event);
  }

  /**
   * Цикл решений для одного пользователя и символа: анализ AI, риск-контроль,
   * исполнение ордера под защитой от дублей.
   */
  async evaluateSymbol(
    userId: number,
    symbol: string,
    source: string
  ): Promise<EngineEvent[]> {
    const normSymbol = symbol.trim().toUpperCase();
    const requestId = createRequestId();
    const events: EngineEvent[] = [];

    // Глобальная пауза админом (/global_pause) останавливает торговлю у всех.
    if (await this.deps.isGlobalPaused?.()) {
      return events;
    }

    const broker = await this.deps.resolveBroker(userId);

    if (!broker) {
      return events;
    }

    const settings = await this.deps.riskManager.getSettings(userId);
    if (!isSymbolAllowed(settings, normSymbol)) {
      return events;
    }

    const snapshot = await this.buildSnapshot(broker);
    const existing = snapshot.positions.find(
      (position) => position.symbol.toUpperCase() === normSymbol
    );

    let analysis: AnalyzeResult<TradeSignal>;
    try {
      analysis = await this.deps.ai.analyzeSignal({
        userId,
        symbol: normSymbol,
      });
    } catch (error) {
      this.pushError(
        events,
        userId,
        normSymbol,
        "Ошибка AI-анализа",
        error,
        requestId
      );
      return events;
    }

    const signal = analysis.decision;
    if (!signal) {
      this.emit(
        event(
          "signal",
          userId,
          normSymbol,
          "AI: нет сигнала (hold/невалидный ответ)",
          { source, requestId },
          requestId
        )
      );
      return events;
    }
    this.emit(
      event(
        "signal",
        userId,
        normSymbol,
        formatSignal(signal),
        { source, confidence: signal.confidence, requestId },
        requestId
      )
    );

    const openSide = signalToSide(signal);

    if (existing) {
      // Закрытие существующей позиции.
      if (
        signal.action === "hold" ||
        openSide === null ||
        openSide === existing.side
      ) {
        return events;
      }
      const key = lockKey(
        userId,
        normSymbol,
        `${existing.side}:close` as PositionSide
      );
      if (!(await this.deps.lockStore.acquire(key, this.lockTtlMs))) {
        this.emit(
          event(
            "dup_skip",
            userId,
            normSymbol,
            "Пропуск: ордер на закрытие уже исполняется",
            { source, requestId },
            requestId
          )
        );
        return events;
      }
      try {
        const receipt = await this.deps.executor.execute(broker, {
          symbol: normSymbol,
          side: existing.side,
          action: "close",
          quantity: existing.quantity,
        });
        this.emit(
          event(
            "trade_close",
            userId,
            normSymbol,
            `Позиция закрыта по ${receipt.executedPrice}`,
            { source, receipt, requestId },
            requestId
          )
        );
        await this.deps.audit?.tradeClose({
          userId,
          actorRole: "system",
          requestId,
          entityType: "order",
          entityId: receipt.orderId,
          details: {
            symbol: normSymbol,
            side: existing.side,
            action: "close",
            quantity: existing.quantity,
            price: receipt.executedPrice,
            executedAt: receipt.executedAt,
            source,
          },
        });
        await this.deps.learning.recordTradeClose({
          userId,
          symbol: normSymbol,
          side: existing.side,
          exitPrice: receipt.executedPrice,
          closedAt: receipt.executedAt,
        });
      } catch (error) {
        this.pushError(
          events,
          userId,
          normSymbol,
          "Ошибка закрытия позиции",
          error,
          requestId
        );
      } finally {
        await this.deps.lockStore.release(key);
      }
      return events;
    }

    // Нет позиции — рассматриваем открытие.
    if (signal.action === "hold" || openSide === null) {
      return events;
    }

    const key = lockKey(userId, normSymbol, openSide);
    if (!(await this.deps.lockStore.acquire(key, this.lockTtlMs))) {
      this.emit(
        event(
          "dup_skip",
          userId,
          normSymbol,
          `Пропуск: блокировка ${normSymbol}/${openSide} уже занята`,
          { source, requestId },
          requestId
        )
      );
      return events;
    }

    try {
      const price = await this.currentPrice(normSymbol, signal.entryPrice);
      const notional = price * 1;
      const decision = await this.deps.riskManager.checkOpenTrade(
        userId,
        normSymbol,
        openSide,
        notional,
        snapshot,
        settings
      );

      if (!decision.allow) {
        const blockEvent = event(
          "risk_block",
          userId,
          normSymbol,
          decision.reason ?? "блокировка",
          {
            code: decision.code,
            source,
            snapshot: redactSnapshot(snapshot),
            requestId,
          },
          requestId
        );
        this.emit(blockEvent);
        void this.deps.audit?.tradeRejected({
          userId,
          actorRole: "system",
          requestId,
          entityType: "order",
          entityId: normSymbol,
          details: {
            symbol: normSymbol,
            side: openSide,
            code: decision.code,
            reason: decision.reason,
            source,
          },
        });
        if (decision.code === "total_stop") {
          const needsNotify =
            await this.deps.riskManager.checkTotalStopNotification(
              userId,
              await this.buildSnapshot(broker)
            );
          if (needsNotify) {
            const msg = `🚨 ВНИМАНИЕ: торговля пользователя ${userId} остановлена — превышена общая просадка.`;
            this.deps.notifyAdmin?.(userId, msg);
            this.emit(
              event(
                "admin_notify",
                userId,
                normSymbol,
                msg,
                { source, requestId },
                requestId
              )
            );
            await this.deps.audit?.riskState("trading.admin_notify", {
              userId,
              actorRole: "system",
              requestId,
              entityType: "trading_state",
              entityId: userId,
              details: { message: msg, source },
            });
            await this.deps.audit?.riskState("trading.total_stop", {
              userId,
              actorRole: "system",
              requestId,
              entityType: "trading_state",
              entityId: userId,
              details: { source },
            });
          }
        }
        return events;
      }

      const budget = Math.min(
        decision.maxTradeNotional,
        snapshot.account.availableCash
      );
      const quantity = roundQuantity(budget / price);
      if (quantity <= 0) {
        this.emit(
          event(
            "risk_block",
            userId,
            normSymbol,
            "Недостаточно средств для минимального объёма",
            {
              code: "margin_insufficient",
              source,
              requestId,
            },
            requestId
          )
        );
        void this.deps.audit?.tradeRejected({
          userId,
          actorRole: "system",
          requestId,
          entityType: "order",
          entityId: normSymbol,
          details: {
            symbol: normSymbol,
            side: openSide,
            code: "margin_insufficient",
            source,
          },
        });
        return events;
      }

      const receipt = await this.deps.executor.execute(broker, {
        symbol: normSymbol,
        side: openSide,
        action: "open",
        quantity,
        price,
      });
      await this.deps.riskManager.recordOpenedTrade(userId);
      this.emit(
        event(
          "trade_open",
          userId,
          normSymbol,
          `Открыта позиция ${openSide} ${quantity} по ${receipt.executedPrice}`,
          { source, receipt, quantity, requestId },
          requestId
        )
      );
      await this.deps.audit?.tradeOpen({
        userId,
        actorRole: "system",
        requestId,
        entityType: "order",
        entityId: receipt.orderId,
        details: {
          symbol: normSymbol,
          side: openSide,
          action: "open",
          quantity,
          price: receipt.executedPrice,
          executedAt: receipt.executedAt,
          source,
          signal: {
            action: signal.action,
            confidence: signal.confidence,
            riskPercent: signal.riskPercent,
          },
        },
      });
      await this.deps.learning.recordTradeOpen({
        userId,
        symbol: normSymbol,
        side: openSide,
        market: analysis.market,
        signal,
        entryPrice: receipt.executedPrice,
        quantity,
        openedAt: receipt.executedAt,
      });
    } catch (error) {
      this.pushError(
        events,
        userId,
        normSymbol,
        "Ошибка исполнения ордера",
        error,
        requestId
      );
    } finally {
      await this.deps.lockStore.release(key);
    }

    return events;
  }

  private async buildSnapshot(broker: BaseBroker): Promise<BrokerSnapshot> {
    const [account, positions] = await Promise.all([
      broker.getAccount(),
      broker.getPositions(),
    ]);
    return { account, positions };
  }

  private async currentPrice(
    symbol: string,
    signalPrice: number | null
  ): Promise<number> {
    if (signalPrice && signalPrice > 0) {
      return signalPrice;
    }
    try {
      const candles = await this.deps.marketData.getCandles(symbol, "1h", 2);
      const last = candles[candles.length - 1];
      if (last) {
        return last.close;
      }
    } catch {
      // fall through
    }
    return 1;
  }

  private pushError(
    events: EngineEvent[],
    userId: number,
    symbol: string,
    prefix: string,
    error: unknown,
    requestId?: string
  ): void {
    const message = `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
    const eventValue = event(
      "error",
      userId,
      symbol,
      message,
      undefined,
      requestId
    );
    this.emit(eventValue);
    events.push(eventValue);
    void this.deps.audit?.tradeError({
      userId,
      actorRole: "system",
      requestId: requestId ?? null,
      entityType: "order",
      entityId: symbol,
      details: { symbol, error: message },
    });
  }
}

function event(
  type: EngineEventType,
  userId: number,
  symbol: string,
  message: string,
  data?: Record<string, unknown>,
  requestId?: string
): EngineEvent {
  return {
    type,
    userId,
    symbol,
    message,
    data,
    at: new Date().toISOString(),
    requestId,
  };
}

function lockKey(
  userId: number,
  symbol: string,
  direction: PositionSide
): string {
  return `trade:${userId}:${symbol}:${direction}`;
}

function signalToSide(signal: TradeSignal): PositionSide | null {
  if (signal.action === "buy" && signal.side === "long") {
    return "long";
  }
  if (signal.action === "sell" && signal.side === "short") {
    return "short";
  }
  return null;
}

function formatSignal(signal: TradeSignal): string {
  return `AI: сигнал ${signal.action}/${signal.side}, уверенность ${signal.confidence}%, риск ${signal.riskPercent}%`;
}

function redactSnapshot(snapshot: BrokerSnapshot): {
  balance: number;
  positions: number;
} {
  return {
    balance: snapshot.account.balance,
    positions: snapshot.positions.length,
  };
}
