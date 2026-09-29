import asyncio

import pytest

from tests.helpers.wait_until import wait_until
from z3t_ai_agent.connection import Connection
from z3t_ai_agent.types import ConsoleLogger, ResolvedConfig


def make_config(**overrides) -> ResolvedConfig:
    defaults = dict(
        api_key="test-key",
        base_url="https://relay.z3t.ai/v1",
        relay_urls=[],
        timeout=25.0,
        max_concurrent_calls=10,
        reconnect_delay=0.01,
        max_reconnect_delay=0.2,
        heartbeat_interval=0.0,  # disabled by default in tests; opt in per-test
        heartbeat_timeout=20.0,
        logger=ConsoleLogger(),
    )
    defaults.update(overrides)
    return ResolvedConfig(**defaults)


async def test_auth_message_includes_supported_versions(mock_relay):
    conn = Connection(f"ws://localhost:{mock_relay.port}", make_config(), lambda *a: None, [1, 2])
    task = asyncio.create_task(conn.run())
    try:
        await wait_until(lambda: len(mock_relay.received) >= 1)
        assert mock_relay.received[0] == {"type": "auth", "apiKey": "test-key", "supportedVersions": [1, 2]}
    finally:
        await conn.stop()
        task.cancel()


async def test_auth_message_omits_supported_versions_when_empty(mock_relay):
    conn = Connection(f"ws://localhost:{mock_relay.port}", make_config(), lambda *a: None, [])
    task = asyncio.create_task(conn.run())
    try:
        await wait_until(lambda: len(mock_relay.received) >= 1)
        assert mock_relay.received[0] == {"type": "auth", "apiKey": "test-key"}
    finally:
        await conn.stop()
        task.cancel()


async def test_ping_replied_with_pong_immediately(mock_relay):
    conn = Connection(f"ws://localhost:{mock_relay.port}", make_config(), lambda *a: None, [])
    task = asyncio.create_task(conn.run())
    try:
        await wait_until(lambda: len(mock_relay.received) >= 1)
        await mock_relay._active_ws.send('{"type": "ping"}')
        # `received` captures every frame the relay gets *from* the agent — a "pong"
        # appearing there means the agent replied to our ping.
        await wait_until(lambda: any(m.get("type") == "pong" for m in mock_relay.received))
    finally:
        await conn.stop()
        task.cancel()


async def test_reconnects_with_new_auth_after_disconnect(mock_relay):
    conn = Connection(f"ws://localhost:{mock_relay.port}", make_config(), lambda *a: None, [])
    task = asyncio.create_task(conn.run())
    try:
        await wait_until(lambda: len(mock_relay.received) >= 1)
        await mock_relay.close_connections()
        await wait_until(lambda: len([m for m in mock_relay.received if m.get("type") == "auth"]) >= 2)
    finally:
        await conn.stop()
        task.cancel()


async def test_connection_refused_logs_error_and_retries():
    errors = []

    class RecordingLogger(ConsoleLogger):
        def error(self, *a):
            errors.append(a)

    conn = Connection("ws://localhost:1", make_config(logger=RecordingLogger()), lambda *a: None, [])
    task = asyncio.create_task(conn.run())
    try:
        await wait_until(lambda: len(errors) >= 1, timeout=2.0)
        assert "WS error" in errors[0][0]
    finally:
        await conn.stop()
        task.cancel()


async def test_malformed_json_message_is_ignored(mock_relay):
    dispatched = []
    conn = Connection(
        f"ws://localhost:{mock_relay.port}", make_config(), lambda *a: dispatched.append(a), []
    )
    task = asyncio.create_task(conn.run())
    try:
        await wait_until(lambda: len(mock_relay.received) >= 1)
        await mock_relay._active_ws.send("not valid json")
        await asyncio.sleep(0.05)  # give the agent a chance to (not) crash on it
        assert dispatched == []
    finally:
        await conn.stop()
        task.cancel()


async def test_ack_message_is_a_noop(mock_relay):
    conn = Connection(f"ws://localhost:{mock_relay.port}", make_config(), lambda *a: None, [])
    task = asyncio.create_task(conn.run())
    try:
        await wait_until(lambda: len(mock_relay.received) >= 1)
        await mock_relay._active_ws.send('{"type": "ack"}')
        # dispatch a real call afterward to prove the connection is still healthy
        await mock_relay.dispatch("call-1", {})
        await asyncio.sleep(0.05)
    finally:
        await conn.stop()
        task.cancel()


async def test_relay_error_with_call_id_is_ignored(mock_relay):
    logged = []

    class RecordingLogger(ConsoleLogger):
        def error(self, *a):
            logged.append(a)

    conn = Connection(f"ws://localhost:{mock_relay.port}", make_config(logger=RecordingLogger()), lambda *a: None, [])
    task = asyncio.create_task(conn.run())
    try:
        await wait_until(lambda: len(mock_relay.received) >= 1)
        await mock_relay._active_ws.send('{"type": "error", "callId": "call-1", "message": "already handled"}')
        await asyncio.sleep(0.05)
        assert logged == []  # has callId → nothing to do client-side
    finally:
        await conn.stop()
        task.cancel()


async def test_relay_error_without_call_id_is_logged(mock_relay):
    logged = []

    class RecordingLogger(ConsoleLogger):
        def error(self, *a):
            logged.append(a)

    conn = Connection(f"ws://localhost:{mock_relay.port}", make_config(logger=RecordingLogger()), lambda *a: None, [])
    task = asyncio.create_task(conn.run())
    try:
        await wait_until(lambda: len(mock_relay.received) >= 1)
        await mock_relay._active_ws.send('{"type": "error", "message": "relay-level failure"}')
        await wait_until(lambda: len(logged) >= 1)
        assert logged[0] == ("[z3t SDK] Relay error: relay-level failure",)
    finally:
        await conn.stop()
        task.cancel()


async def test_send_raw_swallows_connection_closed():
    from z3t_ai_agent.connection import Connection as _Connection

    class FakeClosedWs:
        async def send(self, _data: str) -> None:
            from websockets.exceptions import ConnectionClosedOK

            raise ConnectionClosedOK(None, None)

    # should not raise
    await _Connection._send_raw(FakeClosedWs(), {"type": "pong"})


async def test_keepalive_params_forwarded_to_websockets(monkeypatch):
    # The actual "terminate a dead half-open socket and reconnect" behaviour lives inside
    # the websockets library's keepalive task (a ping every ping_interval, close after
    # ping_timeout with no pong). We can't simulate a true half-open in-process — the mock
    # server auto-ponds — so we assert the config is wired into websockets.connect(); the
    # library is responsible for the rest.
    import z3t_ai_agent.connection as conn_mod

    captured: dict = {}

    def fake_connect(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        raise RuntimeError("halt")  # break out of run()'s connect loop

    monkeypatch.setattr(conn_mod.websockets, "connect", fake_connect)

    conn = Connection(
        "ws://localhost:1",
        make_config(heartbeat_interval=15.0, heartbeat_timeout=7.0),
        lambda *a: None,
        [],
    )
    with pytest.raises(RuntimeError, match="halt"):
        await conn.run()

    assert captured["ping_interval"] == 15.0
    assert captured["ping_timeout"] == 7.0


async def test_keepalive_disabled_when_interval_zero(monkeypatch):
    import z3t_ai_agent.connection as conn_mod

    captured: dict = {}

    def fake_connect(url, **kwargs):
        captured.update(kwargs)
        raise RuntimeError("halt")

    monkeypatch.setattr(conn_mod.websockets, "connect", fake_connect)

    conn = Connection(
        "ws://localhost:1",
        make_config(heartbeat_interval=0.0),
        lambda *a: None,
        [],
    )
    with pytest.raises(RuntimeError, match="halt"):
        await conn.run()

    # interval 0 → keepalive fully disabled
    assert captured["ping_interval"] is None
    assert captured["ping_timeout"] is None


async def test_call_frame_defaults_when_the_relay_predates_interactive_calls(mock_relay):
    dispatched = []
    conn = Connection(f"ws://localhost:{mock_relay.port}", make_config(), dispatched.append, [])
    task = asyncio.create_task(conn.run())
    try:
        await wait_until(lambda: len(mock_relay.received) >= 1)
        await mock_relay.dispatch("call-1", {"x": 1}, schema_version=2)
        await wait_until(lambda: len(dispatched) == 1)
        c = dispatched[0]
        assert (c.call_id, c.schema_version, c.input) == ("call-1", 2, {"x": 1})
        assert (c.turn, c.capabilities, c.can_ask, c.resume) == (0, [], False, None)
    finally:
        await conn.stop()
        task.cancel()


async def test_call_frame_passes_turn_capabilities_can_ask_and_resume(mock_relay):
    dispatched = []
    resume = {"checkpoint": {"v": 1, "steps": {}, "answers": {}}, "response": {"key": "q", "action": "declined"}}
    conn = Connection(f"ws://localhost:{mock_relay.port}", make_config(), dispatched.append, [])
    task = asyncio.create_task(conn.run())
    try:
        await wait_until(lambda: len(mock_relay.received) >= 1)
        await mock_relay.send_frame({
            "type": "call", "callId": "call-7", "schemaVersion": 3, "input": {}, "turn": 2,
            "capabilities": ["progress", "input"], "canAsk": True, "resume": resume,
        })
        await wait_until(lambda: len(dispatched) == 1)
        c = dispatched[0]
        assert (c.turn, c.capabilities, c.can_ask, c.resume) == (2, ["progress", "input"], True, resume)
    finally:
        await conn.stop()
        task.cancel()


async def test_ack_reports_call_and_turn(mock_relay):
    acks = []
    conn = Connection(
        f"ws://localhost:{mock_relay.port}", make_config(), lambda c: None, [],
        on_ack=lambda call_id, turn: acks.append((call_id, turn)),
    )
    task = asyncio.create_task(conn.run())
    try:
        await wait_until(lambda: len(mock_relay.received) >= 1)
        await mock_relay.send_frame({"type": "ack", "callId": "call-1", "turn": 1})
        await mock_relay.send_frame({"type": "ack", "callId": "call-2"})  # an older relay
        await wait_until(lambda: len(acks) == 2)
        assert acks == [("call-1", 1), ("call-2", None)]
    finally:
        await conn.stop()
        task.cancel()


async def test_send_refuses_until_authenticated_then_signals_ready(mock_relay):
    ready = []

    async def on_ready():
        ready.append(True)

    conn = Connection(f"ws://localhost:{mock_relay.port}", make_config(), lambda c: None, [], on_ready=on_ready)
    assert await conn.send({"type": "progress"}) is False  # not even connected
    task = asyncio.create_task(conn.run())
    try:
        await wait_until(lambda: len(ready) == 1)
        assert conn.is_open()
        assert await conn.send({"type": "pong"}) is True
    finally:
        await conn.stop()
        task.cancel()
