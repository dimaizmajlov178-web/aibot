from __future__ import annotations

import pytest

from pycore.ai_parser import AiResponseError, extract_json_object, parse_and_validate
from pycore.models import DeepAnalysis, TradeSignal

VALID_SIGNAL = {
    "action": "buy",
    "side": "long",
    "confidence": 85,
    "entry_price": 100.5,
    "stop_loss": 98.0,
    "take_profit": 110.0,
    "risk_percent": 1.0,
    "reasoning": "сильный пробой уровня",
}


class TestExtractJsonObject:
    def test_direct_json(self) -> None:
        assert extract_json_object('{"action": "buy"}') == {"action": "buy"}

    def test_fenced_markdown(self) -> None:
        raw = 'Вот ответ:\n```json\n{"action": "sell"}\n```'
        assert extract_json_object(raw) == {"action": "sell"}

    def test_fenced_markdown_without_lang(self) -> None:
        raw = '```\n{"action": "hold"}\n```'
        assert extract_json_object(raw) == {"action": "hold"}

    def test_bracketed_json_in_prose(self) -> None:
        raw = 'Модель считает, что {"action": "buy", "confidence": 50} — это хорошо'
        assert extract_json_object(raw) == {"action": "buy", "confidence": 50}

    def test_empty_raises(self) -> None:
        with pytest.raises(AiResponseError):
            extract_json_object("   ")

    def test_no_json_raises(self) -> None:
        with pytest.raises(AiResponseError):
            extract_json_object("просто текст без json")

    def test_invalid_inner_json_raises(self) -> None:
        with pytest.raises(AiResponseError):
            extract_json_object("тут есть ```json\n{не json}\n```")

    def test_scalar_json_returns_value(self) -> None:
        assert extract_json_object("42") == 42


class TestParseAndValidate:
    def test_valid_signal(self) -> None:
        parsed = parse_and_validate('{"action": "buy", "side": "long", "confidence": 80, "risk_percent": 1, "reasoning": "ok"}', TradeSignal)
        assert parsed.action == "buy"
        assert parsed.side == "long"
        assert parsed.confidence == 80
        assert parsed.entry_price is None

    def test_full_valid_signal(self) -> None:
        parsed = parse_and_validate(__import__("json").dumps(VALID_SIGNAL), TradeSignal)
        assert parsed.take_profit == 110.0
        assert parsed.stop_loss == 98.0

    def test_invalid_confidence_raises(self) -> None:
        raw = '{"action": "buy", "side": "long", "confidence": 150, "risk_percent": 1, "reasoning": "ok"}'
        with pytest.raises(AiResponseError) as exc_info:
            parse_and_validate(raw, TradeSignal)
        assert "confidence" in str(exc_info.value)

    def test_missing_required_fields_raises(self) -> None:
        raw = '{"action": "buy"}'
        with pytest.raises(AiResponseError) as exc_info:
            parse_and_validate(raw, TradeSignal)
        assert "схемы" in str(exc_info.value)

    def test_action_not_in_enum_raises(self) -> None:
        raw = '{"action": "short", "side": "long", "confidence": 50, "risk_percent": 1, "reasoning": "ok"}'
        with pytest.raises(AiResponseError):
            parse_and_validate(raw, TradeSignal)

    def test_valid_deep_analysis(self) -> None:
        raw = __import__("json").dumps(
            {
                "trend": "bullish",
                "trend_strength": 70,
                "key_levels": {"support": [90.0], "resistance": [120.0]},
                "scenario": {
                    "bull_case": "рост",
                    "bear_case": "падение",
                    "base_case": "флэт",
                },
                "risk_assessment": "medium",
                "summary": "краткая сводка",
            }
        )
        parsed = parse_and_validate(raw, DeepAnalysis)
        assert parsed.trend == "bullish"
        assert parsed.key_levels.support == [90.0]
        assert parsed.risk_assessment == "medium"

    def test_invalid_deep_analysis_raises(self) -> None:
        raw = '{"trend": "unknown", "trend_strength": 70}'
        with pytest.raises(AiResponseError):
            parse_and_validate(raw, DeepAnalysis)