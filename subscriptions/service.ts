import type { GlobalStateRepository } from "../db/global-state-repository";
import type { UserRepository } from "../db/user-repository";
import type { User, UserRole } from "./types";
import { createDefaultUser, DEFAULT_GRANT_DAYS } from "./types";

export interface SubscriptionServiceDeps {
  users: UserRepository;
  global: GlobalStateRepository;
  /** Telegram_user_id администраторов (из ADMIN_TELEGRAM_IDS). */
  adminIds: readonly number[];
  /** Срок подписки по умолчанию при выдаче через /grant, дней. */
  defaultGrantDays?: number;
}

/**
 * Подписки и роли: admin (ADMIN_TELEGRAM_IDS), subscriber (активная
 * подписка) и guest (без подписки). Проверка активной подписки —
 * на каждом защищённом хендлере.
 */
export class SubscriptionService {
  private readonly defaultGrantDays: number;

  constructor(private readonly deps: SubscriptionServiceDeps) {
    this.defaultGrantDays = deps.defaultGrantDays ?? DEFAULT_GRANT_DAYS;
  }

  isAdmin(userId: number): boolean {
    return this.deps.adminIds.includes(userId);
  }

  async effectiveRole(userId: number): Promise<UserRole> {
    if (this.isAdmin(userId)) {
      return "admin";
    }
    return (await this.hasActiveSubscription(userId)) ? "subscriber" : "guest";
  }

  async getUser(userId: number): Promise<User> {
    return (
      (await this.deps.users.findByUserId(userId)) ?? createDefaultUser(userId)
    );
  }

  /** Регистрирует пользователя (создаёт запись guest) и обновляет активность. */
  async touch(userId: number, username?: string | null): Promise<User> {
    const existing = await this.deps.users.findByUserId(userId);
    const user: User = existing
      ? {
          ...existing,
          username: username != null ? username : existing.username,
          updatedAt: new Date().toISOString(),
        }
      : createDefaultUser(userId, username);
    await this.deps.users.save(user);
    return user;
  }

  async hasActiveSubscription(userId: number): Promise<boolean> {
    const user = await this.getUser(userId);
    if (!user.subscribed) {
      return false;
    }
    if (user.expiresAt == null) {
      return true;
    }
    return user.expiresAt > new Date().toISOString();
  }

  /**
   * Выдаёт подписку. days — срок в днях; null/0/отрицательное — бессрочно.
   */
  async grant(userId: number, days?: number): Promise<User> {
    const now = new Date();
    const expiresAt =
      days == null || days <= 0 ? null : addDays(now, Math.floor(days));
    const current = await this.getUser(userId);
    const user: User = {
      ...current,
      role: "subscriber",
      subscribed: true,
      subscribedAt: current.subscribedAt ?? now.toISOString(),
      expiresAt,
      updatedAt: now.toISOString(),
    };
    await this.deps.users.save(user);
    return user;
  }

  async revoke(userId: number): Promise<User | null> {
    const current = await this.deps.users.findByUserId(userId);
    if (!current) {
      return null;
    }
    const user: User = {
      ...current,
      role: "guest",
      subscribed: false,
      subscribedAt: null,
      expiresAt: null,
      updatedAt: new Date().toISOString(),
    };
    await this.deps.users.save(user);
    return user;
  }

  async listUsers(): Promise<User[]> {
    const users = await this.deps.users.listAll();
    return users.sort((a, b) => a.userId - b.userId);
  }

  async isGlobalPaused(): Promise<boolean> {
    return this.deps.global.getGlobalPaused();
  }

  async setGlobalPaused(paused: boolean): Promise<boolean> {
    await this.deps.global.setGlobalPaused(paused);
    return paused;
  }
}

function addDays(date: Date, days: number): string {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy.toISOString();
}
