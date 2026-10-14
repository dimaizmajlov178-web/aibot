export type PositionSide = "long" | "short";

export interface BrokerAccount {
  balance: number;
  equity: number;
  availableCash: number;
  currency: string;
  openPositions: number;
  dailyPnl: number;
  dailyPnlPercent: number;
  totalPnl: number;
  totalPnlPercent: number;
}

export interface OpenPosition {
  symbol: string;
  side: PositionSide;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  openedAt: string;
}

export interface ClosedTrade {
  symbol: string;
  side: PositionSide;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  rMultiple: number;
  openedAt: string;
  closedAt: string;
}

export interface BrokerStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winrate: number;
  profitFactor: number;
  averageR: number;
  maxDrawdownPercent: number;
}

export type OrderAction = "open" | "close";

export interface OrderRequest {
  symbol: string;
  side: PositionSide;
  action: OrderAction;
  quantity: number;
  price?: number;
}

export interface OrderReceipt {
  orderId: string;
  symbol: string;
  side: PositionSide;
  action: OrderAction;
  quantity: number;
  executedPrice: number;
  status: "filled";
  executedAt: string;
}

export abstract class BaseBroker {
  abstract readonly name: string;

  /**
   * Тестовый вызов счёта: проверяет подключение и возвращает баланс.
   * Бросает Error, если API-ключ невалиден.
   */
  abstract testConnection(): Promise<BrokerAccount>;

  abstract getAccount(): Promise<BrokerAccount>;

  abstract getPositions(): Promise<OpenPosition[]>;

  abstract getClosedTrades(limit?: number): Promise<ClosedTrade[]>;

  abstract getStats(): Promise<BrokerStats>;

  /**
   * Исполняет торговый ордер (открытие/закрытие позиции). Может бросить
   * Error при отказе брокера (например, недостаточно маржи) — вызывающий
   * код обрабатывает ошибку и делает ретрай.
   */
  abstract executeOrder(order: OrderRequest): Promise<OrderReceipt>;
}

export class BrokerConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerConnectionError";
  }
}
