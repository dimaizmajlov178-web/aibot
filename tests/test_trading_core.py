from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest

from pycore.models import BrokerAccount, OpenPosition, TradingSettingsPatch
from pycore.risk_manager import RiskManager
from pycore.trading_core import _round_quantity
from tests.conftest import (
    FakeAnalyzer,
    FakeBroker,
    FakeLearning,
    FakeMarketData,
    RecordingAudit,
    build_core,
    make_signal,
)


def long_position(
    symbol: str = "BTC/USDT",
    quantity: float = 0.1,
    side: str = "long",
) -> OpenPosition:
    return OpenPosition(
        symbol=symbol,
        side=side,  # type: ignore[arg-type]
        quantity=quantity,
        entry_price=100,
        current_price=105,
    )


class TestHelpers:
    def test_round_quantity(self) -> None:
        assert _round_quantity(0.0) == 0.0
        assert _round_quantity(-1.0) == 0.0
        assert _round_quantity(1.23456) == 1.2346

    def test_long_position_is_upper(self) -> None:
        pos = long_position(symbol="btc/usdt")
        assert pos.symbol == "btc/usdt"


class TestLifecycle:
    @pytest.mark.asyncio
    async def test_start_twice_and_stop(self, risk_manager: RiskManager) -> None:
        core = build_core(risk_manager=risk_manager, interval_ms=5)
        core.start()
        core.start()
        assert core._running is True
        try:
            await asyncio.sleep(0.03)
        finally:
            core.stop_pumping()
        assert core._running is False
        assert core._task is None

    @pytest.mark.asyncio
    async def test_pump_runs_ticks(self, risk_manager: RiskManager) -> None:
        analyzer = FakeAnalyzer()
        core = build_core(
            risk_manager=risk_manager, analyzer=analyzer, interval_ms=10
        )
        core.start()
        try:
            await _wait_for(lambda: len(analyzer.calls) > 0)
        finally:
            core.stop_pumping()
        assert len(analyzer.calls) > 0


class FailingMarketData(FakeMarketData):
    async def get_candles(self, symbol: str, timeframe: str, limit: int) -> None:
        raise RuntimeError("market data недоступно")


class TestTick:
    @pytest.mark.asyncio
    async def test_tick_processes_all_users_and_symbols(
        self, risk_manager: RiskManager
    ) -> None:
        analyzer = FakeAnalyzer()
        core = build_core(
            risk_manager=risk_manager,
            analyzer=analyzer,
            user_ids=[1, 2],
            supported_symbols=["BTC/USDT", "ETH/USDT"],
        )
        await core.tick()
        assert len(analyzer.calls) == 4

    @pytest.mark.asyncio
    async def test_tick_ignores_resolver_error(self, risk_manager: RiskManager) -> None:
        def boom() -> list[int]:
            raise RuntimeError("db down")

        core = build_core(risk_manager=risk_manager, resolve_user_ids=boom)
        await core.tick()

    @pytest.mark.asyncio
    async def test_tick_respects_symbol_whitelist(
        self, risk_manager: RiskManager
    ) -> None:
        await risk_manager.update_settings(
            1, TradingSettingsPatch(symbols=["ETH/USDT"])
        )
        analyzer = FakeAnalyzer()
        core = build_core(
            risk_manager=risk_manager,
            analyzer=analyzer,
            user_ids=[1],
            supported_symbols=["BTC/USDT", "ETH/USDT"],
        )
        await core.tick()
        assert analyzer.calls == [(1, "ETH/USDT")]


class TestGlobalAndSymbolChecks:
    @pytest.mark.asyncio
    async def test_global_pause_skips(self, risk_manager: RiskManager) -> None:
        analyzer = FakeAnalyzer(signal=make_signal())
        core = build_core(
            risk_manager=risk_manager,
            analyzer=analyzer,
            is_global_paused=lambda: True,
        )
        events = await core.evaluate_symbol(1, "BTC/USDT", "timer")
        assert events == []
        assert analyzer.calls == []

    @pytest.mark.asyncio
    async def test_global_pause_async_skips(self, risk_manager: RiskManager) -> None:
        analyzer = FakeAnalyzer(signal=make_signal())

        async def paused() -> bool:
            return True

        core = build_core(
            risk_manager=risk_manager,
            analyzer=analyzer,
            is_global_paused=paused,
        )
        events = await core.evaluate_symbol(1, "BTC/USDT", "timer")
        assert events == []
        assert analyzer.calls == []

    @pytest.mark.asyncio
    async def test_missing_broker_skips(self, risk_manager: RiskManager) -> None:
        analyzer = FakeAnalyzer(signal=make_signal())

        async def no_broker(_user_id: int) -> None:
            return None

        core = build_core(
            risk_manager=risk_manager,
            analyzer=analyzer,
            resolve_broker=no_broker,
        )
        events = await core.evaluate_symbol(1, "BTC/USDT", "timer")
        assert events == []
        assert analyzer.calls == []

    @pytest.mark.asyncio
    async def test_symbol_not_configured_skips(self, risk_manager: RiskManager) -> None:
        await risk_manager.update_settings(
            1, TradingSettingsPatch(symbols=["ETH/USDT"])
        )
        analyzer = FakeAnalyzer(signal=make_signal())
        core = build_core(risk_manager=risk_manager, analyzer=analyzer)
        await core.evaluate_symbol(1, "BTC/USDT", "timer")
        assert analyzer.calls == []


class TestOpenTrade:
    @pytest.mark.asyncio
    async def test_open_trade_success(self, risk_manager: RiskManager) -> None:
        events: list[Any] = []
        learning = FakeLearning()
        broker = FakeBroker()
        core = build_core(
            risk_manager=risk_manager,
            broker=broker,
            analyzer=FakeAnalyzer(signal=make_signal(entry_price=100.0)),
            on_event=events.append,
            learning=learning,
        )
        await core.evaluate_symbol(1, "BTC/USDT", "timer")
        assert len(broker.orders) == 1
        order = broker.orders[0]
        assert order.action == "open"
        assert order.side == "long"
        assert order.quantity == 1.0
        assert order.price == 100.0
        assert any(e.type == "trade_open" for e in events)
        assert any(e.type == "signal" for e in events)
        assert len(learning.opened) == 1

    @pytest.mark.asyncio
    async def test_open_uses_market_price_when_no_signal_price(
        self, risk_manager: RiskManager
    ) -> None:
        broker = FakeBroker()
        core = build_core(
            risk_manager=risk_manager,
            broker=broker,
            analyzer=FakeAnalyzer(signal=make_signal(entry_price=None)),
            market_data=FakeMarketData(close=50.0),
        )
        await core.evaluate_symbol(1, "BTC/USDT", "timer")
        assert broker.orders[0].price == 50.0
        assert broker.orders[0].quantity == 2.0

    @pytest.mark.asyncio
    async def test_price_falls_back_to_one_on_market_error(
        self, risk_manager: RiskManager
    ) -> None:
        broker = FakeBroker()
        core = build_core(
            risk_manager=risk_manager,
            broker=broker,
            analyzer=FakeAnalyzer(signal=make_signal(entry_price=None)),
            market_data=FailingMarketData(),
        )
        await core.evaluate_symbol(1, "BTC/USDT", "timer")
        assert broker.orders[0].price == 1.0

    @pytest.mark.asyncio
    async def test_hold_signal_noop(self, risk_manager: RiskManager) -> None:
        broker = FakeBroker()
        core = build_core(
            risk_manager=risk_manager,
            broker=broker,
            analyzer=FakeAnalyzer(signal=make_signal(action="hold", side="none")),
        )
        await core.evaluate_symbol(1, "BTC/USDT", "timer")
        assert broker.orders == []

    @pytest.mark.asyncio
    async def test_ai_error_emits_error_event(self, risk_manager: RiskManager) -> None:
        events: list[Any] = []
        core = build_core(
            risk_manager=risk_manager,
            analyzer=FakeAnalyzer(error=RuntimeError("deepseek недоступен")),
            on_event=events.append,
        )
        result = await core.evaluate_symbol(1, "BTC/USDT", "timer")
        assert any(e.type == "error" for e in result)
        assert any(e.type == "error" for e in events)
        assert "AI-анализа" in result[0].message

    @pytest.mark.asyncio
    async def test_dup_skip_on_open(self, risk_manager: RiskManager) -> None:
        events: list[Any] = []
        broker = FakeBroker()
        core = build_core(
            risk_manager=risk_manager,
            broker=broker,
            analyzer=FakeAnalyzer(signal=make_signal()),
            on_event=events.append,
        )
        lock = core._deps.lock_store
        assert await lock.acquire("trade:1:BTC/USDT:long", 30_000)
        await core.evaluate_symbol(1, "BTC/USDT", "timer")
        assert broker.orders == []
        assert any(e.type == "dup_skip" for e in events)

    @pytest.mark.asyncio
    async def test_risk_block_emits_event(self, risk_manager: RiskManager) -> None:
        events: list[Any] = []
        await risk_manager.pause(1)
        core = build_core(
            risk_manager=risk_manager,
            analyzer=FakeAnalyzer(signal=make_signal()),
            on_event=events.append,
        )
        await core.evaluate_symbol(1, "BTC/USDT", "timer")
        assert any(e.type == "risk_block" for e in events)

    @pytest.mark.asyncio
    async def test_zero_quantity_margin_block(
        self, risk_manager: RiskManager, monkeypatch: Any
    ) -> None:
        events: list[Any] = []
        audit = RecordingAudit()
        broker = FakeBroker()
        monkeypatch.setattr(
            "pycore.trading_core._round_quantity", lambda _value: 0.0
        )
        core = build_core(
            risk_manager=risk_manager,
            broker=broker,
            analyzer=FakeAnalyzer(signal=make_signal(entry_price=100.0)),
            on_event=events.append,
            audit=audit,
        )
        await core.evaluate_symbol(1, "BTC/USDT", "timer")
        assert broker.orders == []
        block_events = [e for e in events if e.type == "risk_block"]
        assert block_events and block_events[0].data.get("code") == "margin_insufficient"
        assert any(name == "trade_rejected" for name, _ in audit.calls)

    @pytest.mark.asyncio
    async def test_total_stop_notifies_admin(self, risk_manager: RiskManager) -> None:
        events: list[Any] = []
        audit = RecordingAudit()
        notified: list[tuple[int, str]] = []
        broker = FakeBroker(
            account=BrokerAccount(
                balance=1000,
                equity=1000,
                available_cash=1000,
                total_pnl_percent=-15,
            )
        )

        async def notifier(user_id: int, message: str) -> None:
            notified.append((user_id, message))

        core = build_core(
            risk_manager=risk_manager,
            broker=broker,
            analyzer=FakeAnalyzer(signal=make_signal()),
            on_event=events.append,
            notify_admin=notifier,
            audit=audit,
        )
        await core.evaluate_symbol(1, "BTC/USDT", "timer")
        assert notified and notified[0][0] == 1
        assert any(e.type == "admin_notify" for e in events)
        assert any(e.type == "risk_block" for e in events)
        assert any(name == "risk_state" for name, _ in audit.calls)

    @pytest.mark.asyncio
    async def test_executor_error_emits_event(self, risk_manager: RiskManager) -> None:
        events: list[Any] = []
        audit = RecordingAudit()
        broker = FakeBroker()
        broker.order_error = RuntimeError("брокер недоступен")
        core = build_core(
            risk_manager=risk_manager,
            broker=broker,
            analyzer=FakeAnalyzer(signal=make_signal()),
            on_event=events.append,
            audit=audit,
        )
        result = await core.evaluate_symbol(1, "BTC/USDT", "timer")
        assert any(e.type == "error" for e in result)
        assert "Не удалось исполнить ордер" in result[0].message
        assert any(name == "trade_error" for name, _ in audit.calls)


class TestCloseTrade:
    @pytest.mark.asyncio
    async def test_close_same_side_signal_keeps_position(
        self, risk_manager: RiskManager
    ) -> None:
        broker = FakeBroker(positions=[long_position()])
        core = build_core(
            risk_manager=risk_manager,
            broker=broker,
            analyzer=FakeAnalyzer(signal=make_signal()),
        )
        await core.evaluate_symbol(1, "BTC/USDT", "timer")
        assert broker.orders == []

    @pytest.mark.asyncio
    async def test_close_opposite_signal_closes_position(
        self, risk_manager: RiskManager
    ) -> None:
        events: list[Any] = []
        audit = RecordingAudit()
        broker = FakeBroker(positions=[long_position()])
        learning = FakeLearning()
        core = build_core(
            risk_manager=risk_manager,
            broker=broker,
            analyzer=FakeAnalyzer(signal=make_signal(action="sell", side="short")),
            on_event=events.append,
            learning=learning,
            audit=audit,
        )
        await core.evaluate_symbol(1, "BTC/USDT", "timer")
        assert len(broker.orders) == 1
        assert broker.orders[0].action == "close"
        assert broker.orders[0].side == "long"
        assert any(e.type == "trade_close" for e in events)
        assert len(learning.closed) == 1
        assert any(name == "trade_close" for name, _ in audit.calls)

    @pytest.mark.asyncio
    async def test_dup_skip_on_close(self, risk_manager: RiskManager) -> None:
        events: list[Any] = []
        broker = FakeBroker(positions=[long_position()])
        core = build_core(
            risk_manager=risk_manager,
            broker=broker,
            analyzer=FakeAnalyzer(signal=make_signal(action="sell", side="short")),
            on_event=events.append,
        )
        lock = core._deps.lock_store
        assert await lock.acquire("trade:1:BTC/USDT:long", 30_000)
        await core.evaluate_symbol(1, "BTC/USDT", "timer")
        assert broker.orders == []
        assert any(e.type == "dup_skip" for e in events)


class TestEvents:
    @pytest.mark.asyncio
    async def test_on_candle_close(self, risk_manager: RiskManager) -> None:
        analyzer = FakeAnalyzer()
        core = build_core(
            risk_manager=risk_manager, analyzer=analyzer, user_ids=[1, 2]
        )
        await core.on_candle_close("BTC/USDT")
        assert len(analyzer.calls) == 2

    @pytest.mark.asyncio
    async def test_on_candle_close_resolver_error(
        self, risk_manager: RiskManager
    ) -> None:
        def boom() -> list[int]:
            raise RuntimeError("db down")

        core = build_core(risk_manager=risk_manager, resolve_user_ids=boom)
        await core.on_candle_close("BTC/USDT")

    @pytest.mark.asyncio
    async def test_sharp_move_below_threshold_ignored(
        self, risk_manager: RiskManager
    ) -> None:
        analyzer = FakeAnalyzer()
        core = build_core(risk_manager=risk_manager, analyzer=analyzer)
        await core.on_sharp_move("BTC/USDT", 1.5)
        assert analyzer.calls == []

    @pytest.mark.asyncio
    async def test_sharp_move_above_threshold_runs(
        self, risk_manager: RiskManager
    ) -> None:
        analyzer = FakeAnalyzer(signal=make_signal())
        core = build_core(risk_manager=risk_manager, analyzer=analyzer)
        await core.on_sharp_move("BTC/USDT", -3.0)
        assert len(analyzer.calls) == 1

    @pytest.mark.asyncio
    async def test_candle_close_respects_symbol_whitelist(
        self, risk_manager: RiskManager
    ) -> None:
        await risk_manager.update_settings(
            1, TradingSettingsPatch(symbols=["ETH/USDT"])
        )
        analyzer = FakeAnalyzer()
        core = build_core(risk_manager=risk_manager, analyzer=analyzer, user_ids=[1])
        await core.on_candle_close("BTC/USDT")
        assert analyzer.calls == []

    @pytest.mark.asyncio
    async def test_audit_trade_events_fired(self, risk_manager: RiskManager) -> None:
        audit = RecordingAudit()
        broker = FakeBroker()
        core = build_core(
            risk_manager=risk_manager,
            broker=broker,
            analyzer=FakeAnalyzer(signal=make_signal()),
            audit=audit,
        )
        await core.evaluate_symbol(1, "BTC/USDT", "timer")
        names = [name for name, _ in audit.calls]
        assert "trade_open" in names


async def _wait_for(predicate: Any, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("timeout ожидания условия")
        await asyncio.sleep(0.01)