import type { Telegraf } from "telegraf";
import type { RiskManager } from "../engine/risk-manager";
import { parseSettingsPayload } from "../engine/settings";
import { getRequestId } from "./request-context";
import {
  formatNotConfigured,
  formatSettings,
  formatSettingsApplied,
  formatTradingState,
} from "./format";

export interface ControlHandlersDeps {
  riskManager: RiskManager;
  /** Проверка, что у пользователя подключён брокер (торговля возможна). */
  isConnected: (userId: number) => Promise<boolean>;
}

export function registerControlHandlers(
  bot: Telegraf,
  deps: ControlHandlersDeps
): void {
  bot.command("pause", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId == null) {
      return;
    }
    if (!(await deps.isConnected(userId))) {
      await ctx.reply(formatNotConfigured());
      return;
    }

    const state = await deps.riskManager.pause(userId, {
      actorId: userId,
      actorRole: "user",
      requestId: getRequestId(ctx),
    });
    const settings = await deps.riskManager.getSettings(userId);
    await ctx.reply(
      [
        "Торговля приостановлена (/resume — возобновить).",
        "",
        formatTradingState(state, settings),
      ].join("\n")
    );
  });

  bot.command("resume", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId == null) {
      return;
    }
    const state = await deps.riskManager.resume(userId, {
      actorId: userId,
      actorRole: "user",
      requestId: getRequestId(ctx),
    });
    const settings = await deps.riskManager.getSettings(userId);
    await ctx.reply(
      ["Торговля возобновлена.", "", formatTradingState(state, settings)].join(
        "\n"
      )
    );
  });

  bot.command("settings", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId == null) {
      return;
    }
    if (!(await deps.isConnected(userId))) {
      await ctx.reply(formatNotConfigured());
      return;
    }

    const payload = ctx.payload.trim();
    if (!payload) {
      try {
        const settings = await deps.riskManager.getSettings(userId);
        const state = await deps.riskManager.getState(userId);
        await ctx.reply(
          `${formatSettings(settings)}\n\n${formatTradingState(state, settings)}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.reply(`Ошибка настройки: ${message}`);
      }
      return;
    }

    try {
      const patch = parseSettingsPayload(payload);
      const updated = await deps.riskManager.updateSettings(userId, patch, {
        actorId: userId,
        actorRole: "user",
        requestId: getRequestId(ctx),
      });
      await ctx.reply(formatSettingsApplied(updated));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Ошибка настройки: ${message}`);
    }
  });
}
