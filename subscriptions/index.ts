import type { BotModule } from "../core/modules";

export const subscriptionsModule: BotModule = { name: "subscriptions" };

export { SubscriptionService } from "./service";
export type { SubscriptionServiceDeps } from "./service";
export { createDefaultUser, DEFAULT_GRANT_DAYS } from "./types";
export type { User, UserRole, StoredRole } from "./types";
