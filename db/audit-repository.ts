import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db";
import { TableName, IndexName } from "../lib/schema";

export type AuditActorRole = "user" | "admin" | "system";

/**
 * Запись журнала аудита: кто, когда и что сделал. Используется для
 * контроля торговых действий и изменений настроек.
 */
export interface AuditLog {
  id: string;
  /** Пользователь, чьё состояние/действие затронуто (субъект). */
  userId: number;
  /** Кто инициировал действие (Telegram user_id или null для автоторговли). */
  actorId: number | null;
  actorRole: AuditActorRole | null;
  /** Категория действия: trade.open, settings.update, broker.connect и т.д. */
  action: string;
  entityType: string | null;
  entityId: string | null;
  /** Структурированные детали действия (без секретов). */
  details: Record<string, unknown> | null;
  /** Идентификатор запроса для связки со структурными логами. */
  requestId: string | null;
  createdAt: string;
}

export interface AuditRepository {
  save(entry: AuditLog): Promise<void>;
  get(id: string): Promise<AuditLog | null>;
  listByUser(userId: number, limit?: number): Promise<AuditLog[]>;
  listAll(limit?: number): Promise<AuditLog[]>;
}

export function createInMemoryAuditRepository(): AuditRepository {
  const entries = new Map<string, AuditLog>();

  return {
    async save(entry) {
      entries.set(entry.id, entry);
    },
    async get(id) {
      return entries.get(id) ?? null;
    },
    async listByUser(userId, limit = 100) {
      return [...entries.values()]
        .filter((entry) => entry.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    },
    async listAll(limit = 100) {
      return [...entries.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    },
  };
}

function toItem(entry: AuditLog): Record<string, unknown> {
  return {
    id: entry.id,
    userId: entry.userId,
    actorId: entry.actorId,
    actorRole: entry.actorRole,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    details: entry.details,
    requestId: entry.requestId,
    createdAt: entry.createdAt,
  };
}

function fromItem(item: Record<string, unknown>): AuditLog {
  return {
    id: String(item.id ?? ""),
    userId: Number(item.userId ?? 0),
    actorId: item.actorId == null ? null : Number(item.actorId),
    actorRole:
      item.actorRole === "user" ||
      item.actorRole === "admin" ||
      item.actorRole === "system"
        ? item.actorRole
        : null,
    action: String(item.action ?? ""),
    entityType: item.entityType == null ? null : String(item.entityType),
    entityId: item.entityId == null ? null : String(item.entityId),
    details: (item.details as Record<string, unknown> | undefined) ?? null,
    requestId: item.requestId == null ? null : String(item.requestId),
    createdAt: String(item.createdAt ?? ""),
  };
}

export function createDynamoDbAuditRepository(
  client: DynamoDBDocumentClient = docClient
): AuditRepository {
  const table = TableName.AUDIT_LOG;
  const index = IndexName.AUDIT_LOG_USER;

  return {
    async save(entry) {
      await client.send(
        new PutCommand({ TableName: table, Item: toItem(entry) })
      );
    },
    async get(id) {
      const result = await client.send(
        new GetCommand({ TableName: table, Key: { id } })
      );
      const item = result.Item as Record<string, unknown> | undefined;
      return item ? fromItem(item) : null;
    },
    async listByUser(userId, limit = 100) {
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
      return ((result.Items ?? []) as Record<string, unknown>[]).map(fromItem);
    },
    async listAll(limit = 100) {
      const result = await client.send(
        new ScanCommand({ TableName: table, Limit: limit })
      );
      const items = (result.Items ?? []) as Record<string, unknown>[];
      return items
        .sort((a, b) =>
          String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""))
        )
        .reverse()
        .slice(0, limit)
        .map(fromItem);
    },
  };
}
