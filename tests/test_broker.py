from __future__ import annotations

import pytest

from pycore.broker import (
    OrderExecutionError,
    OrderExecutor,
    StubBroker,
)
from pycore.models import OrderRequest


class TestStubBroker:
    async def test_account_and_connection(self) -> None:
        broker = StubBroker(balance=5_000, available_cash=3_000)
        account = await broker.test_connection()
        assert account.balance == 5_000
        assert account.available_cash == 3_000

    async def test_execute_open_adds_position(self) -> None:
        broker = StubBroker()
        receipt = await broker.execute_order(
            OrderRequest(
                symbol="BTC/USDT",
                side="long",
                action="open",
                quantity=0.5,
                price=100,
            )
        )
        assert receipt.action == "open"
        assert receipt.status == "filled"
        assert len(await broker.get_positions()) == 1

    async def test_execute_close_removes_position(self) -> None:
        broker = StubBroker()
        await broker.execute_order(
            OrderRequest(
                symbol="BTC/USDT",
                side="long",
                action="open",
                quantity=0.5,
                price=100,
            )
        )
        await broker.execute_order(
            OrderRequest(symbol="BTC/USDT", side="long", action="close", quantity=0.5)
        )
        assert await broker.get_positions() == []


class FakeFlakyBroker(StubBroker):
    def __init__(self, fail_times: int = 1) -> None:
        super().__init__()
        self.fail_times = fail_times

    async def execute_order(self, order: OrderRequest):
        if self.fail_times > 0:
            self.fail_times -= 1
            raise RuntimeError("временный сбой брокера")
        return await super().execute_order(order)


class TestOrderExecutor:
    async def test_succeeds_on_first_try(self) -> None:
        broker = StubBroker()
        executor = OrderExecutor(sleep=noop_sleep)
        receipt = await executor.execute(
            broker,
            OrderRequest(
                symbol="BTC/USDT", side="long", action="open", quantity=1, price=100
            ),
        )
        assert receipt.status == "filled"

    async def test_retries_then_succeeds(self) -> None:
        broker = FakeFlakyBroker(fail_times=2)
        sleeps: list[float] = []
        async def record_sleep(ms: float) -> None:
            sleeps.append(ms)

        executor = OrderExecutor(sleep=record_sleep, max_retries=3)
        receipt = await executor.execute(
            broker,
            OrderRequest(
                symbol="BTC/USDT", side="long", action="open", quantity=1, price=100
            ),
        )
        assert receipt.status == "filled"
        assert len(sleeps) == 2

    async def test_raises_after_max_retries(self) -> None:
        broker = FakeFlakyBroker(fail_times=99)
        executor = OrderExecutor(sleep=noop_sleep, max_retries=2)
        with pytest.raises(OrderExecutionError) as exc_info:
            await executor.execute(
                broker,
                OrderRequest(
                    symbol="BTC/USDT", side="long", action="open", quantity=1, price=100
                ),
            )
        assert exc_info.value.attempts == 2


async def noop_sleep(_: float) -> None:
    return None