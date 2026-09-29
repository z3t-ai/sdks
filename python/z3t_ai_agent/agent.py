from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import httpx

from .connection import Connection, IncomingCall
from .context import CallContext, create_call_context
from .journal import CallJournal, SuspendSignal
from .llm import create_llm_clients
from .schema import VersionSchema
from .types import DEFAULTS, Logger, ResolvedConfig

Handler = Callable[[Any, CallContext], Awaitable[Any]]

# Kept as a name for callers/tests that queue calls directly.
_QueuedCall = IncomingCall

#: How often an unacknowledged turn-terminal frame is re-sent (seconds).
RESULT_RETRY_S = 5.0
#: How long to keep retrying before giving up and logging. Comfortably longer than any relay
#: reconnect, and longer than the platform's own run ceiling, so we stop only once nobody could
#: still be waiting for the answer.
RESULT_RETRY_TIMEOUT_S = 10 * 60.0
#: Cap on best-effort frames held while every connection is down. Turn-terminal frames are never
#: dropped — they live in the pending map and are retried — so this only bounds telemetry.
OUTBOX_MAX = 50


def _pending_key(call_id: str, turn: int) -> str:
    """A suspended call comes back as a new turn of the same call id, so the key must tell turns
    apart — or the ack of turn 0's suspend could settle turn 1's result. Turn 0 keeps the bare id."""
    return call_id if turn == 0 else f"{call_id}#{turn}"


@dataclass
class _Pending:
    call_id: str
    payload: dict[str, Any]
    since: float
    task: asyncio.Task[None] | None = None


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
        heartbeat_interval: float | None = None,
        heartbeat_timeout: float | None = None,
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
            heartbeat_interval=heartbeat_interval if heartbeat_interval is not None else DEFAULTS.heartbeat_interval,
            heartbeat_timeout=heartbeat_timeout if heartbeat_timeout is not None else DEFAULTS.heartbeat_timeout,
            logger=logger or ConsoleLogger(),
        )
        self._handlers: dict[int | str, Handler] = {}
        self._version_schemas: dict[int, VersionSchema] = {}
        self._connections: list[Connection] = []
        self._active_count = 0
        self._queue: list[IncomingCall] = []
        self._http: httpx.AsyncClient | None = None
        # Best-effort frames that had nowhere to go, flushed on the next auth_ok.
        self._outbox: list[dict[str, Any]] = []
        # Turn-terminal frames (result, error, suspend) awaiting the relay's ack. A result that is
        # not acknowledged has not been recorded, whatever the socket reported.
        self._pending: dict[str, _Pending] = {}
        # Strong references to in-flight call tasks: the event loop only keeps weak ones, so an
        # unreferenced task can be garbage-collected mid-run.
        self._tasks: set[asyncio.Task[None]] = set()

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
            Connection(
                url,
                self._config,
                self._dispatch,
                supported_versions,
                on_ready=self._on_connection_ready,
                on_ack=self._settle,
            )
            for url in relay_urls
        ]
        try:
            await asyncio.gather(*(conn.run() for conn in self._connections))
        finally:
            if self._http is not None:
                await self._http.aclose()
                self._http = None

    async def stop(self) -> None:
        """Disconnect from all relays. Useful for testing or graceful shutdown."""
        for entry in self._pending.values():
            if entry.task is not None:
                entry.task.cancel()
        self._pending.clear()
        self._outbox.clear()
        await asyncio.gather(*(conn.stop() for conn in self._connections))
        self._connections.clear()

    # ─── Delivery ────────────────────────────────────────────────────────────

    async def _deliver(self, payload: dict[str, Any]) -> bool:
        """Sends on whichever connection is live, rather than the one a call arrived on. A
        reconnect replaces the socket — and may land on another relay instance — but frames are
        addressed by callId, so any authenticated connection can carry them."""
        for conn in self._connections:
            if await conn.send(payload):
                return True
        return False

    async def _deliver_best_effort(self, payload: dict[str, Any]) -> None:
        """Telemetry: held briefly if nothing is live, dropped once the cap is hit. Progress that
        arrives late is worth little, and a backlog of stale steps after an outage is worth less."""
        if await self._deliver(payload):
            return
        self._outbox.append(payload)
        while len(self._outbox) > OUTBOX_MAX:
            self._outbox.pop(0)

    async def _deliver_terminal(self, call_id: str, turn: int, payload: dict[str, Any]) -> None:
        """At-least-once: retried until the relay acks it. The relay's handlers are keyed by
        callId and turn and guarded on the call still being live, so a duplicate is a no-op."""
        key = _pending_key(call_id, turn)
        entry = _Pending(call_id=call_id, payload=payload, since=asyncio.get_running_loop().time())
        self._pending[key] = entry
        entry.task = asyncio.create_task(self._retry_terminal(key))
        await self._deliver(payload)

    async def _retry_terminal(self, key: str) -> None:
        loop = asyncio.get_running_loop()
        while True:
            await asyncio.sleep(RESULT_RETRY_S)
            entry = self._pending.get(key)
            if entry is None:
                return
            if loop.time() - entry.since > RESULT_RETRY_TIMEOUT_S:
                self._config.logger.error(
                    f"[z3t SDK] Gave up delivering the result for call {entry.call_id} after "
                    f"{round(RESULT_RETRY_TIMEOUT_S / 60)} minutes without an acknowledgement"
                )
                self._pending.pop(key, None)
                return
            await self._deliver(entry.payload)

    def _settle(self, call_id: str, turn: int | None = None) -> None:
        """The relay acked a turn-terminal frame. An ack without a turn comes from a relay that
        predates interactive calls — no call there has more than one turn, so every entry for the
        call goes."""
        if turn is not None:
            keys = [_pending_key(call_id, turn)]
        else:
            keys = [k for k, e in self._pending.items() if e.call_id == call_id]
        for key in keys:
            entry = self._pending.pop(key, None)
            if entry is not None and entry.task is not None:
                entry.task.cancel()

    async def _on_connection_ready(self) -> None:
        """A connection just authenticated — drain anything that had nowhere to go, and re-send
        every still-unacknowledged frame now rather than waiting out the retry interval."""
        while self._outbox:
            if not await self._deliver(self._outbox[0]):
                return
            self._outbox.pop(0)
        for entry in list(self._pending.values()):
            await self._deliver(entry.payload)

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
            if schema.interactive is not None:
                entry["interactive"] = schema.interactive
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

    def _dispatch(self, call: IncomingCall) -> None:
        self._enqueue(call)

    def _spawn(self, coro: Awaitable[None]) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _enqueue(self, call: IncomingCall) -> None:
        if self._active_count < self._config.max_concurrent_calls:
            self._spawn(self._process_call(call))
            return

        self._queue.append(call)

        max_queue = self._config.max_concurrent_calls * 2
        if len(self._queue) > max_queue:
            oldest = self._queue.pop(0)
            self._config.logger.warn(
                f"[z3t SDK] Queue depth exceeded (max {max_queue}) — rejecting call {oldest.call_id}"
            )
            self._spawn(
                self._deliver_terminal(
                    oldest.call_id,
                    oldest.turn,
                    {"type": "error", "callId": oldest.call_id, "turn": oldest.turn, "message": "Queue depth exceeded"},
                )
            )

    def _dequeue(self) -> None:
        if self._queue and self._active_count < self._config.max_concurrent_calls:
            self._spawn(self._process_call(self._queue.pop(0)))

    async def _process_call(self, call: IncomingCall) -> None:
        self._active_count += 1
        turn = call.turn
        try:
            handler = self._handlers.get(call.schema_version) or self._handlers.get("default")
            if handler is None:
                await self._deliver_terminal(
                    call.call_id,
                    turn,
                    {
                        "type": "error",
                        "callId": call.call_id,
                        "turn": turn,
                        "message": f"No handler for schema version {call.schema_version}",
                    },
                )
                return

            assert self._http is not None
            journal = CallJournal(call.resume)
            ctx = create_call_context(
                call.call_id,
                call.schema_version,
                self._deliver_best_effort,
                self._config,
                create_llm_clients(self._config, call.call_id),
                self._http,
                journal=journal,
                can_ask=call.can_ask,
                turn=turn,
            )

            # Per turn: a resumed call gets a fresh timeout, not what was left of the first one.
            output: Any = None
            error: str | None = None
            suspended = False
            try:
                output = await asyncio.wait_for(handler(call.input, ctx), timeout=self._config.timeout)
            except SuspendSignal:
                suspended = True
            except asyncio.TimeoutError:
                error = "Handler timeout"
            except Exception as exc:  # noqa: BLE001 — any handler exception becomes an error frame
                error = str(exc)
            except (asyncio.CancelledError, KeyboardInterrupt, SystemExit):
                raise
            except BaseException as exc:  # noqa: BLE001
                # SuspendSignal raised inside an asyncio.TaskGroup arrives wrapped in a
                # BaseExceptionGroup, which neither clause above matches. The journal says whether
                # it was a question; anything else still owes the relay a terminal frame.
                if journal.pending is not None:
                    suspended = True
                else:
                    error = str(exc)

            await self._finish_turn(call.call_id, turn, journal, output=output, error=error, suspended=suspended)
        finally:
            self._active_count -= 1
            self._dequeue()

    async def _finish_turn(
        self,
        call_id: str,
        turn: int,
        journal: CallJournal,
        *,
        output: Any,
        error: str | None,
        suspended: bool,
    ) -> None:
        """Ends a turn with exactly one turn-terminal frame. A question recorded in the journal
        wins over whatever the handler did afterwards: ``ctx.ask`` unwinds the handler by raising,
        and a handler that catches that and returns must not turn a pause into a result."""
        if journal.pending is not None:
            if not suspended:
                self._config.logger.warn(
                    f'[z3t SDK] Call {call_id}: the handler caught the suspend signal from ctx.ask("{journal.pending.key}") '
                    "and carried on. The run is suspended regardless — let the exception propagate."
                )
            try:
                checkpoint = journal.checkpoint()
            except ValueError as exc:
                await self._deliver_terminal(call_id, turn, {"type": "error", "callId": call_id, "turn": turn, "message": str(exc)})
                return
            await self._deliver_terminal(
                call_id,
                turn,
                {"type": "suspend", "callId": call_id, "turn": turn, "request": journal.pending.to_wire(), "checkpoint": checkpoint},
            )
            return

        if error is None:
            # Checked here rather than left to the socket: a value json can't encode would raise
            # inside every delivery attempt, and NaN/Infinity encode to text the relay can't parse —
            # either way the result would never be acked and the call would time out.
            try:
                json.dumps(output, allow_nan=False)
            except (TypeError, ValueError) as exc:
                error = f"Handler returned a value that can't be sent as JSON: {exc}"

        if error is not None:
            await self._deliver_terminal(call_id, turn, {"type": "error", "callId": call_id, "turn": turn, "message": error})
            return
        await self._deliver_terminal(call_id, turn, {"type": "result", "callId": call_id, "turn": turn, "output": output})
