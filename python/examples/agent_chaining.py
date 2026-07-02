"""Agent that calls another agent on the platform (agent-to-agent chaining) and
incorporates its output into its own result. Progress events are automatically
suppressed for the downstream call.

Run:
    export Z3T_AGENT_KEY=...
    python examples/agent_chaining.py
"""

import asyncio
import os

from z3t_ai_agent import Agent

agent = Agent(api_key=os.environ["Z3T_AGENT_KEY"])


@agent.handle()
async def handle(input: dict, ctx) -> dict:
    await ctx.progress("delegating", "Calling the extraction agent...", 0.3)

    extraction = await ctx.agents.call(
        agent_id=input["extractionAgentId"],
        plan_id=input["extractionPlanId"],
        input={"document": input["document"]},
        timeout=20.0,  # seconds — falls back to this agent's own configured timeout if omitted
    )

    await ctx.progress("finishing", "Formatting results...", 0.8)
    return {"extractedFields": extraction, "source": input["document"]}


if __name__ == "__main__":
    asyncio.run(agent.start())
