from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import httpx

from .connection import Connection
from .context import CallContext, Send, create_call_context
from .llm import create_llm_clients
from .schema import VersionSchema
from .types import DEFAULTS, Logger, ResolvedConfig

Handler = Callable[[Any, CallContext], Awaitable[Any]]


@dataclass
class _QueuedCall:
    call_id: str
    schema_version: int
    input: Any
    send: Send


class Agent:
    def __init__(
        self,
        api_key: str,
        *,
        base_url: str | None = None,
        relay_urls: list[str] | None = None,
        timeout: float | None = None,
        max_concurrent_calls: int | None = None,
        reconnect_delay: float | None = None,
        max_reconnect_delay: float | None = None,
        logger: Logger | None = None,
    ) -> None:
        from .types import ConsoleLogger

        self._config = ResolvedConfig(
            api_key=api_key,
            base_url=base_url or DEFAULTS.base_url,
            # Developer-provided relay URLs take precedence — useful for local dev and
            # tests. Left empty, they're populated on start() via bootstrap.
            relay_urls=list(relay_urls) if relay_urls else [],
            timeout=timeout if timeout is not None else DEFAULTS.timeout,
            max_concurrent_calls=max_concurrent_calls if max_concurrent_calls is not None else DEFAULTS.max_concurrent_calls,
            reconnect_delay=reconnect_delay if reconnect_delay is not None else DEFAULTS.reconnect_delay,
            max_reconnect_delay=max_reconnect_delay if max_reconnect_delay is not None else DEFAULTS.max_reconnect_delay,
            logger=logger or ConsoleLogger(),
        )
        self._handlers: dict[int | str, Handler] = {}
        self._version_schemas: dict[int, VersionSchema] = {}
        self._connections: list[Connection] = []
        self._active_count = 0
        self._queue: list[_QueuedCall] = []
        self._http: httpx.AsyncClient | None = None

    def handle(
        self, version: int | None = None, schema: VersionSchema | None = None
    ) -> Callable[[Handler], Handler]:
        """Register a handler. Use as a decorator:

            @agent.handle()                          # default — all schema versions
            @agent.handle(version=1)                  # version-specific, no schema
            @agent.handle(version=1, schema=...)       # version-specific, typed schema

        The schema is synced with the platform on agent.start() and drives frontend
        form rendering and output display. Schemas sync as status='draft' by default —
        mutable, invisible to consumers, safe to keep editing across restarts. Set
        status='active' on the VersionSchema once ready to publish; from then on the
        schema is immutable and changing it will fail schema-sync.
        """
        if schema is not None and version is None:
            raise ValueError("a schema requires an explicit version")

        def decorator(fn: Handler) -> Handler:
            if version is None:
                self._handlers["default"] = fn
            else:
                self._handlers[version] = fn
                if schema is not None:
                    self._version_schemas[version] = schema
            return fn

        return decorator

    async def start(self) -> None:
        """Connect to the platform relay and begin handling calls. Runs until `stop()`
        is called (or an unhandled startup error occurs) — typically the last call in
        your program, e.g. `asyncio.run(agent.start())`.

        On startup, this:
        1. Fetches relay WebSocket URLs from the platform (unless overridden in config)
        2. Syncs any declared schemas (creates new versions as draft by default, deprecates removed ones)
        3. Opens a persistent WebSocket connection to each relay URL, and blocks until stopped

        Errors during bootstrap or schema sync are logged and abort startup.
        """
        self._http = httpx.AsyncClient()
        try:
            relay_urls = await self._bootstrap()
            if self._version_schemas:
                await self._sync_schemas()
        except Exception as exc:
            self._config.logger.error("[z3t SDK] Startup failed:", str(exc))
            await self._http.aclose()
            self._http = None
            return

        supported_versions = [v for v in self._handlers if isinstance(v, int)]
        self._connections = [
            Connection(url, self._config, self._dispatch, supported_versions) for url in relay_urls
        ]
        try:
            await asyncio.gather(*(conn.run() for conn in self._connections))
        finally:
            if self._http is not None:
                await self._http.aclose()
                self._http = None

    async def stop(self) -> None:
        """Disconnect from all relays. Useful for testing or graceful shutdown."""
        await asyncio.gather(*(conn.stop() for conn in self._connections))
        self._connections.clear()

    # ─── Private ─────────────────────────────────────────────────────────────

    async def _bootstrap(self) -> list[str]:
        if self._config.relay_urls:
            return self._config.relay_urls

        assert self._http is not None
        resp = await self._http.get(
            f"{self._config.base_url}/bootstrap",
            headers={"Authorization": f"Bearer {self._config.api_key}"},
        )
        if resp.is_error:
            raise RuntimeError(f"Bootstrap failed: HTTP {resp.status_code}")
        relay_urls = resp.json().get("relayUrls")
        if not relay_urls:
            raise RuntimeError("Bootstrap returned no relay URLs")
        return relay_urls

    async def _sync_schemas(self) -> None:
        versions = []
        for version, schema in self._version_schemas.items():
            entry: dict[str, Any] = {
                "version": version,
                "inputSchema": schema.input._def,
                "outputSchema": schema.output._def,
                "status": schema.status or "draft",
            }
            if schema.deprecates:
                entry["deprecates"] = schema.deprecates
            if schema.deprecation_notice:
                entry["deprecationNotice"] = schema.deprecation_notice
            versions.append(entry)

        assert self._http is not None
        resp = await self._http.post(
            f"{self._config.base_url}/schema-sync",
            json={"versions": versions},
            headers={"Authorization": f"Bearer {self._config.api_key}"},
        )
        if resp.is_error:
            raise RuntimeError(f"Schema sync failed: HTTP {resp.status_code}: {resp.text}")

        result = resp.json()
        deprecated = result.get("deprecatedVersions") or []
        if deprecated:
            self._config.logger.info(
                f"[z3t SDK] Schema versions deprecated: {', '.join(map(str, deprecated))}"
            )
        drafts = [v["version"] for v in (result.get("versions") or []) if v.get("status") == "draft"]
        if drafts:
            joined = ", v".join(map(str, drafts))
            self._config.logger.info(
                f"[z3t SDK] Synced as draft (not visible to consumers): v{joined} — "
                "set status='active' in .handle() to publish."
            )

    def _dispatch(self, call_id: str, schema_version: int, input: Any, send: Send) -> None:
        self._enqueue(_QueuedCall(call_id, schema_version, input, send))

    def _enqueue(self, call: _QueuedCall) -> None:
        if self._active_count < self._config.max_concurrent_calls:
            asyncio.create_task(self._process_call(call))
            return

        self._queue.append(call)

        max_queue = self._config.max_concurrent_calls * 2
        if len(self._queue) > max_queue:
            oldest = self._queue.pop(0)
            self._config.logger.warn(
                f"[z3t SDK] Queue depth exceeded (max {max_queue}) — rejecting call {oldest.call_id}"
            )
            asyncio.create_task(
                oldest.send({"type": "error", "callId": oldest.call_id, "message": "Queue depth exceeded"})
            )

    def _dequeue(self) -> None:
        if self._queue and self._active_count < self._config.max_concurrent_calls:
            asyncio.create_task(self._process_call(self._queue.pop(0)))

    async def _process_call(self, call: _QueuedCall) -> None:
        self._active_count += 1
        try:
            handler = self._handlers.get(call.schema_version) or self._handlers.get("default")
            if handler is None:
                await call.send(
                    {
                        "type": "error",
                        "callId": call.call_id,
                        "message": f"No handler for schema version {call.schema_version}",
                    }
                )
                return

            assert self._http is not None
            ctx = create_call_context(
                call.call_id,
                call.schema_version,
                call.send,
                self._config,
                create_llm_clients(self._config, call.call_id),
                self._http,
            )

            try:
                output = await asyncio.wait_for(handler(call.input, ctx), timeout=self._config.timeout)
                await call.send({"type": "result", "callId": call.call_id, "output": output})
            except asyncio.TimeoutError:
                await call.send({"type": "error", "callId": call.call_id, "message": "Handler timeout"})
            except Exception as exc:  # noqa: BLE001 — any handler exception becomes an error frame
                await call.send({"type": "error", "callId": call.call_id, "message": str(exc)})
        finally:
            self._active_count -= 1
            self._dequeue()
