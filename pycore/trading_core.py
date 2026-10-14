from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, Protocol, Sequence
from uuid import uuid4

from .broker import BaseBroker, OrderExecutor
from .lock import LockStore
from .models import (
    AnalyzeResult,
    BrokerSnapshot,
    Candle,
    EngineEvent,
    OpenPosition,
    OrderRequest,
    PositionSide,
    TradeSignal,
    utc_now_iso,
)
from .risk_manager import AuditService, RiskManager
from .settings import is_symbol_allowed

DEFAULT_DECISION_INTERVAL_MS = 60_000
DEFAULT_LOCK_TTL_MS = 30_000

SHARP_MOVE_THRESHOLD_PERCENT = 2


class MarketDataProvider(Protocol):
    async def get_candles(self, symbol: str, timeframe: str, limit: int) -> list[Candle]: ...


class AiAnalyzer(Protocol):
    async def analyze_signal(self, *, user_id: int, symbol: str) -> AnalyzeResult: ...


class LearningRecorder(Protocol):
    async def record_trade_open(
        self,
        *,
        user_id: int,
        symbol: str,
        side: PositionSide,
        market: Any,
        signal: TradeSignal,
        entry_price: float,
        quantity: float,
        opened_at: str,
    ) -> None: ...

    async def record_trade_close(
        self,
        *,
        user_id: int,
        symbol: str,
        side: PositionSide,
        exit_price: float,
        closed_at: str,
    ) -> None: ...


ResolveBroker = Callable[[int], Awaitable[BaseBroker | None]]
ResolveUserIds = Callable[[], Awaitable[list[int]]]
NotifyAdmin = Callable[[int, str], Awaitable[Any] | Any]
GlobalPaused = Callable[[], Awaitable[bool] | bool]


class TradingCoreDeps:
    def __init__(
        self,
        *,
        risk_manager: RiskManager,
        executor: OrderExecutor,
        lock_store: LockStore,
        analyzer: AiAnalyzer,
        market_data: MarketDataProvider,
        resolve_broker: ResolveBroker,
        resolve_user_ids: ResolveUserIds,
        supported_symbols: Sequence[str],
        notify_admin: NotifyAdmin | None = None,
        decision_interval_ms: int = DEFAULT_DECISION_INTERVAL_MS,
        lock_ttl_ms: int = DEFAULT_LOCK_TTL_MS,
        on_event: Callable[[EngineEvent], None] | None = None,
        is_global_paused: GlobalPaused | None = None,
        audit: AuditService | None = None,
        learning: LearningRecorder | None = None,
    ) -> None:
        self.risk_manager = risk_manager
        self.executor = executor
        self.lock_store = lock_store
        self.analyzer = analyzer
        self.market_data = market_data
        self.resolve_broker = resolve_broker
        self.resolve_user_ids = resolve_user_ids
        self.supported_symbols = list(supported_symbols)
        self.notify_admin = notify_admin
        self.decision_interval_ms = decision_interval_ms
        self.lock_ttl_ms = lock_ttl_ms
        self.on_event = on_event
        self.is_global_paused = is_global_paused
        self.audit = audit
        self.learning = learning


def _round_quantity(value: float) -> float:
    if value <= 0:
        return 0.0
    return round(value * 10_000) / 10_000


def _create_request_id() -> str:
    return uuid4().hex


def _make_event(
    event_type: str,
    user_id: int,
    symbol: str,
    message: str,
    data: dict[str, Any] | None = None,
    request_id: str | None = None,
) -> EngineEvent:
    return EngineEvent(
        type=event_type,
        user_id=user_id,
        symbol=symbol,
        message=message,
        data=data,
        request_id=request_id,
        at=utc_now_iso(),
    )


def _lock_key(user_id: int, symbol: str, direction: PositionSide) -> str:
    return f"trade:{user_id}:{symbol}:{direction}"


def _signal_to_side(signal: TradeSignal) -> PositionSide | None:
    if signal.action == "buy" and signal.side == "long":
        return "long"
    if signal.action == "sell" and signal.side == "short":
        return "short"
    return None


def _format_signal(signal: TradeSignal) -> str:
    return (
        f"AI: сигнал {signal.action}/{signal.side}, "
        f"уверенность {signal.confidence}%, риск {signal.risk_percent}%"
    )


def _error_message(error: Any) -> str:
    return str(error) if not isinstance(error, BaseException) else str(error)


class TradingCore:
    def __init__(self, deps: TradingCoreDeps) -> None:
        self._deps = deps
        self._decision_interval_ms = deps.decision_interval_ms
        self._lock_ttl_ms = deps.lock_ttl_ms
        self._supported_symbols = deps.supported_symbols
        self._running = False
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.get_event_loop().create_task(self._pump())

    def stop_pumping(self) -> None:
        self._running = False
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self._task = None

    async def _pump(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(self._decision_interval_ms / 1000)
            except asyncio.CancelledError:
                break
            if self._running:
                await self.tick()

    async def tick(self) -> None:
        try:
            user_ids = await self._deps.resolve_user_ids()
        except Exception:
            return
        for user_id in user_ids:
            symbols = await self._symbols_for_user(user_id)
            for symbol in symbols:
                await self.evaluate_symbol(user_id, symbol, "timer")

    async def on_candle_close(self, symbol: str, timeframe: str | None = None) -> None:
        await self._run_for_event(symbol, "candle_close")

    async def on_sharp_move(self, symbol: str, percent: float) -> None:
        if abs(percent) < SHARP_MOVE_THRESHOLD_PERCENT:
            return
        await self._run_for_event(symbol, "sharp_move")

    async def _run_for_event(self, symbol: str, source: str) -> None:
        try:
            user_ids = await self._deps.resolve_user_ids()
        except Exception:
            return
        for user_id in user_ids:
            settings = await self._deps.risk_manager.get_settings(user_id)
            if is_symbol_allowed(settings, symbol):
                await self.evaluate_symbol(user_id, symbol, source)

    async def _symbols_for_user(self, user_id: int) -> list[str]:
        settings = await self._deps.risk_manager.get_settings(user_id)
        if settings.symbols:
            return [s for s in self._supported_symbols if is_symbol_allowed(settings, s)]
        return list(self._supported_symbols)

    def _emit(self, event: EngineEvent) -> None:
        if self._deps.on_event is not None:
            self._deps.on_event(event)

    async def evaluate_symbol(
        self, user_id: int, symbol: str, source: str
    ) -> list[EngineEvent]:
        norm_symbol = symbol.strip().upper()
        request_id = _create_request_id()
        events: list[EngineEvent] = []

        if await self._is_global_paused():
            return events

        broker = await self._deps.resolve_broker(user_id)
        if broker is None:
            return events

        settings = await self._deps.risk_manager.get_settings(user_id)
        if not is_symbol_allowed(settings, norm_symbol):
            return events

        snapshot = await self._build_snapshot(broker)
        existing = self._find_position(snapshot.positions, norm_symbol)

        try:
            analysis = await self._deps.analyzer.analyze_signal(
                user_id=user_id, symbol=norm_symbol
            )
        except Exception as error:
            return await self._push_error(
                events,
                user_id,
                norm_symbol,
                "Ошибка AI-анализа",
                error,
                request_id,
            )

        signal = analysis.decision
        if signal is None:
            self._emit(
                _make_event(
                    "signal",
                    user_id,
                    norm_symbol,
                    "AI: нет сигнала (hold/невалидный ответ)",
                    {"source": source, "request_id": request_id},
                    request_id,
                )
            )
            return events
        self._emit(
            _make_event(
                "signal",
                user_id,
                norm_symbol,
                _format_signal(signal),
                {"source": source, "confidence": signal.confidence, "request_id": request_id},
                request_id,
            )
        )

        open_side = _signal_to_side(signal)

        if existing is not None:
            if (
                signal.action == "hold"
                or open_side is None
                or open_side == existing.side
            ):
                return events
            close_key = _lock_key(user_id, norm_symbol, existing.side)
            if not await self._deps.lock_store.acquire(close_key, self._lock_ttl_ms):
                self._emit(
                    _make_event(
                        "dup_skip",
                        user_id,
                        norm_symbol,
                        "Пропуск: ордер на закрытие уже исполняется",
                        {"source": source, "request_id": request_id},
                        request_id,
                    )
                )
                return events
            try:
                receipt = await self._deps.executor.execute(
                    broker,
                    OrderRequest(
                        symbol=norm_symbol,
                        side=existing.side,
                        action="close",
                        quantity=existing.quantity,
                    ),
                )
                self._emit(
                    _make_event(
                        "trade_close",
                        user_id,
                        norm_symbol,
                        f"Позиция закрыта по {receipt.executed_price}",
                        {"source": source, "request_id": request_id},
                        request_id,
                    )
                )
                if self._deps.audit is not None:
                    await self._deps.audit.trade_close(
                        user_id=user_id,
                        actor_role="system",
                        request_id=request_id,
                        entity_type="order",
                        entity_id=receipt.order_id,
                        details={
                            "symbol": norm_symbol,
                            "side": existing.side,
                            "action": "close",
                            "quantity": existing.quantity,
                            "price": receipt.executed_price,
                            "executed_at": receipt.executed_at,
                            "source": source,
                        },
                    )
                if self._deps.learning is not None:
                    await self._deps.learning.record_trade_close(
                        user_id=user_id,
                        symbol=norm_symbol,
                        side=existing.side,
                        exit_price=receipt.executed_price,
                        closed_at=receipt.executed_at,
                    )
            except Exception as error:
                await self._push_error(
                    events,
                    user_id,
                    norm_symbol,
                    "Ошибка закрытия позиции",
                    error,
                    request_id,
                )
            finally:
                await self._deps.lock_store.release(close_key)
            return events

        if signal.action == "hold" or open_side is None:
            return events

        key = _lock_key(user_id, norm_symbol, open_side)
        if not await self._deps.lock_store.acquire(key, self._lock_ttl_ms):
            self._emit(
                _make_event(
                    "dup_skip",
                    user_id,
                    norm_symbol,
                    f"Пропуск: блокировка {norm_symbol}/{open_side} уже занята",
                    {"source": source, "request_id": request_id},
                    request_id,
                )
            )
            return events

        try:
            price = await self._current_price(norm_symbol, signal.entry_price)
            notional = price * 1
            decision = await self._deps.risk_manager.check_open_trade(
                user_id,
                norm_symbol,
                open_side,
                notional,
                snapshot,
                settings,
            )

            if not decision.allow:
                block_event = _make_event(
                    "risk_block",
                    user_id,
                    norm_symbol,
                    decision.reason if decision.reason is not None else "блокировка",
                    {
                        "code": decision.code,
                        "source": source,
                        "snapshot": self._redact_snapshot(snapshot),
                        "request_id": request_id,
                    },
                    request_id,
                )
                self._emit(block_event)
                if self._deps.audit is not None:
                    await self._deps.audit.trade_rejected(
                        user_id=user_id,
                        actor_role="system",
                        request_id=request_id,
                        entity_type="order",
                        entity_id=norm_symbol,
                        details={
                            "symbol": norm_symbol,
                            "side": open_side,
                            "code": decision.code,
                            "reason": decision.reason,
                            "source": source,
                        },
                    )
                if decision.code == "total_stop":
                    fresh_snapshot = await self._build_snapshot(broker)
                    needs_notify = await self._deps.risk_manager.check_total_stop_notification(
                        user_id, fresh_snapshot
                    )
                    if needs_notify:
                        message = (
                            "ВНИМАНИЕ: торговля пользователя "
                            f"{user_id} остановлена — превышена общая просадка."
                        )
                        if self._deps.notify_admin is not None:
                            await self._call_notify_admin(user_id, message)
                        self._emit(
                            _make_event(
                                "admin_notify",
                                user_id,
                                norm_symbol,
                                message,
                                {"source": source, "request_id": request_id},
                                request_id,
                            )
                        )
                        if self._deps.audit is not None:
                            await self._deps.audit.risk_state(
                                action="trading.admin_notify",
                                user_id=user_id,
                                actor_role="system",
                                request_id=request_id,
                                entity_type="trading_state",
                                entity_id=user_id,
                                details={"message": message, "source": source},
                            )
                            await self._deps.audit.risk_state(
                                action="trading.total_stop",
                                user_id=user_id,
                                actor_role="system",
                                request_id=request_id,
                                entity_type="trading_state",
                                entity_id=user_id,
                                details={"source": source},
                            )
                return events

            budget = min(
                decision.max_trade_notional, snapshot.account.available_cash
            )
            quantity = _round_quantity(budget / price)
            if quantity <= 0:
                self._emit(
                    _make_event(
                        "risk_block",
                        user_id,
                        norm_symbol,
                        "Недостаточно средств для минимального объёма",
                        {"code": "margin_insufficient", "source": source, "request_id": request_id},
                        request_id,
                    )
                )
                if self._deps.audit is not None:
                    await self._deps.audit.trade_rejected(
                        user_id=user_id,
                        actor_role="system",
                        request_id=request_id,
                        entity_type="order",
                        entity_id=norm_symbol,
                        details={
                            "symbol": norm_symbol,
                            "side": open_side,
                            "code": "margin_insufficient",
                            "source": source,
                        },
                    )
                return events

            receipt = await self._deps.executor.execute(
                broker,
                OrderRequest(
                    symbol=norm_symbol,
                    side=open_side,
                    action="open",
                    quantity=quantity,
                    price=price,
                ),
            )
            await self._deps.risk_manager.record_opened_trade(user_id)
            self._emit(
                _make_event(
                    "trade_open",
                    user_id,
                    norm_symbol,
                    f"Открыта позиция {open_side} {quantity} по {receipt.executed_price}",
                    {"source": source, "request_id": request_id},
                    request_id,
                )
            )
            if self._deps.audit is not None:
                await self._deps.audit.trade_open(
                    user_id=user_id,
                    actor_role="system",
                    request_id=request_id,
                    entity_type="order",
                    entity_id=receipt.order_id,
                    details={
                        "symbol": norm_symbol,
                        "side": open_side,
                        "action": "open",
                        "quantity": quantity,
                        "price": receipt.executed_price,
                        "executed_at": receipt.executed_at,
                        "source": source,
                        "signal": {
                            "action": signal.action,
                            "confidence": signal.confidence,
                            "risk_percent": signal.risk_percent,
                        },
                    },
                )
            if self._deps.learning is not None:
                await self._deps.learning.record_trade_open(
                    user_id=user_id,
                    symbol=norm_symbol,
                    side=open_side,
                    market=analysis.market,
                    signal=signal,
                    entry_price=receipt.executed_price,
                    quantity=quantity,
                    opened_at=receipt.executed_at,
                )
        except Exception as error:
            await self._push_error(
                events,
                user_id,
                norm_symbol,
                "Ошибка исполнения ордера",
                error,
                request_id,
            )
        finally:
            await self._deps.lock_store.release(key)

        return events

    async def _is_global_paused(self) -> bool:
        if self._deps.is_global_paused is None:
            return False
        result = self._deps.is_global_paused()
        if asyncio.iscoroutine(result):
            return bool(await result)
        return bool(result)

    async def _call_notify_admin(self, user_id: int, message: str) -> None:
        if self._deps.notify_admin is None:
            return
        result = self._deps.notify_admin(user_id, message)
        if asyncio.iscoroutine(result):
            await result

    async def _build_snapshot(self, broker: BaseBroker) -> BrokerSnapshot:
        account = await broker.get_account()
        positions = await broker.get_positions()
        return BrokerSnapshot(account=account, positions=positions)

    def _find_position(
        self, positions: list[OpenPosition], symbol: str
    ) -> OpenPosition | None:
        return next(
            (p for p in positions if p.symbol.upper() == symbol),
            None,
        )

    async def _current_price(
        self, symbol: str, signal_price: float | None
    ) -> float:
        if signal_price is not None and signal_price > 0:
            return signal_price
        try:
            candles = await self._deps.market_data.get_candles(symbol, "1h", 2)
            last = candles[-1] if candles else None
            if last is not None:
                return last.close
        except Exception:
            pass
        return 1.0

    async def _push_error(
        self,
        events: list[EngineEvent],
        user_id: int,
        symbol: str,
        prefix: str,
        error: Any,
        request_id: str | None,
    ) -> list[EngineEvent]:
        message = f"{prefix}: {_error_message(error)}"
        event = _make_event("error", user_id, symbol, message, None, request_id)
        self._emit(event)
        events.append(event)
        if self._deps.audit is not None:
            await self._deps.audit.trade_error(
                user_id=user_id,
                actor_role="system",
                request_id=request_id,
                entity_type="order",
                entity_id=symbol,
                details={"symbol": symbol, "error": message},
            )
        return events

    def _redact_snapshot(self, snapshot: BrokerSnapshot) -> dict[str, Any]:
        return {
            "balance": snapshot.account.balance,
            "positions": len(snapshot.positions),
        }