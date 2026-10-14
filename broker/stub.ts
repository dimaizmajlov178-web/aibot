import { BaseBroker } from "./base";
import {
  BrokerConnectionError,
  type BrokerAccount,
  type BrokerStats,
  type ClosedTrade,
  type OpenPosition,
  type OrderReceipt,
  type OrderRequest,
  type PositionSide,
} from "./base";

interface SymbolMeta {
  symbol: string;
  basePrice: number;
  crypto: boolean;
}

const SYMBOLS: readonly SymbolMeta[] = [
  { symbol: "BTC/USDT", basePrice: 62_000, crypto: true },
  { symbol: "ETH/USDT", basePrice: 3_200, crypto: true },
  { symbol: "SOL/USDT", basePrice: 150, crypto: true },
  { symbol: "BNB/USDT", basePrice: 580, crypto: true },
  { symbol: "AAPL", basePrice: 210, crypto: false },
  { symbol: "TSLA", basePrice: 240, crypto: false },
  { symbol: "SBER", basePrice: 280, crypto: false },
  { symbol: "NVDA", basePrice: 900, crypto: false },
];

const WIN_RATE = 0.55;
const MIN_TRADE_LENGTH = 8;

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function shift(xs: readonly SymbolMeta[], rng: () => number): SymbolMeta[] {
  const result = [...xs];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function positionPnl(
  side: PositionSide,
  quantity: number,
  entryPrice: number,
  currentPrice: number
): number {
  const diff =
    side === "long" ? currentPrice - entryPrice : entryPrice - currentPrice;
  return round2(diff * quantity);
}

export class StubBroker extends BaseBroker {
  readonly name = "stub";

  constructor(private readonly apiKey: string) {
    super();
  }

  async testConnection(): Promise<BrokerAccount> {
    if (!this.apiKey || this.apiKey.trim().length < MIN_TRADE_LENGTH) {
      throw new BrokerConnectionError(
        "Не удалось подключиться к брокеру: API-ключ отклонён"
      );
    }
    return this.getAccount();
  }

  async getAccount(): Promise<BrokerAccount> {
    const rng = mulberry32(hashString(`${this.apiKey}:account`));
    const balance = round2(10_000 + rng() * 40_000);

    const dailySign = rng() < 0.6 ? 1 : -1;
    const dailyPnl = round2(dailySign * balance * (0.004 + rng() * 0.02));
    const dailyPnlPercent = round2((dailyPnl / balance) * 100);

    const totalSign = rng() < 0.65 ? 1 : -1;
    const totalPnl = round2(totalSign * balance * (0.05 + rng() * 0.15));
    const totalPnlPercent = round2((totalPnl / balance) * 100);

    const equity = round2(balance + totalPnl);
    const availableCash = round2(equity * (0.55 + rng() * 0.35));

    return {
      balance,
      equity,
      availableCash,
      currency: "USD",
      openPositions: (await this.getPositions()).length,
      dailyPnl,
      dailyPnlPercent,
      totalPnl,
      totalPnlPercent,
    };
  }

  async getPositions(): Promise<OpenPosition[]> {
    const rng = mulberry32(hashString(`${this.apiKey}:positions`));
    const count = 2 + Math.floor(rng() * 3);
    const symbols = shift(SYMBOLS, rng).slice(0, count);

    const now = Date.now();
    return symbols.map(({ symbol, basePrice, crypto }) => {
      const side: PositionSide = rng() < 0.5 ? "long" : "short";
      const drift = (rng() - 0.5) * 0.06;
      const currentPrice = round2(basePrice * (1 + rng() * 0.02));
      const entryPrice = round2(currentPrice / (1 + drift));
      const quantity = crypto
        ? round2(0.5 + rng() * 2.5)
        : Math.max(1, Math.round(3 + rng() * 25));
      const openedAt = new Date(
        now - Math.floor(rng() * 96) * 3_600_000
      ).toISOString();

      return {
        symbol,
        side,
        quantity,
        entryPrice,
        currentPrice,
        unrealizedPnl: positionPnl(side, quantity, entryPrice, currentPrice),
        openedAt,
      };
    });
  }

  async getClosedTrades(limit = 10): Promise<ClosedTrade[]> {
    const rng = mulberry32(hashString(`${this.apiKey}:trades`));
    const tradeCount = 8 + Math.floor(rng() * 8);
    const riskUnit = round2((await this.getAccount()).balance * 0.01);

    const trades: ClosedTrade[] = [];
    const now = Date.now();
    for (let i = 0; i < tradeCount; i++) {
      const { symbol, basePrice, crypto } =
        SYMBOLS[Math.floor(rng() * SYMBOLS.length)];
      const side: PositionSide = rng() < 0.5 ? "long" : "short";
      const win = rng() < WIN_RATE;
      const rMultiple = round2(win ? 0.5 + rng() * 2.5 : -(0.5 + rng() * 1.5));
      const pnlBase = round2(rMultiple * riskUnit);
      const quantity = crypto
        ? round2(0.5 + rng() * 2.5)
        : Math.max(1, Math.round(3 + rng() * 25));
      const entryPrice = round2(basePrice * (0.9 + rng() * 0.2));
      const priceShift = pnlBase / quantity;
      const exitPrice = round2(
        entryPrice + (side === "long" ? priceShift : -priceShift)
      );
      const closedAtOffset =
        Math.floor(rng() * 12) * 86_400_000 + Math.floor(rng() * 86_400_000);
      const closedAt = new Date(now - closedAtOffset);
      const openedAt = new Date(
        closedAt.getTime() - (1 + Math.floor(rng() * 96)) * 3_600_000
      );

      trades.push({
        symbol,
        side,
        quantity,
        entryPrice,
        exitPrice,
        pnl: round2(positionPnl(side, quantity, entryPrice, exitPrice)),
        rMultiple,
        openedAt: openedAt.toISOString(),
        closedAt: closedAt.toISOString(),
      });
    }

    return trades.slice(0, Math.max(1, limit));
  }

  async executeOrder(order: OrderRequest): Promise<OrderReceipt> {
    const symbol = order.symbol.trim().toUpperCase();
    const meta = SYMBOLS.find((item) => item.symbol.toUpperCase() === symbol);

    if (!meta) {
      throw new BrokerConnectionError(
        `Символ ${symbol} не поддерживается брокером`
      );
    }

    const now = Date.now();
    const executedPrice = round2(
      order.price ??
        (order.side === "long"
          ? meta.basePrice * (1 + Math.abs(Math.sin(now)) * 0.002)
          : meta.basePrice * (1 - Math.abs(Math.cos(now)) * 0.002))
    );

    if (order.quantity <= 0) {
      throw new BrokerConnectionError("Некорректный объём ордера");
    }

    return {
      orderId: `stub-${symbol}-${now}`,
      symbol,
      side: order.side,
      action: order.action,
      quantity: order.quantity,
      executedPrice,
      status: "filled",
      executedAt: new Date(now).toISOString(),
    };
  }

  async getStats(): Promise<BrokerStats> {
    const rng = mulberry32(hashString(`${this.apiKey}:stats`));
    const trades = await this.getClosedTrades(100);
    const wins = trades.filter((trade) => trade.pnl > 0).length;
    const losses = trades.length - wins;
    const winrate = trades.length > 0 ? wins / trades.length : 0;

    const grossProfit = trades
      .filter((trade) => trade.pnl > 0)
      .reduce((sum, trade) => sum + trade.pnl, 0);
    const grossLoss = trades
      .filter((trade) => trade.pnl < 0)
      .reduce((sum, trade) => sum + Math.abs(trade.pnl), 0);
    const profitFactor =
      grossLoss > 0
        ? round2(grossProfit / grossLoss)
        : grossProfit > 0
          ? 99
          : 0;

    const averageR =
      trades.length > 0
        ? round2(
            trades.reduce((sum, trade) => sum + trade.rMultiple, 0) /
              trades.length
          )
        : 0;

    const maxDrawdownPercent = round2(3 + rng() * 9);

    return {
      totalTrades: trades.length,
      wins,
      losses,
      winrate: round2(winrate * 100),
      profitFactor,
      averageR,
      maxDrawdownPercent,
    };
  }
}
