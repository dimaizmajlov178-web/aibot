import type { PositionSide } from "../broker/base";

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export type AiModelKind = "chat" | "reasoner";

export type AnalysisMode = "signal" | "deep_analysis";

export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface EmaIndicators {
  ema20: number;
  ema50: number;
  ema200: number;
}

export interface MacdIndicators {
  macd: number;
  signal: number;
  histogram: number;
}

export interface MarketIndicators {
  rsi: number;
  macd: MacdIndicators;
  ema: EmaIndicators;
  atr: number;
  cvd: number;
  vwapDeviation: number;
  volume: number;
  volumeAvg: number;
}

export interface MarketContext {
  symbol: string;
  timeframe: Timeframe;
  price: number;
  candles: Candle[];
  indicators: MarketIndicators;
  collectedAt: string;
}

export interface PositionContext {
  symbol: string;
  side: PositionSide;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  /** Нереализованный P&L позиции; null — если брокер не смог его вычислить. */
  unrealizedPnl: number | null;
}

export interface PortfolioContext {
  balance: number;
  equity: number;
  availableCash: number;
  currency: string;
  dailyPnl: number;
  totalPnl: number;
  positions: PositionContext[];
  riskPerTradePercent: number;
  /** Стоп-лосс в процентах от цены входа (например 1 -> стоп 1%). */
  stopLossPercent: number;
  /** Целевое соотношение риска к прибыли (RR) для тейк-профита. */
  riskRewardRatio: number;
  maxPositions: number;
  /**
   * Средняя продолжительность сделки в часах (по закрытым сделкам). Может
   * быть null, если данных недостаточно. AI использует это значение, чтобы
   * ориентироваться на типичное время удержания позиции.
   */
  avgHoldingTimeHours: number | null;
}
