import {
  type KeySchemaElement,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
} from "@aws-sdk/client-dynamodb";

export const TableName = {
  SERVICES: "services",
  AI_DECISIONS: "ai_decisions",
  TRADING_SETTINGS: "trading_settings",
  TRADING_STATE: "trading_state",
  TRADING_SNAPSHOTS: "trading_snapshots",
  LEARNING_REPORTS: "learning_reports",
  STRATEGIES: "strategies",
  STRATEGY_STATE: "strategy_state",
  USERS: "users",
  GLOBAL_STATE: "global_state",
  AUDIT_LOG: "audit_log",
  BROKER_CONNECTIONS: "broker_connections",
} as const;

export type TableName = (typeof TableName)[keyof typeof TableName];

export interface TableSchema {
  name: TableName;
  keySchema: KeySchemaElement[];
  attributeDefinitions: AttributeDefinition[];
  globalSecondaryIndexes?: GlobalSecondaryIndex[];
}

export const TABLE_SCHEMAS: Record<TableName, TableSchema> = {
  [TableName.SERVICES]: {
    name: TableName.SERVICES,
    keySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    attributeDefinitions: [
      { AttributeName: "id", AttributeType: "S" },
      { AttributeName: "status", AttributeType: "S" },
    ],
    globalSecondaryIndexes: [
      {
        IndexName: "status-index",
        KeySchema: [{ AttributeName: "status", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  },
  [TableName.AI_DECISIONS]: {
    name: TableName.AI_DECISIONS,
    keySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    attributeDefinitions: [
      { AttributeName: "id", AttributeType: "S" },
      { AttributeName: "userId", AttributeType: "N" },
      { AttributeName: "createdAt", AttributeType: "S" },
    ],
    globalSecondaryIndexes: [
      {
        IndexName: "userId-index",
        KeySchema: [
          { AttributeName: "userId", KeyType: "HASH" },
          { AttributeName: "createdAt", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  },
  [TableName.TRADING_SETTINGS]: {
    name: TableName.TRADING_SETTINGS,
    keySchema: [{ AttributeName: "userId", KeyType: "HASH" }],
    attributeDefinitions: [{ AttributeName: "userId", AttributeType: "N" }],
  },
  [TableName.TRADING_STATE]: {
    name: TableName.TRADING_STATE,
    keySchema: [{ AttributeName: "userId", KeyType: "HASH" }],
    attributeDefinitions: [{ AttributeName: "userId", AttributeType: "N" }],
  },
  [TableName.TRADING_SNAPSHOTS]: {
    name: TableName.TRADING_SNAPSHOTS,
    keySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    attributeDefinitions: [
      { AttributeName: "id", AttributeType: "S" },
      { AttributeName: "userId", AttributeType: "N" },
      { AttributeName: "createdAt", AttributeType: "S" },
    ],
    globalSecondaryIndexes: [
      {
        IndexName: "userId-index",
        KeySchema: [
          { AttributeName: "userId", KeyType: "HASH" },
          { AttributeName: "createdAt", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  },
  [TableName.LEARNING_REPORTS]: {
    name: TableName.LEARNING_REPORTS,
    keySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    attributeDefinitions: [
      { AttributeName: "id", AttributeType: "S" },
      { AttributeName: "userId", AttributeType: "N" },
      { AttributeName: "createdAt", AttributeType: "S" },
    ],
    globalSecondaryIndexes: [
      {
        IndexName: "userId-index",
        KeySchema: [
          { AttributeName: "userId", KeyType: "HASH" },
          { AttributeName: "createdAt", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  },
  [TableName.STRATEGIES]: {
    name: TableName.STRATEGIES,
    keySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    attributeDefinitions: [
      { AttributeName: "id", AttributeType: "S" },
      { AttributeName: "userId", AttributeType: "N" },
      { AttributeName: "createdAt", AttributeType: "S" },
    ],
    globalSecondaryIndexes: [
      {
        IndexName: "userId-index",
        KeySchema: [
          { AttributeName: "userId", KeyType: "HASH" },
          { AttributeName: "createdAt", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  },
  [TableName.STRATEGY_STATE]: {
    name: TableName.STRATEGY_STATE,
    keySchema: [{ AttributeName: "userId", KeyType: "HASH" }],
    attributeDefinitions: [{ AttributeName: "userId", AttributeType: "N" }],
  },
  [TableName.USERS]: {
    name: TableName.USERS,
    keySchema: [{ AttributeName: "userId", KeyType: "HASH" }],
    attributeDefinitions: [{ AttributeName: "userId", AttributeType: "N" }],
  },
  [TableName.GLOBAL_STATE]: {
    name: TableName.GLOBAL_STATE,
    keySchema: [{ AttributeName: "key", KeyType: "HASH" }],
    attributeDefinitions: [{ AttributeName: "key", AttributeType: "S" }],
  },
  [TableName.AUDIT_LOG]: {
    name: TableName.AUDIT_LOG,
    keySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    attributeDefinitions: [
      { AttributeName: "id", AttributeType: "S" },
      { AttributeName: "userId", AttributeType: "N" },
      { AttributeName: "createdAt", AttributeType: "S" },
    ],
    globalSecondaryIndexes: [
      {
        IndexName: "userId-index",
        KeySchema: [
          { AttributeName: "userId", KeyType: "HASH" },
          { AttributeName: "createdAt", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  },
  [TableName.BROKER_CONNECTIONS]: {
    name: TableName.BROKER_CONNECTIONS,
    keySchema: [{ AttributeName: "userId", KeyType: "HASH" }],
    attributeDefinitions: [{ AttributeName: "userId", AttributeType: "N" }],
  },
};

export const TABLE_NAMES: TableName[] = Object.values(TableName);

export const IndexName = {
  SERVICES_STATUS: "status-index",
  AI_DECISIONS_USER: "userId-index",
  TRADING_SNAPSHOTS_USER: "userId-index",
  LEARNING_REPORTS_USER: "userId-index",
  STRATEGIES_USER: "userId-index",
  AUDIT_LOG_USER: "userId-index",
} as const;

export type IndexName = (typeof IndexName)[keyof typeof IndexName];
