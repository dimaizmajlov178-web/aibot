from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field

PositionSide = Literal["long", "short"]
OrderAction = Literal["open", "close"]
AiMode = Literal["safe", "balanced", "aggressive"]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def utc_today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


class BrokerAccount(BaseModel):
    balance: float
    equity: float
    available_cash: float
    currency: str = "USDT"
    open_positions: int = 0
    daily_pnl: float = 0.0
    daily_pnl_percent: float = 0.0
    total_pnl: float = 0.0
    total_pnl_percent: float = 0.0


class OpenPosition(BaseModel):
    symbol: str
    side: PositionSide
    quantity: float
    entry_price: float
    current_price: float
    unrealized_pnl: float = 0.0
    opened_at: str = Field(default_factory=utc_now_iso)


class ClosedTrade(BaseModel):
    symbol: str
    side: PositionSide
    quantity: float
    entry_price: float
    exit_price: float
    pnl: float = 0.0
    r_multiple: float = 0.0
    opened_at: str = Field(default_factory=utc_now_iso)
    closed_at: str = Field(default_factory=utc_now_iso)


class BrokerStats(BaseModel):
    total_trades: int = 0
    wins: int = 0
    losses: int = 0
    winrate: float = 0.0
    profit_factor: float = 0.0
    average_r: float = 0.0
    max_drawdown_percent: float = 0.0


class OrderRequest(BaseModel):
    symbol: str
    side: PositionSide
    action: OrderAction
    quantity: float
    price: float | None = None


class OrderReceipt(BaseModel):
    order_id: str
    symbol: str
    side: PositionSide
    action: OrderAction
    quantity: float
    executed_price: float
    status: Literal["filled"] = "filled"
    executed_at: str = Field(default_factory=utc_now_iso)


class BrokerSnapshot(BaseModel):
    account: BrokerAccount
    positions: list[OpenPosition] = Field(default_factory=list)


class Candle(BaseModel):
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0
    time: str = ""


class TradingSettings(BaseModel):
    user_id: int = Field(gt=0)
    risk_per_trade_percent: float = Field(ge=0.1, le=50)
    max_positions: int = Field(ge=1, le=100)
    daily_trade_limit: int = Field(ge=1, le=1000)
    max_daily_drawdown_percent: float = Field(ge=0.1, le=100)
    max_total_drawdown_percent: float = Field(ge=0.1, le=100)
    symbols: list[str] = Field(default_factory=list, max_length=200)
    ai_mode: AiMode = "balanced"
    updated_at: str = Field(default_factory=utc_now_iso)


class TradingSettingsPatch(BaseModel):
    risk_per_trade_percent: float | None = None
    max_positions: int | None = None
    daily_trade_limit: int | None = None
    max_daily_drawdown_percent: float | None = None
    max_total_drawdown_percent: float | None = None
    symbols: list[str] | None = None
    ai_mode: AiMode | None = None


class TradingState(BaseModel):
    user_id: int
    paused: bool = False
    paused_at: str | None = None
    auto_daily_paused: bool = False
    auto_daily_pause_date: str | None = None
    total_stop_triggered: bool = False
    total_stop_triggered_at: str | None = None
    admin_notified_for_total_stop: bool = False
    trades_today: int = 0
    trading_day: str = Field(default_factory=utc_today)
    updated_at: str = Field(default_factory=utc_now_iso)


class TradeSignal(BaseModel):
    action: Literal["buy", "sell", "hold"]
    side: Literal["long", "short", "none"]
    confidence: float = Field(ge=0, le=100)
    entry_price: float | None = Field(default=None, gt=0)
    stop_loss: float | None = Field(default=None, gt=0)
    take_profit: float | None = Field(default=None, gt=0)
    risk_percent: float = Field(ge=0, le=100)
    reasoning: str = Field(min_length=1, max_length=2000)


class KeyLevels(BaseModel):
    support: list[float] = Field(default_factory=list, max_length=10)
    resistance: list[float] = Field(default_factory=list, max_length=10)


class Scenario(BaseModel):
    bull_case: str = Field(max_length=2000)
    bear_case: str = Field(max_length=2000)
    base_case: str = Field(max_length=2000)


class DeepAnalysis(BaseModel):
    trend: Literal["bullish", "bearish", "neutral"]
    trend_strength: float = Field(ge=0, le=100)
    key_levels: KeyLevels = Field(default_factory=KeyLevels)
    scenario: Scenario
    risk_assessment: Literal["low", "medium", "high"]
    summary: str = Field(max_length=4000)


class MarketContext(BaseModel):
    symbol: str
    timeframe: str
    price: float
    candles: list[Any] = Field(default_factory=list)
    indicators: dict[str, Any] = Field(default_factory=dict)
    collected_at: str = Field(default_factory=utc_now_iso)


class AnalyzeResult(BaseModel):
    decision: TradeSignal | None = None
    market: MarketContext | None = None
    mode: str = "signal"
    model: str = ""


class RiskDecision(BaseModel):
    allow: bool = False
    code: str | None = None
    reason: str | None = None
    effective_risk_percent: float = 0.0
    max_trade_notional: float = 0.0
    state: TradingState | None = None


class EngineEvent(BaseModel):
    type: str
    user_id: int
    symbol: str
    message: str
    data: dict[str, Any] | None = None
    at: str = Field(default_factory=utc_now_iso)
    request_id: str | None = None