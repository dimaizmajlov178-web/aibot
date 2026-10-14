import type { BotModule } from "../core/modules";

export const aiModule: BotModule = { name: "ai" };

export {
  AiAnalysisService,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEFRAME,
} from "./service";
export type {
  AiAnalysisServiceDeps,
  AnalyzeParams,
  AnalyzeResult,
} from "./service";
export { DeepSeekClient, SYSTEM_PROMPT } from "./deepseek";
export type {
  DeepSeekConfig,
  DeepSeekMessage,
  DeepSeekResult,
} from "./deepseek";
export {
  StubMarketDataProvider,
  DEFAULT_CANDLE_LIMIT,
  isKnownSymbol,
  KNOWN_SYMBOLS,
  timeframeStepMs,
} from "./market-data";
export type { MarketDataProvider } from "./market-data";
export { BrokerPortfolioProvider, portfolioFromAccount } from "./portfolio";
export type { PortfolioProvider } from "./portfolio";
export { computeIndicators, MIN_CANDLES_FOR_INDICATORS } from "./indicators";
export type {
  MarketContext,
  PortfolioContext,
  MarketIndicators,
  Timeframe,
} from "./types";
export {
  buildDeepAnalysisPrompt,
  buildPrompt,
  buildSignalPrompt,
} from "./prompt";
export { parseAndValidate, extractJsonObject } from "./parser";
export { tradeSignalSchema, deepAnalysisSchema } from "./schema";
export type { DeepAnalysis, TradeSignal } from "./schema";
export {
  AiAnalysisError,
  AiResponseError,
  DeepSeekApiError,
  DeepSeekConfigError,
  DeepSeekError,
  InsufficientMarketDataError,
} from "./errors";
