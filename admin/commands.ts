import type { Context, Telegraf } from "telegraf";
import type { SubscriptionService } from "../subscriptions";
import type { User } from "../subscriptions";
import { DEFAULT_GRANT_DAYS } from "../subscriptions";
import type { AuditService } from "../core/audit";
import { getRequestId } from "../bot/request-context";

type Ctx = Context;

export interface AdminHandlersDeps {
  subscriptions: SubscriptionService;
  isAdmin: (userId: number) => boolean;
  /** Журнал аудита административных действий. */
  audit?: AuditService;
}

function requireAdmin(deps: AdminHandlersDeps, ctx: Ctx): boolean {
  const userId = ctx.from?.id;
  if (userId == null || !deps.isAdmin(userId)) {
    void ctx.reply("Команда доступна только админу.");
    return false;
  }
  return true;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerAdminHandlers(
  bot: Telegraf,
  deps: AdminHandlersDeps
): void {
  bot.command("admin", async (ctx) => {
    if (!requireAdmin(deps, ctx)) {
      return;
    }
    const payload = ctx.payload.trim();
    if (!payload || payload.toLowerCase() === "help") {
      await ctx.reply(formatAdminMenu());
      return;
    }
    await dispatchAdminSubcommand(ctx, payload, deps);
  });

  bot.command("grant", async (ctx) => {
    if (!requireAdmin(deps, ctx)) {
      return;
    }
    await runGrant(ctx, deps, ctx.payload.trim());
  });

  bot.command("revoke", async (ctx) => {
    if (!requireAdmin(deps, ctx)) {
      return;
    }
    await runRevoke(ctx, deps, ctx.payload.trim());
  });

  bot.command("users", async (ctx) => {
    if (!requireAdmin(deps, ctx)) {
      return;
    }
    await runUsers(ctx, deps);
  });

  bot.command("broadcast", async (ctx) => {
    if (!requireAdmin(deps, ctx)) {
      return;
    }
    await runBroadcast(ctx, deps, ctx.payload.trim());
  });

  bot.command("global_pause", async (ctx) => {
    if (!requireAdmin(deps, ctx)) {
      return;
    }
    await runGlobalPause(ctx, deps);
  });
}

async function dispatchAdminSubcommand(
  ctx: Ctx,
  payload: string,
  deps: AdminHandlersDeps
): Promise<void> {
  const [sub, ...rest] = payload.split(/\s+/);
  const restPayload = rest.join(" ");
  switch (sub?.toLowerCase()) {
    case "grant":
      await runGrant(ctx, deps, restPayload);
      break;
    case "revoke":
      await runRevoke(ctx, deps, restPayload);
      break;
    case "users":
      await runUsers(ctx, deps);
      break;
    case "broadcast":
      await runBroadcast(ctx, deps, restPayload);
      break;
    case "global_pause":
    case "pause":
      await runGlobalPause(ctx, deps);
      break;
    default:
      await ctx.reply(
        `Неизвестная подкоманда. Доступно:\n${formatAdminMenu()}`
      );
  }
}

async function runGrant(
  ctx: Ctx,
  deps: AdminHandlersDeps,
  payload: string
): Promise<void> {
  const parsed = parseGrant(payload);
  if (!parsed.ok) {
    await ctx.reply(
      "Укажите id пользователя: /grant <user_id> [дней]\nПример: /grant 123456789 30"
    );
    return;
  }
  const actorId = ctx.from?.id ?? null;
  try {
    const user = await deps.subscriptions.grant(parsed.targetId, parsed.days);
    await ctx.reply(formatGranted(user));
    await deps.audit?.adminAction("admin.grant", {
      userId: parsed.targetId,
      actorId,
      actorRole: "admin",
      requestId: getRequestId(ctx),
      entityType: "user_subscription",
      entityId: parsed.targetId,
      details: {
        days: parsed.days ?? null,
        expiresAt: user.expiresAt,
        adminId: actorId,
      },
    });
  } catch (error) {
    await ctx.reply(`Ошибка выдачи подписки: ${toErrorMessage(error)}`);
  }
}

async function runRevoke(
  ctx: Ctx,
  deps: AdminHandlersDeps,
  payload: string
): Promise<void> {
  const targetId = parseUserId(payload);
  if (targetId == null) {
    await ctx.reply("Укажите id пользователя: /revoke <user_id>");
    return;
  }
  const actorId = ctx.from?.id ?? null;
  try {
    const user = await deps.subscriptions.revoke(targetId);
    await ctx.reply(
      user
        ? formatRevoked(user)
        : "Пользователь не найден. Сначала он должен написать боту."
    );
    if (user) {
      await deps.audit?.adminAction("admin.revoke", {
        userId: targetId,
        actorId,
        actorRole: "admin",
        requestId: getRequestId(ctx),
        entityType: "user_subscription",
        entityId: targetId,
        details: { adminId: actorId },
      });
    }
  } catch (error) {
    await ctx.reply(`Ошибка отзыва подписки: ${toErrorMessage(error)}`);
  }
}

async function runUsers(ctx: Ctx, deps: AdminHandlersDeps): Promise<void> {
  try {
    const users = await deps.subscriptions.listUsers();
    await ctx.reply(formatUserList(users, deps));
  } catch (error) {
    await ctx.reply(`Ошибка получения списка: ${toErrorMessage(error)}`);
  }
}

async function runBroadcast(
  ctx: Ctx,
  deps: AdminHandlersDeps,
  payload: string
): Promise<void> {
  if (!payload) {
    await ctx.reply("Укажите текст: /broadcast <сообщение>");
    return;
  }
  const actorId = ctx.from?.id ?? null;
  try {
    const users = await deps.subscriptions.listUsers();
    const results = await Promise.allSettled(
      users.map((user) => ctx.telegram.sendMessage(user.userId, payload))
    );
    const sent = results.filter(
      (result) => result.status === "fulfilled"
    ).length;
    await ctx.reply(`Рассылка: отправлено ${sent} из ${users.length}.`);
    await deps.audit?.adminAction("admin.broadcast", {
      userId: actorId ?? 0,
      actorId,
      actorRole: "admin",
      requestId: getRequestId(ctx),
      entityType: "broadcast",
      details: {
        recipients: users.length,
        sent,
        textLength: payload.length,
      },
    });
  } catch (error) {
    await ctx.reply(`Ошибка рассылки: ${toErrorMessage(error)}`);
  }
}

async function runGlobalPause(
  ctx: Ctx,
  deps: AdminHandlersDeps
): Promise<void> {
  const actorId = ctx.from?.id ?? null;
  try {
    const current = await deps.subscriptions.isGlobalPaused();
    const paused = await deps.subscriptions.setGlobalPaused(!current);
    await ctx.reply(formatGlobalPause(paused));
    await deps.audit?.adminAction("admin.global_pause", {
      userId: actorId ?? 0,
      actorId,
      actorRole: "admin",
      requestId: getRequestId(ctx),
      entityType: "global_state",
      entityId: "global",
      details: { paused, previous: current },
    });
  } catch (error) {
    await ctx.reply(`Ошибка глобальной паузы: ${toErrorMessage(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Парсинг
// ---------------------------------------------------------------------------

function parseUserId(raw: string): number | null {
  const cleaned = raw.trim().replace(/^@/, "");
  if (!/^\d+$/.test(cleaned)) {
    return null;
  }
  const value = Number(cleaned);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseGrant(
  payload: string
): { ok: true; targetId: number; days?: number } | { ok: false } {
  const [rawId, rawDays] = payload.trim().split(/\s+/);
  const targetId = parseUserId(rawId ?? "");
  if (targetId == null) {
    return { ok: false };
  }
  if (!rawDays) {
    return { ok: true, targetId };
  }
  if (!/^\d+$/.test(rawDays)) {
    return { ok: false };
  }
  const days = Number(rawDays);
  if (!Number.isSafeInteger(days) || days < 1) {
    return { ok: false };
  }
  return { ok: true, targetId, days };
}

// ---------------------------------------------------------------------------
// Форматирование
// ---------------------------------------------------------------------------

export function formatAdminMenu(): string {
  return [
    "Админ-панель",
    "/grant <user_id> [дней] — выдать подписку",
    "/revoke <user_id> — отозвать подписку",
    "/users — список пользователей",
    "/broadcast <текст> — рассылка всем",
    "/global_pause — пауза торговли у всех",
    "",
    `По умолчанию подписка выдаётся на ${DEFAULT_GRANT_DAYS} дней.`,
  ].join("\n");
}

export function formatGranted(user: User): string {
  const term = user.expiresAt
    ? ` до ${user.expiresAt.slice(0, 10)}`
    : " без ограничения срока";
  return `Подписка выдана пользователю ${user.userId}${term}.`;
}

export function formatRevoked(user: User): string {
  return `Подписка пользователя ${user.userId} отозвана. Доступ закрыт.`;
}

export function formatUserList(users: User[], deps: AdminHandlersDeps): string {
  if (users.length === 0) {
    return ["Пользователи:", "нет данных"].join("\n");
  }
  const lines = users.map((user) => {
    const role = deps.isAdmin(user.userId) ? "admin" : user.role;
    const status = user.subscribed
      ? user.expiresAt
        ? `активна до ${user.expiresAt.slice(0, 10)}`
        : "активна (бессрочно)"
      : "нет подписки";
    const name = user.username ? `@${user.username}` : "-";
    return `${user.userId} (${name}) — ${role}, ${status}`;
  });
  return ["Пользователи:", `Всего: ${users.length}`, "", ...lines].join("\n");
}

export function formatGlobalPause(paused: boolean): string {
  return paused
    ? "Глобальная пауза включена: торговля остановлена у всех пользователей."
    : "Глобальная пауза выключена: торговля возобновлена у всех.";
}
