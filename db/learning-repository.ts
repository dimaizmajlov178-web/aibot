import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db";
import { TableName, IndexName } from "../lib/schema";
import type {
  LearningReport,
  StrategyState,
  StrategyVersion,
} from "../learning/types";

export interface LearningReportRepository {
  save(report: LearningReport): Promise<void>;
  get(id: string): Promise<LearningReport | null>;
  listByUser(userId: number, limit?: number): Promise<LearningReport[]>;
}

export interface StrategyRepository {
  save(strategy: StrategyVersion): Promise<void>;
  get(id: string): Promise<StrategyVersion | null>;
  byVersion(userId: number, version: number): Promise<StrategyVersion | null>;
  listByUser(userId: number): Promise<StrategyVersion[]>;
  active(userId: number): Promise<StrategyVersion | null>;
}

export interface StrategyStateRepository {
  get(userId: number): Promise<StrategyState | null>;
  save(state: StrategyState): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory реализации
// ---------------------------------------------------------------------------

export function createInMemoryLearningReportRepository(): LearningReportRepository {
  const reports = new Map<string, LearningReport>();

  return {
    async save(report) {
      reports.set(report.id, report);
    },
    async get(id) {
      return reports.get(id) ?? null;
    },
    async listByUser(userId, limit = 30) {
      return [...reports.values()]
        .filter((report) => report.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    },
  };
}

export function createInMemoryStrategyRepository(): StrategyRepository {
  const strategies = new Map<string, StrategyVersion>();

  return {
    async save(strategy) {
      strategies.set(strategy.id, strategy);
    },
    async get(id) {
      return strategies.get(id) ?? null;
    },
    async byVersion(userId, version) {
      return (
        [...strategies.values()].find(
          (strategy) =>
            strategy.userId === userId && strategy.version === version
        ) ?? null
      );
    },
    async listByUser(userId) {
      return [...strategies.values()]
        .filter((strategy) => strategy.userId === userId)
        .sort((a, b) => a.version - b.version);
    },
    async active(userId) {
      return (
        [...strategies.values()].find(
          (strategy) =>
            strategy.userId === userId && strategy.status === "active"
        ) ?? null
      );
    },
  };
}

export function createInMemoryStrategyStateRepository(): StrategyStateRepository {
  const states = new Map<number, StrategyState>();

  return {
    async get(userId) {
      return states.get(userId) ?? null;
    },
    async save(state) {
      states.set(state.userId, state);
    },
  };
}

// ---------------------------------------------------------------------------
// DynamoDB реализации
// ---------------------------------------------------------------------------

export function createDynamoDbLearningReportRepository(
  client: DynamoDBDocumentClient = docClient
): LearningReportRepository {
  const table = TableName.LEARNING_REPORTS;
  const index = IndexName.LEARNING_REPORTS_USER;

  return {
    async save(report) {
      await client.send(
        new PutCommand({ TableName: table, Item: report as object })
      );
    },
    async get(id) {
      const result = await client.send(
        new GetCommand({ TableName: table, Key: { id } })
      );
      return (result.Item as LearningReport | undefined) ?? null;
    },
    async listByUser(userId, limit = 30) {
      const result = await client.send(
        new QueryCommand({
          TableName: table,
          IndexName: index,
          KeyConditionExpression: "userId = :userId",
          ExpressionAttributeValues: { ":userId": userId },
          ScanIndexForward: false,
          Limit: limit,
        })
      );
      return (result.Items ?? []) as LearningReport[];
    },
  };
}

export function createDynamoDbStrategyRepository(
  client: DynamoDBDocumentClient = docClient
): StrategyRepository {
  const table = TableName.STRATEGIES;
  const index = IndexName.STRATEGIES_USER;

  return {
    async save(strategy) {
      await client.send(
        new PutCommand({ TableName: table, Item: strategy as object })
      );
    },
    async get(id) {
      const result = await client.send(
        new GetCommand({ TableName: table, Key: { id } })
      );
      return (result.Item as StrategyVersion | undefined) ?? null;
    },
    async byVersion(userId, version) {
      const rows = await this.listByUser(userId);
      return rows.find((strategy) => strategy.version === version) ?? null;
    },
    async listByUser(userId) {
      const result = await client.send(
        new QueryCommand({
          TableName: table,
          IndexName: index,
          KeyConditionExpression: "userId = :userId",
          ExpressionAttributeValues: { ":userId": userId },
        })
      );
      return ((result.Items ?? []) as StrategyVersion[]).sort(
        (a, b) => a.version - b.version
      );
    },
    async active(userId) {
      const rows = await this.listByUser(userId);
      return rows.find((strategy) => strategy.status === "active") ?? null;
    },
  };
}

export function createDynamoDbStrategyStateRepository(
  client: DynamoDBDocumentClient = docClient
): StrategyStateRepository {
  const table = TableName.STRATEGY_STATE;

  return {
    async get(userId) {
      const result = await client.send(
        new GetCommand({ TableName: table, Key: { userId } })
      );
      return (result.Item as StrategyState | undefined) ?? null;
    },
    async save(state) {
      await client.send(
        new PutCommand({ TableName: table, Item: state as object })
      );
    },
  };
}
