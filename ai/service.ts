import { randomUUID } from "node:crypto";
import type { MarketDataProvider } from "./market-data";
import { DEFAULT_CANDLE_LIMIT } from "./market-data";
import { computeIndicators } from "./indicators";
import { DeepSeekClient, SYSTEM_PROMPT, type DeepSeekResult } from "./deepseek";
import type { PortfolioProvider } from "./portfolio";
import {
  buildDeepAnalysisPrompt,
  buildPrompt,
  buildSignalPrompt,
} from "./prompt";
import { parseAndValidate } from "./parser";
import type {
  AiModelKind,
  AnalysisMode,
  MarketContext,
  PortfolioContext,
  Timeframe,
} from "./types";
import {
  deepAnalysisSchema,
  tradeSignalSchema,
  type DeepAnalysis,
  type TradeSignal,
} from "./schema";
import { toErrorMessage } from "./errors";
import type {
  AiDecision,
  AiDecisionRepository,
} from "../db/ai-decision-repository";
import { createAiDecision } from "../db/ai-decision-repository";

export const DEFAULT_TIMEFRAME: Timeframe = "1h";
export const DEFAULT_MAX_ATTEMPTS = 2;

export interface AiAnalysisServiceDeps {
  marketData: MarketDataProvider;
  deepseek: DeepSeekClient;
  portfolio: PortfolioProvider;
  repository: AiDecisionRepository;
  defaultTimeframe?: Timeframe;
  maxAttempts?: number;
}

export interface AnalyzeParams {
  userId: number;
  symbol: string;
  timeframe?: Timeframe;
  portfolio?: PortfolioContext;
}

export interface AnalyzeResult<D> {
  decision: D | null;
  mode: AnalysisMode;
  modelKind: AiModelKind;
  model: string;
  /** Снимок рыночного контекста, на основе которого принято решение. */
  market: MarketContext;
  logs: AiDecision[];
}

/**
 * AI-цикл анализа рынка через DeepSeek:
 * собирает рыночные данные и индикаторы, формирует структурированный промт,
 * вызывает модель, парсит ответ с валидацией схемы и логирует каждый
 * запрос/ответ в ai_decisions. При невалидном ответе повторяет запрос
 * (maxAttempts) либо пропускает итерацию цикла.
 */
export class AiAnalysisService {
  private readonly defaultTimeframe: Timeframe;
  private readonly maxAttempts: number;

  constructor(private readonly deps: AiAnalysisServiceDeps) {
    this.defaultTimeframe = deps.defaultTimeframe ?? DEFAULT_TIMEFRAME;
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  analyzeSignal(params: AnalyzeParams): Promise<AnalyzeResult<TradeSignal>> {
    return this.run(
      "signal",
      "chat",
      (content) => parseAndValidate(content, tradeSignalSchema),
      params
    );
  }

  analyzeDeep(params: AnalyzeParams): Promise<AnalyzeResult<DeepAnalysis>> {
    return this.run(
      "deep_analysis",
      "reasoner",
      (content) => parseAndValidate(content, deepAnalysisSchema),
      params
    );
  }

  private async run<D>(
    mode: AnalysisMode,
    modelKind: AiModelKind,
    parse: (content: string) => D,
    params: AnalyzeParams
  ): Promise<AnalyzeResult<D>> {
    const symbol = params.symbol.trim().toUpperCase();
    const timeframe = params.timeframe ?? this.defaultTimeframe;
    const portfolio =
      params.portfolio ??
      (await this.deps.portfolio.getPortfolio(params.userId));

    const candles = await this.deps.marketData.getCandles(
      symbol,
      timeframe,
      DEFAULT_CANDLE_LIMIT
    );
    const indicators = computeIndicators(candles);
    const lastCandle = candles[candles.length - 1]!;

    const market: MarketContext = {
      symbol,
      timeframe,
      price: lastCandle.close,
      candles,
      indicators,
      collectedAt: new Date().toISOString(),
    };

    const userPrompt =
      mode === "signal"
        ? buildSignalPrompt(market, portfolio)
        : buildDeepAnalysisPrompt(market, portfolio);
    const fullPrompt = buildPrompt(mode, market, portfolio);
    const model = this.deps.deepseek.modelFor(modelKind);

    const logs: AiDecision[] = [];
    let finalDecision: D | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const startedAt = Date.now();

      let response: DeepSeekResult;
      try {
        response = await this.deps.deepseek.complete(modelKind, {
          system: SYSTEM_PROMPT,
          user: userPrompt,
        });
      } catch (error) {
        logs.push(
          this.buildFailedLog(
            {
              userId: params.userId,
              symbol,
              timeframe,
              mode,
              modelKind,
              model,
              prompt: fullPrompt,
            },
            { latencyMs: Date.now() - startedAt, error }
          )
        );
        if (attempt < this.maxAttempts) {
          continue;
        }
        break;
      }

      let decision: D | null = null;
      let error: string | null = null;
      let valid = false;
      try {
        decision = parse(response.content);
        valid = true;
      } catch (parseError) {
        error = toErrorMessage(parseError);
      }

      logs.push(
        createAiDecision(
          {
            userId: params.userId,
            symbol,
            timeframe,
            mode,
            modelKind,
            model,
            prompt: fullPrompt,
          },
          response,
          {
            valid,
            error: error ?? undefined,
            decision: toDecisionUnion(decision),
          }
        )
      );

      if (valid && decision !== null) {
        finalDecision = decision;
        break;
      }

      if (attempt < this.maxAttempts) {
        continue;
      }
      break;
    }

    for (const log of logs) {
      await this.deps.repository.save(log);
    }

    return {
      decision: finalDecision,
      mode,
      modelKind,
      model,
      market,
      logs,
    };
  }

  private buildFailedLog(
    deps: {
      userId: number;
      symbol: string;
      timeframe: Timeframe;
      mode: AnalysisMode;
      modelKind: AiModelKind;
      model: string;
      prompt: string;
    },
    result: { latencyMs: number; error: unknown }
  ): AiDecision {
    return {
      id: randomUUID(),
      userId: deps.userId,
      symbol: deps.symbol,
      timeframe: deps.timeframe,
      mode: deps.mode,
      modelKind: deps.modelKind,
      model: deps.model,
      prompt: deps.prompt,
      response: "",
      latencyMs: result.latencyMs,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      valid: false,
      error: toErrorMessage(result.error),
      decision: null,
      createdAt: new Date().toISOString(),
    };
  }
}

function toDecisionUnion(value: unknown): TradeSignal | DeepAnalysis | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value as TradeSignal | DeepAnalysis;
}
