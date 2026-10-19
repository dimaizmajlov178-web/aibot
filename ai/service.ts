import { randomUUID } from "node:crypto";
import { defaultLogger } from "../core/logger";
import type { MarketDataProvider } from "./market-data";
import { DEFAULT_CANDLE_LIMIT } from "./market-data";
import { computeIndicators } from "./indicators";
import { DeepSeekClient, SYSTEM_PROMPT } from "./deepseek";
import type { OpenRouterClient } from "./openrouter";
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
import type { AiProvider, AiProviderName, AiProviderResult } from "./provider";
import type {
  AiDecision,
  AiDecisionRepository,
} from "../db/ai-decision-repository";
import { createAiDecision } from "../db/ai-decision-repository";

export const DEFAULT_TIMEFRAME: Timeframe = "15m";
export const DEFAULT_MAX_ATTEMPTS = 2;

export interface AiAnalysisServiceDeps {
  marketData: MarketDataProvider;
  deepseek: DeepSeekClient;
  /** Запасной AI-провайдер (OpenRouter). Опционален: без него работает только DeepSeek. */
  openrouter?: OpenRouterClient;
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
 * AI-цикл анализа рынка через DeepSeek (с fallback на OpenRouter):
 * собирает рыночные данные и индикаторы, формирует структурированный промт,
 * вызывает модель, парсит ответ с валидацией схемы и логирует каждый
 * запрос/ответ в ai_decisions. При ошибке DeepSeek (429 / 5xx /
 * service_unavailable_error / таймаут) автоматически переключается на
 * OpenRouter. При невалидном ответе повторяет запрос (maxAttempts) либо
 * пропускает итерацию цикла.
 */
export class AiAnalysisService {
  private readonly defaultTimeframe: Timeframe;
  private readonly maxAttempts: number;
  /** Провайдеры в порядке приоритета: DeepSeek, затем OpenRouter (если задан). */
  private readonly providers: AiProvider[];

  constructor(private readonly deps: AiAnalysisServiceDeps) {
    this.defaultTimeframe = deps.defaultTimeframe ?? DEFAULT_TIMEFRAME;
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.providers = [
      deps.deepseek,
      ...(deps.openrouter ? [deps.openrouter] : []),
    ];
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
    defaultLogger
      .child({ service: "ai" })
      .info("[ai] промпт отправлен в DeepSeek (первые 1500 символов)", {
        symbol,
        timeframe,
        mode,
        promptPreview: fullPrompt.slice(0, 1500),
        promptLength: fullPrompt.length,
      });
    const model = this.deps.deepseek.modelFor(modelKind);

    const logs: AiDecision[] = [];
    let finalDecision: D | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let response: AiProviderResult | null = null;

      for (let p = 0; p < this.providers.length; p++) {
        const provider = this.providers[p]!;
        const startedAt = Date.now();
        try {
          response = await provider.complete(modelKind, {
            system: SYSTEM_PROMPT,
            user: userPrompt,
          });
          break;
        } catch (error) {
          logs.push(
            this.buildFailedLog(
              {
                userId: params.userId,
                symbol,
                timeframe,
                mode,
                modelKind,
                model: provider.modelFor(modelKind),
                provider: provider.name,
                prompt: fullPrompt,
              },
              { latencyMs: Date.now() - startedAt, error }
            )
          );
          const isLastProvider = p === this.providers.length - 1;
          // Любая ошибка текущего провайдера (не только 429/5xx/таймаут):
          // конфигурационная (пустой API-ключ), биллинговая (402), 400/401/403
          // и т.п. — не должна обрывать цикл. Пробуем следующий провайдер
          // (OpenRouter как fallback), чтобы цикл анализа продолжал работать
          // и бот по-прежнему давал сигналы.
          if (isLastProvider) {
            break;
          }
        }
      }

      if (!response) {
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
            model: response.model,
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
      provider: AiProviderName;
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
      provider: deps.provider,
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
