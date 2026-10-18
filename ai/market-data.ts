import type { Candle, Timeframe } from "./types";
import { InsufficientMarketDataError } from "./errors";
import { MIN_CANDLES_FOR_INDICATORS } from "./indicators";

export interface MarketDataProvider {
  getCandles(
    symbol: string,
    timeframe: Timeframe,
    limit?: number
  ): Promise<Candle[]>;
}

interface SymbolMeta {
  symbol: string;
  basePrice: number;
  baseVolume: number;
}

export const DEFAULT_CANDLE_LIMIT = 300;

const SYMBOLS: readonly SymbolMeta[] = [
  { symbol: "BTC/USDT", basePrice: 62_000, baseVolume: 1_200 },
  { symbol: "ETH/USDT", basePrice: 3_200, baseVolume: 8_000 },
  { symbol: "SOL/USDT", basePrice: 150, baseVolume: 25_000 },
  { symbol: "BNB/USDT", basePrice: 580, baseVolume: 6_500 },
  { symbol: "AAPL", basePrice: 210, baseVolume: 900 },
  { symbol: "TSLA", basePrice: 240, baseVolume: 1_400 },
  { symbol: "SBER", basePrice: 280, baseVolume: 1_100 },
  { symbol: "NVDA", basePrice: 900, baseVolume: 1_300 },
];

const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

const DEFAULT_TIMEFRAME: Timeframe = "15m";

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function isKnownSymbol(symbol: string): boolean {
  return SYMBOLS.some(
    (meta) => meta.symbol.toLowerCase() === symbol.toLowerCase()
  );
}

export const KNOWN_SYMBOLS: readonly string[] = SYMBOLS.map(
  (meta) => meta.symbol
);

export function timeframeStepMs(timeframe: Timeframe): number {
  return TIMEFRAME_MS[timeframe] ?? TIMEFRAME_MS[DEFAULT_TIMEFRAME];
}

/**
 * Детерминированный заглушечный источник рыночных данных.
 * Используется до подключения реального API брокера/биржи.
 */
export class StubMarketDataProvider implements MarketDataProvider {
  async getCandles(
    symbol: string,
    timeframe: Timeframe,
    limit = DEFAULT_CANDLE_LIMIT
  ): Promise<Candle[]> {
    const normSymbol = symbol.toUpperCase();
    const meta = SYMBOLS.find((item) => item.symbol === normSymbol);

    if (!meta) {
      throw new InsufficientMarketDataError(
        `Символ ${symbol} не поддерживается заглушечным источником данных`
      );
    }
    if (limit < MIN_CANDLES_FOR_INDICATORS) {
      throw new InsufficientMarketDataError(
        `Запрошено слишком мало свечей (${limit}), минимум ${MIN_CANDLES_FOR_INDICATORS}`
      );
    }

    const step = TIMEFRAME_MS[timeframe] ?? TIMEFRAME_MS[DEFAULT_TIMEFRAME];
    const rng = mulberry32(hashString(`${normSymbol}:${timeframe}:candles`));
    const now = Math.floor(Date.now() / step) * step;

    const candles: Candle[] = [];
    let previousClose = meta.basePrice * (0.9 + rng() * 0.2);
    const volatility = meta.basePrice * 0.008;

    for (let i = limit - 1; i >= 0; i--) {
      const open = previousClose;
      const close = Math.max(0.01, open + (rng() - 0.5) * volatility * 1.4);
      const high = Math.max(open, close) * (1 + rng() * 0.01);
      const low = Math.min(open, close) * (1 - rng() * 0.01);
      const volume = Math.max(1, meta.baseVolume * (0.4 + rng() * 1.2));

      candles.push({
        time: new Date(now - i * step).toISOString(),
        open: round2(open),
        high: round2(high),
        low: round2(low),
        close: round2(close),
        volume: round2(volume),
      });
      previousClose = close;
    }

    return candles;
  }
}
