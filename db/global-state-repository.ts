import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db";
import { TableName } from "../lib/schema";

export interface GlobalStateRepository {
  getGlobalPaused(): Promise<boolean>;
  setGlobalPaused(paused: boolean): Promise<void>;
}

export function createInMemoryGlobalStateRepository(): GlobalStateRepository {
  let globalPaused = false;

  return {
    async getGlobalPaused() {
      return globalPaused;
    },
    async setGlobalPaused(paused) {
      globalPaused = paused;
    },
  };
}

const GLOBAL_PAUSE_KEY = "global" as const;

interface GlobalStateItem {
  key: string;
  globalPaused: boolean;
  updatedAt: string;
}

export function createDynamoDbGlobalStateRepository(
  client: DynamoDBDocumentClient = docClient
): GlobalStateRepository {
  const table = TableName.GLOBAL_STATE;

  return {
    async getGlobalPaused() {
      const result = await client.send(
        new GetCommand({ TableName: table, Key: { key: GLOBAL_PAUSE_KEY } })
      );
      const item = result.Item as GlobalStateItem | undefined;
      return item?.globalPaused ?? false;
    },
    async setGlobalPaused(paused) {
      const item: GlobalStateItem = {
        key: GLOBAL_PAUSE_KEY,
        globalPaused: paused,
        updatedAt: new Date().toISOString(),
      };
      await client.send(new PutCommand({ TableName: table, Item: item }));
    },
  };
}
