import asyncio

from tests.helpers.wait_until import wait_until
from z3t_ai_agent.agent import Agent


async def test_progress_sends_correct_frame(mock_relay):
    agent = Agent(api_key="test-key", relay_urls=[f"ws://localhost:{mock_relay.port}"])

    @agent.handle()
    async def handler(input, ctx):
        await ctx.progress("downloading", "Downloading contract...", 0.1)
        # keyword form, matching the documented signature in README.md —
        # regression check: the parameter must be named `progress`, not `progress_value`
        await ctx.progress(step="done", message="Finished", progress=None)
        return "ok"

    task = asyncio.create_task(agent.start())
    try:
        await wait_until(lambda: any(m.get("type") == "auth" for m in mock_relay.received))
        await mock_relay.dispatch("call-1", {})
        await wait_until(lambda: len([m for m in mock_relay.received if m.get("type") == "progress"]) >= 2)

        progress_frames = [m for m in mock_relay.received if m.get("type") == "progress"]
        assert progress_frames[0] == {
            "type": "progress",
            "callId": "call-1",
            "step": "downloading",
            "message": "Downloading contract...",
            "progress": 0.1,
        }
        assert progress_frames[1] == {
            "type": "progress",
            "callId": "call-1",
            "step": "done",
            "message": "Finished",
        }
    finally:
        await agent.stop()
        task.cancel()
