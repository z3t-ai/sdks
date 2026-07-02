from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import Any, Protocol, TypedDict


class Logger(Protocol):
    def info(self, *args: Any) -> None: ...
    def warn(self, *args: Any) -> None: ...
    def error(self, *args: Any) -> None: ...


class ConsoleLogger:
    """Default logger — writes info/warn to stdout, error to stderr."""

    def info(self, *args: Any) -> None:
        print(*args, file=sys.stdout)

    def warn(self, *args: Any) -> None:
        print(*args, file=sys.stderr)

    def error(self, *args: Any) -> None:
        print(*args, file=sys.stderr)


class TaxonomyEntry(TypedDict, total=False):
    key: str
    value: Any
    label: str


@dataclass(frozen=True)
class _Defaults:
    base_url: str = "https://relay.z3t.ai/v1"
    # Unlike the TypeScript SDK (which uses milliseconds throughout), these are
    # expressed in seconds to match Python/asyncio convention (asyncio.sleep,
    # asyncio.wait_for both take seconds). The effective durations are the same:
    # 25s handler timeout, 1s initial reconnect backoff, 60s backoff ceiling.
    timeout: float = 25.0
    max_concurrent_calls: int = 10
    reconnect_delay: float = 1.0
    max_reconnect_delay: float = 60.0


DEFAULTS = _Defaults()


@dataclass
class ResolvedConfig:
    """Fully resolved config — all fields present after defaults and bootstrap are applied."""

    api_key: str
    base_url: str
    relay_urls: list[str]
    timeout: float
    max_concurrent_calls: int
    reconnect_delay: float
    max_reconnect_delay: float
    logger: Logger
