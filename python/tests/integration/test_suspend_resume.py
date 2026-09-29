import asyncio

from tests.helpers.wait_until import wait_until
from z3t_ai_agent.agent import Agent
from z3t_ai_agent.schema import s

# The whole round trip over a real WebSocket: one agent process asks and exits the turn; the relay
# hands the journal to a DIFFERENT agent process (a restart, another replica), which picks up where
# the first left off without redoing the paid-for work.


def frames(relay, type_: str) -> list[dict]:
    return [m for m in relay.received if m.get("type") == type_]


def start_agent(relay, extract_calls: list[str], name: str):
    agent = Agent(api_key="k", relay_urls=[f"ws://localhost:{relay.port}"], timeout=2.0)

    @agent.handle()
    async def handler(input, ctx):
        await ctx.progress("reading", "Reading your documents")

        async def extract():
            extract_calls.append(name)
            return {"invoices": 3}

        facts = await ctx.step("extract", extract)
        answer = await ctx.ask(
            "contract",
            message="Invoice 3 names contract **CX-12**, which was not uploaded. What is its number?",
            schema=s.object({"contractNumber": s.string().optional()}),
        )
        await ctx.progress("drafting", "Drafting the notice")
        return {"facts": facts, "contract": (answer.answers or {}).get("contractNumber"), "turn": ctx.turn}

    task = asyncio.create_task(agent.start())
    return agent, task


async def test_pays_for_the_work_once_and_resumes_on_another_process(mock_relay):
    extract_calls: list[str] = []

    first, first_task = start_agent(mock_relay, extract_calls, "first")
    try:
        await wait_until(lambda: len(frames(mock_relay, "auth")) == 1)
        await mock_relay.send_frame({
            "type": "call", "callId": "c1", "schemaVersion": 1, "input": {}, "turn": 0,
            "capabilities": ["progress", "input"], "canAsk": True,
        })
        await wait_until(lambda: len(frames(mock_relay, "suspend")) == 1)
        suspend = frames(mock_relay, "suspend")[0]
        assert suspend["turn"] == 0
        assert suspend["request"]["key"] == "contract"
        await mock_relay.send_frame({"type": "ack", "callId": "c1", "turn": 0})
    finally:
        await first.stop()
        first_task.cancel()

    second, second_task = start_agent(mock_relay, extract_calls, "second")
    try:
        await wait_until(lambda: len(frames(mock_relay, "auth")) == 2)
        progress_before = len(frames(mock_relay, "progress"))
        await mock_relay.send_frame({
            "type": "call", "callId": "c1", "schemaVersion": 1, "input": {}, "turn": 1,
            "capabilities": ["progress", "input"], "canAsk": True,
            "resume": {
                "checkpoint": suspend["checkpoint"],
                "response": {"key": "contract", "action": "answered", "answers": {"contractNumber": "CX-12"}},
            },
        })
        await wait_until(lambda: len(frames(mock_relay, "result")) == 1)
        result = frames(mock_relay, "result")[0]
        assert result["turn"] == 1
        assert result["output"] == {"facts": {"invoices": 3}, "contract": "CX-12", "turn": 1}
        assert extract_calls == ["first"]
        assert [f["step"] for f in frames(mock_relay, "progress")[progress_before:]] == ["drafting"]
    finally:
        await second.stop()
        second_task.cancel()


async def test_carries_on_without_suspending_when_the_caller_cannot_answer(mock_relay):
    agent, task = start_agent(mock_relay, [], "only")
    try:
        await wait_until(lambda: len(frames(mock_relay, "auth")) == 1)
        await mock_relay.send_frame({"type": "call", "callId": "c2", "schemaVersion": 1, "input": {}, "turn": 0})
        await wait_until(lambda: len(frames(mock_relay, "result")) == 1)
        assert frames(mock_relay, "suspend") == []
        assert frames(mock_relay, "result")[0]["output"]["contract"] is None
    finally:
        await agent.stop()
        task.cancel()
