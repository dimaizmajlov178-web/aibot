from __future__ import annotations

import time
from abc import ABC, abstractmethod
from typing import Any, Protocol


class LockStore(ABC):
    @abstractmethod
    async def acquire(self, key: str, ttl_ms: int) -> bool: ...

    @abstractmethod
    async def release(self, key: str) -> None: ...


class InMemoryLockStore(LockStore):
    def __init__(self) -> None:
        self._locks: dict[str, float] = {}

    async def acquire(self, key: str, ttl_ms: int) -> bool:
        now_ms = time.monotonic() * 1000
        expires_at = self._locks.get(key)
        if expires_at is None or expires_at <= now_ms:
            self._locks[key] = now_ms + ttl_ms
            return True
        return False

    async def release(self, key: str) -> None:
        self._locks.pop(key, None)


class RedisLikeClient(Protocol):
    async def set(self, key: str, value: str, px: int, nx: bool) -> Any: ...

    async def delete(self, key: str) -> Any: ...


class RedisLockStore(LockStore):
    def __init__(self, client: RedisLikeClient) -> None:
        self._client = client

    async def acquire(self, key: str, ttl_ms: int) -> bool:
        result = await self._client.set(key, "1", px=ttl_ms, nx=True)
        return result is True or result == 1 or result == "OK"

    async def release(self, key: str) -> None:
        await self._client.delete(key)