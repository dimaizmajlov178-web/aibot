import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db";
import { TableName } from "../lib/schema";
import type { TradingSettings, TradingState } from "../engine/types";

export interface TradingSettingsRepository {
  get(userId: number): Promise<TradingSettings | null>;
  save(settings: TradingSettings): Promise<void>;
}

export interface TradingStateRepository {
  get(userId: number): Promise<TradingState | null>;
  save(state: TradingState): Promise<void>;
}

export function createInMemoryTradingSettingsRepository(): TradingSettingsRepository {
  const store = new Map<number, TradingSettings>();

  return {
    async get(userId) {
      return store.get(userId) ?? null;
    },
    async save(settings) {
      store.set(settings.userId, settings);
    },
  };
}

export function createInMemoryTradingStateRepository(): TradingStateRepository {
  const store = new Map<number, TradingState>();

  return {
    async get(userId) {
      return store.get(userId) ?? null;
    },
    async save(state) {
      store.set(state.userId, state);
    },
  };
}

interface SettingsItem {
  userId: number;
  riskPerTradePercent: number;
  maxPositions: number;
  dailyTradeLimit: number;
  maxDailyDrawdownPercent: number;
  maxTotalDrawdownPercent: number;
  symbols: string[];
  aiMode: string;
  updatedAt: string;
}

function toSettingsItem(settings: TradingSettings): SettingsItem {
  return {
    userId: settings.userId,
    riskPerTradePercent: settings.riskPerTradePercent,
    maxPositions: settings.maxPositions,
    dailyTradeLimit: settings.dailyTradeLimit,
    maxDailyDrawdownPercent: settings.maxDailyDrawdownPercent,
    maxTotalDrawdownPercent: settings.maxTotalDrawdownPercent,
    symbols: settings.symbols,
    aiMode: settings.aiMode,
    updatedAt: settings.updatedAt,
  };
}

function fromSettingsItem(item: SettingsItem): TradingSettings {
  return {
    userId: item.userId,
    riskPerTradePercent: item.riskPerTradePercent,
    maxPositions: item.maxPositions,
    dailyTradeLimit: item.dailyTradeLimit,
    maxDailyDrawdownPercent: item.maxDailyDrawdownPercent,
    maxTotalDrawdownPercent: item.maxTotalDrawdownPercent,
    symbols: item.symbols,
    aiMode: isAiMode(item.aiMode) ? item.aiMode : "balanced",
    updatedAt: item.updatedAt,
  };
}

function isAiMode(value: string): value is TradingSettings["aiMode"] {
  return value === "safe" || value === "balanced" || value === "aggressive";
}

export function createDynamoDbTradingSettingsRepository(
  client: DynamoDBDocumentClient = docClient
): TradingSettingsRepository {
  const table = TableName.TRADING_SETTINGS;

  return {
    async get(userId) {
      const result = await client.send(
        new GetCommand({ TableName: table, Key: { userId } })
      );
      return result.Item ? fromSettingsItem(result.Item as SettingsItem) : null;
    },
    async save(settings) {
      await client.send(
        new PutCommand({
          TableName: table,
          Item: toSettingsItem(settings),
        })
      );
    },
  };
}

interface StateItem {
  userId: number;
  paused: boolean;
  pausedAt: string | null;
  autoDailyPaused: boolean;
  autoDailyPauseDate: string | null;
  totalStopTriggered: boolean;
  totalStopTriggeredAt: string | null;
  adminNotifiedForTotalStop: boolean;
  tradesToday: number;
  tradingDay: string;
  updatedAt: string;
}

function toStateItem(state: TradingState): StateItem {
  return {
    userId: state.userId,
    paused: state.paused,
    pausedAt: state.pausedAt ?? null,
    autoDailyPaused: state.autoDailyPaused,
    autoDailyPauseDate: state.autoDailyPauseDate ?? null,
    totalStopTriggered: state.totalStopTriggered,
    totalStopTriggeredAt: state.totalStopTriggeredAt ?? null,
    adminNotifiedForTotalStop: state.adminNotifiedForTotalStop,
    tradesToday: state.tradesToday,
    tradingDay: state.tradingDay,
    updatedAt: state.updatedAt,
  };
}

function fromStateItem(item: StateItem): TradingState {
  return {
    userId: item.userId,
    paused: item.paused,
    pausedAt: item.pausedAt ?? null,
    autoDailyPaused: item.autoDailyPaused,
    autoDailyPauseDate: item.autoDailyPauseDate ?? null,
    totalStopTriggered: item.totalStopTriggered,
    totalStopTriggeredAt: item.totalStopTriggeredAt ?? null,
    adminNotifiedForTotalStop: item.adminNotifiedForTotalStop,
    tradesToday: item.tradesToday,
    tradingDay: item.tradingDay,
    updatedAt: item.updatedAt,
  };
}

export function createDynamoDbTradingStateRepository(
  client: DynamoDBDocumentClient = docClient
): TradingStateRepository {
  const table = TableName.TRADING_STATE;

  return {
    async get(userId) {
      const result = await client.send(
        new GetCommand({ TableName: table, Key: { userId } })
      );
      return result.Item ? fromStateItem(result.Item as StateItem) : null;
    },
    async save(state) {
      await client.send(
        new PutCommand({ TableName: table, Item: toStateItem(state) })
      );
    },
  };
}
