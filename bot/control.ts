import type { Telegraf } from "telegraf";
import type { BaseBroker } from "../broker";
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
  /** Получение клиента брокера пользователя для живых данных о позициях. */
  resolveBroker: (userId: number) => Promise<BaseBroker | null>;
}

/**
 * Реальное число открытых позиций на брокере:
 * - undefined — брокер не подключён (строку "позиции" не показываем);
 * - null — брокер подключён, но живой запрос позиций недоступен;
 * - число — количество открытых позиций по данным брокера.
 */
async function getOpenPositions(
  resolveBroker: (userId: number) => Promise<BaseBroker | null>,
  userId: number
): Promise<number | null | undefined> {
  let broker: BaseBroker | null;
  try {
    broker = await resolveBroker(userId);
  } catch {
    return null;
  }
  if (!broker) {
    return undefined;
  }
  try {
    const positions = await broker.getPositions();
    return positions.length;
  } catch {
    return null;
  }
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
    const openPositions = await getOpenPositions(deps.resolveBroker, userId);
    await ctx.reply(
      [
        "Торговля приостановлена (/resume — возобновить).",
        "",
        formatTradingState(state, settings, openPositions),
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
    const openPositions = await getOpenPositions(deps.resolveBroker, userId);
    await ctx.reply(
      [
        "Торговля возобновлена.",
        "",
        formatTradingState(state, settings, openPositions),
      ].join("\n")
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
        const openPositions = await getOpenPositions(
          deps.resolveBroker,
          userId
        );
        await ctx.reply(
          `${formatSettings(settings)}\n\n${formatTradingState(
            state,
            settings,
            openPositions
          )}`
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
