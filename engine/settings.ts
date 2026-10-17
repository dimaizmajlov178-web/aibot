import { z } from "zod";
import type { TradingSettings, TradingSettingsPatch } from "./types";

export const DEFAULT_RISK_PER_TRADE_PERCENT = 1;
export const DEFAULT_STOP_LOSS_PERCENT = 1;
export const DEFAULT_RISK_REWARD_RATIO = 2;
export const DEFAULT_MAX_POSITIONS = 3;
export const DEFAULT_DAILY_TRADE_LIMIT = 10;
export const DEFAULT_MAX_DAILY_DRAWDOWN_PERCENT = 3;
export const DEFAULT_MAX_TOTAL_DRAWDOWN_PERCENT = 10;
export const DEFAULT_AI_MODE = "balanced" as const;

/** Дефолтные значения настроек торговли (переопределяются из .env). */
export interface TradingSettingsDefaults {
  riskPerTradePercent: number;
  stopLossPercent: number;
  riskRewardRatio: number;
  maxPositions: number;
  maxDailyDrawdownPercent: number;
  maxTotalDrawdownPercent: number;
}

export function defaultSettings(
  userId: number,
  defaults?: Partial<TradingSettingsDefaults>
): TradingSettings {
  return {
    userId,
    riskPerTradePercent:
      defaults?.riskPerTradePercent ?? DEFAULT_RISK_PER_TRADE_PERCENT,
    stopLossPercent: defaults?.stopLossPercent ?? DEFAULT_STOP_LOSS_PERCENT,
    riskRewardRatio: defaults?.riskRewardRatio ?? DEFAULT_RISK_REWARD_RATIO,
    maxPositions: defaults?.maxPositions ?? DEFAULT_MAX_POSITIONS,
    dailyTradeLimit: DEFAULT_DAILY_TRADE_LIMIT,
    maxDailyDrawdownPercent:
      defaults?.maxDailyDrawdownPercent ?? DEFAULT_MAX_DAILY_DRAWDOWN_PERCENT,
    maxTotalDrawdownPercent:
      defaults?.maxTotalDrawdownPercent ?? DEFAULT_MAX_TOTAL_DRAWDOWN_PERCENT,
    symbols: [],
    aiMode: DEFAULT_AI_MODE,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Применяет частичное обновление настроек поверх существующих.
 * Возвращает новый объект с сохранёнными значениями.
 */
export function applySettingsPatch(
  settings: TradingSettings,
  patch: TradingSettingsPatch
): TradingSettings {
  const symbols =
    patch.symbols !== undefined
      ? patch.symbols
          .map((item) => item.trim().toUpperCase())
          .filter((item) => item.length > 0)
      : settings.symbols;

  return {
    ...settings,
    riskPerTradePercent:
      patch.riskPerTradePercent ?? settings.riskPerTradePercent,
    stopLossPercent: patch.stopLossPercent ?? settings.stopLossPercent,
    riskRewardRatio: patch.riskRewardRatio ?? settings.riskRewardRatio,
    maxPositions: patch.maxPositions ?? settings.maxPositions,
    dailyTradeLimit: patch.dailyTradeLimit ?? settings.dailyTradeLimit,
    maxDailyDrawdownPercent:
      patch.maxDailyDrawdownPercent ?? settings.maxDailyDrawdownPercent,
    maxTotalDrawdownPercent:
      patch.maxTotalDrawdownPercent ?? settings.maxTotalDrawdownPercent,
    symbols,
    aiMode: patch.aiMode ?? settings.aiMode,
    updatedAt: new Date().toISOString(),
  };
}

export const aiModeSchema = z.enum(["safe", "balanced", "aggressive"]);

export const tradingSettingsSchema = z.object({
  riskPerTradePercent: z
    .number()
    .min(0.1, "Риск на сделку не может быть меньше 0.1%")
    .max(50, "Риск на сделку не может превышать 50%"),
  stopLossPercent: z
    .number()
    .min(0.1, "Стоп-лосс не может быть меньше 0.1%")
    .max(50, "Стоп-лосс не может превышать 50%"),
  riskRewardRatio: z
    .number()
    .min(0.5, "Соотношение риска к прибыли не может быть меньше 0.5")
    .max(20, "Соотношение риска к прибыли не может превышать 20"),
  maxPositions: z
    .number()
    .int("Целое число позиций")
    .min(1, "Хотя бы одна позиция")
    .max(100, "Слишком много позиций"),
  dailyTradeLimit: z
    .number()
    .int("Целое число сделок")
    .min(1, "Хотя бы одна сделка в день")
    .max(1000, "Лимит слишком большой"),
  maxDailyDrawdownPercent: z
    .number()
    .min(0.1, "Лимит дневной просадки не может быть меньше 0.1%")
    .max(100, "Лимит дневной просадки не может превышать 100%"),
  maxTotalDrawdownPercent: z
    .number()
    .min(0.1, "Лимит общей просадки не может быть меньше 0.1%")
    .max(100, "Лимит общей просадки не может превышать 100%"),
  symbols: z
    .array(z.string().trim().min(1).max(32))
    .max(200, "Слишком много символов в списке"),
  aiMode: aiModeSchema,
});

export type TradingSettingsInput = z.infer<typeof tradingSettingsSchema>;

/**
 * Парсит простой текст настроек вида
 * "risk=1 stop_loss=1 rr=2 max_positions=5 symbols=BTC/USDT,ETH/USDT ai_mode=aggressive"
 * в частичный патч. Используется командой /settings.
 */
export function parseSettingsPayload(payload: string): TradingSettingsPatch {
  const patch: TradingSettingsPatch = {};

  const tokens = payload.trim().split(/\s+/);
  const symbolTokens: string[] = [];

  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = token.slice(0, eq).toLowerCase();
    const value = token.slice(eq + 1);

    switch (key) {
      case "risk":
      case "risk_per_trade": {
        const num = Number(value);
        if (Number.isFinite(num) && num > 0) {
          patch.riskPerTradePercent = num;
        }
        break;
      }
      case "stop_loss":
      case "stoploss":
      case "sl": {
        const num = Number(value);
        if (Number.isFinite(num) && num > 0) {
          patch.stopLossPercent = num;
        }
        break;
      }
      case "rr":
      case "risk_reward":
      case "risk_reward_ratio": {
        const num = Number(value);
        if (Number.isFinite(num) && num > 0) {
          patch.riskRewardRatio = num;
        }
        break;
      }
      case "max_positions":
      case "positions": {
        const num = Number(value);
        if (Number.isInteger(num) && num > 0) {
          patch.maxPositions = num;
        }
        break;
      }
      case "daily_limit":
      case "limit": {
        const num = Number(value);
        if (Number.isInteger(num) && num > 0) {
          patch.dailyTradeLimit = num;
        }
        break;
      }
      case "daily_drawdown":
      case "drawdown": {
        const num = Number(value);
        if (Number.isFinite(num) && num > 0) {
          patch.maxDailyDrawdownPercent = num;
        }
        break;
      }
      case "total_drawdown": {
        const num = Number(value);
        if (Number.isFinite(num) && num > 0) {
          patch.maxTotalDrawdownPercent = num;
        }
        break;
      }
      case "symbols": {
        symbolTokens.push(
          ...value
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        );
        break;
      }
      case "ai_mode":
      case "mode": {
        if (aiModeSchema.safeParse(value).success) {
          patch.aiMode = value as TradingSettings["aiMode"];
        }
        break;
      }
      default:
        break;
    }
  }

  if (symbolTokens.length > 0) {
    patch.symbols = symbolTokens;
  }

  return patch;
}
