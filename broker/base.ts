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
  /** Нереализованный P&L позиции; null — если брокер не смог его вычислить. */
  unrealizedPnl: number | null;
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
  /**
   * Стоп-лосс в абсолютной цене (для long — ниже цены входа, для short —
   * выше). Отправляется брокеру вместе с ордером на открытие как
   * stopTriggerPrice, чтобы защитный ордер висел на бирже независимо от
   * работы бота.
   */
  stopTriggerPrice?: number;
  /**
   * Тейк-профит в абсолютной цене (для long — выше цены входа, для short —
   * ниже). Отправляется брокеру как takeTriggerPrice в том же POST /orders.
   */
  takeTriggerPrice?: number;
  /**
   * Размер стоп-лосса в процентах от цены входа (например 1 -> стоп 1%).
   * Задаётся в /settings stop_loss=<%> и используется брокером для расчёта
   * абсолютных stopTriggerPrice/takeTriggerPrice от реальной цены исполнения,
   * а также для ограничения плеча: стоп не должен оказываться за ценой
   * ликвидации позиции, иначе биржа не размещает защитные ордера.
   */
  stopLossPercent?: number;
  /**
   * Целевое соотношение риска к прибыли (RR) для тейк-профита из /settings.
   * Тейк = вход ± (RR × стоп).
   */
  riskRewardRatio?: number;
  /**
   * Риск на сделку в процентах от баланса из /settings (risk_per_trade).
   * Используется брокером для расчёта рекомендуемого плеча.
   */
  riskPerTradePercent?: number;
}

/** Открытый (висящий на бирже) ордер брокера — в т.ч. защитные стоп/тейк. */
export interface BrokerOpenOrder {
  id: string;
  symbol: string;
  /** Тип ордера: market / stop / take / limit и т.п. */
  type: string;
  /** Статус на бирже: active / executed / canceled / rejected. */
  status: string;
  side?: PositionSide;
  triggerPrice?: number;
  price?: number;
  amount?: number;
  filledAmount?: number;
  leverage?: number;
  errorCode?: string | null;
  createdAt?: string;
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
  /**
   * Открытые защитные ордера (стоп-лосс / тейк-профит), размещённые на бирже
   * вместе с ордером на открытие. Пустой массив — защитные ордера не
   * размещались (закрытие позиции) или брокер их не возвращает.
   */
  protectiveOrders?: BrokerOpenOrder[];
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

  /**
   * Активные (висящие на бирже) ордера счёта, включая защитные стоп/тейк.
   * Используется для диагностики: статусы защитных ордеров, зависимость от
   * работы бота отсутствует. По умолчанию возвращает пустой список — брокеры,
   * не поддерживающие запрос открытых ордеров, могут оставить реализацию.
   */
  async getOpenOrders(): Promise<BrokerOpenOrder[]> {
    return [];
  }
}

export class BrokerConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerConnectionError";
  }
}
