import type { Telegraf } from "telegraf";
import type { BrokerService } from "../broker";
import {
  formatAccount,
  formatNotConnected,
  formatPositions,
  formatStats,
} from "./format";

export interface AccountHandlersDeps {
  service: BrokerService;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerAccountHandlers(
  bot: Telegraf,
  deps: AccountHandlersDeps
): void {
  bot.command("status", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId == null) {
      return;
    }

    const broker = await deps.service.getBrokerForUser(userId);
    if (!broker) {
      await ctx.reply(formatNotConnected("/status"));
      return;
    }

    try {
      const account = await broker.getAccount();
      await ctx.reply(formatAccount(account));
    } catch (error) {
      await ctx.reply(`Ошибка запроса счёта: ${toErrorMessage(error)}`);
    }
  });

  bot.command("positions", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId == null) {
      return;
    }

    const broker = await deps.service.getBrokerForUser(userId);
    if (!broker) {
      await ctx.reply(formatNotConnected("/positions"));
      return;
    }

    try {
      const [open, closed, account] = await Promise.all([
        broker.getPositions(),
        broker.getClosedTrades(5),
        broker.getAccount(),
      ]);
      // Для Upscale риск-статус даёт суммарный нереализованный P&L:
      // currentEquity - currentBalance. Используется как фолбэк, когда
      // рыночный снимок недоступен и P&L отдельных позиций не вычислен.
      const totalUnrealizedPnl =
        broker.name === "upscale"
          ? account.equity - account.balance
          : undefined;
      await ctx.reply(
        formatPositions(open, closed, account.currency, totalUnrealizedPnl)
      );
    } catch (error) {
      await ctx.reply(`Ошибка запроса сделок: ${toErrorMessage(error)}`);
    }
  });

  bot.command("stats", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId == null) {
      return;
    }

    const broker = await deps.service.getBrokerForUser(userId);
    if (!broker) {
      await ctx.reply(formatNotConnected("/stats"));
      return;
    }

    try {
      const stats = await broker.getStats();
      await ctx.reply(formatStats(stats));
    } catch (error) {
      await ctx.reply(`Ошибка запроса статистики: ${toErrorMessage(error)}`);
    }
  });
}
