from __future__ import annotations

from typing import Any

from pycore.lock import InMemoryLockStore, RedisLockStore


class TestInMemoryLockStore:
    async def test_acquire_and_release(self) -> None:
        lock = InMemoryLockStore()
        assert await lock.acquire("a", 1000) is True
        await lock.release("a")
        assert await lock.acquire("a", 1000) is True

    async def test_blocked_while_held(self) -> None:
        lock = InMemoryLockStore()
        assert await lock.acquire("a", 1000) is True
        assert await lock.acquire("a", 1000) is False

    async def test_release_frees_key(self) -> None:
        lock = InMemoryLockStore()
        assert await lock.acquire("a", 1000) is True
        assert await lock.acquire("a", 1000) is False
        await lock.release("a")
        assert await lock.acquire("a", 1000) is True


class FakeRedisClient:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    async def set(self, key: str, value: str, px: int, nx: bool) -> Any:
        if nx and key in self.values:
            return None
        self.values[key] = value
        return "OK"

    async def delete(self, key: str) -> Any:
        return self.values.pop(key, None)


class TestRedisLockStore:
    async def test_acquire_uses_set_nx(self) -> None:
        client = FakeRedisClient()
        lock = RedisLockStore(client)
        assert await lock.acquire("a", 1000) is True
        assert await lock.acquire("a", 1000) is False

    async def test_release_deletes_key(self) -> None:
        client = FakeRedisClient()
        lock = RedisLockStore(client)
        await lock.acquire("a", 1000)
        await lock.release("a")
        assert await lock.acquire("a", 1000) is True