import type { MarketContext, PortfolioContext } from "./types";
import { SYSTEM_PROMPT } from "./deepseek";

const ROUNDING = 2;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function money(value: number): string {
  return round(value).toLocaleString("ru-RU", {
    maximumFractionDigits: ROUNDING,
  });
}

function formatRecentCandles(context: MarketContext, count = 12): string {
  const rows = context.candles
    .slice(-count)
    .map(
      (candle) =>
        `${candle.time.slice(0, 16)} O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close} V=${candle.volume}`
    );
  return rows.join("\n");
}

function formatMarketContext(context: MarketContext): string {
  const ind = context.indicators;
  const ema = ind.ema;
  return [
    `Символ: ${context.symbol}`,
    `Таймфрейм: ${context.timeframe}`,
    `Текущая цена: ${context.price}`,
    `Дата сбора: ${context.collectedAt}`,
    "",
    "Индикаторы:",
    `  RSI(14): ${round(ind.rsi)}`,
    `  MACD: ${round(ind.macd.macd)} / signal ${round(ind.macd.signal)} / histogram ${round(ind.macd.histogram)}`,
    `  EMA20: ${round(ema.ema20)}, EMA50: ${round(ema.ema50)}, EMA200: ${round(ema.ema200)}`,
    `  ATR(14): ${round(ind.atr)}`,
    `  Объём последней свечи: ${round(ind.volume)}`,
    `  Средний объём (${20}): ${round(ind.volumeAvg)}`,
    `  CVD: ${round(ind.cvd)}`,
    `  Отклонение от VWAP: ${round(ind.vwapDeviation)}%`,
    "",
    `Последние ${12} свечей:`,
    formatRecentCandles(context),
  ].join("\n");
}

function formatPortfolioContext(portfolio: PortfolioContext): string {
  const lines = [
    `Баланс: ${money(portfolio.balance)} ${portfolio.currency}`,
    `Эквити: ${money(portfolio.equity)} ${portfolio.currency}`,
    `Свободно: ${money(portfolio.availableCash)} ${portfolio.currency}`,
    `P&L за день: ${money(portfolio.dailyPnl)}`,
    `P&L общий: ${money(portfolio.totalPnl)}`,
    `Риск на сделку: ${round(portfolio.riskPerTradePercent)}%`,
    `Стоп-лосс: ${round(portfolio.stopLossPercent)}% от цены входа`,
    `Тейк-профит (RR): ${round(portfolio.riskRewardRatio)}`,
    `Максимум позиций: ${portfolio.maxPositions}`,
  ];
  if (portfolio.avgHoldingTimeHours !== null) {
    lines.push(
      `Среднее время удержания сделки: ${round(portfolio.avgHoldingTimeHours)} ч`
    );
  }

  if (portfolio.positions.length === 0) {
    lines.push("Открытых позиций: нет");
  } else {
    lines.push("Открытые позиции:");
    for (const position of portfolio.positions) {
      const pnl =
        position.unrealizedPnl === null
          ? "недоступен"
          : money(position.unrealizedPnl);
      lines.push(
        `  ${position.symbol} ${position.side} qty=${position.quantity} entry=${money(position.entryPrice)} now=${money(position.currentPrice)} P&L=${pnl}`
      );
    }
  }
  return lines.join("\n");
}

function formatAssetHistory(context: MarketContext): string {
  const closes = context.candles.map((candle) => candle.close);
  const start = closes[0] ?? 0;
  const end = closes[closes.length - 1] ?? 0;
  const change = start !== 0 ? ((end - start) / Math.abs(start)) * 100 : 0;
  const high = Math.max(...closes);
  const low = Math.min(...closes);

  return [
    "История по активу (за период выборки):",
    `  Первая цена: ${round(start)}`,
    `  Последняя цена: ${round(end)}`,
    `  Изменение за период: ${round(change)}%`,
    `  Максимум: ${round(high)}`,
    `  Минимум: ${round(low)}`,
  ].join("\n");
}

export function buildSignalPrompt(
  context: MarketContext,
  portfolio: PortfolioContext
): string {
  return [
    "Ты — профессиональный трейдер алгоритмической торговли.",
    "Твоя задача — принять решение по активу на основе предоставленных данных.",
    "",
    "КОНТЕКСТ РЫНКА:",
    formatMarketContext(context),
    "",
    formatAssetHistory(context),
    "",
    "СОСТОЯНИЕ ПОРТФЕЛЯ:",
    formatPortfolioContext(portfolio),
    "",
    "ПРАВИЛА:",
    "1. Учитывай тренд, моментум и риск текущего портфеля.",
    "2. Не открывай сделку, если это увеличит число позиций сверх максимума.",
    "3. При входе всегда указывай stopLoss и takeProfit.",
    "4. riskPercent не должен превышать лимит риска на сделку.",
    "5. Стоп-лосс на бирже выставляется автоматически по настройке (стоп в % от",
    "   цены входа), тейк-профит — по соотношению риска к прибыли (RR).",
    "   Учитывай среднее время удержания сделки: не планируй сделку на срок,",
    "   заметно больший типичного удержания, если на то нет явных причин по данным.",
    "",
    "ОТВЕТ: верни ТОЛЬКО валидный JSON без пояснений по схеме:",
    `{"action": "buy"|"sell"|"hold", "side": "long"|"short"|"none", "confidence": 0-100, "entryPrice": number|null, "stopLoss": number|null, "takeProfit": number|null, "riskPercent": 0-100, "reasoning": "краткое обоснование"}`,
  ].join("\n");
}

export function buildDeepAnalysisPrompt(
  context: MarketContext,
  portfolio: PortfolioContext
): string {
  return [
    "Ты — глубокий аналитик финансовых рынков.",
    "Проведи детальный разбор актива: тренд, ключевые уровни и сценарии.",
    "",
    "КОНТЕКСТ РЫНКА:",
    formatMarketContext(context),
    "",
    formatAssetHistory(context),
    "",
    "СОСТОЯНИЕ ПОРТФЕЛЯ:",
    formatPortfolioContext(portfolio),
    "",
    "ОТВЕТ: верни ТОЛЬКО валидный JSON без пояснений по схеме:",
    `{"trend": "bullish"|"bearish"|"neutral", "trendStrength": 0-100, "keyLevels": {"support": [числа], "resistance": [числа]}, "scenario": {"bullCase": "...", "bearCase": "...", "baseCase": "..."}, "riskAssessment": "low"|"medium"|"high", "summary": "итог анализа"}`,
  ].join("\n");
}

export function buildPrompt(
  kind: "signal" | "deep_analysis",
  context: MarketContext,
  portfolio: PortfolioContext
): string {
  const userPrompt =
    kind === "signal"
      ? buildSignalPrompt(context, portfolio)
      : buildDeepAnalysisPrompt(context, portfolio);
  return `${SYSTEM_PROMPT}\n\n=== ЗАПРОС ===\n\n${userPrompt}`;
}
