import asyncio

import httpx
import pytest

from z3t_ai_agent.agent import Agent, _QueuedCall


def make_agent(**kwargs) -> Agent:
    agent = Agent(api_key="test-key", **kwargs)
    agent._http = httpx.AsyncClient()
    return agent


class Collector:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send(self, payload: dict) -> None:
        self.sent.append(payload)


async def test_default_handler_invoked():
    agent = make_agent()

    @agent.handle()
    async def handler(input, ctx):
        return {"echo": input}

    collector = Collector()
    await agent._process_call(_QueuedCall("call-1", 1, {"x": 1}, collector.send))

    assert collector.sent == [{"type": "result", "callId": "call-1", "output": {"echo": {"x": 1}}}]
    await agent._http.aclose()


async def test_versioned_handler_takes_priority_over_default():
    agent = make_agent()

    @agent.handle()
    async def default_handler(input, ctx):
        return "default"

    @agent.handle(version=2)
    async def v2_handler(input, ctx):
        return "v2"

    collector = Collector()
    await agent._process_call(_QueuedCall("call-1", 2, {}, collector.send))

    assert collector.sent[0]["output"] == "v2"
    await agent._http.aclose()


async def test_unknown_schema_version_sends_error():
    agent = make_agent()

    @agent.handle(version=1)
    async def handler(input, ctx):
        return "ok"

    collector = Collector()
    await agent._process_call(_QueuedCall("call-1", 99, {}, collector.send))

    assert collector.sent == [
        {"type": "error", "callId": "call-1", "message": "No handler for schema version 99"}
    ]
    await agent._http.aclose()


async def test_handler_exception_becomes_error_frame():
    agent = make_agent()

    @agent.handle()
    async def handler(input, ctx):
        raise ValueError("boom")

    collector = Collector()
    await agent._process_call(_QueuedCall("call-1", 1, {}, collector.send))

    assert collector.sent == [{"type": "error", "callId": "call-1", "message": "boom"}]
    await agent._http.aclose()


async def test_handler_timeout_sends_error_and_cancels_handler():
    agent = make_agent(timeout=0.05)
    was_cancelled = False

    @agent.handle()
    async def handler(input, ctx):
        nonlocal was_cancelled
        try:
            await asyncio.sleep(5)
        except asyncio.CancelledError:
            was_cancelled = True
            raise

    collector = Collector()
    await agent._process_call(_QueuedCall("call-1", 1, {}, collector.send))

    assert collector.sent == [{"type": "error", "callId": "call-1", "message": "Handler timeout"}]
    assert was_cancelled is True
    await agent._http.aclose()


async def test_enqueue_runs_immediately_under_capacity():
    agent = make_agent(max_concurrent_calls=10)
    ran = []

    async def fake_process_call(call):
        ran.append(call)

    agent._process_call = fake_process_call  # type: ignore[method-assign]

    async def send(payload):
        pass

    agent._enqueue(_QueuedCall("call-1", 1, {}, send))
    await asyncio.sleep(0)  # let the scheduled task run

    assert agent._queue == []
    assert len(ran) == 1
    await agent._http.aclose()


async def test_enqueue_queues_excess_calls_over_capacity():
    agent = make_agent(max_concurrent_calls=1)
    agent._active_count = 1  # simulate one call already running

    async def send(payload):
        pass

    agent._enqueue(_QueuedCall("call-1", 1, {}, send))
    assert len(agent._queue) == 1
    await agent._http.aclose()


async def test_queue_overflow_evicts_oldest_with_error():
    agent = make_agent(max_concurrent_calls=1)  # max_queue = 2
    agent._active_count = 1

    sent_by_call: dict[str, list[dict]] = {}

    def make_send(call_id: str):
        sent_by_call[call_id] = []

        async def send(payload):
            sent_by_call[call_id].append(payload)

        return send

    agent._enqueue(_QueuedCall("call-1", 1, {}, make_send("call-1")))
    agent._enqueue(_QueuedCall("call-2", 1, {}, make_send("call-2")))
    agent._enqueue(_QueuedCall("call-3", 1, {}, make_send("call-3")))  # triggers overflow eviction

    await asyncio.sleep(0.01)  # let the fire-and-forget eviction send complete

    assert [c.call_id for c in agent._queue] == ["call-2", "call-3"]
    assert sent_by_call["call-1"] == [
        {"type": "error", "callId": "call-1", "message": "Queue depth exceeded"}
    ]
    await agent._http.aclose()


def test_handle_with_schema_requires_version():
    from z3t_ai_agent.schema import VersionSchema, s

    agent = make_agent()
    schema = VersionSchema(input=s.object({}), output=s.object({}))
    with pytest.raises(ValueError, match="explicit version"):
        agent.handle(schema=schema)
