import { adminModule } from "../admin";
import { aiModule } from "../ai";
import { brokerModule } from "../broker";
import { dbModule } from "../db";
import { engineModule } from "../engine";
import { loadConfig } from "../core/config";
import { describeModules } from "../core/modules";
import { defaultLogger } from "../core/logger";
import { learningModule } from "../learning";
import { subscriptionsModule } from "../subscriptions";
import { createBot } from "./bot";
import { setupCommandsMenu } from "./commands";

const modules = [
  brokerModule,
  aiModule,
  engineModule,
  learningModule,
  subscriptionsModule,
  adminModule,
  dbModule,
] as const;

const logger = defaultLogger.child({ service: "bot" });

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info(`[bot] модули: ${describeModules(modules)}`, {
    environment: config.environment,
    brokerType: config.brokerType,
    dryRun: config.dryRun,
  });

  if (config.dryRun) {
    logger.warn("BOT_DRY_RUN=true: запуск без подключения к Telegram");
    return;
  }

  const bot = createBot(config);

  await bot.telegram.getMe();
  await setupCommandsMenu(bot, config.adminTelegramIds);
  logger.info("бот запущен и подключён к Telegram");

  bot.launch().catch((error) => {
    logger.error("[bot] ошибка запуска:", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}

main().catch((error) => {
  logger.error("[bot] ошибка запуска:", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
