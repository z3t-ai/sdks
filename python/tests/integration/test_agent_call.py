import asyncio
import json

import httpx
import pytest

from tests.helpers.wait_until import wait_until
from z3t_ai_agent.agent import Agent


@pytest.mark.respx(base_url="https://relay.z3t.ai/v1")
async def test_agents_call_always_omits_progress_capability(mock_relay, respx_mock):
    route = respx_mock.post("/agents/call").mock(
        return_value=httpx.Response(200, json={"output": {"chained": True}})
    )

    agent = Agent(api_key="test-key", relay_urls=[f"ws://localhost:{mock_relay.port}"])

    @agent.handle()
    async def handler(input, ctx):
        return await ctx.agents.call("agent-2", "plan-1", {"x": 1})

    task = asyncio.create_task(agent.start())
    try:
        await wait_until(lambda: any(m.get("type") == "auth" for m in mock_relay.received))
        await mock_relay.dispatch("call-1", {})
        await wait_until(lambda: any(m.get("type") == "result" for m in mock_relay.received))

        result = next(m for m in mock_relay.received if m.get("type") == "result")
        assert result["output"] == {"chained": True}

        body = json.loads(route.calls[0].request.content)
        assert body["capabilities"] == []
        assert "progress" not in body["capabilities"]
    finally:
        await agent.stop()
        task.cancel()
