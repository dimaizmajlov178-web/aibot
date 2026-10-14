from __future__ import annotations

import pytest

from pydantic import ValidationError

from pycore.models import (
    OpenPosition,
    TradingSettingsPatch,
    TradingState,
    utc_today,
)
from pycore.risk_manager import (
    MemoryStateRepository,
    RiskManager,
    ai_mode_multiplier,
    create_default_state,
)
from pycore.settings import (
    DEFAULT_AI_MODE,
    DEFAULT_DAILY_TRADE_LIMIT,
    DEFAULT_MAX_POSITIONS,
    DEFAULT_RISK_PER_TRADE_PERCENT,
)
from tests.conftest import RecordingAudit, default_snapshot


class TestDefaults:
    @pytest.mark.asyncio
    async def test_get_settings_creates_defaults(
        self, settings_repo, risk_manager: RiskManager
    ) -> None:
        settings = await risk_manager.get_settings(1)
        assert settings.user_id == 1
        assert settings.risk_per_trade_percent == DEFAULT_RISK_PER_TRADE_PERCENT
        assert settings.max_positions == DEFAULT_MAX_POSITIONS
        assert settings.daily_trade_limit == DEFAULT_DAILY_TRADE_LIMIT
        assert settings.ai_mode == DEFAULT_AI_MODE
        stored = await settings_repo.get(1)
        assert stored is not None

    def test_ai_mode_multiplier(self) -> None:
        assert ai_mode_multiplier("safe") == 0.5
        assert ai_mode_multiplier("aggressive") == 1.5
        assert ai_mode_multiplier("balanced") == 1.0

    def test_default_state(self) -> None:
        state = create_default_state(1)
        assert state.user_id == 1
        assert state.trades_today == 0
        assert not state.paused


class TestSettingsUpdate:
    @pytest.mark.asyncio
    async def test_update_settings_persists_and_audits(
        self, settings_repo, risk_manager: RiskManager
    ) -> None:
        audit = RecordingAudit()
        rm = RiskManager(
            settings=settings_repo, state=MemoryStateRepository(), audit=audit
        )
        updated = await rm.update_settings(
            1,
            TradingSettingsPatch(risk_per_trade_percent=2.0, ai_mode="safe"),
            actor_id=42,
            request_id="req-1",
        )
        assert updated.risk_per_trade_percent == 2.0
        assert updated.ai_mode == "safe"
        stored = await settings_repo.get(1)
        assert stored is not None
        assert stored.risk_per_trade_percent == 2.0
        assert any(name == "settings_update" for name, _ in audit.calls)

    @pytest.mark.asyncio
    async def test_update_settings_invalid_raises(self, risk_manager: RiskManager) -> None:
        with pytest.raises(ValidationError):
            await risk_manager.update_settings(
                1, TradingSettingsPatch(risk_per_trade_percent=100)
            )

    @pytest.mark.asyncio
    async def test_update_settings_normalizes_symbols(self, risk_manager: RiskManager) -> None:
        updated = await risk_manager.update_settings(
            1, TradingSettingsPatch(symbols=["  btc/usdt ", "ETH/USDT"])
        )
        assert updated.symbols == ["BTC/USDT", "ETH/USDT"]

    @pytest.mark.asyncio
    async def test_update_settings_without_audit(self, risk_manager: RiskManager) -> None:
        updated = await risk_manager.update_settings(
            1, TradingSettingsPatch(max_positions=5)
        )
        assert updated.max_positions == 5


class TestState:
    @pytest.mark.asyncio
    async def test_get_state_returns_default(self, risk_manager: RiskManager) -> None:
        state = await risk_manager.get_state(1)
        assert state.trades_today == 0

    @pytest.mark.asyncio
    async def test_rollover_resets_day_counters(
        self, state_repo, risk_manager: RiskManager
    ) -> None:
        yesterday = "2000-01-01"
        await state_repo.save(
            TradingState(
                user_id=1,
                trades_today=7,
                trading_day=yesterday,
                auto_daily_paused=True,
                auto_daily_pause_date=yesterday,
            )
        )
        state = await risk_manager.get_state(1)
        assert state.trades_today == 0
        assert not state.auto_daily_paused
        assert state.trading_day == utc_today()

    @pytest.mark.asyncio
    async def test_pause_and_resume(
        self, state_repo, risk_manager: RiskManager
    ) -> None:
        paused = await risk_manager.pause(1)
        assert paused.paused
        assert paused.paused_at is not None
        stored = await state_repo.get(1)
        assert stored is not None and stored.paused
        resumed = await risk_manager.resume(1)
        assert not resumed.paused
        assert resumed.paused_at is None

    @pytest.mark.asyncio
    async def test_record_opened_trade_increments(
        self, risk_manager: RiskManager
    ) -> None:
        state = await risk_manager.record_opened_trade(1)
        assert state.trades_today == 1


class TestTotalStopNotification:
    @pytest.mark.asyncio
    async def test_notifies_once(self, risk_manager: RiskManager) -> None:
        snapshot = default_snapshot(total_pnl_percent=-15)
        assert await risk_manager.check_total_stop_notification(1, snapshot) is True
        assert await risk_manager.check_total_stop_notification(1, snapshot) is False

    @pytest.mark.asyncio
    async def test_no_notification_when_pnl_ok(self, risk_manager: RiskManager) -> None:
        snapshot = default_snapshot(total_pnl_percent=-1)
        assert await risk_manager.check_total_stop_notification(1, snapshot) is False


class TestCheckOpenTrade:
    @pytest.mark.asyncio
    async def test_allows_within_limits(self, risk_manager: RiskManager) -> None:
        decision = await risk_manager.check_open_trade(
            1, "BTC/USDT", "long", 10.0, default_snapshot()
        )
        assert decision.allow
        assert decision.code is None
        assert decision.max_trade_notional == 10.0
        assert decision.effective_risk_percent == 1.0

    @pytest.mark.asyncio
    async def test_blocks_when_paused(self, risk_manager: RiskManager) -> None:
        await risk_manager.pause(1)
        decision = await risk_manager.check_open_trade(
            1, "BTC/USDT", "long", 1.0, default_snapshot()
        )
        assert not decision.allow
        assert decision.code == "paused"

    @pytest.mark.asyncio
    async def test_total_stop_blocks(self, risk_manager: RiskManager) -> None:
        decision = await risk_manager.check_open_trade(
            1,
            "BTC/USDT",
            "long",
            1.0,
            default_snapshot(total_pnl_percent=-15),
        )
        assert not decision.allow
        assert decision.code == "total_stop"

    @pytest.mark.asyncio
    async def test_daily_drawdown_auto_pause(self, risk_manager: RiskManager) -> None:
        decision = await risk_manager.check_open_trade(
            1,
            "BTC/USDT",
            "long",
            1.0,
            default_snapshot(daily_pnl_percent=-5),
        )
        assert not decision.allow
        assert decision.code == "auto_daily_paused"

    @pytest.mark.asyncio
    async def test_symbol_not_whitelisted(self, risk_manager: RiskManager) -> None:
        await risk_manager.update_settings(
            1, TradingSettingsPatch(symbols=["ETH/USDT"])
        )
        decision = await risk_manager.check_open_trade(
            1, "BTC/USDT", "long", 1.0, default_snapshot()
        )
        assert not decision.allow
        assert decision.code == "symbol_not_whitelisted"

    @pytest.mark.asyncio
    async def test_daily_trade_limit_reached(self, risk_manager: RiskManager) -> None:
        state = await risk_manager.get_state(1)
        await risk_manager._persist(
            state.model_copy(update={"trades_today": DEFAULT_DAILY_TRADE_LIMIT})
        )
        decision = await risk_manager.check_open_trade(
            1, "BTC/USDT", "long", 1.0, default_snapshot()
        )
        assert not decision.allow
        assert decision.code == "daily_trade_limit_reached"

    @pytest.mark.asyncio
    async def test_max_positions_reached(self, risk_manager: RiskManager) -> None:
        positions = [
            OpenPosition(
                symbol=f"S{i}",
                side="long",
                quantity=1,
                entry_price=100,
                current_price=100,
            )
            for i in range(DEFAULT_MAX_POSITIONS)
        ]
        snapshot = default_snapshot(positions=positions)
        decision = await risk_manager.check_open_trade(
            1, "BTC/USDT", "long", 1.0, snapshot
        )
        assert not decision.allow
        assert decision.code == "max_positions_reached"

    @pytest.mark.asyncio
    async def test_risk_per_trade_exceeded(self, risk_manager: RiskManager) -> None:
        decision = await risk_manager.check_open_trade(
            1, "BTC/USDT", "long", 11.0, default_snapshot()
        )
        assert not decision.allow
        assert decision.code == "risk_per_trade_exceeded"

    @pytest.mark.asyncio
    async def test_margin_insufficient(self, risk_manager: RiskManager) -> None:
        snapshot = default_snapshot(available_cash=5.0)
        decision = await risk_manager.check_open_trade(
            1, "BTC/USDT", "long", 10.0, snapshot
        )
        assert not decision.allow
        assert decision.code == "margin_insufficient"

    @pytest.mark.asyncio
    async def test_safe_mode_reduces_effective_risk(
        self, risk_manager: RiskManager
    ) -> None:
        await risk_manager.update_settings(1, TradingSettingsPatch(ai_mode="safe"))
        decision = await risk_manager.check_open_trade(
            1, "BTC/USDT", "long", 5.0, default_snapshot()
        )
        assert decision.allow
        assert decision.effective_risk_percent == 0.5
        assert decision.max_trade_notional == 5.0

    @pytest.mark.asyncio
    async def test_total_stop_persisted_and_repeats(
        self, risk_manager: RiskManager
    ) -> None:
        snapshot = default_snapshot(total_pnl_percent=-15)
        first = await risk_manager.check_open_trade(1, "BTC/USDT", "long", 1.0, snapshot)
        assert first.code == "total_stop"
        second = await risk_manager.check_open_trade(1, "BTC/USDT", "long", 1.0, snapshot)
        assert second.code == "total_stop"