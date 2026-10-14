import type { StrategyVersion, TradingSnapshot } from "./types";
import { LEARNING_SAMPLE_SIZE } from "./types";

export const LEARNING_SYSTEM_PROMPT =
  "Ты — измерительный аналитик автоматизированной торговой системы. " +
  "На основе истории закрытых сделок находи паттерны успешных и убыточных входов " +
  "и предлагай корректировки правил стратегии. " +
  "Не выдумывай данные, опирайся только на предоставленный датасет. " +
  "Отвечай строго JSON по заданной схеме.";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatTrade(trade: TradingSnapshot): string {
  const result = trade.result
    ? `PnL=${round2(trade.result.pnl)} R=${round2(trade.result.rMultiple)} закрыта ${trade.result.closedAt}`
    : "ещё не закрыта";
  const ind = trade.market.indicators;
  return [
    `- ${trade.symbol} ${trade.side} tf=${trade.timeframe}`,
    `  решение: ${trade.decision.action}/${trade.decision.side}, уверенность ${trade.decision.confidence}, риск ${trade.decision.riskPercent}%`,
    `  reasoning: ${trade.reasoning}`,
    `  вход=${trade.entryPrice} qty=${trade.quantity}`,
    `  индикаторы: RSI=${round2(ind.rsi)} MACD=${round2(ind.macd.macd)}/signal=${round2(ind.macd.signal)} ` +
      `EMA20=${round2(ind.ema.ema20)} EMA50=${round2(ind.ema.ema50)} EMA200=${round2(ind.ema.ema200)} ` +
      `ATR=${round2(ind.atr)} CVD=${round2(ind.cvd)} VWAP-dev=${round2(ind.vwapDeviation)}%`,
    `  результат: ${result}`,
  ].join("\n");
}

function formatRules(version: StrategyVersion | null): string {
  if (!version || version.rules.length === 0) {
    return "Активных правил нет (базовая стратегия).";
  }
  const lines = version.rules.map(
    (rule) => `- ${rule.field}: ${rule.change} (причина: ${rule.reason})`
  );
  return `Версия активной стратегии: v${version.version}\n${lines.join("\n")}`;
}

export function buildLearningPrompt(input: {
  trades: readonly TradingSnapshot[];
  activeVersion: StrategyVersion | null;
}): string {
  const sample = input.trades.slice(-LEARNING_SAMPLE_SIZE);
  const tradesBlock =
    sample.length > 0
      ? sample.map(formatTrade).join("\n")
      : "Закрытых сделок нет.";

  return [
    "ДАННЫЕ ДЛЯ АНАЛИЗА:",
    "",
    "ТЕКУЩАЯ СТРАТЕГИЯ:",
    formatRules(input.activeVersion),
    "",
    "ЗАКРЫТЫЕ СДЕЛКИ (последние 60 дней):",
    tradesBlock,
    "",
    "ЗАДАЧА:",
    "1. Кратко резюмируй результаты сделок.",
    "2. Выдели паттерны успешных и неудачных сделок (до 5 каждого).",
    "3. Если по данным видны устойчивые корректировки правил — предложи их; ",
    "   иначе верни пустой ruleAdjustments.",
    "",
    "ОТВЕТ: верни ТОЛЬКО валидный JSON без пояснений по схеме:",
    `{"summary": "итог анализа", "successPatterns": ["паттерн"], "failurePatterns": ["паттерн"], "ruleAdjustments": [{"field": "имя_правила", "change": "что_меняем", "reason": "обоснование"}]}`,
  ].join("\n");
}
