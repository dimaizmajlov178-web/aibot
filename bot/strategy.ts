import type { Telegraf } from "telegraf";
import type { LearningService } from "../learning";
import { getRequestId } from "./request-context";
import type { AuditService } from "../core/audit";
import {
  formatAbTestResults,
  formatLearningReport,
  formatStrategyList,
  formatStrategyVersion,
} from "../learning/format";

export interface StrategyHandlersDeps {
  learning: LearningService;
  isAdmin: (userId: number) => boolean;
  /** Журнал аудита управления стратегиями. */
  audit?: AuditService;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseVersion(payload: string): number | null {
  const value = Number(payload.trim());
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

export function registerStrategyHandlers(
  bot: Telegraf,
  deps: StrategyHandlersDeps
): void {
  bot.command("learning", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId == null) {
      return;
    }

    const force = ctx.payload.trim().toLowerCase() === "force";
    if (force && !deps.isAdmin(userId)) {
      await ctx.reply("Принудительная перегенерация доступна только админу.");
      return;
    }

    try {
      let report;
      if (force) {
        report = await deps.learning.runDailyReport(userId, { force: true });
      } else {
        const recent = await deps.learning.listReports(userId, 1);
        report = recent[0] ?? (await deps.learning.runDailyReport(userId));
      }
      await ctx.reply(formatLearningReport(report));
    } catch (error) {
      await ctx.reply(`Ошибка отчёта: ${toErrorMessage(error)}`);
    }
  });

  bot.command("strategy", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId == null) {
      return;
    }

    const [state, versions] = await Promise.all([
      deps.learning.getState(userId),
      deps.learning.listStrategies(userId),
    ]);
    await ctx.reply(formatStrategyList(state, versions));
  });

  bot.command("strategy_rollback", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId == null) {
      return;
    }
    if (!deps.isAdmin(userId)) {
      await ctx.reply("Команда доступна только админу.");
      return;
    }

    const version = parseVersion(ctx.payload);
    if (version == null) {
      await ctx.reply("Укажите номер версии: /strategy_rollback <версия>");
      return;
    }

    try {
      const strategy = await deps.learning.rollbackStrategy(userId, version);
      await ctx.reply(
        `Стратегия откачена на v${strategy.version}.\n\n${formatStrategyVersion(strategy)}`
      );
      await deps.audit?.strategyAction("strategy.promote", {
        userId,
        actorId: userId,
        actorRole: "admin",
        requestId: getRequestId(ctx),
        entityType: "strategy",
        entityId: version,
        details: { action: "rollback", version },
      });
    } catch (error) {
      await ctx.reply(`Ошибка отката: ${toErrorMessage(error)}`);
    }
  });

  bot.command("strategy_ab", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId == null) {
      return;
    }
    if (!deps.isAdmin(userId)) {
      await ctx.reply("Команда доступна только админу.");
      return;
    }

    const version = parseVersion(ctx.payload);
    if (version == null) {
      await ctx.reply("Укажите номер версии: /strategy_ab <версия>");
      return;
    }

    try {
      const state = await deps.learning.startAbTest(userId, version);
      const ab = state.abTest;
      await ctx.reply(
        `A/B тест запущен: активная v${state.activeVersion} против тестовой v${ab?.testVersion}. Сделки распределяются поровну. Остановка: /strategy_ab_stop`
      );
      await deps.audit?.strategyAction("strategy.ab_start", {
        userId,
        actorId: userId,
        actorRole: "admin",
        requestId: getRequestId(ctx),
        entityType: "strategy_ab",
        entityId: version,
        details: {
          referenceVersion: state.activeVersion,
          testVersion: ab?.testVersion,
          startedAt: state.abTest?.startedAt,
        },
      });
    } catch (error) {
      await ctx.reply(`Ошибка запуска A/B: ${toErrorMessage(error)}`);
    }
  });

  bot.command("strategy_ab_stop", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId == null) {
      return;
    }
    if (!deps.isAdmin(userId)) {
      await ctx.reply("Команда доступна только админу.");
      return;
    }

    try {
      const { comparison, state } = await deps.learning.stopAbTest(userId);
      const lines = ["A/B тест остановлен."];
      if (comparison) {
        lines.push("", formatAbTestResults(comparison));
      }
      await ctx.reply(lines.join("\n"));
      await deps.audit?.strategyAction("strategy.ab_stop", {
        userId,
        actorId: userId,
        actorRole: "admin",
        requestId: getRequestId(ctx),
        entityType: "strategy_ab",
        entityId: state.abTest?.testVersion ?? null,
        details: {
          ab: comparison
            ? {
                referenceVersion: comparison.referenceVersion,
                testVersion: comparison.testVersion,
                referenceTrades: comparison.referenceTrades,
                testTrades: comparison.testTrades,
              }
            : null,
        },
      });
    } catch (error) {
      await ctx.reply(`Ошибка остановки A/B: ${toErrorMessage(error)}`);
    }
  });
}
