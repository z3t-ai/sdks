import asyncio

from tests.helpers.wait_until import wait_until
from z3t_ai_agent.agent import Agent


def relay_url(mock_relay) -> str:
    return f"ws://localhost:{mock_relay.port}"


def auth_count(mock_relay) -> int:
    return len([m for m in mock_relay.received if m.get("type") == "auth"])


async def test_connect_auth_dispatch_result(mock_relay):
    agent = Agent(api_key="test-key", relay_urls=[relay_url(mock_relay)])

    @agent.handle()
    async def handler(input, ctx):
        return {"doubled": input["x"] * 2}

    task = asyncio.create_task(agent.start())
    try:
        await wait_until(lambda: any(m.get("type") == "auth" for m in mock_relay.received))
        await mock_relay.dispatch("call-1", {"x": 21})
        await wait_until(lambda: any(m.get("type") == "result" for m in mock_relay.received))

        result = next(m for m in mock_relay.received if m.get("type") == "result")
        assert result == {"type": "result", "callId": "call-1", "output": {"doubled": 42}}
    finally:
        await agent.stop()
        task.cancel()


async def test_handler_exception_sends_error(mock_relay):
    agent = Agent(api_key="test-key", relay_urls=[relay_url(mock_relay)])

    @agent.handle()
    async def handler(input, ctx):
        raise RuntimeError("kaboom")

    task = asyncio.create_task(agent.start())
    try:
        await wait_until(lambda: any(m.get("type") == "auth" for m in mock_relay.received))
        await mock_relay.dispatch("call-1", {})
        await wait_until(lambda: any(m.get("type") == "error" for m in mock_relay.received))

        error = next(m for m in mock_relay.received if m.get("type") == "error")
        assert error == {"type": "error", "callId": "call-1", "message": "kaboom"}
    finally:
        await agent.stop()
        task.cancel()


async def test_handler_timeout_sends_error(mock_relay):
    agent = Agent(api_key="test-key", relay_urls=[relay_url(mock_relay)], timeout=0.05)

    @agent.handle()
    async def handler(input, ctx):
        await asyncio.sleep(5)

    task = asyncio.create_task(agent.start())
    try:
        await wait_until(lambda: any(m.get("type") == "auth" for m in mock_relay.received))
        await mock_relay.dispatch("call-1", {})
        await wait_until(lambda: any(m.get("type") == "error" for m in mock_relay.received))

        error = next(m for m in mock_relay.received if m.get("type") == "error")
        assert error == {"type": "error", "callId": "call-1", "message": "Handler timeout"}
    finally:
        await agent.stop()
        task.cancel()


async def test_unregistered_version_sends_error_without_dispatch(mock_relay):
    agent = Agent(api_key="test-key", relay_urls=[relay_url(mock_relay)])

    @agent.handle(version=1)
    async def handler(input, ctx):
        return "v1"

    task = asyncio.create_task(agent.start())
    try:
        await wait_until(lambda: any(m.get("type") == "auth" for m in mock_relay.received))
        await mock_relay.dispatch("call-1", {}, schema_version=7)
        await wait_until(lambda: any(m.get("type") == "error" for m in mock_relay.received))

        error = next(m for m in mock_relay.received if m.get("type") == "error")
        assert error["message"] == "No handler for schema version 7"
    finally:
        await agent.stop()
        task.cancel()


async def test_reconnect_after_relay_disconnect_does_not_redispatch(mock_relay):
    agent = Agent(
        api_key="test-key",
        relay_urls=[relay_url(mock_relay)],
        reconnect_delay=0.01,
        max_reconnect_delay=0.1,
    )
    seen_calls = []

    @agent.handle()
    async def handler(input, ctx):
        seen_calls.append(input)
        return "ok"

    task = asyncio.create_task(agent.start())
    try:
        await wait_until(lambda: any(m.get("type") == "auth" for m in mock_relay.received))
        await mock_relay.close_connections()
        await wait_until(lambda: auth_count(mock_relay) >= 2)

        # the call that was "in flight" at disconnect is never replayed by the SDK
        assert seen_calls == []

        await mock_relay.dispatch("call-after-reconnect", {})
        await wait_until(lambda: any(m.get("type") == "result" for m in mock_relay.received))
        assert seen_calls == [{}]
    finally:
        await agent.stop()
        task.cancel()
