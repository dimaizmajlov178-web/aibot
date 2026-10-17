import type { Telegraf } from "telegraf";

interface BotCommandDescriptor {
  name: string;
  description: string;
  /** Команда доступна только админам из ADMIN_TELEGRAM_IDS. */
  adminOnly?: boolean;
}

export type { BotCommandDescriptor as BotCommand };

export const COMMANDS: readonly BotCommandDescriptor[] = [
  { name: "start", description: "Приветствие и краткая инструкция" },
  { name: "help", description: "Список доступных команд" },
  { name: "connect", description: "Привязать API-ключ брокера" },
  { name: "disconnect", description: "Отключить брокера и удалить ключ" },
  { name: "status", description: "Баланс, позиции, дневной и общий P&L" },
  { name: "positions", description: "Открытые и последние закрытые сделки" },
  { name: "stats", description: "Винрейт, профит-фактор, средний R, просадка" },
  { name: "pause", description: "Приостановить автоторговлю" },
  { name: "resume", description: "Возобновить автоторговлю" },
  {
    name: "settings",
    description: "Настройки: риск, стоп-лосс, RR, позиции, символы, режим AI",
  },
  { name: "learning", description: "Суточный learning-отчёт по сделки" },
  {
    name: "strategy",
    description: "Версии стратегии, метрики и статус A/B теста",
  },
  {
    name: "strategy_ab",
    description: "Запустить A/B тест версии (админ)",
    adminOnly: true,
  },
  {
    name: "strategy_ab_stop",
    description: "Остановить A/B тест и показать сравнение (админ)",
    adminOnly: true,
  },
  {
    name: "strategy_rollback",
    description: "Откатить стратегию на версию (админ)",
    adminOnly: true,
  },
  { name: "cancel", description: "Отменить текущее действие" },
];

export const ADMIN_COMMANDS: readonly BotCommandDescriptor[] = [
  { name: "admin", description: "Админ-панель: меню команд", adminOnly: true },
  {
    name: "grant",
    description: "Выдать подписку: /grant <user_id> [дней]",
    adminOnly: true,
  },
  {
    name: "revoke",
    description: "Отозвать подписку: /revoke <user_id>",
    adminOnly: true,
  },
  {
    name: "users",
    description: "Список пользователей и подписок",
    adminOnly: true,
  },
  {
    name: "broadcast",
    description: "Рассылка всем: /broadcast <текст>",
    adminOnly: true,
  },
  {
    name: "global_pause",
    description: "Глобальная пауза торговли у всех",
    adminOnly: true,
  },
];

export function formatHelp(isAdmin: boolean): string {
  const lines = COMMANDS.map(
    (command) => `/${command.name} — ${command.description}`
  );
  if (isAdmin) {
    lines.push(
      "",
      "Админ:",
      ...ADMIN_COMMANDS.map(
        (command) => `/${command.name} — ${command.description}`
      )
    );
  }
  return ["Доступные команды:", "", ...lines].join("\n");
}

// Команды для меню «Меню» у поля ввода (setMyCommands). Общий список для всех
// пользователей и дополнительные админ-команды, видимые только админам.
export const MENU_COMMANDS: readonly BotCommandDescriptor[] = [
  { name: "start", description: "Приветствие и краткая инструкция" },
  { name: "help", description: "Список доступных команд" },
  { name: "connect", description: "Привязать API-ключ брокера" },
  { name: "disconnect", description: "Отключить брокера и удалить ключ" },
  { name: "status", description: "Баланс, позиции, P&L за день и всего" },
  { name: "positions", description: "Открытые и закрытые сделки" },
  { name: "stats", description: "Винрейт, профит-фактор, просадка" },
  { name: "pause", description: "Приостановить автоторговлю" },
  { name: "resume", description: "Возобновить автоторговлю" },
  { name: "settings", description: "Настройки риска и режима AI" },
  { name: "learning", description: "Суточный learning-отчёт по сделкам" },
  { name: "strategy", description: "Версии стратегии и метрики" },
  { name: "strategy_ab", description: "Запустить A/B тест версии стратегии" },
];

export const ADMIN_MENU_COMMANDS: readonly BotCommandDescriptor[] = [
  { name: "admin", description: "Админ-панель: меню команд" },
  { name: "grant", description: "Выдать подписку: /grant <user_id> [дней]" },
  { name: "revoke", description: "Отозвать подписку: /revoke <user_id>" },
  { name: "users", description: "Список пользователей и подписок" },
  { name: "broadcast", description: "Рассылка всем: /broadcast <текст>" },
  { name: "global_pause", description: "Глобальная пауза торговли у всех" },
];

function toTelegramCommand(descriptor: BotCommandDescriptor): {
  command: string;
  description: string;
} {
  return { command: descriptor.name, description: descriptor.description };
}

/** Устанавливает меню команд: общий список + админ-команды для ADMIN_TELEGRAM_IDS. */
export async function setupCommandsMenu(
  bot: Pick<Telegraf, "telegram">,
  adminTelegramIds: readonly number[]
): Promise<void> {
  const common = MENU_COMMANDS.map(toTelegramCommand);
  const adminOnly = ADMIN_MENU_COMMANDS.map(toTelegramCommand);

  await bot.telegram.setMyCommands(common);

  for (const adminId of adminTelegramIds) {
    await bot.telegram.setMyCommands([...common, ...adminOnly], {
      scope: { type: "chat", chat_id: adminId },
    });
  }
}
