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
    "Твоя задача — оценить предоставленные данные и выдать торговый сигнал",
    "с вероятностной оценкой, строго следуя алгоритму ниже.",
    "",
    "ПРАВИЛА:",
    "1. Используй ТОЛЬКО данные из контекста. Если параметра нет в данных —",
    "   не выдумывай его и не учитывай в чек-листе.",
    "2. Не давай сигнал, если условия входа не выполнены. NO_TRADE — это",
    "   полноценный и часто лучший ответ.",
    "3. Оценивай score по чек-листу, а не на глаз.",
    "4. Отвечай ТОЛЬКО валидным JSON без markdown и без пояснений вне JSON.",
    "",
    "ШАГ 1. Определи режим рынка по данным: trend_up / trend_down / range / high_volatility.",
    "  Критерии: цена выше/ниже EMA50 и EMA200 (тренд), RSI в крайних зонах",
    "  и ATR выше среднего (high_volatility), иначе range.",
    "",
    "ШАГ 2. Проверь контекст:",
    "  - Направление сигнала совпадает с расположением цены относительно EMA20/EMA50?",
    "  - Объём последней свечи выше среднего объёма (подтверждение импульса)?",
    "  - CVD согласуется с направлением (положительный для long, отрицательный для short)?",
    "",
    "ШАГ 3. Прогони чек-лист (для long; для short зеркально):",
    "  [ ] Цена выше EMA200",
    "  [ ] EMA20 > EMA50",
    "  [ ] RSI в зоне 40-65 (не перекуплен)",
    "  [ ] MACD гистограмма растёт и выше сигнальной",
    "  [ ] CVD положительный (для long) / отрицательный (для short)",
    "  [ ] Отклонение от VWAP не экстремальное (по модулю меньше 2%)",
    "  [ ] Объём последней свечи выше среднего",
    "  [ ] ATR не в экстремуме",
    "",
    "ШАГ 4. Посчитай score: (число выполненных пунктов / 8) * 100.",
    "  Правила решения:",
    "  - score >= 65 → SIGNAL: открывай позицию, riskPercent 1.0-2.0",
    "  - 45 <= score < 65 → WEAK_SIGNAL: открывай позицию МЕНЬШЕГО размера, riskPercent 0.5-1.0",
    "  - score < 45 → NO_TRADE",
    "",
    "ШАГ 5. Сформируй уровни:",
    "  - entry: текущая цена",
    "  - stop_loss: на расстоянии 1.0-1.5 ATR от входа (для long ниже, для short выше)",
    "  - take_profit: на расстоянии risk_reward x стоп (RR минимум 2)",
    "  - riskPercent: 0.5-2.0 в зависимости от score (см. шаг 4)",
    "",
    "КОНТЕКСТ РЫНКА:",
    formatMarketContext(context),
    "",
    formatAssetHistory(context),
    "",
    "СОСТОЯНИЕ ПОРТФЕЛЯ:",
    formatPortfolioContext(portfolio),
    "",
    "ФОРМАТ ОТВЕТА (строго JSON, поля action/side/entryPrice/stopLoss/takeProfit/riskPercent ОБЯЗАТЕЛЬНЫ):",
    "{",
    "  \"signal\": \"LONG | SHORT | NO_TRADE\",",
    "  \"action\": \"buy | sell | hold\",",
    "  \"side\": \"long | short | none\",",
    "  \"confidence\": 0-100,",
    "  \"score\": 0-100,",
    "  \"market_regime\": \"...\",",
    "  \"checklist\": {\"item\": true/false, ...},",
    "  \"entry\": number|null,",
    "  \"entryPrice\": number|null,",
    "  \"stop_loss\": number|null,",
    "  \"stopLoss\": number|null,",
    "  \"take_profit\": number|null,",
    "  \"takeProfit\": number|null,",
    "  \"risk_reward\": number|null,",
    "  \"position_size_pct\": number,",
    "  \"riskPercent\": number,",
    "  \"reasoning\": \"кратко, 2-3 предложения, только по фактам из данных\",",
    "  \"invalidation\": \"что отменит сигнал\",",
    "  \"missing_data\": []",
    "}",
    "",
    "Правила маппинга: LONG → action buy / side long; SHORT → action sell / side short;",
    "NO_TRADE → action hold / side none. WEAK_SIGNAL для LONG → action buy, для SHORT → action sell.",
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
