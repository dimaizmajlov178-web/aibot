import { PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { docClient } from "../lib/db";
import { TableName, IndexName } from "../lib/schema";
import type { AiModelKind, AnalysisMode, Timeframe } from "../ai/types";
import type { DeepAnalysis, TradeSignal } from "../ai/schema";
import type { AiProviderName } from "../ai/provider";
import type { DeepSeekResult } from "../ai/deepseek";

export interface AiDecisionInput {
  userId: number;
  symbol: string;
  timeframe: Timeframe;
  mode: AnalysisMode;
  modelKind: AiModelKind;
  model: string;
  /** Провайдер, обслуживший запрос: deepseek или openrouter. */
  provider: AiProviderName;
  prompt: string;
  response: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  valid: boolean;
  error?: string | null;
  decision?: TradeSignal | DeepAnalysis | null;
}

export interface AiDecision extends AiDecisionInput {
  id: string;
  createdAt: string;
}

export interface AiDecisionRepository {
  save(decision: AiDecision): Promise<void>;
  listByUser(userId: number, limit?: number): Promise<AiDecision[]>;
  listRecent(limit?: number): Promise<AiDecision[]>;
}

export function createInMemoryAiDecisionRepository(): AiDecisionRepository {
  const decisions: AiDecision[] = [];

  return {
    async save(decision) {
      decisions.push(decision);
    },
    async listByUser(userId, limit = 50) {
      return decisions
        .filter((decision) => decision.userId === userId)
        .slice(-limit)
        .reverse();
    },
    async listRecent(limit = 50) {
      return decisions.slice(-limit).reverse();
    },
  };
}

interface AiDecisionItem {
  id: string;
  userId: number;
  symbol: string;
  timeframe: Timeframe;
  mode: AnalysisMode;
  modelKind: AiModelKind;
  model: string;
  provider?: AiProviderName;
  prompt: string;
  response: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  valid: boolean;
  error?: string;
  decision?: TradeSignal | DeepAnalysis;
  createdAt: string;
}

function toItem(decision: AiDecision): AiDecisionItem {
  return {
    id: decision.id,
    userId: decision.userId,
    symbol: decision.symbol,
    timeframe: decision.timeframe,
    mode: decision.mode,
    modelKind: decision.modelKind,
    model: decision.model,
    provider: decision.provider,
    prompt: decision.prompt,
    response: decision.response,
    latencyMs: decision.latencyMs,
    promptTokens: decision.promptTokens,
    completionTokens: decision.completionTokens,
    totalTokens: decision.totalTokens,
    valid: decision.valid,
    error: decision.error ?? undefined,
    decision: decision.decision ?? undefined,
    createdAt: decision.createdAt,
  };
}

function fromItem(item: AiDecisionItem): AiDecision {
  return {
    id: item.id,
    userId: item.userId,
    symbol: item.symbol,
    timeframe: item.timeframe,
    mode: item.mode,
    modelKind: item.modelKind,
    model: item.model,
    provider: item.provider ?? "deepseek",
    prompt: item.prompt,
    response: item.response,
    latencyMs: item.latencyMs,
    promptTokens: item.promptTokens,
    completionTokens: item.completionTokens,
    totalTokens: item.totalTokens,
    valid: item.valid,
    error: item.error ?? null,
    decision: item.decision ?? null,
    createdAt: item.createdAt,
  };
}

export function createDynamoDbAiDecisionRepository(
  client: DynamoDBDocumentClient = docClient
): AiDecisionRepository {
  const table = TableName.AI_DECISIONS;

  return {
    async save(decision) {
      await client.send(
        new PutCommand({ TableName: table, Item: toItem(decision) })
      );
    },
    async listByUser(userId, limit = 50) {
      const result = await client.send(
        new QueryCommand({
          TableName: table,
          IndexName: IndexName.AI_DECISIONS_USER,
          KeyConditionExpression: "userId = :userId",
          ExpressionAttributeValues: { ":userId": userId },
          Limit: limit,
          ScanIndexForward: false,
        })
      );
      return (result.Items ?? []).map((item) =>
        fromItem(item as AiDecisionItem)
      );
    },
    async listRecent(limit = 50) {
      const result = await client.send(
        new ScanCommand({ TableName: table, Limit: limit })
      );
      return (result.Items ?? [])
        .map((item) => fromItem(item as AiDecisionItem))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    },
  };
}

export interface AiDecisionFactoryDeps {
  userId: number;
  symbol: string;
  timeframe: Timeframe;
  mode: AnalysisMode;
  modelKind: AiModelKind;
  model: string;
  prompt: string;
}

export function createAiDecision(
  deps: AiDecisionFactoryDeps,
  response: DeepSeekResult,
  outcome: {
    valid: boolean;
    error?: string;
    decision?: TradeSignal | DeepAnalysis | null;
  }
): AiDecision {
  return {
    id: randomUUID(),
    userId: deps.userId,
    symbol: deps.symbol,
    timeframe: deps.timeframe,
    mode: deps.mode,
    modelKind: deps.modelKind,
    model: deps.model,
    provider: response.provider,
    prompt: deps.prompt,
    response: response.content,
    latencyMs: response.latencyMs,
    promptTokens: response.promptTokens,
    completionTokens: response.completionTokens,
    totalTokens: response.totalTokens,
    valid: outcome.valid,
    error: outcome.error ?? null,
    decision: outcome.decision ?? null,
    createdAt: new Date().toISOString(),
  };
}
