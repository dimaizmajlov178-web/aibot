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

/**
 * Реальный источник рыночных данных для AI-анализа: строит свечи из реальных
 * цен брокера (GET /v2/markets -> state.indexPrice), опрашиваемых каждый цикл.
 * В отличие от StubMarketDataProvider здесь нет выдуманных детерминированных
 * свечей: тренд отражает реальное движение цены (в т.ч. рост -> лонги).
 * Если реальных точек меньше limit, недостающие начальные свечи добираются
 * плоской ценой (первая реальная), чтобы индикаторы (EMA200 и т.п.) считались.
 */
export class RealMarketDataProvider implements MarketDataProvider {
  private readonly samples = new Map<string, Array<{ ts: number; price: number }>>();
  private readonly maxSamples = 20_000;
  private readonly minSampleIntervalMs = 45_000;
  private readonly cryptoSymbols = new Set([
    "BTC/USDT",
    "ETH/USDT",
    "SOL/USDT",
    "BNB/USDT",
  ]);

  constructor(
    private readonly fetchPrices: () => Promise<Map<string, number>>
  ) {}

  async getCandles(
    symbol: string,
    timeframe: Timeframe,
    limit = DEFAULT_CANDLE_LIMIT
  ): Promise<Candle[]> {
    const normSymbol = symbol.trim().toUpperCase();
    // Настоящие биржевые свечи (OHLCV с историей и объёмом) для криптовалют
    // берём с Binance; если Binance недоступен или символ не крипта —
    // продолжаем сборку свечей из реальных цен брокера (ниже).
    if (this.cryptoSymbols.has(normSymbol)) {
      try {
        const candles = await this.tryBinanceCandles(
          normSymbol,
          timeframe,
          limit
        );
        if (candles !== null) {
          return candles;
        }
      } catch {
        // fall through к сборке из цен
      }
    }
    try {
      const prices = await this.fetchPrices();
      const price = prices.get(normSymbol);
      if (price && price > 0) {
        this.addSample(normSymbol, price);
      }
    } catch {
      // цены временно недоступны — используем накопленные сэмплы
    }
    const arr = this.samples.get(normSymbol) ?? [];
    if (arr.length === 0) {
      throw new InsufficientMarketDataError(
        `Нет реальных цен для ${normSymbol}: рынок ещё не опрошен`
      );
    }
    const step = this.bucketMs(timeframe);
    const grouped = this.groupByBucket(arr, step);
    const candles = this.toCandles(grouped);
    return this.padToLimit(candles, limit, arr[0].price, step);
  }

  private addSample(symbol: string, price: number): void {
    const arr = this.samples.get(symbol) ?? [];
    const now = Date.now();
    const last = arr[arr.length - 1];
    if (last && now - last.ts < this.minSampleIntervalMs) {
      last.price = price;
    } else {
      arr.push({ ts: now, price });
    }
    if (arr.length > this.maxSamples) {
      arr.splice(0, arr.length - this.maxSamples);
    }
    this.samples.set(symbol, arr);
  }

  private bucketMs(timeframe: Timeframe): number {
    switch (timeframe) {
      case "1m": return 60_000;
      case "5m": return 300_000;
      case "15m": return 900_000;
      case "1h": return 3_600_000;
      case "4h": return 14_400_000;
      case "1d": return 86_400_000;
      default: return 60_000;
    }
  }

  private groupByBucket(
    arr: Array<{ ts: number; price: number }>,
    step: number
  ): Array<{ start: number; prices: number[] }> {
    const buckets = new Map<number, number[]>();
    for (const sample of arr) {
      const key = Math.floor(sample.ts / step) * step;
      const list = buckets.get(key) ?? [];
      list.push(sample.price);
      buckets.set(key, list);
    }
    const keys = [...buckets.keys()].sort((a, b) => a - b);
    return keys.map((key) => ({ start: key, prices: buckets.get(key)! }));
  }

  private toCandles(
    buckets: Array<{ start: number; prices: number[] }>
  ): Candle[] {
    return buckets.map((bucket) => {
      const prices = bucket.prices;
      const open = prices[0]!;
      const close = prices[prices.length - 1]!;
      const high = Math.max(...prices);
      const low = Math.min(...prices);
      return {
        time: new Date(bucket.start).toISOString(),
        open: round2(open),
        high: round2(high),
        low: round2(low),
        close: round2(close),
        volume: 1,
      };
    });
  }

  private padToLimit(
    candles: Candle[],
    limit: number,
    firstPrice: number,
    step: number
  ): Candle[] {
    if (candles.length >= limit) {
      return candles.slice(-limit);
    }
    const missing = limit - candles.length;
    const firstTime = candles.length > 0 ? Date.parse(candles[0].time) : Date.now();
    const pads: Candle[] = [];
    for (let i = missing; i > 0; i--) {
      const time = firstTime - i * step;
      pads.push({
        time: new Date(time).toISOString(),
        open: round2(firstPrice),
        high: round2(firstPrice),
        low: round2(firstPrice),
        close: round2(firstPrice),
        volume: 1,
      });
    }
    return [...pads, ...candles];
  }

  /** Пробует получить настоящие свечи OHLCV с Binance; null — если нельзя. */
  private async tryBinanceCandles(
    symbol: string,
    timeframe: Timeframe,
    limit: number
  ): Promise<Candle[] | null> {
    const pair = symbol.replace("/", "");
    const interval = this.binanceInterval(timeframe);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(
        `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(pair)}&interval=${interval}&limit=${Math.max(1, limit)}`,
        { signal: controller.signal }
      );
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as unknown[];
      const candles: Candle[] = [];
      for (const raw of data) {
        const row = raw as [number, string, string, string, string, string];
        candles.push({
          time: new Date(row[0]).toISOString(),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5]),
        });
      }
      if (candles.length === 0) {
        return null;
      }
      return candles.slice(-limit);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private binanceInterval(timeframe: Timeframe): string {
    switch (timeframe) {
      case "1m":
        return "1m";
      case "5m":
        return "5m";
      case "15m":
        return "15m";
      case "1h":
        return "1h";
      case "4h":
        return "4h";
      case "1d":
        return "1d";
      default:
        return "15m";
    }
  }
}

