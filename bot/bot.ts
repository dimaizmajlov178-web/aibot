import { Telegraf } from "telegraf";
import { BrokerService } from "../broker";
import type { BotConfig } from "../core/config";
import { isAdmin } from "../core/config";
import { createCrypto } from "../core/crypto";
import {
  createDynamoDbBrokerRepository,
  createDynamoDbGlobalStateRepository,
  createDynamoDbTradingSettingsRepository,
  createDynamoDbTradingStateRepository,
  createDynamoDbTradingSnapshotRepository,
  createDynamoDbLearningReportRepository,
  createDynamoDbStrategyRepository,
  createDynamoDbStrategyStateRepository,
  createDynamoDbUserRepository,
  createDynamoDbAuditRepository,
  createInMemoryBrokerRepository,
  createInMemoryGlobalStateRepository,
  createInMemoryTradingSettingsRepository,
  createInMemoryTradingStateRepository,
  createInMemoryTradingSnapshotRepository,
  createInMemoryLearningReportRepository,
  createInMemoryStrategyRepository,
  createInMemoryStrategyStateRepository,
  createInMemoryUserRepository,
  createInMemoryAuditRepository,
} from "../db";
import { isDatabaseAvailable } from "../lib/db";
import { registerAccountHandlers } from "./account";
import { registerAdminHandlers } from "../admin";
import { formatHelp } from "./commands";
import { registerConnectHandlers } from "./connect";
import { registerControlHandlers } from "./control";
import { registerStrategyHandlers } from "./strategy";
import { START_TEXT } from "./messages";
import { createConnectSessionStore } from "./sessions";
import { attachRequestContext, getRequestContext } from "./request-context";
import { defaultLogger } from "../core/logger";
import { AuditService } from "../core/audit";
import { SubscriptionService } from "../subscriptions";
import { DeepSeekClient } from "../ai/deepseek";
import { OpenRouterClient } from "../ai/openrouter";
import {
  AiAnalysisService,
  BrokerPortfolioProvider,
  KNOWN_SYMBOLS,
  StubMarketDataProvider,
} from "../ai";
import { createDynamoDbAiDecisionRepository } from "../db/ai-decision-repository";
import { createInMemoryAiDecisionRepository } from "../db/ai-decision-repository";
import { RiskManager } from "../engine/risk-manager";
import { OrderExecutor } from "../engine/executor";
import { createInMemoryLockStore } from "../engine/lock";
import type { TradingSettingsDefaults } from "../engine/settings";
import { TradingCore } from "../engine/trading-core";
import { LearningService } from "../learning";
import { startDailyLearningScheduler } from "../learning";

export async function createBot(config: BotConfig): Promise<Telegraf> {
  const bot = new Telegraf(config.telegramToken);

  // Структурированные логи и аудит: requestId прикрепляется к каждому
  // входящему апдейту Telegram и пробрасывается в логи и audit_log.
  bot.use(async (ctx, next) => {
    attachRequestContext(ctx);
    return next();
  });

  // Персистентность: предпочитаем DynamoDB, чтобы подключения брокера,
  // подписки, настройки и состояние торговли переживали рестарт бота.
  // Если БД недоступна — фолбэк на in-memory (бота можно запускать и без
  // DynamoDB, но данные не переживают перезапуск).
  const dbAvailable = await isDatabaseAvailable().catch(() => false);
  defaultLogger.info("выбран источник данных для бота", {
    storage: dbAvailable ? "dynamodb" : "in-memory",
  });
  const chooseRepo = <T>(dbRepo: T, memoryRepo: T): T =>
    dbAvailable ? dbRepo : memoryRepo;

  const audit = new AuditService(
    chooseRepo(createDynamoDbAuditRepository(), createInMemoryAuditRepository())
  );
  const crypto = createCrypto(config.encryptionKey);
  const repository = chooseRepo(
    createDynamoDbBrokerRepository(),
    createInMemoryBrokerRepository()
  );
  const sessions = createConnectSessionStore();
  const service = new BrokerService({
    crypto,
    repository,
    brokerType: config.brokerType,
    brokerApiBaseUrl: config.brokerApiBaseUrl,
    brokerApiKeyHeader: config.brokerApiKeyHeader,
    audit,
  });

  // Подписки и админ-панель: роли admin/subscriber/guest, защита хендлеров.
  const subscriptions = new SubscriptionService({
    users: chooseRepo(
      createDynamoDbUserRepository(),
      createInMemoryUserRepository()
    ),
    global: chooseRepo(
      createDynamoDbGlobalStateRepository(),
      createInMemoryGlobalStateRepository()
    ),
    adminIds: config.adminTelegramIds,
  });

  // Публичные команды, доступные без активной подписки. Админ-команды
  // проверяют ADMIN_TELEGRAM_IDS в своих хендлерах.
  const PUBLIC_COMMANDS = new Set([
    "start",
    "help",
    "cancel",
    "admin",
    "grant",
    "revoke",
    "users",
    "broadcast",
    "global_pause",
  ]);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    const { requestId, logger } = getRequestContext(ctx);
    if (userId == null) {
      return next();
    }

    // Админам не нужна подписка — пропускаем.
    if (subscriptions.isAdmin(userId)) {
      return next();
    }

    await subscriptions.touch(userId, ctx.from?.username ?? null);

    const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    if (text.startsWith("/")) {
      const command = text.split(/\s+/)[0]!.slice(1).toLowerCase();
      if (PUBLIC_COMMANDS.has(command)) {
        return next();
      }
    }

    // Защищённый хендлер: без активной подписки доступ закрыт.
    if (!(await subscriptions.hasActiveSubscription(userId))) {
      logger.warn("доступ запрещён: подписка не активна", {
        userId,
        requestId,
        text: text.slice(0, 120) || undefined,
      });
      await ctx.reply(
        "Доступ по подписке: подписка не активна. Обратитесь к администратору."
      );
      return;
    }

    return next();
  });

  registerConnectHandlers(bot, { service, sessions });
  registerAccountHandlers(bot, { service });
  registerAdminHandlers(bot, {
    subscriptions,
    isAdmin: (userId) => subscriptions.isAdmin(userId),
    audit,
  });

  // Торговое ядро и риск-контроль.
  const deepseek = new DeepSeekClient({
    apiKey: config.deepSeekApiKey,
    baseUrl: config.deepSeekBaseUrl,
    chatModel: config.deepSeekChatModel,
    reasonerModel: config.deepSeekReasonerModel,
  });
  // Fallback AI-провайдер OpenRouter. Если OPENROUTER_API_KEY не задан —
  // работает только DeepSeek, как раньше.
  const openrouter = config.openRouterApiKey
    ? new OpenRouterClient({
        apiKey: config.openRouterApiKey,
        model: config.openRouterModel,
      })
    : undefined;
  const marketData = new StubMarketDataProvider();
  const portfolio = new BrokerPortfolioProvider({
    getBroker: (userId) => service.getBrokerForUser(userId),
  });
  const ai = new AiAnalysisService({
    marketData,
    deepseek,
    openrouter,
    portfolio,
    repository: chooseRepo(
      createDynamoDbAiDecisionRepository(),
      createInMemoryAiDecisionRepository()
    ),
  });

  // Дефолтные значения настроек торговли из .env (DEFAULT_RISK_PER_TRADE,
  // MAX_POSITIONS, DAILY_DRAWDOWN_LIMIT, TOTAL_DRAWDOWN_LIMIT).
  const riskDefaults: TradingSettingsDefaults = {
    riskPerTradePercent: config.defaultRiskPerTrade,
    maxPositions: config.maxPositions,
    maxDailyDrawdownPercent: config.dailyDrawdownLimit,
    maxTotalDrawdownPercent: config.totalDrawdownLimit,
  };

  const riskManager = new RiskManager({
    settings: chooseRepo(
      createDynamoDbTradingSettingsRepository(),
      createInMemoryTradingSettingsRepository()
    ),
    state: chooseRepo(
      createDynamoDbTradingStateRepository(),
      createInMemoryTradingStateRepository()
    ),
    audit,
    defaults: riskDefaults,
  });

  // Самообучение: датасет сделок, learning-отчёты, версии стратегий.
  const learning = new LearningService({
    snapshots: chooseRepo(
      createDynamoDbTradingSnapshotRepository(),
      createInMemoryTradingSnapshotRepository()
    ),
    reports: chooseRepo(
      createDynamoDbLearningReportRepository(),
      createInMemoryLearningReportRepository()
    ),
    strategies: chooseRepo(
      createDynamoDbStrategyRepository(),
      createInMemoryStrategyRepository()
    ),
    state: chooseRepo(
      createDynamoDbStrategyStateRepository(),
      createInMemoryStrategyStateRepository()
    ),
    deepseek,
  });

  const core = new TradingCore({
    riskManager,
    executor: new OrderExecutor(),
    lockStore: createInMemoryLockStore(),
    ai,
    marketData,
    learning,
    audit,
    resolveBroker: (userId) => service.getBrokerForUser(userId),
    resolveUserIds: () => service.listUserIds(),
    supportedSymbols: KNOWN_SYMBOLS,
    decisionIntervalMs: config.decisionIntervalMs,
    isGlobalPaused: () => subscriptions.isGlobalPaused(),
    notifyAdmin: (userId, message) => {
      defaultLogger.warn("уведомление админа", { userId, message });
    },
    onEvent: (event) => {
      // Все шаги торгового цикла (сбор данных и запрос AI, сигнал, hold,
      // risk_block, trade_open/close, dup_skip, паузы, ошибки) пишутся в лог,
      // чтобы поведение цикла было видимым и диагностируемым.
      const logger = defaultLogger.child({
        service: "engine",
        userId: event.userId,
        requestId: event.requestId,
      });
      const fields: Record<string, unknown> = {
        eventType: event.type,
        symbol: event.symbol,
        at: event.at,
        data: event.data,
      };
      if (event.type === "error" || event.type === "admin_notify") {
        logger.warn(`[engine] ${event.type}: ${event.message}`, fields);
      } else {
        logger.info(`[engine] ${event.type}: ${event.message}`, fields);
      }
    },
  });

  registerControlHandlers(bot, {
    riskManager,
    isConnected: (userId) => service.isConnected(userId),
    resolveBroker: (userId) => service.getBrokerForUser(userId),
  });

  registerStrategyHandlers(bot, {
    learning,
    isAdmin: (userId) => isAdmin(config, userId),
    audit,
  });

  bot.command("start", (ctx) => ctx.reply(START_TEXT));
  bot.command("help", (ctx) =>
    ctx.reply(
      formatHelp(ctx.from?.id != null && subscriptions.isAdmin(ctx.from.id))
    )
  );

  if (!config.dryRun) {
    core.start();
    const userIds = await service.listUserIds().catch(() => [] as number[]);
    defaultLogger
      .child({ service: "engine" })
      .info("торговый цикл запущен: первый анализ стартует немедленно", {
        decisionIntervalMs: config.decisionIntervalMs,
        users: userIds.length,
        symbols: [...KNOWN_SYMBOLS],
      });
    startDailyLearningScheduler({
      learning,
      onError: (userId, error) => {
        console.warn(
          `[learning] ошибка суточного отчёта (user ${userId}): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      },
    });
  }

  return bot;
}
