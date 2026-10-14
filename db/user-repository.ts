import { GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db";
import { TableName } from "../lib/schema";

export type StoredRole = "subscriber" | "guest";

/** Строка таблицы `users`: подписка и роль пользователя. */
export interface User {
  userId: number;
  /** Роль относительно подписки. Роль admin вычисляется из ADMIN_TELEGRAM_IDS. */
  role: StoredRole;
  /** Есть ли активная (возможно поле expiresAt == null — бессрочная) подписка. */
  subscribed: boolean;
  subscribedAt: string | null;
  expiresAt: string | null;
  username: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserRepository {
  save(user: User): Promise<void>;
  findByUserId(userId: number): Promise<User | null>;
  listAll(): Promise<User[]>;
}

interface UserItem {
  userId: number;
  role: StoredRole;
  subscribed: boolean;
  subscribedAt: string | null;
  expiresAt: string | null;
  username: string | null;
  createdAt: string;
  updatedAt: string;
}

export function createInMemoryUserRepository(): UserRepository {
  const users = new Map<number, User>();

  return {
    async save(user) {
      users.set(user.userId, user);
    },
    async findByUserId(userId) {
      return users.get(userId) ?? null;
    },
    async listAll() {
      return [...users.values()];
    },
  };
}

function toItem(user: User): UserItem {
  return {
    userId: user.userId,
    role: user.role,
    subscribed: user.subscribed,
    subscribedAt: user.subscribedAt ?? null,
    expiresAt: user.expiresAt ?? null,
    username: user.username ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function fromItem(item: UserItem): User {
  return {
    userId: item.userId,
    role: item.role,
    subscribed: item.subscribed,
    subscribedAt: item.subscribedAt ?? null,
    expiresAt: item.expiresAt ?? null,
    username: item.username ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export function createDynamoDbUserRepository(
  client: DynamoDBDocumentClient = docClient
): UserRepository {
  const table = TableName.USERS;

  return {
    async save(user) {
      await client.send(
        new PutCommand({ TableName: table, Item: toItem(user) })
      );
    },
    async findByUserId(userId) {
      const result = await client.send(
        new GetCommand({ TableName: table, Key: { userId } })
      );
      return result.Item ? fromItem(result.Item as UserItem) : null;
    },
    async listAll() {
      const result = await client.send(new ScanCommand({ TableName: table }));
      return ((result.Items ?? []) as UserItem[]).map(fromItem);
    },
  };
}
