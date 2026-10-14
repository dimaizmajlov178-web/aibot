import "dotenv/config";

export interface BotConfig {
  telegramToken: string;
  dryRun: boolean;
  environment: string;
  encryptionKey: string;
  brokerType: string;
  deepSeekApiKey: string;
  deepSeekBaseUrl: string;
  deepSeekChatModel: string;
  deepSeekReasonerModel: string;
  /** Telegram-user_id администраторов (из ADMIN_TELEGRAM_IDS). */
  adminTelegramIds: number[];
  /** URL базы данных (из DATABASE_URL, фолбэк DOCUMENT_API_ENDPOINT). */
  databaseUrl: string;
  /** URL Redis для распределённых блокировок (REDIS_URL). */
  redisUrl: string;
  /** Базовый URL API брокера (BROKER_API_BASE_URL). */
  brokerApiBaseUrl: string;
  /** HTTP-заголовок для API-ключа брокера (BROKER_API_KEY_HEADER). */
  brokerApiKeyHeader: string;
  /** Дефолтный % баланса на сделку из .env. */
  defaultRiskPerTrade: number;
  /** Дефолтный максимум одновременных позиций из .env. */
  maxPositions: number;
  /** Дефолтный лимит дневной просадки из .env (%). */
  dailyDrawdownLimit: number;
  /** Дефолтный лимит общей просадки из .env (%). */
  totalDrawdownLimit: number;
}

function parseAdminIds(raw: string | undefined): number[] {
  if (!raw) {
    return [];
  }
  const ids: number[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const id = Number(trimmed);
    if (Number.isInteger(id) && id > 0) {
      ids.push(id);
    }
  }
  return ids;
}

function parseNumber(
  raw: string | undefined,
  fallback: number,
  options: { min?: number; max?: number } = {}
): number {
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const min = options.min ?? -Infinity;
  const max = options.max ?? Infinity;
  if (value < min || value > max) {
    return fallback;
  }
  return value;
}

export function isAdmin(config: BotConfig, userId: number): boolean {
  return config.adminTelegramIds.includes(userId);
}

export function loadConfig(): BotConfig {
  const dryRun = process.env.BOT_DRY_RUN === "true";
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const encryptionKey = process.env.ENCRYPTION_KEY ?? "";
  const brokerType = process.env.BROKER_TYPE ?? "stub";

  if (!dryRun && !telegramToken) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN не задан. Укажите токен бота в переменной окружения TELEGRAM_BOT_TOKEN или запустите с BOT_DRY_RUN=true"
    );
  }

  return {
    telegramToken,
    dryRun,
    environment: process.env.NODE_ENV ?? "development",
    encryptionKey,
    brokerType,
    deepSeekApiKey: process.env.DEEPSEEK_API_KEY ?? "",
    deepSeekBaseUrl:
      process.env.DEEPSEEK_API_BASE_URL ?? "https://api.deepseek.com",
    deepSeekChatModel: process.env.DEEPSEEK_CHAT_MODEL ?? "deepseek-chat",
    deepSeekReasonerModel:
      process.env.DEEPSEEK_REASONER_MODEL ?? "deepseek-reasoner",
    adminTelegramIds: parseAdminIds(process.env.ADMIN_TELEGRAM_IDS),
    databaseUrl:
      process.env.DATABASE_URL ?? process.env.DOCUMENT_API_ENDPOINT ?? "",
    redisUrl: process.env.REDIS_URL ?? "",
    brokerApiBaseUrl: process.env.BROKER_API_BASE_URL ?? "",
    brokerApiKeyHeader: process.env.BROKER_API_KEY_HEADER ?? "",
    defaultRiskPerTrade: parseNumber(process.env.DEFAULT_RISK_PER_TRADE, 1, {
      min: 0.1,
      max: 50,
    }),
    maxPositions: parseNumber(process.env.MAX_POSITIONS, 3, {
      min: 1,
      max: 100,
    }),
    dailyDrawdownLimit: parseNumber(process.env.DAILY_DRAWDOWN_LIMIT, 3, {
      min: 0.1,
      max: 100,
    }),
    totalDrawdownLimit: parseNumber(process.env.TOTAL_DRAWDOWN_LIMIT, 10, {
      min: 0.1,
      max: 100,
    }),
  };
}
