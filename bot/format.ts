import type {
  BrokerAccount,
  BrokerStats,
  ClosedTrade,
  ConnectResult,
  OpenPosition,
} from "../broker";
import type { TradingSettings, TradingState } from "../engine/types";

const money = (value: number): string =>
  value.toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const signedMoney = (value: number): string =>
  value >= 0 ? `+${money(value)}` : money(value);

const percent = (value: number): string => `${money(value)}%`;

const signedPercent = (value: number): string =>
  value >= 0 ? `+${money(value)}%` : `${money(value)}%`;

export function maskApiKey(apiKey: string): string {
  const first = apiKey.slice(0, 4);
  const last = apiKey.slice(-4);
  return `${first}••••${last}`;
}

export function formatConnectResult(
  result: ConnectResult,
  apiKey: string
): string {
  return [
    "Брокер подключён.",
    `Тип: ${result.brokerName}`,
    "Тестовый вызов balance: успешно",
    `Баланс: ${money(result.account.balance)} ${result.account.currency}`,
    `Ключ: ${maskApiKey(apiKey)} — хранится только в зашифрованном виде.`,
    "",
    "Смотрю счёт: /status, сделки: /positions, статистику: /stats",
  ].join("\n");
}

export function formatBrokerAlreadyConnected(): string {
  return "Брокер уже подключён. Отключить: /disconnect";
}

export function formatConnectPrompt(): string {
  return [
    "Привязка брокера, шаг 1/2.",
    "Отправьте API-ключ брокера.",
    "Отмена: /cancel",
  ].join("\n");
}

export function formatConnectError(message: string): string {
  return `Ошибка: ${message}. Отправьте ключ ещё раз или /cancel.`;
}

export function formatNotConnected(entity: string): string {
  return `Брокер не подключён. Сначала привяжите ключ через /connect. (${entity})`;
}

export function formatAccount(account: BrokerAccount): string {
  return [
    "Счёт",
    `Баланс: ${money(account.balance)} ${account.currency}`,
    `Свободно: ${money(account.availableCash)} ${account.currency}`,
    `Открытых позиций: ${account.openPositions}`,
    `P&L за день: ${signedMoney(account.dailyPnl)} (${signedPercent(account.dailyPnlPercent)})`,
    `P&L общий: ${signedMoney(account.totalPnl)} (${signedPercent(account.totalPnlPercent)})`,
  ].join("\n");
}

function formatPositionLine(position: OpenPosition, currency: string): string {
  const side = position.side === "long" ? "long" : "short";
  return `${position.symbol} ${side} ${position.quantity} — вход ${money(position.entryPrice)}, сейчас ${money(position.currentPrice)} → ${signedMoney(position.unrealizedPnl)} ${currency}`;
}

function formatClosedTradeLine(trade: ClosedTrade, currency: string): string {
  const side = trade.side === "long" ? "long" : "short";
  const date = trade.closedAt.slice(0, 10);
  return `${trade.symbol} ${side} ${date} — ${signedMoney(trade.pnl)} ${currency}, R=${trade.rMultiple}`;
}

export function formatPositions(
  open: OpenPosition[],
  closed: ClosedTrade[],
  currency: string
): string {
  const lines: string[] = ["Открытые позиции:"];
  if (open.length === 0) {
    lines.push("нет");
  } else {
    for (const position of open) {
      lines.push(formatPositionLine(position, currency));
    }
  }

  lines.push("", "Последние закрытые:");
  if (closed.length === 0) {
    lines.push("нет");
  } else {
    for (const trade of closed) {
      lines.push(formatClosedTradeLine(trade, currency));
    }
  }

  return lines.join("\n");
}

export function formatStats(stats: BrokerStats): string {
  return [
    "Статистика",
    `Сделок: ${stats.totalTrades} (${stats.wins} прибыльных / ${stats.losses} убыточных)`,
    `Винрейт: ${percent(stats.winrate)}`,
    `Профит-фактор: ${stats.profitFactor === 99 ? "∞" : stats.profitFactor}`,
    `Средний R: ${money(stats.averageR)}`,
    `Максимальная просадка: ${percent(stats.maxDrawdownPercent)}`,
  ].join("\n");
}

export function formatSettings(settings: TradingSettings): string {
  const symbols =
    settings.symbols.length > 0 ? settings.symbols.join(", ") : "все";
  return [
    "Настройки торговли",
    `Риск на сделку: ${money(settings.riskPerTradePercent)}%`,
    `Максимум позиций: ${settings.maxPositions}`,
    `Лимит сделок в день: ${settings.dailyTradeLimit}`,
    `Дневная просадка (лимит): ${money(settings.maxDailyDrawdownPercent)}%`,
    `Общая просадка (лимит): ${money(settings.maxTotalDrawdownPercent)}%`,
    `Символы: ${symbols}`,
    `Режим AI: ${settings.aiMode}`,
    "",
    "Изменить: /settings risk=1 max_positions=5 symbols=BTC/USDT,ETH/USDT ai_mode=aggressive",
  ].join("\n");
}

export function formatTradingState(
  state: TradingState,
  settings: TradingSettings
): string {
  const lines = ["Состояние торговли"];
  lines.push(state.paused ? "Пауза: да (/resume)" : "Пауза: нет");
  if (state.autoDailyPaused) {
    lines.push("Автопауза по дневной просадке: да (до следующего дня)");
  }
  if (state.totalStopTriggered) {
    lines.push("Автостоп по общей просадке: да");
  }
  lines.push(
    `Сделок сегодня: ${state.tradesToday} / ${settings.dailyTradeLimit}`
  );
  lines.push(`Режим AI: ${settings.aiMode}`);
  return lines.join("\n");
}

export function formatSettingsApplied(settings: TradingSettings): string {
  return `Настройки сохранены.\n\n${formatSettings(settings)}`;
}

export function formatNotConfigured(): string {
  return "Брокер не подключён или торговля не инициализирована.";
}
