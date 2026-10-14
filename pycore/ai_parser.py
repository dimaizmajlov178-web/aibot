from __future__ import annotations

import json
import re
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

M = TypeVar("M", bound=BaseModel)


class AiResponseError(Exception):
    pass


def _try_parse_json(text: str) -> Any | None:
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None


def _extract_fenced_json(raw: str) -> Any | None:
    match = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw, flags=re.IGNORECASE)
    if not match:
        return None
    return _try_parse_json(match.group(1).strip())


def _extract_bracketed_json(raw: str) -> Any | None:
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end <= start:
        return None
    return _try_parse_json(raw[start : end + 1])


def extract_json_object(raw: str) -> Any:
    trimmed = raw.strip()
    if not trimmed:
        raise AiResponseError("Пустой ответ модели: невозможно извлечь JSON")

    direct = _try_parse_json(trimmed)
    if direct is not None:
        return direct

    fenced = _extract_fenced_json(trimmed)
    if fenced is not None:
        return fenced

    bracketed = _extract_bracketed_json(trimmed)
    if bracketed is not None:
        return bracketed

    raise AiResponseError("Не удалось извлечь JSON из ответа модели")


def _format_issues(error: ValidationError) -> str:
    details: list[str] = []
    for item in error.errors()[:5]:
        path = ".".join(str(part) for part in item.get("loc", ())) or "<root>"
        details.append(f"{path}: {item.get('msg', '')}")
    return "; ".join(details)


def parse_and_validate(raw: str, model: type[M]) -> M:
    value = extract_json_object(raw)
    try:
        return model.model_validate(value)
    except ValidationError as error:
        raise AiResponseError(
            f"Ответ модели не прошёл валидацию схемы: {_format_issues(error)}"
        ) from error