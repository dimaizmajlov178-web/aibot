from __future__ import annotations

from typing import Any, Callable

import pytest

from pycore.broker import BaseBroker, OrderExecutor
from pycore.lock import InMemoryLockStore
from pycore.models import (
    AnalyzeResult,
    BrokerAccount,
    BrokerSnapshot,
    BrokerStats,
    Candle,
    ClosedTrade,
    MarketContext,
    OpenPosition,
    OrderReceipt,
    OrderRequest,
    TradeSignal,
    utc_now_iso,
)
from pycore.risk_manager import (
    MemorySettingsRepository,
    MemoryStateRepository,
    NullAuditService,
    RiskManager,
    TradingSettingsRepository,
    TradingStateRepository,
)
from pycore.trading_core import TradingCore, TradingCoreDeps


class FakeBroker(BaseBroker):
    def __init__(
        self,
        account: BrokerAccount | None = None,
        positions: list[OpenPosition] | None = None,
    ) -> None:
        self.account = account or BrokerAccount(
            balance=10_000, equity=10_000, available_cash=10_000
        )
        self.positions = positions or []
        self.orders: list[OrderRequest] = []
        self.order_error: Exception | None = None
        self.executed_price: float = 100.0

    @property
    def name(self) -> str:
        return "fake"

    async def test_connection(self) -> BrokerAccount:
        return self.account

    async def get_account(self) -> BrokerAccount:
        return self.account

    async def get_positions(self) -> list[OpenPosition]:
        return list(self.positions)

    async def get_closed_trades(self, limit: int | None = None) -> list[ClosedTrade]:
        return []

    async def get_stats(self) -> BrokerStats:
        return BrokerStats()

    async def execute_order(self, order: OrderRequest) -> OrderReceipt:
        if self.order_error is not None:
            raise self.order_error
        self.orders.append(order)
        return OrderReceipt(
            order_id=f"o-{len(self.orders)}",
            symbol=order.symbol,
            side=order.side,
            action=order.action,
            quantity=order.quantity,
            executed_price=order.price or self.executed_price,
            executed_at=utc_now_iso(),
        )


class FakeAnalyzer:
    def __init__(
        self,
        signal: TradeSignal | None = None,
        error: Exception | None = None,
    ) -> None:
        self.signal = signal
        self.error = error
        self.calls: list[tuple[int, str]] = []

    async def analyze_signal(self, *, user_id: int, symbol: str) -> AnalyzeResult:
        self.calls.append((user_id, symbol))
        if self.error is not None:
            raise self.error
        return AnalyzeResult(
            decision=self.signal,
            market=MarketContext(symbol=symbol, timeframe="1h", price=100.0),
        )


class FakeMarketData:
    def __init__(self, close: float = 100.0) -> None:
        self.close = close
        self.calls: list[tuple[str, str, int]] = []

    async def get_candles(self, symbol: str, timeframe: str, limit: int) -> list[Candle]:
        self.calls.append((symbol, timeframe, limit))
        return [
            Candle(open=self.close, high=self.close, low=self.close, close=self.close)
            for _ in range(limit)
        ]


class FakeLearning:
    def __init__(self) -> None:
        self.opened: list[dict[str, Any]] = []
        self.closed: list[dict[str, Any]] = []

    async def record_trade_open(self, **kwargs: Any) -> None:
        self.opened.append(kwargs)

    async def record_trade_close(self, **kwargs: Any) -> None:
        self.closed.append(kwargs)


class RecordingAudit(NullAuditService):
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def settings_update(self, **kwargs: Any) -> None:
        self.calls.append(("settings_update", kwargs))

    async def trading_control(self, **kwargs: Any) -> None:
        self.calls.append(("trading_control", kwargs))

    async def trade_open(self, **kwargs: Any) -> None:
        self.calls.append(("trade_open", kwargs))

    async def trade_close(self, **kwargs: Any) -> None:
        self.calls.append(("trade_close", kwargs))

    async def trade_rejected(self, **kwargs: Any) -> None:
        self.calls.append(("trade_rejected", kwargs))

    async def trade_error(self, **kwargs: Any) -> None:
        self.calls.append(("trade_error", kwargs))

    async def risk_state(self, **kwargs: Any) -> None:
        self.calls.append(("risk_state", kwargs))


@pytest.fixture
def settings_repo() -> MemorySettingsRepository:
    return MemorySettingsRepository()


@pytest.fixture
def state_repo() -> MemoryStateRepository:
    return MemoryStateRepository()


@pytest.fixture
def risk_manager(
    settings_repo: MemorySettingsRepository, state_repo: MemoryStateRepository
) -> RiskManager:
    return RiskManager(settings=settings_repo, state=state_repo)


def make_signal(
    action: str = "buy",
    side: str = "long",
    confidence: float = 80,
    entry_price: float | None = 100.0,
) -> TradeSignal:
    return TradeSignal(
        action=action,  # type: ignore[arg-type]
        side=side,  # type: ignore[arg-type]
        confidence=confidence,
        entry_price=entry_price,
        risk_percent=1.0,
        reasoning="тестовый сигнал",
    )


def build_core(
    *,
    risk_manager: RiskManager,
    broker: FakeBroker | None = None,
    analyzer: FakeAnalyzer | None = None,
    market_data: FakeMarketData | None = None,
    lock_store: InMemoryLockStore | None = None,
    user_ids: list[int] | None = None,
    resolve_broker: Callable[[int], Any] | None = None,
    resolve_user_ids: Callable[[], Any] | None = None,
    on_event: Callable[[Any], None] | None = None,
    notify_admin: Any = None,
    is_global_paused: Any = None,
    audit: Any = None,
    learning: Any = None,
    supported_symbols: list[str] | None = None,
    interval_ms: int = 60_000,
) -> TradingCore:
    resolved_broker = broker if broker is not None else FakeBroker()
    resolved_analyzer = analyzer if analyzer is not None else FakeAnalyzer()
    resolved_market = market_data if market_data is not None else FakeMarketData()
    ids = user_ids if user_ids is not None else [1]
    deps = TradingCoreDeps(
        risk_manager=risk_manager,
        executor=OrderExecutor(sleep=noop_sleep),
        lock_store=lock_store if lock_store is not None else InMemoryLockStore(),
        analyzer=resolved_analyzer,
        market_data=resolved_market,
        resolve_broker=resolve_broker
        if resolve_broker is not None
        else lambda _user_id: async_value(resolved_broker),
        resolve_user_ids=resolve_user_ids
        if resolve_user_ids is not None
        else lambda: async_value(list(ids)),
        supported_symbols=supported_symbols
        if supported_symbols is not None
        else ["BTC/USDT", "ETH/USDT"],
        notify_admin=notify_admin,
        decision_interval_ms=interval_ms,
        lock_ttl_ms=30_000,
        on_event=on_event,
        is_global_paused=is_global_paused,
        audit=audit,
        learning=learning,
    )
    return TradingCore(deps)


async def async_value(value: Any) -> Any:
    return value


async def noop_sleep(_: float) -> None:
    return None


def default_snapshot(
    balance: float = 1_000,
    available_cash: float = 1_000,
    daily_pnl_percent: float = 0.0,
    total_pnl_percent: float = 0.0,
    positions: list[OpenPosition] | None = None,
) -> BrokerSnapshot:
    return BrokerSnapshot(
        account=BrokerAccount(
            balance=balance,
            equity=balance,
            available_cash=available_cash,
            daily_pnl_percent=daily_pnl_percent,
            total_pnl_percent=total_pnl_percent,
        ),
        positions=positions or [],
    )