import type { BrokerAccount, OpenPosition, PositionSide } from "../broker/base";
import type {
  TradingSettingsRepository,
  TradingStateRepository,
} from "../db/trading-repository";
import type {
  TradingSettings,
  TradingSettingsPatch,
  TradingState,
} from "./types";
import { isSymbolAllowed } from "./types";
import type { AuditMeta, AuditService } from "../core/audit";

export type RiskBlockCode =
  | "paused"
  | "auto_daily_paused"
  | "total_stop"
  | "symbol_not_whitelisted"
  | "max_positions_reached"
  | "daily_trade_limit_reached"
  | "risk_per_trade_exceeded"
  | "margin_insufficient";

export interface RiskDecision {
  allow: boolean;
  code: RiskBlockCode | null;
  reason: string | null;
  effectiveRiskPercent: number;
  /** Максимальный объём позиции в деньгах из расчёта риск на сделку. */
  maxTradeNotional: number;
  /** Итоговое состояние после оценки (просадки, паузы) — уже сохранено. */
  state: TradingState;
}

export interface BrokerSnapshot {
  account: BrokerAccount;
  positions: OpenPosition[];
}

export interface RiskManagerDeps {
  settings: TradingSettingsRepository;
  state: TradingStateRepository;
  /** Журнал аудита изменений настроек и пауз. */
  audit?: AuditService;
  /** Дефолтные значения настроек (из .env) для новых пользователей. */
  defaults?: import("./settings").TradingSettingsDefaults;
}

export function utcToday(): string {
  return new Date().toISOString().split("T")[0]!;
}

export function createDefaultState(userId: number): TradingState {
  return {
    userId,
    paused: false,
    pausedAt: null,
    autoDailyPaused: false,
    autoDailyPauseDate: null,
    totalStopTriggered: false,
    totalStopTriggeredAt: null,
    adminNotifiedForTotalStop: false,
    tradesToday: 0,
    tradingDay: utcToday(),
    updatedAt: new Date().toISOString(),
  };
}

export function aiModeMultiplier(aiMode: TradingSettings["aiMode"]): number {
  switch (aiMode) {
    case "safe":
      return 0.5;
    case "aggressive":
      return 1.5;
    case "balanced":
    default:
      return 1;
  }
}

/**
 * Риск-менеджмент: жёсткие лимиты перед каждым ордером —
 * % баланса на сделку, максимум позиций, лимит сделок в день,
 * дневная и общая просадка, whitelist символов, маржа.
 */
export class RiskManager {
  constructor(private readonly deps: RiskManagerDeps) {}

  async getSettings(userId: number): Promise<TradingSettings> {
    const existing = await this.deps.settings.get(userId);
    if (existing) {
      return existing;
    }
    const { defaultSettings } = await import("./settings");
    const settings = defaultSettings(userId, this.deps.defaults);
    await this.deps.settings.save(settings);
    return settings;
  }

  async updateSettings(
    userId: number,
    patch: TradingSettingsPatch,
    meta: AuditMeta = {}
  ): Promise<TradingSettings> {
    const { applySettingsPatch, tradingSettingsSchema } =
      await import("./settings");
    const current = await this.getSettings(userId);
    const next = applySettingsPatch(current, patch);
    const parsed = tradingSettingsSchema.safeParse({
      riskPerTradePercent: next.riskPerTradePercent,
      stopLossPercent: next.stopLossPercent,
      riskRewardRatio: next.riskRewardRatio,
      maxPositions: next.maxPositions,
      dailyTradeLimit: next.dailyTradeLimit,
      maxDailyDrawdownPercent: next.maxDailyDrawdownPercent,
      maxTotalDrawdownPercent: next.maxTotalDrawdownPercent,
      symbols: next.symbols,
      aiMode: next.aiMode,
    });
    if (!parsed.success) {
      const message =
        parsed.error.issues[0]?.message ?? "Некорректные настройки";
      throw new Error(message);
    }
    const settings: TradingSettings = {
      ...next,
      riskPerTradePercent: parsed.data.riskPerTradePercent,
      stopLossPercent: parsed.data.stopLossPercent,
      riskRewardRatio: parsed.data.riskRewardRatio,
      maxPositions: parsed.data.maxPositions,
      dailyTradeLimit: parsed.data.dailyTradeLimit,
      maxDailyDrawdownPercent: parsed.data.maxDailyDrawdownPercent,
      maxTotalDrawdownPercent: parsed.data.maxTotalDrawdownPercent,
      symbols: parsed.data.symbols,
      aiMode: parsed.data.aiMode,
    };
    await this.deps.settings.save(settings);

    if (this.deps.audit) {
      const changedFields: string[] = [];
      const fieldsToCompare: {
        key: string;
        before: unknown;
        after: unknown;
      }[] = [
        {
          key: "riskPerTradePercent",
          before: current.riskPerTradePercent,
          after: settings.riskPerTradePercent,
        },
        {
          key: "stopLossPercent",
          before: current.stopLossPercent,
          after: settings.stopLossPercent,
        },
        {
          key: "riskRewardRatio",
          before: current.riskRewardRatio,
          after: settings.riskRewardRatio,
        },
        {
          key: "maxPositions",
          before: current.maxPositions,
          after: settings.maxPositions,
        },
        {
          key: "dailyTradeLimit",
          before: current.dailyTradeLimit,
          after: settings.dailyTradeLimit,
        },
        {
          key: "maxDailyDrawdownPercent",
          before: current.maxDailyDrawdownPercent,
          after: settings.maxDailyDrawdownPercent,
        },
        {
          key: "maxTotalDrawdownPercent",
          before: current.maxTotalDrawdownPercent,
          after: settings.maxTotalDrawdownPercent,
        },
        {
          key: "symbols",
          before: current.symbols,
          after: settings.symbols,
        },
        { key: "aiMode", before: current.aiMode, after: settings.aiMode },
      ];
      for (const field of fieldsToCompare) {
        if (JSON.stringify(field.before) !== JSON.stringify(field.after)) {
          changedFields.push(field.key);
        }
      }
      const details: Record<string, unknown> = { changedFields };
      for (const field of fieldsToCompare) {
        if (changedFields.includes(field.key)) {
          details[field.key] = { before: field.before, after: field.after };
        }
      }
      await this.deps.audit.settingsUpdate({
        userId,
        actorId: meta.actorId ?? userId,
        actorRole: meta.actorRole ?? "user",
        requestId: meta.requestId ?? null,
        entityType: "trading_settings",
        entityId: userId,
        details,
      });
    }

    return settings;
  }

  async getState(userId: number): Promise<TradingState> {
    const current = await this.deps.state.get(userId);
    const state = current ?? createDefaultState(userId);
    return this.rolloverDay(state);
  }

  /** Переносит дневные счётчики и снимает автопаузу, если наступил новый день. */
  private async persist(state: TradingState): Promise<TradingState> {
    const rolled = this.rolloverDay(state);
    await this.deps.state.save(rolled);
    return rolled;
  }

  private rolloverDay(state: TradingState): TradingState {
    const today = utcToday();
    if (state.tradingDay !== today) {
      return {
        ...state,
        tradingDay: today,
        tradesToday: 0,
        autoDailyPaused: false,
        autoDailyPauseDate: null,
      };
    }
    return state;
  }

  async pause(userId: number, meta: AuditMeta = {}): Promise<TradingState> {
    const state = await this.getState(userId);
    const updated: TradingState = {
      ...state,
      paused: true,
      pausedAt: new Date().toISOString(),
    };
    const persisted = await this.persist(updated);
    await this.deps.audit?.tradingControl("trading.pause", {
      userId,
      actorId: meta.actorId ?? userId,
      actorRole: meta.actorRole ?? "user",
      requestId: meta.requestId ?? null,
      entityType: "trading_state",
      entityId: userId,
      details: { pausedAt: updated.pausedAt },
    });
    return persisted;
  }

  async resume(userId: number, meta: AuditMeta = {}): Promise<TradingState> {
    const state = await this.getState(userId);
    const updated: TradingState = {
      ...state,
      paused: false,
      pausedAt: null,
      autoDailyPaused: false,
      autoDailyPauseDate: null,
    };
    const persisted = await this.persist(updated);
    await this.deps.audit?.tradingControl("trading.resume", {
      userId,
      actorId: meta.actorId ?? userId,
      actorRole: meta.actorRole ?? "user",
      requestId: meta.requestId ?? null,
      entityType: "trading_state",
      entityId: userId,
      details: { resumedAt: updated.updatedAt },
    });
    return persisted;
  }

  /** Учитывает совершённое открытие позиции в счётчике сделок за день. */
  async recordOpenedTrade(userId: number): Promise<TradingState> {
    const state = await this.getState(userId);
    const updated: TradingState = {
      ...state,
      tradesToday: state.tradesToday + 1,
    };
    return this.persist(updated);
  }

  /**
   * Проверяет, нужно ли отправить админу уведомление об общей просадке
   * (срабатывает один раз). Возвращает true, если уведомление нужно.
   */
  async checkTotalStopNotification(
    userId: number,
    snapshot: BrokerSnapshot
  ): Promise<boolean> {
    const settings = await this.getSettings(userId);
    const state = await this.getState(userId);
    if (
      snapshot.account.totalPnlPercent <= -settings.maxTotalDrawdownPercent &&
      !state.adminNotifiedForTotalStop
    ) {
      await this.persist({ ...state, adminNotifiedForTotalStop: true });
      return true;
    }
    return false;
  }

  /**
   * Полная проверка перед открытием позиции. Оценивает просадки (и сохраняет
   * автопаузу/автостоп) и проверяет все лимиты. Возвращает решение.
   */
  async checkOpenTrade(
    userId: number,
    symbol: string,
    side: PositionSide,
    orderNotional: number,
    snapshot: BrokerSnapshot,
    settings?: TradingSettings
  ): Promise<RiskDecision> {
    const resolvedSettings = settings ?? (await this.getSettings(userId));
    let state = await this.getState(userId);

    // 1. Общая просадка → автостоп без права возобновления.
    const total = await this.evaluateDrawdown(userId, snapshot, state);
    state = total.state;
    if (total.totalStopTriggered) {
      return this.blocked(
        "total_stop",
        "Торговля остановлена: превышена общая просадка"
      );
    }

    // 2. Дневная просадка → автопауза до следующего дня.
    if (state.autoDailyPaused) {
      return this.blocked(
        "auto_daily_paused",
        "Автопауза: превышена дневная просадка, торговля возобновится завтра"
      );
    }

    // 3. Ручная пауза.
    if (state.paused) {
      return this.blocked("paused", "Торговля на паузе. Возобновить: /resume");
    }

    // 4. Whitelist символов.
    if (!isSymbolAllowed(resolvedSettings, symbol)) {
      return this.blocked(
        "symbol_not_whitelisted",
        `Символ ${symbol} не разрешён настройками`
      );
    }

    // 5. Лимит сделок в день.
    if (state.tradesToday >= resolvedSettings.dailyTradeLimit) {
      return this.blocked(
        "daily_trade_limit_reached",
        `Достигнут лимит сделок за день: ${resolvedSettings.dailyTradeLimit}`
      );
    }

    // 6. Максимум позиций.
    if (snapshot.positions.length >= resolvedSettings.maxPositions) {
      return this.blocked(
        "max_positions_reached",
        `Достигнут максимум открытых позиций: ${resolvedSettings.maxPositions}`
      );
    }

    // 7. % баланса на сделку (с учётом режима AI): риск реализуется через
    // стоп-лосс, поэтому позиция ограничивается сверху не номиналом, а
    // размером, при котором срабатывание стопа теряет не больше риска на
    // сделку: notional_limit = рискБюджет / (стоп% / 100).
    const effectiveRiskPercent = Math.min(
      resolvedSettings.riskPerTradePercent *
        aiModeMultiplier(resolvedSettings.aiMode),
      resolvedSettings.riskPerTradePercent
    );
    const riskBudget = (snapshot.account.balance * effectiveRiskPercent) / 100;
    const stopFraction = resolvedSettings.stopLossPercent / 100;
    const maxTradeNotional =
      stopFraction > 0 ? riskBudget / stopFraction : riskBudget;
    if (orderNotional > maxTradeNotional) {
      return this.blocked(
        "risk_per_trade_exceeded",
        `Объём ${orderNotional.toFixed(2)} превышает риск на сделку (стоп ${resolvedSettings.stopLossPercent}%): не более ${maxTradeNotional.toFixed(2)}`
      );
    }

    // 8. Маржа: свободных средств должно хватать на позицию.
    if (orderNotional > snapshot.account.availableCash) {
      return this.blocked(
        "margin_insufficient",
        "Недостаточно свободных средств (маржа) для позиции"
      );
    }

    return {
      allow: true,
      code: null,
      reason: null,
      effectiveRiskPercent,
      maxTradeNotional,
      state,
    };
  }

  /**
   * Оценивает дневную и общую просадку, обновляет состояние (автопауза /
   * автостоп) и сохраняет его. Возвращает флаги срабатываний.
   */
  private async evaluateDrawdown(
    userId: number,
    snapshot: BrokerSnapshot,
    stateIn: TradingState
  ): Promise<{
    state: TradingState;
    autoDailyPaused: boolean;
    totalStopTriggered: boolean;
  }> {
    const settings = await this.getSettings(userId);
    const maxDaily = settings.maxDailyDrawdownPercent;
    const maxTotal = settings.maxTotalDrawdownPercent;
    let state = this.rolloverDay(stateIn);
    let autoDailyPaused = state.autoDailyPaused;
    let totalStopTriggered = state.totalStopTriggered;

    const dailyPnlPercent = snapshot.account.dailyPnlPercent;
    const totalPnlPercent = snapshot.account.totalPnlPercent;

    // Общая просадка: просадка = -totalPnlPercent.
    if (totalPnlPercent <= -maxTotal && !state.totalStopTriggered) {
      totalStopTriggered = true;
      state = {
        ...state,
        totalStopTriggered: true,
        totalStopTriggeredAt: new Date().toISOString(),
      };
    }

    if (
      !totalStopTriggered &&
      dailyPnlPercent <= -maxDaily &&
      !state.autoDailyPaused
    ) {
      autoDailyPaused = true;
      state = {
        ...state,
        autoDailyPaused: true,
        autoDailyPauseDate: utcToday(),
      };
    }

    if (state !== stateIn) {
      await this.persist(state);
    }

    return { state, autoDailyPaused, totalStopTriggered };
  }

  private blocked(code: RiskBlockCode, reason: string): RiskDecision {
    return {
      allow: false,
      code,
      reason,
      effectiveRiskPercent: 0,
      maxTradeNotional: 0,
      state: createDefaultState(0),
    };
  }

  /** Сумма P&L закрытых сделок за сегодня (UTC). */

}
