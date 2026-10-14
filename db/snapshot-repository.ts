import { PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db";
import { TableName, IndexName } from "../lib/schema";
import type { TradingSnapshot } from "../learning/types";

export interface TradingSnapshotRepository {
  save(snapshot: TradingSnapshot): Promise<void>;
  findOpen(
    userId: number,
    symbol: string,
    side: string
  ): Promise<TradingSnapshot | null>;
  listByUser(userId: number, limit?: number): Promise<TradingSnapshot[]>;
  countByStrategyVersion(userId: number, version: number): Promise<number>;
  listUserIds(): Promise<number[]>;
}

export function createInMemoryTradingSnapshotRepository(): TradingSnapshotRepository {
  const snapshots: TradingSnapshot[] = [];

  return {
    async save(snapshot) {
      const index = snapshots.findIndex((item) => item.id === snapshot.id);
      if (index >= 0) {
        snapshots[index] = snapshot;
      } else {
        snapshots.push(snapshot);
      }
    },
    async findOpen(userId, symbol, side) {
      const normSymbol = symbol.trim().toUpperCase();
      return (
        snapshots.find(
          (snapshot) =>
            snapshot.userId === userId &&
            snapshot.symbol === normSymbol &&
            snapshot.side === side &&
            snapshot.status === "open"
        ) ?? null
      );
    },
    async listByUser(userId, limit = 500) {
      return snapshots
        .filter((snapshot) => snapshot.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    },
    async countByStrategyVersion(userId, version) {
      return snapshots.filter(
        (snapshot) =>
          snapshot.userId === userId && snapshot.strategyVersion === version
      ).length;
    },
    async listUserIds() {
      return [...new Set(snapshots.map((snapshot) => snapshot.userId))];
    },
  };
}

export function createDynamoDbTradingSnapshotRepository(
  client: DynamoDBDocumentClient = docClient
): TradingSnapshotRepository {
  const table = TableName.TRADING_SNAPSHOTS;
  const index = IndexName.TRADING_SNAPSHOTS_USER;

  return {
    async save(snapshot) {
      await client.send(
        new PutCommand({ TableName: table, Item: snapshot as object })
      );
    },
    async findOpen(userId, symbol, side) {
      const normSymbol = symbol.trim().toUpperCase();
      const result = await client.send(
        new QueryCommand({
          TableName: table,
          IndexName: index,
          KeyConditionExpression: "userId = :userId",
          FilterExpression:
            "#status = :status AND #symbol = :symbol AND #side = :side",
          ExpressionAttributeNames: {
            "#status": "status",
            "#symbol": "symbol",
            "#side": "side",
          },
          ExpressionAttributeValues: {
            ":userId": userId,
            ":status": "open",
            ":symbol": normSymbol,
            ":side": side,
          },
          Limit: 1,
        })
      );
      return (result.Items?.[0] as TradingSnapshot | undefined) ?? null;
    },
    async listByUser(userId, limit = 500) {
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
      return (result.Items ?? []) as TradingSnapshot[];
    },
    async countByStrategyVersion(userId, version) {
      const result = await client.send(
        new ScanCommand({
          TableName: table,
          ExpressionAttributeNames: {
            "#userId": "userId",
            "#strategyVersion": "strategyVersion",
          },
          ExpressionAttributeValues: {
            ":userId": userId,
            ":version": version,
          },
          FilterExpression: "#userId = :userId AND #strategyVersion = :version",
          Select: "COUNT",
        })
      );
      return result.Count ?? 0;
    },
    async listUserIds() {
      const result = await client.send(
        new ScanCommand({
          TableName: table,
          ProjectionExpression: "userId",
        })
      );
      const rows = (result.Items ?? []) as { userId: number }[];
      return [...new Set(rows.map((row) => row.userId))];
    },
  };
}
