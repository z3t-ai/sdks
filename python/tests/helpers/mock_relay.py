from __future__ import annotations

import json
from typing import Any

import websockets


class MockRelay:
    """In-process WebSocket server on a random port, mirroring
    typescript/tests/helpers/mock-relay.ts. Auto-replies `auth_ok` to `auth`."""

    def __init__(self) -> None:
        self.received: list[dict[str, Any]] = []
        self._active_ws: Any = None
        self._server: Any = None

    @property
    def port(self) -> int:
        assert self._server is not None
        return self._server.sockets[0].getsockname()[1]

    async def _handle(self, ws: Any) -> None:
        self._active_ws = ws
        try:
            async for raw in ws:
                msg = json.loads(raw)
                self.received.append(msg)
                if msg.get("type") == "auth":
                    await ws.send(
                        json.dumps({"type": "auth_ok", "agentId": "mock-agent-id", "relayInstanceId": "mock-relay"})
                    )
        finally:
            if self._active_ws is ws:
                self._active_ws = None

    async def start(self) -> None:
        self._server = await websockets.serve(self._handle, "localhost", 0)

    async def dispatch(self, call_id: str, input: Any, schema_version: int = 1) -> None:
        """Dispatch a call to the agent (after auth)."""
        if self._active_ws is None:
            raise RuntimeError("No active WebSocket connection to dispatch to")
        await self._active_ws.send(
            json.dumps({"type": "call", "callId": call_id, "schemaVersion": schema_version, "input": input})
        )

    async def close_connections(self) -> None:
        """Force-close the active connected client WebSocket (triggers agent reconnect)."""
        if self._active_ws is not None:
            await self._active_ws.close()

    async def close(self) -> None:
        assert self._server is not None
        self._server.close()
        await self._server.wait_closed()


async def create_mock_relay() -> MockRelay:
    relay = MockRelay()
    await relay.start()
    return relay
