import type { PositionSide } from "../broker/base";

export type AiMode = "safe" | "balanced" | "aggressive";

/**
 * Настройки торговли пользователя. Значения, управляющие риск-менеджментом
 * и выбором символов. Заполняются через /settings и хранятся в
 * trading_settings.
 */
export interface TradingSettings {
  userId: number;
  /** Максимальный % баланса на одну сделку (например 1 -> 1%). */
  riskPerTradePercent: number;
  /**
   * Размер стоп-лосса в процентах от цены входа (например 1 -> стоп 1%).
   * По умолчанию равен риску на сделку (riskPerTradePercent), но задаётся
   * отдельно через /settings stop_loss=<%>: риск на сделку реализуется через
   * защитный стоп-ордер на бирже именно этого размера.
   */
  stopLossPercent: number;
  /**
   * Целевое соотношение риска к прибыли (RR) для тейк-профита. Тейк = вход ±
   * (RR × стоп): при RR=2 тейк в 2 раза дальше от входа, чем стоп.
   */
  riskRewardRatio: number;
  /** Максимум одновременных открытых позиций. */
  maxPositions: number;
  /** Лимит сделок в день (открытий). */
  dailyTradeLimit: number;
  /** Дневная просадка, выше которой торговля паузится до следующего дня (%). */
  maxDailyDrawdownPercent: number;
  /** Общая просадка, выше которой торговля останавливается (%). */
  maxTotalDrawdownPercent: number;
  /** Whitelist символов. Пустой массив — разрешены все поддерживаемые. */
  symbols: string[];
  /** Режим AI: влияет на агрессивность анализа. */
  aiMode: AiMode;
  updatedAt: string;
}

export interface TradingSettingsPatch {
  riskPerTradePercent?: number;
  stopLossPercent?: number;
  riskRewardRatio?: number;
  maxPositions?: number;
  dailyTradeLimit?: number;
  maxDailyDrawdownPercent?: number;
  maxTotalDrawdownPercent?: number;
  symbols?: string[];
  aiMode?: AiMode;
}

/**
 * Текущее состояние торгового ядра пользователя: паузы, просадки, счётчик
 * сделок за день. Хранится в trading_state.
 */
export interface TradingState {
  userId: number;
  /** Ручная пауза через /pause. */
  paused: boolean;
  pausedAt: string | null;
  /** Автопауза из-за дневной просадки выше лимита. */
  autoDailyPaused: boolean;
  /** Дата ("YYYY-MM-DD"), за которую сработала автопауза по дневной просадке. */
  autoDailyPauseDate: string | null;
  /** Полная остановка из-за общей просадки выше лимита. */
  totalStopTriggered: boolean;
  totalStopTriggeredAt: string | null;
  /** Отправлено ли уведомление админу об общей просадке. */
  adminNotifiedForTotalStop: boolean;
  /** Сколько сделок (открытий) совершено за текущий торговый день. */
  tradesToday: number;
  /** Текущий торговый день ("YYYY-MM-DD") — для сброса daily-счётчиков. */
  tradingDay: string;
  updatedAt: string;
}

export function isSymbolAllowed(
  settings: TradingSettings,
  symbol: string
): boolean {
  if (settings.symbols.length === 0) {
    return true;
  }
  const normalized = symbol.trim().toUpperCase();
  return settings.symbols.some(
    (item) => item.trim().toUpperCase() === normalized
  );
}

export type OrderDirection = PositionSide;
