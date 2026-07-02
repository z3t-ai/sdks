from __future__ import annotations

import asyncio
import json
from typing import Any, Awaitable, Callable

import websockets
from websockets.exceptions import ConnectionClosed

from .types import ResolvedConfig

# Called by the Connection whenever the relay dispatches a call to this agent.
# `send` is bound to the WebSocket that delivered the call.
CallDispatcher = Callable[[str, int, Any, Callable[[dict[str, Any]], Awaitable[None]]], None]


class Connection:
    def __init__(
        self,
        url: str,
        config: ResolvedConfig,
        dispatch: CallDispatcher,
        supported_versions: list[int],
    ) -> None:
        self._url = url
        self._config = config
        self._dispatch = dispatch
        # Schema versions this agent instance handles — sent in the auth message so the
        # relay can route calls to instances that support the requested version.
        self._supported_versions = supported_versions
        self._stopped = False
        self._reconnect_attempt = 0
        self._ws: Any = None

    async def run(self) -> None:
        """Connect, authenticate, and process messages until `stop()` is called.
        Reconnects with exponential backoff on every disconnect in between."""
        while not self._stopped:
            try:
                async with websockets.connect(self._url) as ws:
                    self._ws = ws
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
            self._config.logger.info(f"[z3t SDK] Authenticated on {self._url} — agentId: {msg.get('agentId')}")

        elif msg_type == "ping":
            await self._send_raw(ws, {"type": "pong"})

        elif msg_type == "call":
            async def send(payload: dict[str, Any]) -> None:
                await self._send_raw(ws, payload)

            self._dispatch(msg["callId"], msg["schemaVersion"], msg.get("input"), send)

        elif msg_type == "ack":
            pass  # no-op — relay acknowledging receipt of a result/error frame

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
