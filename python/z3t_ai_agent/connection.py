from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import websockets
from websockets.exceptions import ConnectionClosed

from .types import ResolvedConfig


@dataclass
class IncomingCall:
    """A call as the relay dispatches it. Fields past ``input`` are absent from relays that predate
    interactive calls, which is why they're defaulted where the frame is parsed."""

    call_id: str
    schema_version: int
    input: Any
    turn: int = 0
    capabilities: list[str] = field(default_factory=list)
    can_ask: bool = False
    resume: dict[str, Any] | None = None


# Called by the Connection whenever the relay dispatches a call to this agent.
#
# Deliberately carries no send channel. Binding a call's replies to the socket it arrived on is what
# made a long run unrecoverable: the socket dies mid-call, the closure keeps pointing at it, and every
# later frame — including the result the user is waiting for — is dropped in silence. Delivery is the
# Agent's job, across whichever connection is alive when there is something to say.
CallDispatcher = Callable[[IncomingCall], None]


class Connection:
    def __init__(
        self,
        url: str,
        config: ResolvedConfig,
        dispatch: CallDispatcher,
        supported_versions: list[int],
        *,
        on_ready: Callable[[], Awaitable[None]] | None = None,
        on_ack: Callable[[str, int | None], None] | None = None,
    ) -> None:
        self._url = url
        self._config = config
        self._dispatch = dispatch
        # Schema versions this agent instance handles — sent in the auth message so the
        # relay can route calls to instances that support the requested version.
        self._supported_versions = supported_versions
        # The relay has accepted our auth — this connection can carry call traffic now.
        self._on_ready = on_ready
        # The relay has durably recorded a turn-terminal frame (result, error, or suspend).
        self._on_ack = on_ack
        self._stopped = False
        self._reconnect_attempt = 0
        self._ws: Any = None
        # Frames sent before the relay answers our auth are rejected, so "open" is not enough.
        self._authenticated = False

    def is_open(self) -> bool:
        return self._authenticated and self._ws is not None

    async def send(self, payload: dict[str, Any]) -> bool:
        """Attempts to send on the CURRENT socket. Returns False if this connection can't carry it,
        so the caller can try another connection or hold the frame."""
        if not self.is_open():
            return False
        try:
            await self._ws.send(json.dumps(payload))
            return True
        except ConnectionClosed:
            return False

    async def run(self) -> None:
        """Connect, authenticate, and process messages until `stop()` is called.
        Reconnects with exponential backoff on every disconnect in between."""
        # websockets runs keepalive in a background task: it pings every `ping_interval`
        # seconds and raises ConnectionClosed if no pong arrives within `ping_timeout`.
        # This is what detects silently-dropped ("half-open") connections that never
        # deliver a close frame — without it the `async for` below would block forever on
        # a dead socket and never reconnect. `heartbeat_interval <= 0` disables keepalive.
        ping_interval = self._config.heartbeat_interval if self._config.heartbeat_interval > 0 else None
        ping_timeout = self._config.heartbeat_timeout if self._config.heartbeat_interval > 0 else None

        while not self._stopped:
            try:
                async with websockets.connect(
                    self._url,
                    ping_interval=ping_interval,
                    ping_timeout=ping_timeout,
                ) as ws:
                    self._ws = ws
                    self._authenticated = False
                    self._reconnect_attempt = 0
                    await self._send_raw(ws, self._auth_message())
                    async for raw in ws:
                        await self._handle_message(ws, raw)
            except ConnectionClosed:
                pass
            except OSError as exc:
                self._config.logger.error(f"[z3t SDK] WS error on {self._url}: {exc}")
            finally:
                self._ws = None
                self._authenticated = False

            if self._stopped:
                return
            await self._sleep_backoff()

    async def stop(self) -> None:
        self._stopped = True
        if self._ws is not None:
            await self._ws.close()

    def _auth_message(self) -> dict[str, Any]:
        msg: dict[str, Any] = {"type": "auth", "apiKey": self._config.api_key}
        if self._supported_versions:
            msg["supportedVersions"] = self._supported_versions
        return msg

    async def _handle_message(self, ws: Any, raw: str | bytes) -> None:
        try:
            msg = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return

        msg_type = msg.get("type")

        if msg_type == "auth_ok":
            self._authenticated = True
            self._config.logger.info(f"[z3t SDK] Authenticated on {self._url} — agentId: {msg.get('agentId')}")
            # Anything held while every connection was down can go out now.
            if self._on_ready is not None:
                await self._on_ready()

        elif msg_type == "ping":
            await self._send_raw(ws, {"type": "pong"})

        elif msg_type == "call":
            turn = msg.get("turn")
            capabilities = msg.get("capabilities")
            self._dispatch(
                IncomingCall(
                    call_id=msg["callId"],
                    schema_version=msg["schemaVersion"],
                    input=msg.get("input"),
                    turn=turn if isinstance(turn, int) else 0,
                    capabilities=list(capabilities) if isinstance(capabilities, list) else [],
                    can_ask=msg.get("canAsk") is True,
                    resume=msg.get("resume") if isinstance(msg.get("resume"), dict) else None,
                )
            )

        elif msg_type == "ack":
            # The relay has recorded the turn-terminal frame — the Agent can stop retrying it.
            if self._on_ack is not None and msg.get("callId"):
                turn = msg.get("turn")
                self._on_ack(msg["callId"], turn if isinstance(turn, int) else None)

        elif msg_type == "error":
            if not msg.get("callId"):
                self._config.logger.error(f"[z3t SDK] Relay error: {msg.get('message')}")
            # else: nothing to do — the call already reached a terminal state on our end

    @staticmethod
    async def _send_raw(ws: Any, payload: dict[str, Any]) -> None:
        try:
            await ws.send(json.dumps(payload))
        except ConnectionClosed:
            pass

    async def _sleep_backoff(self) -> None:
        delay = min(
            self._config.reconnect_delay * (2**self._reconnect_attempt),
            self._config.max_reconnect_delay,
        )
        self._config.logger.info(
            f"[z3t SDK] Reconnecting to {self._url} in {delay:.1f}s (attempt {self._reconnect_attempt + 1})"
        )
        self._reconnect_attempt += 1
        await asyncio.sleep(delay)
