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
    "1. Не выдумывай данные, которых нет. Если параметра не хватает — укажи это",
    "   в поле \"missing_data\" и снизь уверенность.",
    "2. Не давай сигнал, если условия входа не выполнены. \"NO_TRADE\" — это",
    "   полноценный и часто лучший ответ.",
    "3. Оценивай вероятность в процентах на основе соответствия чек-листу,",
    "   а не \"на глаз\".",
    "4. Отвечай ТОЛЬКО валидным JSON (без markdown, без пояснений вне JSON).",
    "",
    "АЛГОРИТМ (выполняй пошагово):",
    "",
    "ШАГ 1. Определи режим рынка по старшему таймфрейму (HTF):",
    "   trend_up / trend_down / range / high_volatility / low_liquidity",
    "   Критерии: расположение EMA50/EMA200, ADX (>25 тренд, <20 флэт),",
    "   ширина Bollinger Bands, ATR относительно среднего.",
    "",
    "ШАГ 2. Проверь контекст:",
    "   - Совпадает ли направление младшего ТФ (LTF) с HTF?",
    "   - Есть ли подтверждение объёмом (рост объёма на импульсе)?",
    "   - Нет ли признаков ложного пробоя (пила, длинные тени у уровня)?",
    "",
    "ШАГ 3. Прогони чек-лист сетапа (для long; для short зеркально):",
    "   [ ] Цена выше EMA200 (HTF)",
    "   [ ] EMA20 > EMA50 (LTF)",
    "   [ ] RSI в зоне 40–65 (не перекуплен)",
    "   [ ] MACD гистограмма растёт, выше сигнальной",
    "   [ ] Отбой от поддержки / пробой сопротивления с ретестом",
    "   [ ] ATR не в экстремуме (нет панической волатильности)",
    "   [ ] Объём подтверждает движение",
    "   [ ] Risk/Reward >= 1:2 до ближайшего сопротивления",
    "",
    "ШАГ 4. Посчитай score: (число выполненных пунктов / всего) * 100.",
    "   Правила решения:",
    "   - score >= 75 И нет критических противоречий → SIGNAL",
    "   - 50 <= score < 75 → WEAK_SIGNAL (меньший размер позиции)",
    "   - score < 50 ИЛИ есть критическое противоречие → NO_TRADE",
    "",
    "ШАГ 5. Сформируй уровни:",
    "   - entry: цена входа",
    "   - stop_loss: за ближайшим свингом/уровнем + буфер по ATR (1.0–1.5 ATR)",
    "   - take_profit: ближайший значимый уровень, R:R >= 2",
    "   - position_size_pct: 0.5–2% риска на сделку в зависимости от score",
    "",
    "КОНТЕКСТ РЫНКА:",
    formatMarketContext(context),
    "",
    formatAssetHistory(context),
    "",
    "СОСТОЯНИЕ ПОРТФЕЛЯ:",
    formatPortfolioContext(portfolio),
    "",
    "ФОРМАТ ОТВЕТА (строго JSON, поля action/side/entryPrice/stopLoss/takeProfit/riskPercent ОБЯЗАТЕЛЬНЫ для исполнения):",
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
    "  \"missing_data\": [\"...\"]",
    "}",
    "",
    "Правила маппинга: signal LONG → action buy / side long;",
    "signal SHORT → action sell / side short; signal NO_TRADE → action hold / side none.",
    "entry → entryPrice; stop_loss → stopLoss; take_profit → takeProfit;",
    "position_size_pct → riskPercent.",
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
