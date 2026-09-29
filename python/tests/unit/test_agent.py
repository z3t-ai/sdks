import asyncio

import httpx
import pytest

from tests.helpers.wait_until import wait_until
from z3t_ai_agent import agent as agent_module
from z3t_ai_agent.agent import Agent
from z3t_ai_agent.connection import IncomingCall
from z3t_ai_agent.schema import s


class FakeConn:
    """Stands in for a relay connection: frames are no longer bound to the socket a call arrived
    on — the Agent picks a live connection at send time — so tests observe the connection."""

    def __init__(self, open_: bool = True) -> None:
        self.open = open_
        self.sent: list[dict] = []

    async def send(self, payload: dict) -> bool:
        if not self.open:
            return False
        self.sent.append(payload)
        return True

    async def stop(self) -> None:
        pass


def make_agent(*conns: FakeConn, **kwargs) -> Agent:
    agent = Agent(api_key="test-key", **kwargs)
    agent._http = httpx.AsyncClient()
    agent._connections = list(conns) if conns else [FakeConn()]  # type: ignore[list-item]
    return agent


async def close(agent: Agent) -> None:
    await agent.stop()
    assert agent._http is not None
    await agent._http.aclose()


def call(call_id: str = "call-1", version: int = 1, input=None, **kw) -> IncomingCall:
    return IncomingCall(call_id, version, {} if input is None else input, **kw)


def sent(agent: Agent) -> list[dict]:
    return agent._connections[0].sent  # type: ignore[attr-defined]


# ─── Handler routing ──────────────────────────────────────────────────────────


async def test_default_handler_invoked():
    agent = make_agent()

    @agent.handle()
    async def handler(input, ctx):
        return {"echo": input}

    await agent._process_call(call(input={"x": 1}))

    assert sent(agent) == [{"type": "result", "callId": "call-1", "turn": 0, "output": {"echo": {"x": 1}}}]
    await close(agent)


async def test_versioned_handler_takes_priority_over_default():
    agent = make_agent()

    @agent.handle()
    async def default_handler(input, ctx):
        return "default"

    @agent.handle(version=2)
    async def v2_handler(input, ctx):
        return "v2"

    await agent._process_call(call(version=2))

    assert sent(agent)[0]["output"] == "v2"
    await close(agent)


async def test_unknown_schema_version_sends_error():
    agent = make_agent()

    @agent.handle(version=1)
    async def handler(input, ctx):
        return "ok"

    await agent._process_call(call(version=99))

    assert sent(agent) == [
        {"type": "error", "callId": "call-1", "turn": 0, "message": "No handler for schema version 99"}
    ]
    await close(agent)


async def test_handler_exception_becomes_error_frame():
    agent = make_agent()

    @agent.handle()
    async def handler(input, ctx):
        raise ValueError("boom")

    await agent._process_call(call())

    assert sent(agent) == [{"type": "error", "callId": "call-1", "turn": 0, "message": "boom"}]
    await close(agent)


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

    await agent._process_call(call())

    assert sent(agent) == [{"type": "error", "callId": "call-1", "turn": 0, "message": "Handler timeout"}]
    assert was_cancelled is True
    await close(agent)


# ─── Concurrency ──────────────────────────────────────────────────────────────


async def test_enqueue_runs_immediately_under_capacity():
    agent = make_agent(max_concurrent_calls=10)
    ran = []

    async def fake_process_call(c):
        ran.append(c)

    agent._process_call = fake_process_call  # type: ignore[method-assign]

    agent._enqueue(call())
    await asyncio.sleep(0)  # let the scheduled task run

    assert agent._queue == []
    assert len(ran) == 1
    await close(agent)


async def test_enqueue_queues_excess_calls_over_capacity():
    agent = make_agent(max_concurrent_calls=1)
    agent._active_count = 1  # simulate one call already running

    agent._enqueue(call())
    assert len(agent._queue) == 1
    await close(agent)


async def test_queue_overflow_evicts_oldest_with_error():
    agent = make_agent(max_concurrent_calls=1)  # max_queue = 2
    agent._active_count = 1

    agent._enqueue(call("call-1"))
    agent._enqueue(call("call-2"))
    agent._enqueue(call("call-3"))  # triggers overflow eviction

    await asyncio.sleep(0.01)  # let the fire-and-forget eviction send complete

    assert [c.call_id for c in agent._queue] == ["call-2", "call-3"]
    assert sent(agent) == [{"type": "error", "callId": "call-1", "turn": 0, "message": "Queue depth exceeded"}]
    await close(agent)


def test_handle_with_schema_requires_version():
    from z3t_ai_agent.schema import VersionSchema

    agent = Agent(api_key="test-key")
    schema = VersionSchema(input=s.object({}), output=s.object({}))
    with pytest.raises(ValueError, match="explicit version"):
        agent.handle(schema=schema)


# ─── Delivery (parity with the TypeScript SDK) ─────────────────────────────────
# The failure these cover, seen in production on the TS side first: a run works for ten minutes,
# the socket it arrived on dies in the middle, the handler finishes — and the result is written to a
# closed socket and lost. The call then sits in 'processing' until the platform reaps it.


async def test_delivers_on_a_live_connection_when_another_is_dead():
    dead, live = FakeConn(open_=False), FakeConn()
    agent = make_agent(dead, live)

    @agent.handle()
    async def handler(input, ctx):
        return "finished"

    await agent._process_call(call())

    assert live.sent[0] == {"type": "result", "callId": "call-1", "turn": 0, "output": "finished"}
    assert dead.sent == []
    await close(agent)


async def test_holds_the_result_until_a_connection_comes_back():
    conn = FakeConn(open_=False)
    agent = make_agent(conn)

    @agent.handle()
    async def handler(input, ctx):
        return "finished"

    await agent._process_call(call())
    assert "call-1" in agent._pending
    assert conn.sent == []

    conn.open = True
    await agent._on_connection_ready()  # the reconnect authenticated

    assert conn.sent[0]["type"] == "result"
    await close(agent)


async def test_drops_progress_rather_than_replaying_a_stale_backlog():
    conn = FakeConn(open_=False)
    agent = make_agent(conn)

    @agent.handle()
    async def handler(input, ctx):
        for i in range(agent_module.OUTBOX_MAX + 10):
            await ctx.progress("step", f"page {i}")
        return "finished"

    await agent._process_call(call())
    conn.open = True
    await agent._on_connection_ready()

    assert len([f for f in conn.sent if f["type"] == "progress"]) == agent_module.OUTBOX_MAX
    assert len([f for f in conn.sent if f["type"] == "result"]) == 1
    await close(agent)


async def test_resends_until_acknowledged(monkeypatch):
    monkeypatch.setattr(agent_module, "RESULT_RETRY_S", 0.02)
    agent = make_agent()

    @agent.handle()
    async def handler(input, ctx):
        return "finished"

    await agent._process_call(call())
    # A socket that accepted the bytes is not proof the relay recorded the call — only the ack is.
    await wait_until(lambda: len(sent(agent)) >= 3)

    agent._settle("call-1", 0)
    count = len(sent(agent))
    await asyncio.sleep(0.1)
    assert len(sent(agent)) == count
    await close(agent)


async def test_gives_up_and_reports_after_the_retry_window(monkeypatch):
    monkeypatch.setattr(agent_module, "RESULT_RETRY_S", 0.01)
    monkeypatch.setattr(agent_module, "RESULT_RETRY_TIMEOUT_S", 0.03)
    errors: list[tuple] = []

    class Logger:
        def info(self, *a): pass
        def warn(self, *a): pass
        def error(self, *a): errors.append(a)

    agent = make_agent(logger=Logger())

    @agent.handle()
    async def handler(input, ctx):
        return "finished"

    await agent._process_call(call())
    await wait_until(lambda: not agent._pending)

    assert "Gave up delivering the result for call call-1" in errors[0][0]
    await close(agent)


async def test_an_earlier_turns_ack_does_not_settle_a_later_turn():
    agent = make_agent()

    @agent.handle()
    async def handler(input, ctx):
        return "finished"

    await agent._process_call(call(turn=1))
    agent._settle("call-1", 0)
    assert "call-1#1" in agent._pending

    agent._settle("call-1", 1)
    assert agent._pending == {}
    await close(agent)


async def test_an_ack_without_a_turn_settles_every_turn_of_the_call():
    agent = make_agent()

    @agent.handle()
    async def handler(input, ctx):
        return "finished"

    await agent._process_call(call(turn=2))
    agent._settle("call-1")  # an older relay acks without a turn

    assert agent._pending == {}
    await close(agent)


# ─── Interactive calls: suspend and resume ───────────────────────────────────────

QUESTION = s.object({"contract": s.file_uri().optional(), "n": s.string().optional()})


async def test_asking_ends_the_turn_with_a_suspend_frame():
    agent = make_agent()
    runs = 0

    @agent.handle()
    async def handler(input, ctx):
        nonlocal runs

        async def extract():
            nonlocal runs
            runs += 1
            return {"gaps": 1}

        await ctx.step("case-file", extract)
        await ctx.ask("gaps", message="Invoice 3 names contract CX-12.", schema=QUESTION)
        return "never reached"

    await agent._process_call(call(can_ask=True))

    frame = sent(agent)[-1]
    assert frame["type"] == "suspend"
    assert frame["turn"] == 0
    assert frame["request"] == {"key": "gaps", "message": "Invoice 3 names contract CX-12.", "schema": QUESTION._def}
    assert frame["checkpoint"]["steps"] == {"case-file": {"value": {"gaps": 1}}}
    assert runs == 1
    assert not any(f["type"] in ("result", "error") for f in sent(agent))
    await close(agent)


async def test_except_exception_cannot_swallow_the_suspend():
    agent = make_agent()

    @agent.handle()
    async def handler(input, ctx):
        try:
            await ctx.ask("gaps", message="Which contract?", schema=QUESTION)
        except Exception:  # a well-meaning catch-all — SuspendSignal is a BaseException
            return "a result the consumer never asked for"

    await agent._process_call(call(can_ask=True))

    assert [f["type"] for f in sent(agent)] == ["suspend"]
    await close(agent)


@pytest.mark.skipif(not hasattr(asyncio, "TaskGroup"), reason="asyncio.TaskGroup needs Python 3.11+")
async def test_asking_inside_a_task_group_still_suspends():
    # A TaskGroup wraps the SuspendSignal in a BaseExceptionGroup, which slips past both
    # `except SuspendSignal` and `except Exception` — the turn must still end with a suspend.
    agent = make_agent()

    @agent.handle()
    async def handler(input, ctx):
        async def check():
            await ctx.ask("gaps", message="Which contract?", schema=QUESTION)

        async with asyncio.TaskGroup() as tg:
            tg.create_task(check())

    await agent._process_call(call(can_ask=True))

    assert [f["type"] for f in sent(agent)] == ["suspend"]
    await close(agent)


async def test_a_base_exception_that_is_not_a_question_becomes_an_error_frame():
    class Abort(BaseException):
        pass

    agent = make_agent()

    @agent.handle()
    async def handler(input, ctx):
        raise Abort("stop")

    await agent._process_call(call())

    assert sent(agent)[-1] == {"type": "error", "callId": "call-1", "turn": 0, "message": "stop"}
    await close(agent)


async def test_suspends_even_when_the_handler_catches_the_signal_and_warns():
    warnings: list[tuple] = []

    class Logger:
        def info(self, *a): pass
        def warn(self, *a): warnings.append(a)
        def error(self, *a): pass

    agent = make_agent(logger=Logger())

    @agent.handle()
    async def handler(input, ctx):
        try:
            await ctx.ask("gaps", message="Which contract?", schema=QUESTION)
        except BaseException:  # deliberately too broad
            return "a result the consumer never asked for"

    await agent._process_call(call(can_ask=True))

    assert [f["type"] for f in sent(agent)] == ["suspend"]
    assert "caught the suspend signal" in warnings[0][0]
    await close(agent)


async def test_carries_on_with_unavailable_when_the_run_cannot_ask():
    agent = make_agent()

    @agent.handle()
    async def handler(input, ctx):
        result = await ctx.ask("gaps", message="Which contract?", schema=QUESTION)
        return result.action

    await agent._process_call(call())  # can_ask defaults to False

    assert sent(agent) == [{"type": "result", "callId": "call-1", "turn": 0, "output": "unavailable"}]
    await close(agent)


async def test_resume_replays_steps_without_rerunning_them():
    agent = make_agent()
    ran: list[str] = []

    @agent.handle()
    async def handler(input, ctx):
        await ctx.progress("extracting", "Reading documents")

        def extract():
            ran.append("extract")
            return "facts"

        facts = await ctx.step("extract", extract)
        answer = await ctx.ask("gaps", message="Which contract?", schema=QUESTION)
        await ctx.progress("drafting", "Writing the letter")

        def draft():
            ran.append("draft")
            return "letter"

        letter = await ctx.step("draft", draft)
        return {"facts": facts, "letter": letter, "answer": (answer.answers or {}).get("n"), "turn": ctx.turn}

    resume = {
        "checkpoint": {"v": 1, "steps": {"extract": {"value": "facts"}}, "answers": {}},
        "response": {"key": "gaps", "action": "answered", "answers": {"n": "CX-12"}},
    }
    await agent._process_call(call(turn=1, can_ask=True, resume=resume))

    result = [f for f in sent(agent) if f["type"] == "result"][0]
    assert result["turn"] == 1
    assert result["output"] == {"facts": "facts", "letter": "letter", "answer": "CX-12", "turn": 1}
    assert ran == ["draft"]
    # The replayed milestone is already in the activity log; only the new one goes out.
    assert [f["step"] for f in sent(agent) if f["type"] == "progress"] == ["drafting"]
    await close(agent)


async def test_an_oversized_journal_fails_the_call_with_a_clear_message():
    agent = make_agent()

    @agent.handle()
    async def handler(input, ctx):
        await ctx.step("huge", lambda: "x" * (3 * 1024 * 1024))
        await ctx.ask("gaps", message="Which contract?", schema=QUESTION)

    await agent._process_call(call(can_ask=True))

    frame = sent(agent)[-1]
    assert frame["type"] == "error"
    assert "over the" in frame["message"]
    await close(agent)


@pytest.mark.parametrize("output", [float("nan"), {"score": float("inf")}, object()])
async def test_an_output_that_is_not_valid_json_fails_the_call_instead_of_hanging(output):
    agent = make_agent()

    @agent.handle()
    async def handler(input, ctx):
        return output

    await agent._process_call(call())

    frame = sent(agent)[-1]
    assert frame["type"] == "error"
    assert "can't be sent as JSON" in frame["message"]
    await close(agent)


async def test_call_tasks_are_held_until_they_finish():
    agent = make_agent()
    release = asyncio.Event()

    @agent.handle()
    async def handler(input, ctx):
        await release.wait()
        return "done"

    agent._enqueue(call())
    await asyncio.sleep(0)
    assert len(agent._tasks) == 1

    release.set()
    await wait_until(lambda: not agent._tasks)
    assert sent(agent)[-1]["type"] == "result"
    await close(agent)


async def test_schema_sync_sends_interactive_only_when_declared():
    from z3t_ai_agent.schema import VersionSchema

    agent = make_agent()

    @agent.handle(version=1, schema=VersionSchema(input=s.object({}), output=s.object({})))
    async def v1(input, ctx):
        return None

    @agent.handle(version=2, schema=VersionSchema(input=s.object({}), output=s.object({}), interactive=True))
    async def v2(input, ctx):
        return None

    captured: dict = {}

    async def fake_post(url, json=None, headers=None):
        captured["body"] = json
        return httpx.Response(200, json={"versions": []}, request=httpx.Request("POST", url))

    agent._http.post = fake_post  # type: ignore[method-assign, union-attr]
    await agent._sync_schemas()

    by_version = {v["version"]: v for v in captured["body"]["versions"]}
    assert by_version[2]["interactive"] is True
    assert "interactive" not in by_version[1]
    await close(agent)
