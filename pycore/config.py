from __future__ import annotations

import os

from pydantic import BaseModel, Field


def _parse_admin_ids(raw: str | None) -> list[int]:
    if not raw:
        return []
    ids: list[int] = []
    for part in raw.split(","):
        token = part.strip()
        if not token:
            continue
        try:
            value = int(token)
        except ValueError:
            continue
        if value > 0:
            ids.append(value)
    return ids


def _parse_number(raw: str | None, fallback: float, lo: float, hi: float) -> float:
    if raw is None or raw.strip() == "":
        return fallback
    try:
        value = float(raw)
    except ValueError:
        return fallback
    if not lo <= value <= hi:
        return fallback
    return value


class BotConfig(BaseModel):
    telegram_token: str = ""
    dry_run: bool = False
    environment: str = "development"
    encryption_key: str = ""
    broker_type: str = "stub"
    deep_seek_api_key: str = ""
    deep_seek_base_url: str = "https://api.deepseek.com"
    deep_seek_chat_model: str = "deepseek-chat"
    deep_seek_reasoner_model: str = "deepseek-reasoner"
    admin_telegram_ids: list[int] = Field(default_factory=list)
    database_url: str = ""
    redis_url: str = ""
    broker_api_base_url: str = ""
    broker_api_key_header: str = ""
    default_risk_per_trade: float = Field(default=1.0, ge=0.1, le=50)
    max_positions: int = Field(default=3, ge=1, le=100)
    daily_drawdown_limit: float = Field(default=3.0, ge=0.1, le=100)
    total_drawdown_limit: float = Field(default=10.0, ge=0.1, le=100)

    @classmethod
    def from_env(cls) -> "BotConfig":
        dry_run = os.getenv("BOT_DRY_RUN", "false").lower() == "true"
        config = cls(
            telegram_token=os.getenv("TELEGRAM_BOT_TOKEN", ""),
            dry_run=dry_run,
            environment=os.getenv("NODE_ENV", "development"),
            encryption_key=os.getenv("ENCRYPTION_KEY", ""),
            broker_type=os.getenv("BROKER_TYPE", "stub"),
            deep_seek_api_key=os.getenv("DEEPSEEK_API_KEY", ""),
            deep_seek_base_url=os.getenv(
                "DEEPSEEK_API_BASE_URL", "https://api.deepseek.com"
            ),
            deep_seek_chat_model=os.getenv("DEEPSEEK_CHAT_MODEL", "deepseek-chat"),
            deep_seek_reasoner_model=os.getenv(
                "DEEPSEEK_REASONER_MODEL", "deepseek-reasoner"
            ),
            admin_telegram_ids=_parse_admin_ids(os.getenv("ADMIN_TELEGRAM_IDS")),
            database_url=os.getenv("DATABASE_URL")
            or os.getenv("DOCUMENT_API_ENDPOINT", ""),
            redis_url=os.getenv("REDIS_URL", ""),
            broker_api_base_url=os.getenv("BROKER_API_BASE_URL", ""),
            broker_api_key_header=os.getenv("BROKER_API_KEY_HEADER", ""),
            default_risk_per_trade=_parse_number(
                os.getenv("DEFAULT_RISK_PER_TRADE"), 1.0, 0.1, 50.0
            ),
            max_positions=int(
                _parse_number(os.getenv("MAX_POSITIONS"), 3.0, 1.0, 100.0)
            ),
            daily_drawdown_limit=_parse_number(
                os.getenv("DAILY_DRAWDOWN_LIMIT"), 3.0, 0.1, 100.0
            ),
            total_drawdown_limit=_parse_number(
                os.getenv("TOTAL_DRAWDOWN_LIMIT"), 10.0, 0.1, 100.0
            ),
        )
        if not dry_run and not config.telegram_token:
            raise ValueError(
                "TELEGRAM_BOT_TOKEN не задан. Укажите токен бота в переменной "
                "окружения TELEGRAM_BOT_TOKEN или запустите с BOT_DRY_RUN=true"
            )
        return config


def is_admin(config: BotConfig, user_id: int) -> bool:
    return user_id in config.admin_telegram_ids