from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod

from .models import (
    BrokerAccount,
    BrokerStats,
    ClosedTrade,
    OpenPosition,
    OrderReceipt,
    OrderRequest,
    utc_now_iso,
)


class BaseBroker(ABC):
    name: str

    @abstractmethod
    async def test_connection(self) -> BrokerAccount: ...

    @abstractmethod
    async def get_account(self) -> BrokerAccount: ...

    @abstractmethod
    async def get_positions(self) -> list[OpenPosition]: ...

    @abstractmethod
    async def get_closed_trades(self, limit: int | None = None) -> list[ClosedTrade]: ...

    @abstractmethod
    async def get_stats(self) -> BrokerStats: ...

    @abstractmethod
    async def execute_order(self, order: OrderRequest) -> OrderReceipt: ...


class StubBroker(BaseBroker):
    name = "stub"

    def __init__(
        self, balance: float = 10_000, available_cash: float | None = None
    ) -> None:
        self._balance = balance
        self._available_cash = available_cash if available_cash is not None else balance
        self._positions: list[OpenPosition] = []

    async def test_connection(self) -> BrokerAccount:
        return self._account()

    async def get_account(self) -> BrokerAccount:
        return self._account()

    async def get_positions(self) -> list[OpenPosition]:
        return list(self._positions)

    async def get_closed_trades(self, limit: int | None = None) -> list[ClosedTrade]:
        return []

    async def get_stats(self) -> BrokerStats:
        return BrokerStats()

    async def execute_order(self, order: OrderRequest) -> OrderReceipt:
        price = order.price if order.price and order.price > 0 else 100.0
        if order.action == "open":
            self._positions.append(
                OpenPosition(
                    symbol=order.symbol,
                    side=order.side,
                    quantity=order.quantity,
                    entry_price=price,
                    current_price=price,
                )
            )
        else:
            self._positions = [
                position
                for position in self._positions
                if not (position.symbol == order.symbol and position.side == order.side)
            ]
        return OrderReceipt(
            order_id=f"stub-{order.symbol}-{order.action}",
            symbol=order.symbol,
            side=order.side,
            action=order.action,
            quantity=order.quantity,
            executed_price=price,
            executed_at=utc_now_iso(),
        )

    def _account(self) -> BrokerAccount:
        return BrokerAccount(
            balance=self._balance,
            equity=self._balance,
            available_cash=self._available_cash,
            currency="USDT",
            open_positions=len(self._positions),
            daily_pnl=0.0,
            daily_pnl_percent=0.0,
            total_pnl=0.0,
            total_pnl_percent=0.0,
        )


class OrderExecutionError(Exception):
    def __init__(
        self,
        message: str,
        attempts: int,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message)
        self.attempts = attempts
        self.cause = cause


class OrderExecutor:
    default_max_retries = 3
    retry_base_delay_ms = 500

    def __init__(
        self,
        sleep: object | None = None,
        max_retries: int | None = None,
    ) -> None:
        self._sleep = sleep if sleep is not None else asyncio.sleep
        self._max_retries = max_retries or self.default_max_retries

    async def execute(self, broker: BaseBroker, order: OrderRequest) -> OrderReceipt:
        last_error: BaseException | None = None
        for attempt in range(1, self._max_retries + 1):
            try:
                return await broker.execute_order(order)
            except BaseException as error:
                last_error = error
                if attempt < self._max_retries:
                    await self._sleep(self.retry_base_delay_ms * attempt)
        message = str(last_error) if last_error is not None else "неизвестная ошибка"
        raise OrderExecutionError(
            f"Не удалось исполнить ордер {order.symbol} после "
            f"{self._max_retries} попыток: {message}",
            self._max_retries,
            last_error,
        )