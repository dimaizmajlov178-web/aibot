import { randomUUID } from "node:crypto";
import { defaultLogger } from "../core/logger";
import {
  BaseBroker,
  BrokerConnectionError,
  type BrokerAccount,
  type BrokerStats,
  type ClosedTrade,
  type OpenPosition,
  type OrderReceipt,
  type OrderRequest,
  type PositionSide,
} from "./base";

export const DEFAULT_UPSCALE_BASE_URL = "https://api.upscale.trade";

const FP9 = 1_000_000_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 750;
const DEFAULT_ACCOUNT_CACHE_MS = 60_000;
const DEFAULT_MARKET_CACHE_MS = 300_000;
const POSITION_LOOKUP_ATTEMPTS = 8;
const POSITION_LOOKUP_DELAY_MS = 500;

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface UpscaleBrokerOptions {
  apiKey: string;
  /** Базовый URL API (по умолчанию https://api.upscale.trade). */
  baseUrl?: string;
  /** Имя заголовка с API-ключом (для Upscale — Authorization). */
  apiKeyHeader?: string;
  /** Инжектируемый fetch (для тестов). */
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

/**
 * Ошибка API Upscale. Ветвление по `code` (машиночитаемый код из поля error),
 * а не по тексту сообщения.
 */
export class UpscaleApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "UpscaleApiError";
  }
}

/**
 * Ордер на открытие ушёл брокеру, но позиция так и не появилась в активных.
 * Отличается от UpscaleApiError тем, что повторный ретрай создаст дубль ордера,
 * поэтому executor не должен ретраить такую ошибку.
 */
export class PositionNotOpenedError extends BrokerConnectionError {
  constructor(message: string) {
    super(message);
    this.name = "PositionNotOpenedError";
  }
}

interface UpscaleRiskStatus {
  currentBalance?: string;
  currentEquity?: string;
  dayStartEquity?: string;
  maxEquity?: string;
  tradingDays?: number | string;
  consistencyRuleMet?: boolean;
  payoutBaselineBalance?: string;
}

interface UpscaleAccount {
  accountId?: string | number;
  id?: string | number;
  status?: string;
  type?: string;
  apiTrading?: boolean;
  accountBalance?: string;
  initialAccountBalance?: string;
  currentPhase?: number | string;
  riskStatus?: UpscaleRiskStatus;
}

interface UpscaleMarket {
  id?: string | number;
  config?: {
    baseAsset?: string;
    quoteAsset?: string;
    ticker?: string;
    [key: string]: unknown;
  };
  state?: {
    indexPrice?: string;
    [key: string]: unknown;
  };
  settings?: {
    minLeverage?: string;
    maxLeverage?: string;
    [key: string]: unknown;
  };
}

interface UpscalePosition {
  idx?: string | number;
  id?: string | number;
  market?: unknown;
  direction?: string;
  size?: string;
  notional?: string;
  margin?: string;
  pnl?: string;
  entryPrice?: string;
  openedAt?: string | number;
  status?: string;
}

interface UpscaleOrderResponse {
  id?: string | number;
  orderId?: string | number;
  status?: string;
  error?: string;
  errorType?: string;
  errorCode?: string;
  indexPrice?: string | number;
  realizedPnl?: string | number;
  amount?: string | number;
  leverage?: string | number;
  type?: string;
  direction?: string;
  price?: string | number;
  filledAmount?: string | number;
  createdAt?: string | number;
}

interface UpscaleActiveOrder {
  id?: string | number;
  orderId?: string | number;
  marketId?: string | number;
  market?: unknown;
  status?: string;
  type?: string;
  direction?: string;
  amount?: number | null;
  filledAmount?: number | null;
  leverage?: number | null;
  price?: number | null;
  indexPrice?: number | null;
  errorCode?: string;
  createdAt?: string | number;
}

export interface BrokerMarket {
  id: string;
  symbol: string;
  indexPrice: number;
  minLeverage: number;
  maxLeverage: number;
  baseAsset: string;
  quoteAsset: string;
}

export interface EquityPoint {
  timestamp: string;
  equity: number;
  phaseIndex: number | null;
  phaseStartEquity: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Извлекает первое непустое значение по списку ключей (строка/число). */
function readString(
  source: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function readNumber(
  source: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function readBoolean(
  source: Record<string, unknown>,
  ...keys: string[]
): boolean | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

/** human -> fp9: целочисленная строка, значение × 10^9. */
export function toFp9(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return BigInt(Math.round(value * FP9)).toString();
}

/** fp9 -> human: целочисленная строка (или число), значение ÷ 10^9. */
export function fromFp9(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "bigint") {
    return Number(value) / FP9;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value / FP9 : 0;
  }
  const raw = String(value).trim();
  if (raw === "") {
    return 0;
  }
  try {
    return Number(BigInt(raw)) / FP9;
  } catch {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}

/** Нормализует timestamp (ISO, секунды/миллисекунды) в ISO-строку. */
function toIso(value: unknown): string {
  if (value === null || value === undefined) {
    return new Date().toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  const raw = String(value).trim();
  const asNumber = Number(raw);
  if (raw !== "" && Number.isFinite(asNumber)) {
    const ms = asNumber < 1e12 ? asNumber * 1000 : asNumber;
    return new Date(ms).toISOString();
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime())
    ? new Date().toISOString()
    : parsed.toISOString();
}

function normalizeSymbol(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[/\-_]/g, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Реальный брокер Upscale (https://api.upscale.trade).
 *
 * Все суммы/цены/плечи передаются в fp9 (× 10^9). Конвертация — через BigInt.
 * Ошибки ветвятся по машиночитаемому `error`-коду; 429 и 409
 * (idempotency_key_in_flight) ретраятся с тем же x-idempotency-key.
 */
export class UpscaleBroker extends BaseBroker {
  readonly name = "upscale";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;

  private accountCache: { account: UpscaleAccount; at: number } | null = null;
  private marketsCache: { markets: UpscaleMarket[]; at: number } | null = null;

  constructor(options: UpscaleBrokerOptions) {
    super();
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (
      options.baseUrl?.trim() || DEFAULT_UPSCALE_BASE_URL
    ).replace(/\/+$/, "");
    this.authHeader = options.apiKeyHeader?.trim() || "Authorization";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async testConnection(): Promise<BrokerAccount> {
    if (!this.apiKey) {
      throw new BrokerConnectionError(
        "Не удалось подключиться к Upscale: API-ключ не задан"
      );
    }
    try {
      const account = await this.resolveAccount(true);
      if (!account.accountId && !account.id) {
        throw new BrokerConnectionError(
          "Не удалось подключиться к Upscale: активный счёт с включённой API-торговлей не найден"
        );
      }
      return await this.getAccount();
    } catch (error) {
      if (error instanceof BrokerConnectionError) {
        throw error;
      }
      if (error instanceof UpscaleApiError) {
        throw new BrokerConnectionError(this.describeAuthError(error));
      }
      throw new BrokerConnectionError(
        `Не удалось подключиться к Upscale: ${errorMessage(error)}`
      );
    }
  }

  async getAccount(): Promise<BrokerAccount> {
    const account = await this.resolveAccount();
    const accountId = this.accountIdOf(account);
    const [riskStatusRaw, positions] = await Promise.all([
      this.request("GET", `/accounts/${accountId}/risk-status`),
      this.fetchActivePositions(accountId),
    ]);
    const riskStatus = asRecord(riskStatusRaw);

    const currentBalance = fromFp9(
      readString(riskStatus, "currentBalance") ?? account.accountBalance
    );
    const currentEquity = fromFp9(
      readString(riskStatus, "currentEquity") ??
        readString(riskStatus, "currentBalance") ??
        account.accountBalance
    );
    const dayStartEquity = fromFp9(readString(riskStatus, "dayStartEquity"));
    const initialBalance =
      fromFp9(account.initialAccountBalance) ||
      fromFp9(readString(riskStatus, "payoutBaselineBalance")) ||
      currentBalance;

    const dailyPnl = dayStartEquity > 0 ? currentEquity - dayStartEquity : 0;
    const dailyPnlPercent =
      dayStartEquity > 0 ? (dailyPnl / dayStartEquity) * 100 : 0;

    const totalPnl = initialBalance > 0 ? currentEquity - initialBalance : 0;
    const totalPnlPercent =
      initialBalance > 0 ? (totalPnl / initialBalance) * 100 : 0;

    const usedMargin = positions.reduce(
      (sum, position) => sum + fromFp9(position.margin),
      0
    );
    const availableCash = Math.max(0, currentEquity - usedMargin);

    return {
      balance: currentBalance,
      equity: currentEquity,
      availableCash,
      currency: "USD",
      openPositions: positions.length,
      dailyPnl,
      dailyPnlPercent,
      totalPnl,
      totalPnlPercent,
    };
  }

  async getPositions(): Promise<OpenPosition[]> {
    const account = await this.resolveAccount();
    const accountId = this.accountIdOf(account);
    const positions = await this.fetchActivePositions(accountId);
    let markets: UpscaleMarket[] = [];
    try {
      markets = await this.fetchMarkets(accountId);
    } catch {
      // Рыночный снимок недоступен — позиции всё равно показываем,
      // unrealized P&L для них будет помечен как недоступный.
      markets = [];
    }
    return positions.map((position) => this.toOpenPosition(position, markets));
  }

  async getClosedTrades(limit = 10): Promise<ClosedTrade[]> {
    const account = await this.resolveAccount();
    const accountId = this.accountIdOf(account);
    const response = await this.request(
      "GET",
      `/positions/${accountId}/portfolio/history?limit=${Math.max(1, limit)}&offset=0`
    );
    const record = asRecord(response);
    const items = Array.isArray(response)
      ? response
      : asArray(record.data ?? record.items ?? record.positions);
    const markets = await this.fetchMarkets(accountId);

    return items
      .map((item) => this.toClosedTrade(asRecord(item), markets))
      .slice(0, Math.max(1, limit));
  }

  async getStats(): Promise<BrokerStats> {
    const account = await this.resolveAccount();
    const accountId = this.accountIdOf(account);
    const raw = asRecord(
      await this.request("GET", `/accounts/${accountId}/stats`)
    );

    const totalTrades = readNumber(raw, "positionsCount", "tradesCount") ?? 0;
    const wins = readNumber(raw, "profitablePositionsCount") ?? 0;
    const losses =
      readNumber(raw, "unprofitablePositionsCount") ??
      Math.max(0, totalTrades - wins);
    const winrate =
      readNumber(raw, "winratePercent") ??
      (totalTrades > 0 ? (wins / totalTrades) * 100 : 0);

    const avgProfit = fromFp9(readString(raw, "avgProfit"));
    const avgLoss = Math.abs(fromFp9(readString(raw, "avgLoss")));
    const grossProfit = avgProfit > 0 ? avgProfit * wins : 0;
    const grossLoss = avgLoss > 0 ? avgLoss * losses : 0;
    const profitFactor =
      grossLoss > 0
        ? grossProfit / grossLoss
        : grossProfit > 0
          ? 99
          : (readNumber(raw, "profitFactor") ?? 0);

    const averageR = readNumber(raw, "riskRewardRatio", "averageR") ?? 0;
    const maxDrawdownPercent =
      readNumber(raw, "maxDrawdownPercent", "maxDrawdown") ?? 0;

    return {
      totalTrades,
      wins,
      losses,
      winrate,
      profitFactor,
      averageR,
      maxDrawdownPercent,
    };
  }

  /** Торгуемые рынки счёта (GET /v2/markets). */
  async getMarkets(): Promise<BrokerMarket[]> {
    const account = await this.resolveAccount();
    const accountId = this.accountIdOf(account);
    const markets = await this.fetchMarkets(accountId);
    return markets.map((market) => this.toBrokerMarket(market));
  }

  /** История эквити счёта (GET /accounts/{id}/equity-history). */
  async getEquityHistory(
    options: {
      timestamp?: string;
      duration?: string;
    } = {}
  ): Promise<EquityPoint[]> {
    const account = await this.resolveAccount();
    const accountId = this.accountIdOf(account);
    const params = new URLSearchParams();
    if (options.timestamp) {
      params.set("timestamp", options.timestamp);
    }
    if (options.duration) {
      params.set("duration", options.duration);
    }
    const query = params.toString();
    const response = await this.request(
      "GET",
      `/accounts/${accountId}/equity-history${query ? `?${query}` : ""}`
    );
    const items = Array.isArray(response)
      ? response
      : asArray(asRecord(response).data);
    return items.map((item) => {
      const record = asRecord(item);
      const phaseIndex = readNumber(record, "phaseIndex");
      return {
        timestamp: toIso(record.timestamp),
        equity: fromFp9(record.volume ?? record.equity),
        phaseIndex: phaseIndex ?? null,
        phaseStartEquity: fromFp9(record.phaseStartEquity),
      };
    });
  }

  /** Закрывает все позиции и отменяет все ордера счёта (204). */
  async closeAllPositions(): Promise<void> {
    const account = await this.resolveAccount();
    const accountId = this.accountIdOf(account);
    await this.request("POST", `/accounts/${accountId}/close-all`);
  }

  async executeOrder(order: OrderRequest): Promise<OrderReceipt> {
    const account = await this.resolveAccount();
    const accountId = this.accountIdOf(account);
    const markets = await this.fetchMarkets(accountId);
    const market = this.findMarket(markets, order.symbol);
    if (!market) {
      throw new BrokerConnectionError(
        `Символ ${order.symbol} не найден среди рынков Upscale`
      );
    }
    const marketId = String(market.id ?? "");

    defaultLogger
      .child({ service: "broker" })
      .info(`[upscale] ордер: ${order.action} ${order.symbol} ${order.side}`, {
        orderAction: order.action,
        symbol: order.symbol,
        side: order.side,
        accountId,
        marketId,
      });

    if (order.action === "open") {
      return this.openPosition(accountId, market, marketId, order);
    }
    return this.closeExistingPosition(accountId, market, marketId, order);
  }

  private async openPosition(
    accountId: string,
    market: UpscaleMarket,
    marketId: string,
    order: OrderRequest
  ): Promise<OrderReceipt> {
    const direction: PositionSide = order.side;
    const price =
      order.price && order.price > 0
        ? order.price
        : fromFp9(readString(asRecord(market.state), "indexPrice"));
    if (!(price > 0)) {
      throw new BrokerConnectionError(
        `Нет цены для открытия ${order.symbol}: укажите price или дождитесь indexPrice`
      );
    }
    const leverage = this.resolveLeverage(market);
    const notional = order.quantity * price;
    if (!(notional > 0)) {
      throw new BrokerConnectionError("Некорректный объём ордера");
    }
    // amount для market-ордера на открытие — quote-сумма резерва (маржа).
    const amount = notional / leverage;
    const amountFp9 = toFp9(amount);
    const leverageFp9 = toFp9(leverage);
    const expectedAmountFp9 = toFp9(notional);

    defaultLogger
      .child({ service: "broker" })
      .debug(`[upscale] параметры market-ордера на открытие`, {
        symbol: order.symbol,
        side: direction,
        marketId,
        quantity: order.quantity,
        price,
        notional,
        amount,
        leverage,
        amountFp9,
        leverageFp9,
        expectedAmountFp9,
      });

    const response = await this.createOrder({
      accountId,
      marketId,
      type: "market",
      direction,
      amount: amountFp9,
      leverage: leverageFp9,
      expectedAmount: expectedAmountFp9,
    });

    const orderStatus = this.orderStatusOf(response);
    const responseInfo = {
      orderId: String(response.id ?? response.orderId ?? "?"),
      status: orderStatus,
      errorCode: response.errorCode ?? response.error ?? null,
      indexPrice: this.readHuman(response.indexPrice),
      realizedPnl: this.readHuman(response.realizedPnl),
      amount: this.readHuman(response.amount),
      leverage: this.readHuman(response.leverage),
      type: response.type ?? response.errorType ?? null,
      direction: response.direction ?? null,
      price: this.readHuman(response.price),
      filledAmount: this.readHuman(response.filledAmount),
      createdAt: response.createdAt ?? null,
    };

    defaultLogger
      .child({ service: "broker" })
      .info(`[upscale] market-ордер на открытие передан брокеру`, {
        symbol: order.symbol,
        side: direction,
        marketId,
        notional,
        amount,
        leverage,
        price,
        response: responseInfo,
      });

    // Диагностика: после POST /orders смотрим активные ордера счёта, чтобы
    // увидеть, завис ли наш ордер в статусе active или был отклонён.
    let activeOrders: UpscaleActiveOrder[] = [];
    try {
      activeOrders = await this.fetchActiveOrders(accountId);
    } catch (error) {
      defaultLogger
        .child({ service: "broker" })
        .warn(
          `[upscale] не удалось получить активные ордера после market-ордера`,
          {
            symbol: order.symbol,
            orderId: String(response.id ?? response.orderId ?? "?"),
            error: errorMessage(error),
          }
        );
    }

    if (orderStatus !== "executed") {
      const reason =
        orderStatus === "active" || orderStatus === "pending"
          ? `ордер завис в статусе ${orderStatus} и не исполнился`
          : orderStatus === "canceled" || orderStatus === "cancelled"
            ? "ордер был отменён брокером"
            : orderStatus === "rejected"
              ? "ордер отклонён брокером"
              : `неожиданный статус ордера: ${orderStatus || "не указан"}`;
      defaultLogger
        .child({ service: "broker" })
        .error(`[upscale] market-ордер не исполнен: ${reason}`, {
          symbol: order.symbol,
          side: direction,
          marketId,
          orderId: String(response.id ?? response.orderId ?? "?"),
          status: orderStatus,
          errorCode: response.errorCode ?? response.error ?? null,
          activeOrders,
          response: responseInfo,
        });
      throw new PositionNotOpenedError(
        `Ордер на открытие ${order.symbol} ${direction} принят брокером, но не исполнен (id=${response.id ?? "?"}): ${reason}${response.errorCode ? `, errorCode=${response.errorCode}` : ""}. Позиция не создана.`
      );
    }

    if (activeOrders.length > 0) {
      defaultLogger
        .child({ service: "broker" })
        .info(`[upscale] активные ордера после market-ордера`, {
          symbol: order.symbol,
          orderId: String(response.id ?? response.orderId ?? "?"),
          activeOrders,
        });
    }

    const position = await this.waitForPosition(accountId, market, direction, {
      activeOrders,
    });
    if (!position) {
      // Не засчитываем открытие, которого нет на брокере: иначе движок
      // покажет «сделок открыто 30/30», а на брокере не будет ни одной позиции.
      defaultLogger
        .child({ service: "broker" })
        .warn(`[upscale] позиция не подтверждена после market-ордера`, {
          symbol: order.symbol,
          side: direction,
          marketId,
          orderId: String(response.id ?? "?"),
          attempts: POSITION_LOOKUP_ATTEMPTS,
          status: orderStatus,
          activeOrders,
        });
      throw new PositionNotOpenedError(
        `Ордер на открытие ${order.symbol} ${direction} передан брокеру (id=${response.id ?? "?"}), но позиция не подтверждена: после ${POSITION_LOOKUP_ATTEMPTS} опросов активных позиций её нет. Проверьте счёт на брокере — ордер мог не исполниться.`
      );
    }
    const executedPrice = this.positionEntryPrice(position, market);
    const quantity = fromFp9(position.size);

    return {
      orderId: String(response.id ?? `upscale-${Date.now()}`),
      symbol: order.symbol,
      side: order.side,
      action: "open",
      quantity,
      executedPrice,
      status: "filled",
      executedAt: toIso(response.createdAt),
    };
  }

  private async closeExistingPosition(
    accountId: string,
    market: UpscaleMarket,
    marketId: string,
    order: OrderRequest
  ): Promise<OrderReceipt> {
    const direction: PositionSide = order.side;
    const positions = await this.fetchActivePositions(accountId);
    const position = positions.find(
      (item) =>
        this.matchesMarket(item, market) &&
        this.normalizeDirection(item.direction) === direction
    );
    if (!position) {
      throw new BrokerConnectionError(
        `Нет открытой позиции ${order.symbol} ${direction} для закрытия`
      );
    }

    // Закрытие позиции — take-ордер по рынку (triggerPrice "0"),
    // amount = base-размер позиции, positionId = idx позиции.
    const response = await this.createOrder({
      accountId,
      marketId,
      type: "take",
      direction,
      amount: position.size ?? toFp9(order.quantity),
      triggerPrice: "0",
      positionId: position.idx,
    });

    const executedPrice =
      fromFp9(response.indexPrice) || this.positionEntryPrice(position, market);

    return {
      orderId: String(response.id ?? `upscale-${Date.now()}`),
      symbol: order.symbol,
      side: order.side,
      action: "close",
      quantity: fromFp9(position.size) || order.quantity,
      executedPrice,
      status: "filled",
      executedAt: toIso(response.createdAt),
    };
  }

  private async createOrder(
    body: Record<string, unknown>
  ): Promise<UpscaleOrderResponse> {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null && value !== "") {
        payload[key] = value;
      }
    }
    const response = await this.request("POST", "/orders", { body: payload });
    return asRecord(response);
  }

  private async waitForPosition(
    accountId: string,
    market: UpscaleMarket,
    direction: PositionSide,
    options: { activeOrders?: UpscaleActiveOrder[] } = {}
  ): Promise<UpscalePosition | null> {
    const marketId = String(market.id ?? "");
    for (let attempt = 1; attempt <= POSITION_LOOKUP_ATTEMPTS; attempt += 1) {
      const positions = await this.fetchActivePositions(accountId);
      const match = positions.find(
        (item) =>
          this.matchesMarket(item, market) &&
          this.normalizeDirection(item.direction) === direction
      );
      if (match) {
        defaultLogger
          .child({ service: "broker", accountId })
          .info(
            `[upscale] позиция подтверждена: marketId=${marketId} ${direction} (попытка ${attempt}/${POSITION_LOOKUP_ATTEMPTS})`,
            {
              marketId,
              direction,
              attempt,
              openPositions: positions.length,
            }
          );
        return match;
      }
      defaultLogger
        .child({ service: "broker", accountId })
        .debug(
          `[upscale] ожидание позиции: marketId=${marketId} ${direction} — активных позиций: ${positions.length} (попытка ${attempt}/${POSITION_LOOKUP_ATTEMPTS})`,
          {
            marketId,
            positionMarkets: positions.map((item) =>
              this.positionMarketIdOf(item)
            ),
            activeOrders: options.activeOrders ?? [],
          }
        );
      if (attempt < POSITION_LOOKUP_ATTEMPTS) {
        await this.sleep(POSITION_LOOKUP_DELAY_MS);
      }
    }
    return null;
  }

  /**
   * Нормализованный статус ордера из ответа POST /orders. Вероятные значения
   * API: executed / active / canceled / rejected (и производные filled/pending).
   */
  private orderStatusOf(response: UpscaleOrderResponse): string {
    const raw = response.status?.trim().toLowerCase() ?? "";
    if (!raw) {
      return "";
    }
    switch (raw) {
      case "executed":
      case "filled":
        return "executed";
      case "active":
      case "pending":
        return "active";
      case "canceled":
      case "cancelled":
        return "canceled";
      case "rejected":
      case "failed":
        return "rejected";
      default:
        return raw;
    }
  }

  /** Значение fp9 -> human (для логирования); отсутствующие поля = null. */
  private readHuman(value: unknown): number | null {
    if (value === undefined || value === null || value === "") {
      return null;
    }
    const parsed = fromFp9(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private positionEntryPrice(
    position: UpscalePosition,
    market: UpscaleMarket
  ): number {
    const entry = fromFp9(position.entryPrice);
    if (entry > 0) {
      return entry;
    }
    const size = fromFp9(position.size);
    const notional = fromFp9(position.notional);
    if (size > 0 && notional > 0) {
      return notional / size;
    }
    return fromFp9(readString(asRecord(market.state), "indexPrice"));
  }

  /**
   * Нереализованный P&L позиции. Если API вернул явный pnl — используем его,
   * иначе считаем по рыночному снимку: (indexPrice - entryPrice) * size для
   * long и (entryPrice - indexPrice) * size для short. entryPrice берётся из
   * позиции или из notional/size (без фолбэка на indexPrice). Если данных
   * недостаточно — возвращаем null (P&L недоступен).
   */
  private positionUnrealizedPnl(
    position: UpscalePosition,
    market: UpscaleMarket | null
  ): number | null {
    if (position.pnl !== undefined) {
      return fromFp9(position.pnl);
    }
    const size = fromFp9(position.size);
    const indexPrice = fromFp9(
      readString(asRecord(market?.state), "indexPrice")
    );
    if (!(size > 0) || !(indexPrice > 0)) {
      return null;
    }
    const entry = fromFp9(position.entryPrice);
    const notional = fromFp9(position.notional);
    const entryPrice = entry > 0 ? entry : notional > 0 ? notional / size : 0;
    if (!(entryPrice > 0)) {
      return null;
    }
    const diff =
      this.normalizeDirection(position.direction) === "long"
        ? indexPrice - entryPrice
        : entryPrice - indexPrice;
    return diff * size;
  }

  private toOpenPosition(
    position: UpscalePosition,
    markets: UpscaleMarket[]
  ): OpenPosition {
    const market = this.marketForRef(position.market, markets);
    const symbol = market
      ? this.marketSymbol(market)
      : String(position.market ?? "");
    const size = fromFp9(position.size);
    const entryPrice = this.positionEntryPrice(position, market ?? {});
    const currentPrice =
      fromFp9(readString(asRecord(market?.state), "indexPrice")) || entryPrice;
    const side = this.normalizeDirection(position.direction);

    return {
      symbol,
      side,
      quantity: size,
      entryPrice,
      currentPrice,
      unrealizedPnl: this.positionUnrealizedPnl(position, market),
      openedAt: toIso(position.openedAt),
    };
  }

  private toClosedTrade(
    item: Record<string, unknown>,
    markets: UpscaleMarket[]
  ): ClosedTrade {
    const marketRef = item.market ?? item.marketId;
    const market = this.marketForRef(marketRef, markets);
    const symbol = market ? this.marketSymbol(market) : String(marketRef ?? "");
    const direction = readString(item, "direction", "side") ?? "long";
    const size = fromFp9(item.size);
    const entryPrice =
      fromFp9(item.entryPrice) ||
      fromFp9(readString(item, "openPrice", "open"));
    const exitPrice =
      fromFp9(item.exitPrice) ||
      fromFp9(readString(item, "closePrice", "closingPrice", "indexPrice"));
    const pnl = fromFp9(
      readString(item, "pnl", "realizedPnl", "profit", "sumPnl")
    );

    return {
      symbol,
      side: this.normalizeDirection(direction),
      quantity: size,
      entryPrice,
      exitPrice,
      pnl,
      rMultiple: readNumber(item, "rMultiple") ?? 0,
      openedAt: toIso(item.openedAt ?? item.openTime),
      closedAt: toIso(item.closedAt ?? item.closeTime ?? item.updatedAt),
    };
  }

  private toBrokerMarket(market: UpscaleMarket): BrokerMarket {
    const config = asRecord(market.config);
    const state = asRecord(market.state);
    const settings = asRecord(market.settings);
    return {
      id: String(market.id ?? ""),
      symbol: this.marketSymbol(market),
      indexPrice: fromFp9(readString(state, "indexPrice")),
      minLeverage: fromFp9(readString(settings, "minLeverage")),
      maxLeverage: fromFp9(readString(settings, "maxLeverage")),
      baseAsset: String(config.baseAsset ?? ""),
      quoteAsset: String(config.quoteAsset ?? ""),
    };
  }

  private marketSymbol(market: UpscaleMarket): string {
    const config = asRecord(market.config);
    const ticker = readString(config, "ticker");
    if (ticker && ticker.includes("/")) {
      return ticker.toUpperCase();
    }
    const base = readString(config, "baseAsset") ?? ticker ?? "";
    const quote = readString(config, "quoteAsset") ?? "USDT";
    if (base && quote) {
      return `${base.toUpperCase()}/${quote.toUpperCase()}`;
    }
    return String(market.id ?? "").toUpperCase();
  }

  private findMarket(
    markets: UpscaleMarket[],
    symbol: string
  ): UpscaleMarket | null {
    const target = normalizeSymbol(symbol);
    return (
      markets.find((market) => {
        const config = asRecord(market.config);
        const candidates = [
          String(market.id ?? ""),
          readString(config, "ticker"),
          readString(config, "baseAsset"),
          this.marketSymbol(market),
        ];
        return candidates.some(
          (candidate) => normalizeSymbol(candidate) === target
        );
      }) ?? null
    );
  }

  private marketForRef(
    ref: unknown,
    markets: UpscaleMarket[]
  ): UpscaleMarket | null {
    if (ref !== null && typeof ref === "object") {
      const object = ref as UpscaleMarket;
      if (object.id !== undefined || object.config) {
        return object;
      }
      return null;
    }
    if (typeof ref === "string" || typeof ref === "number") {
      const key = String(ref);
      return markets.find((market) => String(market.id ?? "") === key) ?? null;
    }
    return null;
  }

  /**
   * Идентификатор рынка позиции. Поле `market` в /positions/.../active —
   * это объект рынка (id/config/ticker), строка с id рынка или число; здесь
   * извлечён нормализованный id рынка для сравнения.
   */
  private positionMarketIdOf(position: UpscalePosition): string {
    const raw = position.market;
    if (raw !== null && typeof raw === "object") {
      const object = raw as UpscaleMarket;
      const id = readString(asRecord(object), "id", "marketId");
      if (id) {
        return normalizeSymbol(id);
      }
      const ticker = readString(asRecord(object.config), "ticker");
      if (ticker) {
        return normalizeSymbol(ticker);
      }
    }
    return normalizeSymbol(String(raw ?? ""));
  }

  /**
   * Все идентификаторы рынка/тикера, по которым API может ссылаться на рынок
   * в ответе позиции (market в /positions/.../active).
   */
  private marketRefsOf(market: UpscaleMarket): string[] {
    const config = asRecord(market.config);
    const refs = [
      market.id,
      readString(config, "ticker"),
      readString(config, "baseAsset"),
      this.marketSymbol(market),
    ];
    return refs
      .filter(
        (value): value is string =>
          typeof value === "string" && value.trim() !== ""
      )
      .map((value) => normalizeSymbol(value));
  }

  /**
   * Совпадает ли рынок позиции с целевым рынком. Сравнение — по любому
   * из идентификаторов рынка (id/тикер/baseAsset), а не только по точному
   * формату поля market, чтобы объектная форма market из API не превращалась
   * в "[object Object]" и подтверждение позиции работало на реальных данных.
   */
  private matchesMarket(
    position: UpscalePosition,
    market: UpscaleMarket
  ): boolean {
    const targetRefs = this.marketRefsOf(market);
    const positionId = this.positionMarketIdOf(position);
    return targetRefs.includes(positionId);
  }

  private normalizeDirection(value: unknown): PositionSide {
    return String(value ?? "").toLowerCase() === "short" ? "short" : "long";
  }

  private resolveLeverage(market: UpscaleMarket): number {
    const settings = asRecord(market.settings);
    const min = fromFp9(readString(settings, "minLeverage"));
    const max = fromFp9(readString(settings, "maxLeverage"));
    let leverage = 1;
    if (min > 0 && leverage < min) {
      leverage = min;
    }
    if (max > 0 && leverage > max) {
      leverage = max;
    }
    return leverage;
  }

  private accountIdOf(account: UpscaleAccount): string {
    const id = account.accountId ?? account.id;
    if (id === undefined || id === null || String(id) === "") {
      throw new BrokerConnectionError(
        "Не удалось определить accountId активного счёта Upscale"
      );
    }
    return String(id);
  }

  private async resolveAccount(force = false): Promise<UpscaleAccount> {
    if (
      !force &&
      this.accountCache &&
      Date.now() - this.accountCache.at < DEFAULT_ACCOUNT_CACHE_MS
    ) {
      return this.accountCache.account;
    }

    const response = await this.request("GET", "/accounts/with-risk-status");
    const record = asRecord(response);
    const accounts = Array.isArray(response)
      ? response
      : asArray(record.accounts ?? record.data ?? record.items);

    const parsed = accounts.map((item) => {
      const raw = asRecord(item);
      return {
        accountId: readString(raw, "accountId", "id"),
        id: readString(raw, "id"),
        status: readString(raw, "status"),
        type: readString(raw, "type"),
        apiTrading: readBoolean(raw, "apiTrading"),
        accountBalance: readString(raw, "accountBalance"),
        initialAccountBalance: readString(raw, "initialAccountBalance"),
        currentPhase: readNumber(raw, "currentPhase"),
        riskStatus: asRecord(raw.riskStatus) as UpscaleRiskStatus,
      } satisfies UpscaleAccount;
    });

    const account =
      parsed.find(
        (item) => item.apiTrading === true && this.isActive(item.status)
      ) ??
      parsed.find((item) => item.apiTrading === true) ??
      parsed[0];

    if (!account) {
      throw new BrokerConnectionError(
        "У аккаунта Upscale нет доступных торговых счетов"
      );
    }

    this.accountCache = { account, at: Date.now() };
    return account;
  }

  private isActive(status: string | undefined): boolean {
    if (!status) {
      return false;
    }
    const value = status.toLowerCase();
    return value === "active" || value === "trading" || value === "enabled";
  }

  private async fetchActivePositions(
    accountId: string
  ): Promise<UpscalePosition[]> {
    const response = await this.request(
      "GET",
      `/positions/${accountId}/active`
    );
    const record = asRecord(response);
    const items = Array.isArray(response)
      ? response
      : asArray(record.positions ?? record.data ?? record.items);
    return items.map((item) => {
      const raw = asRecord(item);
      return {
        idx: readString(raw, "idx", "id", "positionId"),
        id: readString(raw, "id"),
        market: raw.market ?? raw.marketId,
        direction: readString(raw, "direction", "side"),
        size: readString(raw, "size", "amount", "quantity"),
        notional: readString(raw, "notional"),
        margin: readString(raw, "margin"),
        pnl: readString(raw, "pnl", "unrealizedPnl"),
        entryPrice: readString(raw, "entryPrice", "openPrice"),
        openedAt: (raw.openedAt ?? raw.createdAt) as string | number,
        status: readString(raw, "status"),
      } satisfies UpscalePosition;
    });
  }

  /**
   * Активные ордера счёта (GET /orders/{accountId}/active). Нужны для
   * диагностики: завис ли market-ордер в статусе active или был отклонён.
   * Возвращает компактное представление для логирования.
   */
  private async fetchActiveOrders(
    accountId: string
  ): Promise<UpscaleActiveOrder[]> {
    const response = await this.request("GET", `/orders/${accountId}/active`);
    const record = asRecord(response);
    const items = Array.isArray(response)
      ? response
      : asArray(record.orders ?? record.data ?? record.items);
    return items.map((item) => {
      const raw = asRecord(item);
      return {
        id: readString(raw, "id", "orderId"),
        orderId: readString(raw, "orderId", "id"),
        marketId: readString(raw, "marketId", "market"),
        market: raw.market ?? raw.marketId,
        status: readString(raw, "status"),
        type: readString(raw, "type"),
        direction: readString(raw, "direction", "side"),
        amount: this.readHuman(readNumber(raw, "amount", "requestedAmount")),
        filledAmount: this.readHuman(
          readNumber(raw, "filledAmount", "executedAmount")
        ),
        leverage: this.readHuman(readNumber(raw, "leverage")),
        price: this.readHuman(readNumber(raw, "price", "triggerPrice")),
        indexPrice: this.readHuman(readNumber(raw, "indexPrice")),
        errorCode: readString(raw, "errorCode", "error"),
        createdAt: raw.createdAt as string | number | undefined,
      } satisfies UpscaleActiveOrder;
    });
  }

  private async fetchMarkets(accountId: string): Promise<UpscaleMarket[]> {
    if (
      this.marketsCache &&
      Date.now() - this.marketsCache.at < DEFAULT_MARKET_CACHE_MS
    ) {
      return this.marketsCache.markets;
    }
    const response = await this.request(
      "GET",
      `/v2/markets?accountId=${encodeURIComponent(accountId)}`
    );
    const record = asRecord(response);
    const items = Array.isArray(response)
      ? response
      : asArray(record.markets ?? record.data ?? record.items);
    const markets = items.map((item) => {
      const raw = asRecord(item);
      return {
        id: raw.id as string | number | undefined,
        config: asRecord(raw.config),
        state: asRecord(raw.state),
        settings: asRecord(raw.settings),
      } satisfies UpscaleMarket;
    });
    this.marketsCache = { markets, at: Date.now() };
    return markets;
  }

  /** HTTP-запрос с ретраями (429/409) и x-idempotency-key для записи. */
  private async request(
    method: HttpMethod,
    path: string,
    options: { body?: unknown } = {}
  ): Promise<unknown> {
    const idempotencyKey = method === "GET" ? null : randomUUID();
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        const { response, data } = await this.send(
          method,
          path,
          options.body,
          idempotencyKey
        );
        if (response.ok) {
          return data;
        }
        const error = this.toApiError(response, data);
        if (
          attempt < this.maxRetries &&
          (error.statusCode === 429 || error.statusCode === 409)
        ) {
          // Уважаем Retry-After: ждём максимум из бэк-оффа и заголовка.
          const backoff = Math.max(
            this.retryDelayMs * attempt,
            this.retryAfterMs(response)
          );
          await this.sleep(backoff);
          continue;
        }
        throw error;
      } catch (error) {
        if (error instanceof UpscaleApiError) {
          throw error;
        }
        lastError = error;
        if (attempt < this.maxRetries) {
          await this.sleep(this.retryDelayMs * attempt);
          continue;
        }
      }
    }

    throw new BrokerConnectionError(
      `Ошибка запроса к Upscale (${method} ${path}): ${errorMessage(lastError)}`
    );
  }

  private async send(
    method: HttpMethod,
    path: string,
    body: unknown,
    idempotencyKey: string | null
  ): Promise<{ response: Response; data: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        [this.authHeader]: `Bearer ${this.apiKey}`,
        Accept: "application/json",
      };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }
      if (idempotencyKey) {
        headers["x-idempotency-key"] = idempotencyKey;
      }

      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      let data: unknown;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      return { response, data };
    } finally {
      clearTimeout(timer);
    }
  }

  private toApiError(response: Response, data: unknown): UpscaleApiError {
    const record = asRecord(data);
    const code =
      readString(record, "error", "code") ?? `http_${response.status}`;
    const message = readString(record, "message") ?? `HTTP ${response.status}`;
    return new UpscaleApiError(response.status, code, message);
  }

  private retryAfterMs(response: Response): number {
    const header = response.headers.get("retry-after");
    if (!header) {
      return 0;
    }
    const seconds = Number(header);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  }

  private describeAuthError(error: UpscaleApiError): string {
    switch (error.statusCode) {
      case 401:
        return "API-ключ Upscale отклонён (401 unauthorized)";
      case 403:
        return `Upscale отказал в доступе (403 ${error.code})`;
      default:
        return `Ошибка Upscale (${error.statusCode} ${error.code}): ${error.message}`;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
