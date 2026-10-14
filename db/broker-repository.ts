import {
  GetCommand,
  PutCommand,
  ScanCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db";
import { TableName } from "../lib/schema";

export interface BrokerConnection {
  userId: number;
  brokerType: string;
  encryptedApiKey: string;
  keyFingerprint: string;
  connectedAt: string;
}

export interface BrokerRepository {
  save(connection: BrokerConnection): Promise<void>;
  findByUserId(userId: number): Promise<BrokerConnection | null>;
  deleteByUserId(userId: number): Promise<boolean>;
  listUserIds(): Promise<number[]>;
}

export function createInMemoryBrokerRepository(): BrokerRepository {
  const connections = new Map<number, BrokerConnection>();

  return {
    async save(connection) {
      connections.set(connection.userId, connection);
    },
    async findByUserId(userId) {
      return connections.get(userId) ?? null;
    },
    async deleteByUserId(userId) {
      return connections.delete(userId);
    },
    async listUserIds() {
      return [...connections.keys()];
    },
  };
}

/** Строка таблицы broker_connections. Хранится только шифр ключа + отпечаток. */
interface BrokerConnectionItem {
  userId: number;
  brokerType: string;
  encryptedApiKey: string;
  keyFingerprint: string;
  connectedAt: string;
}

export function createDynamoDbBrokerRepository(
  client: DynamoDBDocumentClient = docClient
): BrokerRepository {
  const table = TableName.BROKER_CONNECTIONS;

  return {
    async save(connection) {
      const item: BrokerConnectionItem = {
        userId: connection.userId,
        brokerType: connection.brokerType,
        encryptedApiKey: connection.encryptedApiKey,
        keyFingerprint: connection.keyFingerprint,
        connectedAt: connection.connectedAt,
      };
      await client.send(new PutCommand({ TableName: table, Item: item }));
    },
    async findByUserId(userId) {
      const result = await client.send(
        new GetCommand({ TableName: table, Key: { userId } })
      );
      const item = result.Item as BrokerConnectionItem | undefined;
      return item
        ? {
            userId: item.userId,
            brokerType: item.brokerType,
            encryptedApiKey: item.encryptedApiKey,
            keyFingerprint: item.keyFingerprint,
            connectedAt: item.connectedAt,
          }
        : null;
    },
    async deleteByUserId(userId) {
      const result = await client.send(
        new DeleteCommand({
          TableName: table,
          Key: { userId },
          ReturnValues: "ALL_OLD",
        })
      );
      return result.Attributes != null;
    },
    async listUserIds() {
      const result = await client.send(new ScanCommand({ TableName: table }));
      return ((result.Items ?? []) as BrokerConnectionItem[]).map(
        (item) => item.userId
      );
    },
  };
}
