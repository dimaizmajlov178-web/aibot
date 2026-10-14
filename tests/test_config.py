from __future__ import annotations

from typing import Any

import pytest

from pycore.config import BotConfig, is_admin


class TestFromEnv:
    @pytest.fixture
    def clean_env(self, monkeypatch: Any) -> dict[str, str]:
        for key in [
            "BOT_DRY_RUN",
            "TELEGRAM_BOT_TOKEN",
            "NODE_ENV",
            "ENCRYPTION_KEY",
            "BROKER_TYPE",
            "DEEPSEEK_API_KEY",
            "DEEPSEEK_API_BASE_URL",
            "ADMIN_TELEGRAM_IDS",
            "DATABASE_URL",
            "DOCUMENT_API_ENDPOINT",
            "REDIS_URL",
            "BROKER_API_BASE_URL",
            "BROKER_API_KEY_HEADER",
            "DEFAULT_RISK_PER_TRADE",
            "MAX_POSITIONS",
            "DAILY_DRAWDOWN_LIMIT",
            "TOTAL_DRAWDOWN_LIMIT",
        ]:
            monkeypatch.delenv(key, raising=False)
        return {}

    def test_missing_token_and_no_dry_run_raises(self, monkeypatch: Any) -> None:
        monkeypatch.delenv("BOT_DRY_RUN", raising=False)
        monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
        with pytest.raises(ValueError):
            BotConfig.from_env()

    def test_dry_run_allows_missing_token(self, monkeypatch: Any) -> None:
        monkeypatch.setenv("BOT_DRY_RUN", "true")
        monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
        config = BotConfig.from_env()
        assert config.dry_run is True
        assert config.telegram_token == ""

    def test_parses_env_values(self, monkeypatch: Any) -> None:
        monkeypatch.setenv("BOT_DRY_RUN", "false")
        monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "token-123")
        monkeypatch.setenv("NODE_ENV", "test")
        monkeypatch.setenv("ENCRYPTION_KEY", "secret")
        monkeypatch.setenv("BROKER_TYPE", "http")
        monkeypatch.setenv("DEEPSEEK_API_KEY", "ds-key")
        monkeypatch.setenv("DEEPSEEK_API_BASE_URL", "https://example.com")
        monkeypatch.setenv("ADMIN_TELEGRAM_IDS", " 11 ,22 , ")
        monkeypatch.setenv("DOCUMENT_API_ENDPOINT", "http://db:8000")
        monkeypatch.setenv("REDIS_URL", "redis://redis:6379")
        monkeypatch.setenv("DEFAULT_RISK_PER_TRADE", "2.5")
        monkeypatch.setenv("MAX_POSITIONS", "7")
        monkeypatch.setenv("DAILY_DRAWDOWN_LIMIT", "4")
        monkeypatch.setenv("TOTAL_DRAWDOWN_LIMIT", "15")
        config = BotConfig.from_env()
        assert config.telegram_token == "token-123"
        assert config.environment == "test"
        assert config.encryption_key == "secret"
        assert config.broker_type == "http"
        assert config.deep_seek_api_key == "ds-key"
        assert config.deep_seek_base_url == "https://example.com"
        assert config.admin_telegram_ids == [11, 22]
        assert config.database_url == "http://db:8000"
        assert config.redis_url == "redis://redis:6379"
        assert config.default_risk_per_trade == 2.5
        assert config.max_positions == 7
        assert config.daily_drawdown_limit == 4
        assert config.total_drawdown_limit == 15

    def test_database_url_takes_precedence(self, monkeypatch: Any) -> None:
        monkeypatch.setenv("BOT_DRY_RUN", "true")
        monkeypatch.setenv("DATABASE_URL", "http://primary:8000")
        monkeypatch.setenv("DOCUMENT_API_ENDPOINT", "http://secondary:8000")
        config = BotConfig.from_env()
        assert config.database_url == "http://primary:8000"

    def test_invalid_numbers_fall_back_to_defaults(self, monkeypatch: Any) -> None:
        monkeypatch.setenv("BOT_DRY_RUN", "true")
        monkeypatch.setenv("DEFAULT_RISK_PER_TRADE", "999")
        monkeypatch.setenv("MAX_POSITIONS", "not-a-number")
        config = BotConfig.from_env()
        assert config.default_risk_per_trade == 1.0
        assert config.max_positions == 3

    def test_is_admin(self, monkeypatch: Any) -> None:
        monkeypatch.setenv("BOT_DRY_RUN", "true")
        monkeypatch.setenv("ADMIN_TELEGRAM_IDS", "1,2")
        config = BotConfig.from_env()
        assert is_admin(config, 1) is True
        assert is_admin(config, 3) is False