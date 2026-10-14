export interface ConnectSession {
  step: "awaiting_key";
  startedAt: string;
}

export interface ConnectSessionStore {
  start(userId: number): void;
  isAwaitingKey(userId: number): boolean;
  clear(userId: number): void;
}

export function createConnectSessionStore(): ConnectSessionStore {
  const sessions = new Map<number, ConnectSession>();

  return {
    start(userId) {
      sessions.set(userId, {
        step: "awaiting_key",
        startedAt: new Date().toISOString(),
      });
    },
    isAwaitingKey(userId) {
      return sessions.get(userId)?.step === "awaiting_key";
    },
    clear(userId) {
      sessions.delete(userId);
    },
  };
}
