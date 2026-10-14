from __future__ import annotations

from pydantic import BaseModel

from .models import AiMode, TradingSettings, TradingSettingsPatch, utc_now_iso

DEFAULT_RISK_PER_TRADE_PERCENT = 1
DEFAULT_MAX_POSITIONS = 3
DEFAULT_DAILY_TRADE_LIMIT = 10
DEFAULT_MAX_DAILY_DRAWDOWN_PERCENT = 3
DEFAULT_MAX_TOTAL_DRAWDOWN_PERCENT = 10
DEFAULT_AI_MODE: AiMode = "balanced"


class TradingSettingsDefaults(BaseModel):
    risk_per_trade_percent: float = DEFAULT_RISK_PER_TRADE_PERCENT
    max_positions: int = DEFAULT_MAX_POSITIONS
    max_daily_drawdown_percent: float = DEFAULT_MAX_DAILY_DRAWDOWN_PERCENT
    max_total_drawdown_percent: float = DEFAULT_MAX_TOTAL_DRAWDOWN_PERCENT


def default_settings(
    user_id: int, defaults: TradingSettingsDefaults | None = None
) -> TradingSettings:
    values = defaults if defaults is not None else TradingSettingsDefaults()
    return TradingSettings(
        user_id=user_id,
        risk_per_trade_percent=values.risk_per_trade_percent,
        max_positions=values.max_positions,
        daily_trade_limit=DEFAULT_DAILY_TRADE_LIMIT,
        max_daily_drawdown_percent=values.max_daily_drawdown_percent,
        max_total_drawdown_percent=values.max_total_drawdown_percent,
        symbols=[],
        ai_mode=DEFAULT_AI_MODE,
        updated_at=utc_now_iso(),
    )


def apply_settings_patch(
    settings: TradingSettings, patch: TradingSettingsPatch
) -> TradingSettings:
    data = settings.model_dump()
    updates = patch.model_dump(exclude_none=True)
    data.update(updates)
    if patch.symbols is not None:
        data["symbols"] = [item.strip().upper() for item in patch.symbols if item.strip()]
    data["updated_at"] = utc_now_iso()
    return TradingSettings(**data)


def is_symbol_allowed(settings: TradingSettings, symbol: str) -> bool:
    if not settings.symbols:
        return True
    return symbol.strip().upper() in settings.symbols