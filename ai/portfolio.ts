import type { BrokerAccount, ClosedTrade, OpenPosition } from "../broker/base";
import type { PositionContext, PortfolioContext } from "./types";
import { AiAnalysisError } from "./errors";

/**
 * Средняя продолжительность сделки в часах по закрытым сделкам. Считается
 * только по сделкам с валидными датами открытия/закрытия (длительность > 0
 * и не «вечная» — отсекаем аномалии в 0 и > 365 дней). Используется AI для
 * ориентира по времени удержания позиции.
 */
export function averageHoldingTimeHours(
  closedTrades: readonly ClosedTrade[]
): number | null {
  const durations: number[] = [];
  for (const trade of closedTrades) {
    const opened = Date.parse(trade.openedAt);
    const closed = Date.parse(trade.closedAt);
    if (!Number.isFinite(opened) || !Number.isFinite(closed)) {
      continue;
    }
    const hours = (closed - opened) / 3_600_000;
    if (hours > 0 && hours <= 24 * 365) {
      durations.push(hours);
    }
  }
  if (durations.length === 0) {
    return null;
  }
  const avg =
    durations.reduce((sum, value) => sum + value, 0) / durations.length;
  return Math.round(avg * 100) / 100;
}

function toPositionContext(position: OpenPosition): PositionContext {
  return {
    symbol: position.symbol,
    side: position.side,
    quantity: position.quantity,
    entryPrice: position.entryPrice,
    currentPrice: position.currentPrice,
    unrealizedPnl: position.unrealizedPnl,
  };
}

export interface PortfolioProvider {
  getPortfolio(userId: number): Promise<PortfolioContext>;
}

export interface PortfolioAccountOptions {
  /** Риск (стоп-лосс) в процентах от цены входа. */
  stopLossPercent?: number;
  /** Целевое соотношение риска к прибыли (RR) для тейк-профита. */
  riskRewardRatio?: number;
  /** Максимум одновременных открытых позиций. */
  maxPositions?: number;
  /**
   * Закрытые сделки для расчёта средней длительности сделки. Если не
   * переданы — avgHoldingTimeHours = null.
   */
  closedTrades?: readonly ClosedTrade[];
}

export function portfolioFromAccount(
  account: BrokerAccount,
  positions: OpenPosition[],
  options: PortfolioAccountOptions = {}
): PortfolioContext {
  return {
    balance: account.balance,
    equity: account.equity,
    availableCash: account.availableCash,
    currency: account.currency,
    dailyPnl: account.dailyPnl,
    totalPnl: account.totalPnl,
    positions: positions.map(toPositionContext),
    riskPerTradePercent: options.stopLossPercent ?? 1,
    stopLossPercent: options.stopLossPercent ?? 1,
    riskRewardRatio: options.riskRewardRatio ?? 2,
    maxPositions: Math.max(1, options.maxPositions ?? 5),
    avgHoldingTimeHours: averageHoldingTimeHours(options.closedTrades ?? []),
  };
}

export interface BrokerPortfolioProviderDeps {
  getBroker: (userId: number) => Promise<{
    getAccount(): Promise<BrokerAccount>;
    getPositions(): Promise<OpenPosition[]>;
    getClosedTrades?(limit?: number): Promise<ClosedTrade[]>;
  } | null>;
  /**
   * Дополнительные данные из настроек пользователя (стоп-лосс % и RR).
   * Может вернуть null/undefined — тогда используются дефолтные значения.
   */
  getSettings?: (userId: number) => Promise<{
    stopLossPercent?: number;
    riskRewardRatio?: number;
    maxPositions?: number;
  } | null>;
}

/**
 * Собирает состояние портфеля через брокерский клиент пользователя.
 */
export class BrokerPortfolioProvider implements PortfolioProvider {
  constructor(private readonly deps: BrokerPortfolioProviderDeps) {}

  async getPortfolio(userId: number): Promise<PortfolioContext> {
    const broker = await this.deps.getBroker(userId);
    if (!broker) {
      throw new AiAnalysisError(
        `Нет подключённого брокера для user_id=${userId}: невозможно собрать состояние портфеля`
      );
    }

    const [account, positions, settings, closedTrades] = await Promise.all([
      broker.getAccount(),
      broker.getPositions(),
      this.deps.getSettings
        ? this.deps.getSettings(userId).catch(() => null)
        : Promise.resolve(null),
      broker.getClosedTrades
        ? broker.getClosedTrades(50).catch(() => [])
        : Promise.resolve([]),
    ]);
    return portfolioFromAccount(account, positions, {
      stopLossPercent: settings?.stopLossPercent,
      riskRewardRatio: settings?.riskRewardRatio,
      maxPositions: settings?.maxPositions,
      closedTrades,
    });
  }
}
