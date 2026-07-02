from __future__ import annotations

import asyncio
from typing import Callable


async def wait_until(predicate: Callable[[], bool], timeout: float = 2.0, interval: float = 0.02) -> None:
    """Poll `predicate` until it's truthy, mirroring the role of vi.waitUntil in the
    TypeScript test suite (no equivalent push-based notification from the mock relay)."""
    elapsed = 0.0
    while not predicate():
        if elapsed >= timeout:
            raise AssertionError("condition not met within timeout")
        await asyncio.sleep(interval)
        elapsed += interval
