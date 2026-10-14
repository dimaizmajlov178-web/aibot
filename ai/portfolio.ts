import type { BrokerAccount, OpenPosition } from "../broker/base";
import type { PositionContext, PortfolioContext } from "./types";
import { AiAnalysisError } from "./errors";

export interface PortfolioProvider {
  getPortfolio(userId: number): Promise<PortfolioContext>;
}

const DEFAULT_RISK_PER_TRADE_PERCENT = 1;
const DEFAULT_MAX_POSITIONS = 5;

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

export function portfolioFromAccount(
  account: BrokerAccount,
  positions: OpenPosition[]
): PortfolioContext {
  return {
    balance: account.balance,
    equity: account.equity,
    availableCash: account.availableCash,
    currency: account.currency,
    dailyPnl: account.dailyPnl,
    totalPnl: account.totalPnl,
    positions: positions.map(toPositionContext),
    riskPerTradePercent: DEFAULT_RISK_PER_TRADE_PERCENT,
    maxPositions: Math.max(1, DEFAULT_MAX_POSITIONS),
  };
}

export interface BrokerPortfolioProviderDeps {
  getBroker: (userId: number) => Promise<{
    getAccount(): Promise<BrokerAccount>;
    getPositions(): Promise<OpenPosition[]>;
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

    const [account, positions] = await Promise.all([
      broker.getAccount(),
      broker.getPositions(),
    ]);
    return portfolioFromAccount(account, positions);
  }
}
