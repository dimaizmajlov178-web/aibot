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
    description: "Настройки риска, позиций, символов и режима AI",
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
