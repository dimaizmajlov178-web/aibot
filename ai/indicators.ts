import type {
  Candle,
  EmaIndicators,
  MacdIndicators,
  MarketIndicators,
} from "./types";
import { InsufficientMarketDataError } from "./errors";

export const RSI_PERIOD = 14;
export const ATR_PERIOD = 14;
export const EMA_FAST = 12;
export const EMA_SLOW = 26;
export const MACD_SIGNAL = 9;
export const VOLUME_AVG_PERIOD = 20;

export const MIN_CANDLES_FOR_INDICATORS = 200;

function computeSma(values: number[], start: number, count: number): number {
  let sum = 0;
  for (let i = start; i < start + count; i++) {
    sum += values[i];
  }
  return sum / count;
}

export function emaSeries(values: readonly number[], period: number): number[] {
  const result: number[] = [];
  if (values.length < period || period <= 0) {
    return result;
  }
  const k = 2 / (period + 1);
  let previous = computeSma([...values], 0, period);
  result.push(previous);
  for (let i = period; i < values.length; i++) {
    previous = values[i] * k + previous * (1 - k);
    result.push(previous);
  }
  return result;
}

export function emaLast(values: readonly number[], period: number): number {
  const series = emaSeries(values, period);
  const last = series[series.length - 1];
  if (last === undefined) {
    throw new InsufficientMarketDataError(
      `Недостаточно данных для EMA(${period}): нужно не менее ${period} свечей, получено ${values.length}`
    );
  }
  return last;
}

export function rsi(values: readonly number[], period = RSI_PERIOD): number {
  if (values.length < period + 1) {
    throw new InsufficientMarketDataError(
      `Недостаточно данных для RSI(${period}): нужно не менее ${period + 1} значений, получено ${values.length}`
    );
  }

  const changes: number[] = [];
  for (let i = 1; i < values.length; i++) {
    changes.push(values[i] - values[i - 1]);
  }

  let gain = 0;
  let loss = 0;
  for (let i = 0; i < period; i++) {
    const change = changes[i];
    if (change >= 0) {
      gain += change;
    } else {
      loss -= change;
    }
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function macd(
  values: readonly number[],
  fast = EMA_FAST,
  slow = EMA_SLOW,
  signalPeriod = MACD_SIGNAL
): MacdIndicators {
  if (values.length < slow + signalPeriod) {
    throw new InsufficientMarketDataError(
      `Недостаточно данных для MACD(${fast}, ${slow}, ${signalPeriod}): нужно не менее ${slow + signalPeriod} значений, получено ${values.length}`
    );
  }

  const fastSeries = emaSeries(values, fast);
  const slowSeries = emaSeries(values, slow);
  const offset = fastSeries.length - slowSeries.length;

  const macdLine: number[] = [];
  for (let i = offset; i < fastSeries.length; i++) {
    macdLine.push(fastSeries[i] - slowSeries[i - offset]!);
  }

  const signalLine = emaSeries(macdLine, signalPeriod);
  const lastMacd = macdLine[macdLine.length - 1]!;
  const lastSignal = signalLine[signalLine.length - 1]!;

  return {
    macd: lastMacd,
    signal: lastSignal,
    histogram: lastMacd - lastSignal,
  };
}

export function trueRange(candles: readonly Candle[]): number[] {
  const ranges: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (i === 0) {
      ranges.push(candle.high - candle.low);
      continue;
    }
    const previousClose = candles[i - 1]!.close;
    ranges.push(
      Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previousClose),
        Math.abs(candle.low - previousClose)
      )
    );
  }
  return ranges;
}

export function atr(candles: readonly Candle[], period = ATR_PERIOD): number {
  const ranges = trueRange(candles);
  if (ranges.length < period + 1) {
    throw new InsufficientMarketDataError(
      `Недостаточно данных для ATR(${period}): нужно не менее ${period + 1} свечей, получено ${candles.length}`
    );
  }

  let previous =
    ranges.slice(1, 1 + period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period + 1; i < ranges.length; i++) {
    previous = (previous * (period - 1) + ranges[i]!) / period;
  }
  return previous;
}

export function cumulativeVolumeDelta(candles: readonly Candle[]): number {
  let cvd = 0;
  for (const candle of candles) {
    const delta = candle.close >= candle.open ? 1 : -1;
    cvd += delta * candle.volume;
  }
  return cvd;
}

export function vwapDeviation(candles: readonly Candle[]): number {
  let cumulativeTypicalVolume = 0;
  let cumulativeVolume = 0;
  for (const candle of candles) {
    const typical = (candle.high + candle.low + candle.close) / 3;
    cumulativeTypicalVolume += typical * candle.volume;
    cumulativeVolume += candle.volume;
  }
  if (cumulativeVolume === 0) {
    return 0;
  }
  const vwap = cumulativeTypicalVolume / cumulativeVolume;
  if (vwap === 0) {
    return 0;
  }
  const last = candles[candles.length - 1]!;
  return ((last.close - vwap) / vwap) * 100;
}

export function computeIndicators(
  candles: readonly Candle[]
): MarketIndicators {
  if (candles.length < MIN_CANDLES_FOR_INDICATORS) {
    throw new InsufficientMarketDataError(
      `Недостаточно данных для расчёта индикаторов: нужно не менее ${MIN_CANDLES_FOR_INDICATORS} свечей, получено ${candles.length}`
    );
  }

  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const latestVolume = volumes[volumes.length - 1] ?? 0;

  const sampleStart = Math.max(0, volumes.length - VOLUME_AVG_PERIOD);
  const sample = volumes.slice(sampleStart);
  const volumeAvg =
    sample.length > 0
      ? sample.reduce((sum, value) => sum + value, 0) / sample.length
      : 0;

  const ema: EmaIndicators = {
    ema20: emaLast(closes, 20),
    ema50: emaLast(closes, 50),
    ema200: emaLast(closes, 200),
  };

  return {
    rsi: rsi(closes, RSI_PERIOD),
    macd: macd(closes, EMA_FAST, EMA_SLOW, MACD_SIGNAL),
    ema,
    atr: atr(candles, ATR_PERIOD),
    cvd: cumulativeVolumeDelta(candles),
    vwapDeviation: vwapDeviation(candles),
    volume: latestVolume,
    volumeAvg,
  };
}
