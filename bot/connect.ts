import type { Context, Telegraf } from "telegraf";
import type { BrokerService } from "../broker";
import {
  formatBrokerAlreadyConnected,
  formatConnectError,
  formatConnectPrompt,
  formatConnectResult,
} from "./format";
import type { ConnectSessionStore } from "./sessions";
import { getRequestId } from "./request-context";

export interface ConnectHandlersDeps {
  service: BrokerService;
  sessions: ConnectSessionStore;
}

export function registerConnectHandlers(
  bot: Telegraf,
  deps: ConnectHandlersDeps
): void {
  bot.command("connect", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId == null) {
      return;
    }

    const payload = ctx.payload.trim();
    if (payload) {
      await performConnect(ctx, userId, payload, deps);
      return;
    }

    if (await deps.service.isConnected(userId)) {
      deps.sessions.clear(userId);
      await ctx.reply(formatBrokerAlreadyConnected());
      return;
    }

    deps.sessions.start(userId);
    await ctx.reply(formatConnectPrompt());
  });

  bot.command("disconnect", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId == null) {
      return;
    }

    deps.sessions.clear(userId);
    const removed = await deps.service.disconnectUser(userId, {
      actorId: userId,
      actorRole: "user",
      requestId: getRequestId(ctx),
    });
    await ctx.reply(
      removed
        ? "Брокер отключён, API-ключ удалён."
        : "Брокер не подключён. Подключить: /connect"
    );
  });

  bot.command("cancel", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId == null) {
      return;
    }

    const wasWaiting = deps.sessions.isAwaitingKey(userId);
    deps.sessions.clear(userId);
    await ctx.reply(wasWaiting ? "Привязка отменена." : "Нечего отменять.");
  });

  bot.on("text", async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId == null) {
      return next();
    }

    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/")) {
      return next();
    }
    if (!deps.sessions.isAwaitingKey(userId)) {
      return next();
    }

    await performConnect(ctx, userId, text, deps);
  });
}

async function performConnect(
  ctx: Context,
  userId: number,
  rawApiKey: string,
  deps: ConnectHandlersDeps
): Promise<void> {
  try {
    const result = await deps.service.connectUser(userId, rawApiKey, {
      actorId: userId,
      actorRole: "user",
      requestId: getRequestId(ctx),
    });
    deps.sessions.clear(userId);
    await ctx.reply(formatConnectResult(result, rawApiKey));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(formatConnectError(message));
  }
}