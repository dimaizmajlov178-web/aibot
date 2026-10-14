import type { User } from "../db/user-repository";

export type { User, StoredRole } from "../db/user-repository";

export type UserRole = "admin" | "subscriber" | "guest";

export function createDefaultUser(
  userId: number,
  username?: string | null
): User {
  const now = new Date().toISOString();
  return {
    userId,
    role: "guest",
    subscribed: false,
    subscribedAt: null,
    expiresAt: null,
    username: username ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Срок подписки по умолчанию при выдаче через /grant (дней). */
export const DEFAULT_GRANT_DAYS = 30;
