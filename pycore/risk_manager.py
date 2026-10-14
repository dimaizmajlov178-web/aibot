from __future__ import annotations

from typing import Any, Literal, Protocol

from .models import (
    BrokerSnapshot,
    PositionSide,
    RiskDecision,
    TradingSettings,
    TradingSettingsPatch,
    TradingState,
    utc_now_iso,
    utc_today,
)
from .settings import (
    TradingSettingsDefaults,
    apply_settings_patch,
    default_settings,
    is_symbol_allowed,
)

RiskBlockCode = Literal[
    "paused",
    "auto_daily_paused",
    "total_stop",
    "symbol_not_whitelisted",
    "max_positions_reached",
    "daily_trade_limit_reached",
    "risk_per_trade_exceeded",
    "margin_insufficient",
]

AUDIT_FIELDS = [
    "risk_per_trade_percent",
    "max_positions",
    "daily_trade_limit",
    "max_daily_drawdown_percent",
    "max_total_drawdown_percent",
    "symbols",
    "ai_mode",
]

SettingsAuditKwargs = dict[str, Any]


class AuditService(Protocol):
    async def settings_update(
        self,
        *,
        user_id: int,
        actor_id: int,
        actor_role: str,
        request_id: str | None,
        entity_type: str,
        entity_id: int | str,
        details: SettingsAuditKwargs,
    ) -> None: ...

    async def trading_control(
        self,
        *,
        action: str,
        user_id: int,
        actor_id: int,
        actor_role: str,
        request_id: str | None,
        entity_type: str,
        entity_id: int | str,
        details: SettingsAuditKwargs,
    ) -> None: ...

    async def trade_open(
        self,
        *,
        user_id: int,
        actor_role: str,
        request_id: str | None,
        entity_type: str,
        entity_id: int | str,
        details: SettingsAuditKwargs,
    ) -> None: ...

    async def trade_close(
        self,
        *,
        user_id: int,
        actor_role: str,
        request_id: str | None,
        entity_type: str,
        entity_id: int | str,
        details: SettingsAuditKwargs,
    ) -> None: ...

    async def trade_rejected(
        self,
        *,
        user_id: int,
        actor_role: str,
        request_id: str | None,
        entity_type: str,
        entity_id: int | str,
        details: SettingsAuditKwargs,
    ) -> None: ...

    async def trade_error(
        self,
        *,
        user_id: int,
        actor_role: str,
        request_id: str | None,
        entity_type: str,
        entity_id: int | str,
        details: SettingsAuditKwargs,
    ) -> None: ...

    async def risk_state(
        self,
        *,
        action: str,
        user_id: int,
        actor_role: str,
        request_id: str | None,
        entity_type: str,
        entity_id: int | str,
        details: SettingsAuditKwargs,
    ) -> None: ...


class NullAuditService:
    async def settings_update(self, **_: Any) -> None:
        return None

    async def trading_control(self, **_: Any) -> None:
        return None

    async def trade_open(self, **_: Any) -> None:
        return None

    async def trade_close(self, **_: Any) -> None:
        return None

    async def trade_rejected(self, **_: Any) -> None:
        return None

    async def trade_error(self, **_: Any) -> None:
        return None

    async def risk_state(self, **_: Any) -> None:
        return None


class TradingSettingsRepository(Protocol):
    async def get(self, user_id: int) -> TradingSettings | None: ...

    async def save(self, settings: TradingSettings) -> None: ...


class TradingStateRepository(Protocol):
    async def get(self, user_id: int) -> TradingState | None: ...

    async def save(self, state: TradingState) -> None: ...


class MemorySettingsRepository:
    def __init__(self) -> None:
        self._data: dict[int, TradingSettings] = {}

    async def get(self, user_id: int) -> TradingSettings | None:
        return self._data.get(user_id)

    async def save(self, settings: TradingSettings) -> None:
        self._data[settings.user_id] = settings


class MemoryStateRepository:
    def __init__(self) -> None:
        self._data: dict[int, TradingState] = {}

    async def get(self, user_id: int) -> TradingState | None:
        return self._data.get(user_id)

    async def save(self, state: TradingState) -> None:
        self._data[state.user_id] = state


def ai_mode_multiplier(ai_mode: str) -> float:
    return {"safe": 0.5, "aggressive": 1.5}.get(ai_mode, 1.0)


def create_default_state(user_id: int) -> TradingState:
    return TradingState(
        user_id=user_id,
        paused=False,
        paused_at=None,
        auto_daily_paused=False,
        auto_daily_pause_date=None,
        total_stop_triggered=False,
        total_stop_triggered_at=None,
        admin_notified_for_total_stop=False,
        trades_today=0,
        trading_day=utc_today(),
        updated_at=utc_now_iso(),
    )


class RiskManager:
    def __init__(
        self,
        settings: TradingSettingsRepository,
        state: TradingStateRepository,
        audit: AuditService | None = None,
        defaults: TradingSettingsDefaults | None = None,
    ) -> None:
        self._settings_repo = settings
        self._state_repo = state
        self._audit = audit
        self._defaults = defaults

    async def get_settings(self, user_id: int) -> TradingSettings:
        existing = await self._settings_repo.get(user_id)
        if existing is not None:
            return existing
        settings = default_settings(user_id, self._defaults)
        await self._settings_repo.save(settings)
        return settings

    async def update_settings(
        self,
        user_id: int,
        patch: TradingSettingsPatch,
        *,
        actor_id: int | None = None,
        actor_role: str = "user",
        request_id: str | None = None,
    ) -> TradingSettings:
        current = await self.get_settings(user_id)
        merged = apply_settings_patch(current, patch)
        parsed = TradingSettings.model_validate(merged.model_dump())
        await self._settings_repo.save(parsed)

        if self._audit is not None:
            changed = [
                field
                for field in AUDIT_FIELDS
                if getattr(current, field) != getattr(parsed, field)
            ]
            details: SettingsAuditKwargs = {"changed_fields": changed}
            for field in changed:
                details[field] = {
                    "before": getattr(current, field),
                    "after": getattr(parsed, field),
                }
            await self._audit.settings_update(
                user_id=user_id,
                actor_id=actor_id if actor_id is not None else user_id,
                actor_role=actor_role,
                request_id=request_id,
                entity_type="trading_settings",
                entity_id=user_id,
                details=details,
            )
        return parsed

    async def get_state(self, user_id: int) -> TradingState:
        current = await self._state_repo.get(user_id)
        state = current if current is not None else create_default_state(user_id)
        return self._rollover_day(state)

    def _rollover_day(self, state: TradingState) -> TradingState:
        today = utc_today()
        if state.trading_day != today:
            return state.model_copy(
                update={
                    "trading_day": today,
                    "trades_today": 0,
                    "auto_daily_paused": False,
                    "auto_daily_pause_date": None,
                    "updated_at": utc_now_iso(),
                }
            )
        return state

    async def _persist(self, state: TradingState) -> TradingState:
        rolled = self._rollover_day(state)
        await self._state_repo.save(rolled)
        return rolled

    async def pause(
        self,
        user_id: int,
        *,
        actor_id: int | None = None,
        actor_role: str = "user",
        request_id: str | None = None,
    ) -> TradingState:
        state = await self.get_state(user_id)
        updated = state.model_copy(update={"paused": True, "paused_at": utc_now_iso()})
        persisted = await self._persist(updated)
        if self._audit is not None:
            await self._audit.trading_control(
                action="trading.pause",
                user_id=user_id,
                actor_id=actor_id if actor_id is not None else user_id,
                actor_role=actor_role,
                request_id=request_id,
                entity_type="trading_state",
                entity_id=user_id,
                details={"paused_at": updated.paused_at},
            )
        return persisted

    async def resume(
        self,
        user_id: int,
        *,
        actor_id: int | None = None,
        actor_role: str = "user",
        request_id: str | None = None,
    ) -> TradingState:
        state = await self.get_state(user_id)
        updated = state.model_copy(
            update={
                "paused": False,
                "paused_at": None,
                "auto_daily_paused": False,
                "auto_daily_pause_date": None,
            }
        )
        persisted = await self._persist(updated)
        if self._audit is not None:
            await self._audit.trading_control(
                action="trading.resume",
                user_id=user_id,
                actor_id=actor_id if actor_id is not None else user_id,
                actor_role=actor_role,
                request_id=request_id,
                entity_type="trading_state",
                entity_id=user_id,
                details={"resumed_at": persisted.updated_at},
            )
        return persisted

    async def record_opened_trade(self, user_id: int) -> TradingState:
        state = await self.get_state(user_id)
        updated = state.model_copy(update={"trades_today": state.trades_today + 1})
        return await self._persist(updated)

    async def check_total_stop_notification(
        self, user_id: int, snapshot: BrokerSnapshot
    ) -> bool:
        settings = await self.get_settings(user_id)
        state = await self.get_state(user_id)
        if (
            snapshot.account.total_pnl_percent <= -settings.max_total_drawdown_percent
            and not state.admin_notified_for_total_stop
        ):
            await self._persist(state.model_copy(update={"admin_notified_for_total_stop": True}))
            return True
        return False

    async def check_open_trade(
        self,
        user_id: int,
        symbol: str,
        side: PositionSide,
        order_notional: float,
        snapshot: BrokerSnapshot,
        settings: TradingSettings | None = None,
    ) -> RiskDecision:
        resolved = settings if settings is not None else await self.get_settings(user_id)
        state = await self.get_state(user_id)

        state, _, total_stop_triggered = await self._evaluate_drawdown(
            user_id, snapshot, state
        )

        if total_stop_triggered:
            return self._blocked(
                "total_stop", "Торговля остановлена: превышена общая просадка"
            )

        if state.auto_daily_paused:
            return self._blocked(
                "auto_daily_paused",
                "Автопауза: превышена дневная просадка, торговля возобновится завтра",
            )

        if state.paused:
            return self._blocked("paused", "Торговля на паузе. Возобновить: /resume")

        if not is_symbol_allowed(resolved, symbol):
            return self._blocked("symbol_not_whitelisted", f"Символ {symbol} не разрешён настройками")

        if state.trades_today >= resolved.daily_trade_limit:
            return self._blocked(
                "daily_trade_limit_reached",
                f"Достигнут лимит сделок за день: {resolved.daily_trade_limit}",
            )

        if len(snapshot.positions) >= resolved.max_positions:
            return self._blocked(
                "max_positions_reached",
                f"Достигнут максимум открытых позиций: {resolved.max_positions}",
            )

        effective_risk_percent = min(
            resolved.risk_per_trade_percent * ai_mode_multiplier(resolved.ai_mode),
            resolved.risk_per_trade_percent,
        )
        max_trade_notional = snapshot.account.balance * effective_risk_percent / 100
        if order_notional > max_trade_notional:
            return self._blocked(
                "risk_per_trade_exceeded",
                f"Объём {order_notional:.2f} превышает риск на сделку {max_trade_notional:.2f}",
            )

        if order_notional > snapshot.account.available_cash:
            return self._blocked(
                "margin_insufficient", "Недостаточно свободных средств (маржа) для позиции"
            )

        return RiskDecision(
            allow=True,
            code=None,
            reason=None,
            effective_risk_percent=effective_risk_percent,
            max_trade_notional=max_trade_notional,
            state=state,
        )

    async def _evaluate_drawdown(
        self,
        user_id: int,
        snapshot: BrokerSnapshot,
        state_in: TradingState,
    ) -> tuple[TradingState, bool, bool]:
        settings = await self.get_settings(user_id)
        max_daily = settings.max_daily_drawdown_percent
        max_total = settings.max_total_drawdown_percent
        state = self._rollover_day(state_in)
        auto_daily_paused = state.auto_daily_paused
        total_stop_triggered = state.total_stop_triggered

        total_pnl_percent = snapshot.account.total_pnl_percent
        if total_pnl_percent <= -max_total and not state.total_stop_triggered:
            total_stop_triggered = True
            state = state.model_copy(
                update={
                    "total_stop_triggered": True,
                    "total_stop_triggered_at": utc_now_iso(),
                }
            )

        daily_pnl_percent = snapshot.account.daily_pnl_percent
        if (
            not total_stop_triggered
            and daily_pnl_percent <= -max_daily
            and not state.auto_daily_paused
        ):
            auto_daily_paused = True
            state = state.model_copy(
                update={
                    "auto_daily_paused": True,
                    "auto_daily_pause_date": utc_today(),
                }
            )

        if state != state_in:
            await self._persist(state)

        return state, auto_daily_paused, total_stop_triggered

    def _blocked(self, code: RiskBlockCode, reason: str) -> RiskDecision:
        return RiskDecision(
            allow=False,
            code=code,
            reason=reason,
            effective_risk_percent=0.0,
            max_trade_notional=0.0,
            state=create_default_state(0),
        )