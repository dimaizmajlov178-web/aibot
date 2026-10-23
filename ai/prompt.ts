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

function formatRecentCandles(context: MarketContext, count = 30): string {
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
    `Последние ${30} свечей:`,
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
    "Ты — старший quantitative-аналитик с 15-летним опытом в крипто- и форекс-трейдинге.",
    "Твоя задача — оценить данные и выдать торговый сигнал.",
    "",
    "ПРАВИЛА:",
    "1. Используй ТОЛЬКО данные из контекста, не выдумывай.",
    "2. Отвечай ТОЛЬКО валидным JSON без markdown и без пояснений.",
    "3. Главный принцип: СЛЕДУЙ ТРЕНДУ. Тренд важнее перепроданности/перекупленности.",
    "",
    "РЕШАЮЩИЕ ПРАВИЛА (применяй в первую очередь):",
    "1. НИСХОДЯЩИЙ ТРЕНД (цена < EMA50 и EMA20 < EMA50):",
    "   если изменение за 1h < -0.2% и RSI < 60 → SHORT.",
    "   Перепроданность (RSI 15-35) НЕ запрещает шорт: в нисходящем тренде шорти даже на перепроданности, стоп защитит.",
    "2. ВОСХОДЯЩИЙ ТРЕНД (цена > EMA50 и EMA20 > EMA50):",
    "   если изменение за 1h > +0.2% и RSI > 40 → LONG.",
    "3. БОКОВИК (не выполнены 1-2): оцени по чек-листу ниже. score >= 55 → SIGNAL (входи),",
    "   score 35-55 → WEAK_SIGNAL (входи, riskPercent 0.5-1.0), score < 35 → NO_TRADE.",
    "4. ЗАПРЕЩЕНО открывать против тренда: лонг при нисходящем тренде, шорт при восходящем.",
    "",
    "КОНТЕКСТ РЫНКА:",
    formatMarketContext(context),
    "",
    formatAssetHistory(context),
    "",
    "СОСТОЯНИЕ ПОРТФЕЛЯ:",
    formatPortfolioContext(portfolio),
    "",
    "ЧЕК-ЛИСТ (только если в боковике):",
    "  [ ] Цена выше EMA200",
    "  [ ] EMA20 > EMA50",
    "  [ ] RSI в зоне 40-65",
    "  [ ] MACD гистограмма растёт",
    "  [ ] CVD согласуется с направлением",
    "  [ ] Отклонение от VWAP по модулю < 2%",
    "  [ ] Объём выше среднего",
    "  [ ] ATR не в экстремуме",
    "",
    "УРОВНИ:",
    "  - entry: текущая цена",
    "  - stop_loss: для long ниже входа на 1.0-1.5 ATR; для short выше входа на 1.0-1.5 ATR",
    "  - take_profit: на расстоянии risk_reward x стоп (минимум 2)",
    "  - riskPercent: 1.0-2.0 для SIGNAL, 0.5-1.0 для WEAK_SIGNAL",
    "",
    "ФОРМАТ ОТВЕТА (поля action/side/entryPrice/stopLoss/takeProfit/riskPercent ОБЯЗАТЕЛЬНЫ):",
    "{",
    "  \"signal\": \"LONG | SHORT | NO_TRADE\",",
    "  \"action\": \"buy | sell | hold\",",
    "  \"side\": \"long | short | none\",",
    "  \"confidence\": 0-100,",
    "  \"score\": 0-100,",
    "  \"market_regime\": \"trend_up | trend_down | range | high_volatility\",",
    "  \"checklist\": {\"item\": true/false},",
    "  \"entry\": number|null,",
    "  \"entryPrice\": number|null,",
    "  \"stop_loss\": number|null,",
    "  \"stopLoss\": number|null,",
    "  \"take_profit\": number|null,",
    "  \"takeProfit\": number|null,",
    "  \"risk_reward\": number|null,",
    "  \"position_size_pct\": number,",
    "  \"riskPercent\": number,",
    "  \"reasoning\": \"кратко, 2-3 предложения, только по фактам\",",
    "  \"invalidation\": \"что отменит сигнал\",",
    "  \"missing_data\": []",
    "}",
    "",
    "Маппинг: LONG → action buy / side long; SHORT → action sell / side short;",
    "NO_TRADE → action hold / side none. WEAK_SIGNAL для LONG → buy; для SHORT → sell.",
    "entry → entryPrice; stop_loss → stopLoss; take_profit → takeProfit; position_size_pct → riskPercent.",
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
