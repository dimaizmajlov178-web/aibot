import type { BaseBroker, BrokerOpenOrder, PositionSide } from "../broker/base";
import { UpscaleApiError } from "../broker";
import type { AnalyzeResult, AiAnalysisService } from "../ai/service";
import type { TradeSignal } from "../ai/schema";
import type { MarketDataProvider } from "../ai/market-data";
import { isSymbolAllowed, type TradingSettings } from "./types";
import {
  RiskManager,
  aiModeMultiplier,
  type BrokerSnapshot,
} from "./risk-manager";
import { OrderExecutor } from "./executor";
import type { LockStore } from "./lock";
import type { LearningRecorder } from "../learning/types";
import type { AuditService } from "../core/audit";
import { createRequestId } from "../core/request-id";

export const DEFAULT_DECISION_INTERVAL_MS = 300_000;
export const DEFAULT_LOCK_TTL_MS = 30_000;
/** Пауза перед следующей итерацией после ошибки rate limit брокера (429). */
export const RATE_LIMIT_BACKOFF_MS = 5_000;
/**
 * Минимальный интервал между проверками статусов защитных ордеров (мс).
 * Защита от лишних запросов GET /orders: статусы висящих стоп/тейк-ордеров
 * проверяются не чаще раза в этот интервал на каждый символ.
 */
export const PROTECTIVE_STATUS_CHECK_INTERVAL_MS = 120_000;

export type EngineEventType =
  | "signal"
  | "trade_open"
  | "trade_close"
  | "risk_block"
  | "dup_skip"
  | "admin_notify"
  | "pause_changed"
  | "error"
  | "diagnostic";

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
  /**
   * Последний зафиксированный статус защитных ордеров по ключу
   * "userId:symbol" — чтобы статусы висящих стоп/тейк ордеров писались в лог
   * при изменении, а не на каждом тике цикла.
   */
  private readonly protectiveStatusCache = new Map<string, string>();
  /** Ключи "userId:symbol", для которых мы видели открытую позицию. */
  private readonly seenPositionKeys = new Set<string>();
  /**
   * Время последней проверки защитных ордеров по ключу "userId:symbol".
   * Статусы проверяются не чаще PROTECTIVE_STATUS_CHECK_INTERVAL_MS, чтобы
   * лишние GET /orders не упирались в rate limit брокера.
   */
  private readonly protectiveStatusCheckedAt = new Map<string, number>();

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
    this.emit(
      event(
        "diagnostic",
        0,
        "",
        `торговый цикл запущен: интервал ${this.decisionIntervalMs} мс`,
        {
          decisionIntervalMs: this.decisionIntervalMs,
          lockTtlMs: this.lockTtlMs,
          symbols: this.supportedSymbols,
        },
        createRequestId()
      )
    );
    // Первый тик выполняем сразу после старта, а не дожидаясь первого
    // интервала (по умолчанию 5 минут): иначе после перезапуска бота, пока
    // дойдёт первый tick, торговый цикл молчит, и в логах видны только строки
    // запуска.
    void this.tick().catch((error) => this.onTickFatal(error));
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.onTickFatal(error));
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

  /**
   * Последняя линия защиты: исключение никогда не должно выходить из tick()
   * в `void this.tick()` (иначе unhandled rejection роняет процесс).
   */
  private onTickFatal(error: unknown): void {
    const requestId = createRequestId();
    try {
      this.emit(
        event(
          "error",
          0,
          "",
          `Необработанная ошибка торгового цикла: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { requestId },
          requestId
        )
      );
    } catch {
      // Ошибка наблюдателя не должна ронять процесс.
    }
  }

  /** Полный цикл решений по таймеру для всех пользователей и символов. */
  async tick(): Promise<void> {
    const requestId = createRequestId();
    let userIds: number[];
    try {
      userIds = await this.deps.resolveUserIds();
    } catch (error) {
      // Если БД/репозиторий подключений недоступен — цикл не должен молча
      // пропускать итерацию: пишем ошибку, чтобы причина была видна в логах.
      this.emit(
        event(
          "error",
          0,
          "",
          `Ошибка чтения списка подключённых пользователей: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { source: "timer" },
          requestId
        )
      );
      return;
    }

    if (userIds.length === 0) {
      // Самая частая причина «пустых» логов: боту не для кого торговать.
      // Пишем диагностику, чтобы это было очевидно, а не молчанием.
      this.emit(
        event(
          "diagnostic",
          0,
          "",
          "торговый цикл: нет подключённых пользователей (выполните /connect в боте)",
          { source: "timer" },
          requestId
        )
      );
      return;
    }

    for (const userId of userIds) {
      let symbols: string[];
      try {
        symbols = await this.symbolsForUser(userId);
      } catch (error) {
        this.emit(
          event(
            "error",
            userId,
            "",
            `Ошибка чтения настроек пользователя ${userId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { source: "timer" },
            requestId
          )
        );
        continue;
      }
      if (symbols.length === 0) {
        // Тихая ветка: пользователь есть, но whitelist не совпадает ни с
        // одним поддерживаемым символом. Раньше цикл молча ничего не делал.
        this.emit(
          event(
            "diagnostic",
            userId,
            "",
            "торговый цикл: у пользователя нет символов для торговли (whitelist не пересекается с поддерживаемыми)",
            { source: "timer" },
            requestId
          )
        );
        continue;
      }
      for (const symbol of symbols) {
        try {
          await this.evaluateSymbol(userId, symbol, "timer");
        } catch (error) {
          this.emit(
            event(
              "error",
              userId,
              symbol,
              `Необработанная ошибка обработки ${symbol}: ${
                error instanceof Error ? error.message : String(error)
              }`,
              { source: "timer" },
              requestId
            )
          );
        }
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
    } catch (error) {
      this.emit(
        event(
          "error",
          0,
          symbol,
          `Ошибка чтения списка подключённых пользователей: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { source },
          createRequestId()
        )
      );
      return;
    }
    for (const userId of userIds) {
      try {
        const settings = await this.deps.riskManager.getSettings(userId);
        if (isSymbolAllowed(settings, symbol)) {
          await this.evaluateSymbol(userId, symbol, source);
        }
      } catch (error) {
        this.emit(
          event(
            "error",
            userId,
            symbol,
            `Необработанная ошибка обработки события ${source}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { source },
            createRequestId()
          )
        );
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
      this.emit(
        event(
          "diagnostic",
          userId,
          normSymbol,
          "пропуск: глобальная пауза (/global_pause)",
          { source },
          requestId
        )
      );
      return events;
    }

    let broker: BaseBroker | null;
    try {
      broker = await this.deps.resolveBroker(userId);
    } catch (error) {
      this.pushError(
        events,
        userId,
        normSymbol,
        "Ошибка получения клиента брокера",
        error,
        requestId
      );
      return events;
    }

    if (!broker) {
      this.emit(
        event(
          "diagnostic",
          userId,
          normSymbol,
          "пропуск: брокер не подключён (выполните /connect)",
          { source },
          requestId
        )
      );
      return events;
    }

    let settings: TradingSettings;
    try {
      settings = await this.deps.riskManager.getSettings(userId);
    } catch (error) {
      this.pushError(
        events,
        userId,
        normSymbol,
        "Ошибка чтения настроек торговли",
        error,
        requestId
      );
      return events;
    }
    if (!isSymbolAllowed(settings, normSymbol)) {
      this.emit(
        event(
          "diagnostic",
          userId,
          normSymbol,
          "пропуск: символ не разрешён настройками (/settings symbols=...)",
          { source },
          requestId
        )
      );
      return events;
    }

    // Ошибки брокера (в т.ч. 429 rate limit) не должны ронять процесс:
    // пропускаем итерацию и, при rate limit, делаем короткую паузу.
    let snapshot: BrokerSnapshot;
    try {
      snapshot = await this.buildSnapshot(broker);
    } catch (error) {
      this.pushError(
        events,
        userId,
        normSymbol,
        "Ошибка получения состояния счёта (брокер недоступен)",
        error,
        requestId
      );
      await this.maybeRateLimitBackoff(error);
      return events;
    }
    const existing = snapshot.positions.find(
      (position) => position.symbol.toUpperCase() === normSymbol
    );

    // Если ранее позиция была открыта, а сейчас её нет (до того, как AI
    // успел дать сигнал на закрытие) — она закрылась на бирже, скорее всего
    // защитным ордером (стоп-лосс или тейк-профит). Фиксируем в логах.
    if (!existing) {
      const positionKey = `${userId}:${normSymbol}`;
      if (this.seenPositionKeys.has(positionKey)) {
        this.emit(
          event(
            "diagnostic",
            userId,
            normSymbol,
            "Позиция закрыта на бирже (вероятно, сработал защитный стоп/тейк ордер)",
            { source, requestId },
            requestId
          )
        );
        this.seenPositionKeys.delete(positionKey);
      }
    } else {
      this.seenPositionKeys.add(`${userId}:${normSymbol}`);
    }

    this.emit(
      event(
        "diagnostic",
        userId,
        normSymbol,
        "AI-анализ: сбор рыночных данных и запрос к DeepSeek",
        { source, requestId },
        requestId
      )
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
      await this.maybeRateLimitBackoff(error);
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
        // Позиция жива, но на бирже уже сработал защитный ордер (стоп-лосс
        // или тейк-профит не в статусе active) — фиксируем это в логах,
        // чтобы срабатывание стопа/тейка было видно без зависимости от бота.
        await this.logProtectiveOrderStatus(userId, normSymbol, requestId);
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
        this.seenPositionKeys.delete(`${userId}:${normSymbol}`);
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
        await this.maybeRateLimitBackoff(error);
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
      const effectiveRiskPercent = Math.min(
        settings.riskPerTradePercent * aiModeMultiplier(settings.aiMode),
        settings.riskPerTradePercent
      );
      // Риск на сделку задаётся как стоп-лосс в процентах от цены входа.
      // Бюджет риска в деньгах = баланс × риск%. Позиция открывается так,
      // чтобы при срабатывании стопа потеря не превышала этот бюджет:
      // notional = рискБюджет / (стоп% / 100). Так риск-менеджмент подгоняет
      // размер позиции под стоп, а маржа (при макс. плече) уходит минимальной.
      const riskBudget =
        (snapshot.account.balance * effectiveRiskPercent) / 100;
      const stopFraction = settings.stopLossPercent / 100;
      const riskSizedNotional =
        stopFraction > 0 ? riskBudget / stopFraction : riskBudget;
      const notional = Math.min(
        riskSizedNotional,
        snapshot.account.availableCash
      );
      // Стоп-лосс и тейк-профит считаются от цены входа по настройкам:
      // для long стоп ниже входа, тейк выше; для short наоборот. Тейк на
      // расстоянии RR × стоп. Квадратное округление гарантирует, что стоп не
      // больше заданного процента.
      const stopPct = settings.stopLossPercent;
      const rr = settings.riskRewardRatio;
      const stopDistance = price * (stopPct / 100);
      const stopTriggerPrice =
        openSide === "long" ? price - stopDistance : price + stopDistance;
      const takeTriggerPrice =
        openSide === "long"
          ? price + stopDistance * rr
          : price - stopDistance * rr;
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
          const currentSnapshot = await this.refreshSnapshot(broker, snapshot);
          const needsNotify =
            await this.deps.riskManager.checkTotalStopNotification(
              userId,
              currentSnapshot
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
        stopTriggerPrice,
        takeTriggerPrice,
      });
      await this.deps.riskManager.recordOpenedTrade(userId);
      this.seenPositionKeys.add(`${userId}:${normSymbol}`);
      this.emit(
        event(
          "trade_open",
          userId,
          normSymbol,
          `Открыта позиция ${openSide} ${quantity} по ${receipt.executedPrice}`,
          {
            source,
            receipt,
            quantity,
            stopTriggerPrice,
            takeTriggerPrice,
            protectiveOrders: receipt.protectiveOrders ?? [],
            requestId,
          },
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
          stopTriggerPrice,
          takeTriggerPrice,
          protectiveOrders: receipt.protectiveOrders ?? [],
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
      await this.maybeRateLimitBackoff(error);
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

  /**
   * Логирует статусы висящих на бирже защитных ордеров (стоп-лосс/тейк-профит).
   * Если хотя бы один защитный ордер ушёл из active (сработал), пишет
   * отдельное событие diagnose, чтобы срабатывание стопа/тейка было видно
   * в логах, даже когда закрытие произошло на бирже без участия бота.
   */
  protected async logProtectiveOrderStatus(
    userId: number,
    symbol: string,
    requestId?: string
  ): Promise<void> {
    let protectiveOrders: BrokerOpenOrder[] = [];
    let broker: BaseBroker | null = null;
    try {
      const now = Date.now();
      const cacheKey = `${userId}:${symbol}`;
      const lastChecked = this.protectiveStatusCheckedAt.get(cacheKey) ?? 0;
      if (now - lastChecked < PROTECTIVE_STATUS_CHECK_INTERVAL_MS) {
        return;
      }
      this.protectiveStatusCheckedAt.set(cacheKey, now);
      broker = await this.deps.resolveBroker(userId);
      if (broker) {
        protectiveOrders = await broker.getOpenOrders();
      }
    } catch (error) {
      this.emit(
        event(
          "diagnostic",
          userId,
          symbol,
          `Не удалось проверить статусы защитных ордеров: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { source: "protective_order" },
          requestId ?? createRequestId()
        )
      );
      return;
    }
    if (!broker) {
      return;
    }

    const marketKey = symbol.trim().toUpperCase();
    const relevant = protectiveOrders.filter((order) => {
      const rawSymbol = String(order.symbol ?? "").toUpperCase();
      const type = String(order.type ?? "").toLowerCase();
      const isProtective = type.includes("stop") || type.includes("take");
      return (
        isProtective &&
        (rawSymbol === "" ||
          rawSymbol.includes(marketKey) ||
          marketKey.includes(rawSymbol))
      );
    });

    if (relevant.length > 0) {
      const triggered = relevant.filter(
        (order) => String(order.status ?? "").toLowerCase() !== "active"
      );
      // Пишем событие только когда статус защитных ордеров изменился,
      // чтобы не засорять логи одинаковыми статусами на каждом тике цикла.
      const cacheKey = `${userId}:${symbol}`;
      const statusDigest = relevant
        .map((order) => `${order.type}:${order.status}`)
        .sort()
        .join(",");
      const cached = this.protectiveStatusCache.get(cacheKey);
      if (cached === statusDigest) {
        return;
      }
      this.protectiveStatusCache.set(cacheKey, statusDigest);
      if (triggered.length > 0) {
        this.emit(
          event(
            "diagnostic",
            userId,
            symbol,
            `Сработал защитный ордер на бирже: ${triggered
              .map((order) => `${order.type} (${order.status})`)
              .join(", ")}`,
            {
              source: "protective_order",
              triggeredOrders: triggered,
              activeOrders: relevant.filter(
                (order) => String(order.status ?? "").toLowerCase() === "active"
              ),
              requestId: requestId ?? undefined,
            },
            requestId
          )
        );
      } else {
        this.emit(
          event(
            "diagnostic",
            userId,
            symbol,
            "Защитные ордера висят на бирже (active)",
            {
              source: "protective_order",
              protectiveOrders: relevant,
              requestId: requestId ?? undefined,
            },
            requestId
          )
        );
      }
    }
  }

  /**
   * Повторно запрашивает снимок счёта; при ошибке брокера возвращает
   * предыдущий снимок, чтобы ветка обработки не падала.
   */
  private async refreshSnapshot(
    broker: BaseBroker,
    fallback: BrokerSnapshot
  ): Promise<BrokerSnapshot> {
    try {
      return await this.buildSnapshot(broker);
    } catch {
      return fallback;
    }
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
    void this.deps.audit
      ?.tradeError({
        userId,
        actorRole: "system",
        requestId: requestId ?? null,
        entityType: "order",
        entityId: symbol,
        details: { symbol, error: message },
      })
      .catch(() => {
        // Ошибка аудита не должна влиять на торговый цикл.
      });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * При ошибке rate limit брокера (429) делает короткую паузу, чтобы не
   * долбить API подряд в следующей итерации цикла.
   */
  private async maybeRateLimitBackoff(error: unknown): Promise<void> {
    if (error instanceof UpscaleApiError && error.statusCode === 429) {
      await this.sleep(RATE_LIMIT_BACKOFF_MS);
    }
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
