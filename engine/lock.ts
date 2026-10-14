/**
 * Защита от дублей ордеров.
 *
 * Блокировка на ключ "символ+направление" с TTL — семантика SET NX PX из
 * Redis. По умолчанию используется in-memory реализация (Redis-совместимая),
 * а при наличии Redis-клиента (передача через createRedisLockStore) блокировка
 * держится в Redis для работы в распределённом режиме.
 */

export interface LockStore {
  /**
   * Пытается занять блокировку на key. Возвращает true, если блокировка
   * получена (ключ не был занят), false — если она уже занята.
   */
  acquire(key: string, ttlMs: number): Promise<boolean>;
  /** Снимает блокировку. */
  release(key: string): Promise<void>;
}

export function createInMemoryLockStore(): LockStore {
  const locks = new Map<string, number>();

  const isExpired = (key: string, now: number): boolean => {
    const expiresAt = locks.get(key);
    return expiresAt === undefined || expiresAt <= now;
  };

  return {
    async acquire(key, ttlMs) {
      const now = Date.now();
      if (isExpired(key, now)) {
        locks.set(key, now + ttlMs);
        return true;
      }
      return false;
    },
    async release(key) {
      locks.delete(key);
    },
  };
}

/**
 * Минимальный контракт Redis-клиента для блокировок (SET NX PX + DEL),
 * совместимый с ioredis/node-redis. Используется для распределённого режима,
 * когда два экземпляра бота могут исполнять ордера конкурентно.
 */
export interface RedisLikeClient {
  set(
    key: string,
    value: string,
    mode: "PX",
    ttlMs: number,
    condition: "NX"
  ): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

const LOCK_VALUE = "1";

export function createRedisLockStore(client: RedisLikeClient): LockStore {
  return {
    async acquire(key, ttlMs) {
      const result = await client.set(key, LOCK_VALUE, "PX", ttlMs, "NX");
      return result === "OK" || result === 1 || result === true;
    },
    async release(key) {
      await client.del(key);
    },
  };
}
