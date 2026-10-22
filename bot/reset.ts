import type { Telegraf } from "telegraf";
import { docClient } from "../lib/db";
import { ScanCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { TableName } from "../lib/schema";

const TABLES: string[] = [
  TableName.SERVICES,
  TableName.AI_DECISIONS,
  TableName.TRADING_SETTINGS,
  TableName.TRADING_STATE,
  TableName.TRADING_SNAPSHOTS,
  TableName.LEARNING_REPORTS,
  TableName.STRATEGIES,
  TableName.STRATEGY_STATE,
  TableName.USERS,
  TableName.GLOBAL_STATE,
  TableName.AUDIT_LOG,
  TableName.BROKER_CONNECTIONS,
];

const KEY_BY_TABLE: Record<string, string[]> = {
  services: ["id"],
  ai_decisions: ["id"],
  trading_settings: ["userId"],
  trading_state: ["userId"],
  trading_snapshots: ["id"],
  learning_reports: ["id"],
  strategies: ["id"],
  strategy_state: ["userId"],
  users: ["userId"],
  global_state: ["key"],
  audit_log: ["id"],
  broker_connections: ["userId"],
};

async function clearTable(name: string): Promise<number> {
  let deleted = 0;
  let lastKey: Record<string, unknown> | undefined;
  do {
    const scan = await docClient.send(
      new ScanCommand({ TableName: name, ExclusiveStartKey: lastKey, Limit: 500 })
    );
    const items = scan.Items ?? [];
    if (items.length === 0) break;
    const keyNames = KEY_BY_TABLE[name] ?? ["id"];
    for (let i = 0; i < items.length; i += 25) {
      const chunk = items.slice(i, i + 25);
      const requests = chunk.map((item) => {
        const key: Record<string, unknown> = {};
        for (const k of keyNames) key[k] = item[k];
        return { DeleteRequest: { Key: key } };
      });
      await docClient.send(
        new BatchWriteCommand({ RequestItems: { [name]: requests } })
      );
    }
    deleted += items.length;
    lastKey = scan.LastEvaluatedKey;
  } while (lastKey);
  return deleted;
}

export function registerResetCommand(
  bot: Telegraf,
  deps: { isAdmin: (userId: number) => boolean }
): void {
  bot.command("reset", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId == null) return;
    if (!deps.isAdmin(userId)) {
      await ctx.reply("Команда доступна только админу.");
      return;
    }

    const payload = ctx.payload.trim().toLowerCase();
    if (payload !== "confirm") {
      await ctx.reply(
        "⚠️ ВНИМАНИЕ: /reset удалит ВСЕ данные бота:\n" +
          "• историю сделок (learning)\n• все стратегии и отчёты\n" +
          "• настройки торговли\n• подключение брокера (нужно /connect заново)\n\n" +
          "Открытые позиции на бирже НЕ закрываются.\n\n" +
          "Для подтверждения отправьте: /reset confirm"
      );
      return;
    }

    await ctx.reply("Сбрасываю бота...");
    const results: string[] = [];
    for (const t of TABLES) {
      try {
        const n = await clearTable(t);
        results.push(`${t}: ${n}`);
      } catch (e) {
        results.push(`${t}: error ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await ctx.reply(
      "✅ Бот сброшен до заводских настроек.\n\n" +
        results.join("\n") +
        "\n\nКонтейнер перезапускается..."
    );

    // Очистка памяти: пробуем перезапустить контейнер. Если docker изнутри
    // контейнера недоступен — просто завершаем процесс, и Docker поднимет
    // контейнер заново по restart policy.
    try {
      const { spawn } = await import("node:child_process");
      const child = spawn(
        "sh",
        ["-c", "sleep 3 && docker compose restart bot >/dev/null 2>&1"],
        { detached: true, stdio: "ignore" }
      );
      child.unref();
    } catch {
      // docker недоступен — выходим через process.exit ниже
    }
    setTimeout(() => process.exit(0), 4000);
  });
}
